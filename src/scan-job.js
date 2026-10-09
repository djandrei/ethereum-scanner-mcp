/**
 * One background scan. Mirrors the block loop in the scanner CLI's main()
 * with console output replaced by structured state, plus cancellation,
 * bounded retries and a match cap.
 */

import { randomUUID } from 'node:crypto';
import { withTimeout } from './rpc.js';

const RPC_ATTEMPTS = 3;
const RPC_BACKOFF_MS = 500;
const MAX_WARNINGS = 50;

function isHexEmpty(hex)
{
    return !hex || hex.replace(/^0[xX]/, '').length === 0;
}

function sleep(ms, signal)
{
    if (ms <= 0 || signal.aborted)
    {
        return Promise.resolve();
    }
    return new Promise(resolve =>
    {
        const timer = setTimeout(done, ms);
        function done()
        {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done, { once: true });
    });
}

export class ScanJob
{
    /**
     * @param {object} options
     * @param {import('ethers').JsonRpcProvider} options.provider
     * @param {{hexaizedQuery: string, matches: (bytecode: string) => boolean}} options.matcher
     * @param {object} options.params  query, blockStart, blockEnd, searchCreation,
     *                                 searchRuntime, onlyNonZeroBalance, delayMs
     * @param {object} options.limits  maxMatches, rpcTimeoutMs, rpcBackoffMs (optional)
     * @param {(message: string) => void} [options.log]
     */
    constructor({ provider, matcher, params, limits, log })
    {
        this.jobId = 'scan-' + randomUUID();
        this.provider = provider;
        this.matcher = matcher;
        this.params = params;
        this.limits = limits;
        this.log = log || (() => {});

        this.state = 'running';
        this.createdAt = Date.now();
        this.startedAt = new Date(this.createdAt).toISOString();
        this.finishedAt = null;
        this.currentBlock = null;
        this.blocksScanned = 0;
        this.contractsExamined = 0;
        this.matches = [];
        this.truncated = false;
        this.error = null;
        this.warnings = [];

        this.abortController = new AbortController();
        this.done = null;
    }

    isFinished()
    {
        return this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled';
    }

    start()
    {
        this.done = this.run().catch(error =>
        {
            // run() handles its own errors; this guards against bugs in that handling.
            this.finish('failed', error);
        });
        return this;
    }

    /** Aborts at the next RPC call or sleep; matches found so far are kept. */
    cancel()
    {
        if (this.isFinished())
        {
            return;
        }
        this.state = 'cancelling';
        this.abortController.abort();
    }

    status()
    {
        return {
            jobId: this.jobId,
            state: this.state,
            query: this.params.query,
            hexaizedQuery: this.matcher.hexaizedQuery,
            blockStart: this.params.blockStart,
            blockEnd: this.params.blockEnd,
            currentBlock: this.currentBlock,
            blocksScanned: this.blocksScanned,
            contractsExamined: this.contractsExamined,
            matchCount: this.matches.length,
            truncated: this.truncated,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            error: this.error,
            warnings: this.warnings
        };
    }

    summary()
    {
        return {
            jobId: this.jobId,
            state: this.state,
            blockStart: this.params.blockStart,
            blockEnd: this.params.blockEnd,
            currentBlock: this.currentBlock,
            matchCount: this.matches.length,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt
        };
    }

    warn(message)
    {
        if (this.warnings.length < MAX_WARNINGS)
        {
            this.warnings.push(message);
        }
    }

    finish(state, error)
    {
        this.state = state;
        this.finishedAt = new Date().toISOString();
        if (error)
        {
            this.error = error.message || String(error);
            this.log(`${this.jobId} failed: ${this.error}`);
        }
    }

    async rpc(label, call)
    {
        let lastError;
        for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt++)
        {
            if (this.abortController.signal.aborted)
            {
                throw new Error('cancelled');
            }
            try
            {
                return await withTimeout(call(), this.limits.rpcTimeoutMs, label);
            }
            catch (error)
            {
                lastError = error;
                if (attempt < RPC_ATTEMPTS)
                {
                    const backoffMs = this.limits.rpcBackoffMs ?? RPC_BACKOFF_MS;
                    await sleep(backoffMs * 2 ** (attempt - 1), this.abortController.signal);
                }
            }
        }
        throw new Error(`${label} failed after ${RPC_ATTEMPTS} attempts: ${lastError.message}`);
    }

    async run()
    {
        const { blockStart, blockEnd, delayMs, searchCreation, searchRuntime, onlyNonZeroBalance } = this.params;
        const signal = this.abortController.signal;

        try
        {
            for (let blockNumber = blockStart; blockNumber <= blockEnd; blockNumber++)
            {
                if (signal.aborted)
                {
                    this.finish('cancelled');
                    return;
                }
                await sleep(delayMs, signal);
                if (signal.aborted)
                {
                    this.finish('cancelled');
                    return;
                }

                const block = await this.rpc(`getBlock(${blockNumber})`,
                    () => this.provider.getBlock(blockNumber, true));
                this.currentBlock = blockNumber;

                if (!block)
                {
                    this.warn(`block ${blockNumber}: invalid block`);
                    this.blocksScanned++;
                    continue;
                }

                for (const transaction of block.prefetchedTransactions)
                {
                    if (transaction.to !== null && transaction.to !== undefined)
                    {
                        continue;
                    }
                    this.contractsExamined++;

                    const receipt = await this.rpc(`getTransactionReceipt(${transaction.hash})`,
                        () => this.provider.getTransactionReceipt(transaction.hash));
                    const contractAddress = receipt.contractAddress;
                    const contractBalance = await this.rpc(`getBalance(${contractAddress})`,
                        () => this.provider.getBalance(contractAddress));
                    const contractBytecode = await this.rpc(`getCode(${contractAddress})`,
                        () => this.provider.getCode(contractAddress));

                    if (onlyNonZeroBalance && contractBalance === 0n)
                    {
                        continue;
                    }

                    const transactionData = transaction.data;
                    let matched = false;
                    if (searchCreation)
                    {
                        if (isHexEmpty(transactionData))
                        {
                            this.warn(`block ${blockNumber}: cannot retrieve transaction data from provider, consider searching runtime`);
                        }
                        matched = this.matcher.matches(transactionData);
                    }
                    if (searchRuntime)
                    {
                        if (isHexEmpty(contractBytecode))
                        {
                            this.warn(`block ${blockNumber}: cannot retrieve contract bytecode from provider, consider searching creation`);
                        }
                        matched = this.matcher.matches(contractBytecode) || matched;
                    }
                    if (!matched)
                    {
                        continue;
                    }

                    this.matches.push({
                        blockNumber: receipt.blockNumber,
                        transactionHash: transaction.hash,
                        contractAddress,
                        ownerAddress: receipt.from,
                        transactionNonce: transaction.nonce,
                        transactionValue: transaction.value.toString(),
                        contractBalance: contractBalance.toString(),
                        transactionData,
                        contractBytecode
                    });

                    if (this.matches.length >= this.limits.maxMatches)
                    {
                        this.truncated = true;
                        this.warn(`match cap of ${this.limits.maxMatches} reached at block ${blockNumber}; scan stopped early`);
                        this.blocksScanned++;
                        this.finish('completed');
                        return;
                    }
                }
                this.blocksScanned++;
            }
            this.finish('completed');
        }
        catch (error)
        {
            if (signal.aborted)
            {
                this.finish('cancelled');
            }
            else
            {
                this.finish('failed', error);
            }
        }
    }
}
