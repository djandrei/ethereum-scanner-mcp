/**
 * One background scan. Mirrors the block loop in the scanner CLI's main()
 * with console output replaced by structured state, plus cancellation,
 * bounded retries and a match cap.
 */

import { randomUUID } from 'node:crypto';
import type { Matcher } from './query.js';
import { withTimeout, type ScanProvider } from './rpc.js';

const RPC_ATTEMPTS = 3;
const RPC_BACKOFF_MS = 500;
const MAX_WARNINGS = 50;

export type ScanState = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export interface ScanParams
{
    query: string;
    blockStart: number;
    blockEnd: number;
    searchCreation: boolean;
    searchRuntime: boolean;
    onlyNonZeroBalance: boolean;
    delayMs: number;
}

export interface ScanLimits
{
    maxMatches: number;
    rpcTimeoutMs: number;
    /** Base retry backoff; defaults to 500 ms. */
    rpcBackoffMs?: number;
}

/** Same shape and field names as an entry of the CLI's --output-file. */
export interface MatchRecord
{
    blockNumber: number;
    transactionHash: string;
    contractAddress: string;
    ownerAddress: string;
    transactionNonce: number;
    transactionValue: string;
    contractBalance: string;
    transactionData: string;
    contractBytecode: string;
}

export interface ScanStatus
{
    jobId: string;
    state: ScanState;
    query: string;
    hexaizedQuery: string;
    blockStart: number;
    blockEnd: number;
    currentBlock: number | null;
    blocksScanned: number;
    contractsExamined: number;
    matchCount: number;
    truncated: boolean;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
    warnings: string[];
}

export interface ScanSummary
{
    jobId: string;
    state: ScanState;
    blockStart: number;
    blockEnd: number;
    currentBlock: number | null;
    matchCount: number;
    startedAt: string;
    finishedAt: string | null;
}

export type Logger = (message: string) => void;

export interface ScanJobOptions
{
    provider: ScanProvider;
    matcher: Matcher;
    params: ScanParams;
    limits: ScanLimits;
    log?: Logger;
}

function isHexEmpty(hex: string | null | undefined): boolean
{
    return !hex || hex.replace(/^0[xX]/, '').length === 0;
}

function sleep(ms: number, signal: AbortSignal): Promise<void>
{
    if (ms <= 0 || signal.aborted)
    {
        return Promise.resolve();
    }
    return new Promise(resolve =>
    {
        const timer = setTimeout(done, ms);
        function done(): void
        {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done, { once: true });
    });
}

function errorMessage(error: unknown): string
{
    return error instanceof Error ? error.message : String(error);
}

export class ScanJob
{
    readonly jobId = 'scan-' + randomUUID();
    readonly params: ScanParams;
    readonly createdAt = Date.now();
    readonly startedAt = new Date(this.createdAt).toISOString();
    readonly matches: MatchRecord[] = [];
    readonly warnings: string[] = [];

    /** Assigned by JobStore.add(); orders jobs deterministically. */
    sequence = 0;
    state: ScanState = 'running';
    finishedAt: string | null = null;
    currentBlock: number | null = null;
    blocksScanned = 0;
    contractsExamined = 0;
    truncated = false;
    error: string | null = null;
    /** Resolves when the loop has ended in any state; set by start(). */
    done: Promise<void> | null = null;

    private readonly provider: ScanProvider;
    private readonly matcher: Matcher;
    private readonly limits: ScanLimits;
    private readonly log: Logger;
    private readonly abortController = new AbortController();

    constructor({ provider, matcher, params, limits, log }: ScanJobOptions)
    {
        this.provider = provider;
        this.matcher = matcher;
        this.params = params;
        this.limits = limits;
        this.log = log ?? (() => {});
    }

    isFinished(): boolean
    {
        return this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled';
    }

    start(): this
    {
        this.done = this.run().catch((error: unknown) =>
        {
            // run() handles its own errors; this guards against bugs in that handling.
            this.finish('failed', error);
        });
        return this;
    }

    /** Aborts at the next RPC call or sleep; matches found so far are kept. */
    cancel(): void
    {
        if (this.isFinished())
        {
            return;
        }
        this.state = 'cancelling';
        this.abortController.abort();
    }

    status(): ScanStatus
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

    summary(): ScanSummary
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

    private warn(message: string): void
    {
        if (this.warnings.length < MAX_WARNINGS)
        {
            this.warnings.push(message);
        }
    }

    private finish(state: ScanState, error?: unknown): void
    {
        this.state = state;
        this.finishedAt = new Date().toISOString();
        if (error !== undefined)
        {
            this.error = errorMessage(error);
            this.log(`${this.jobId} failed: ${this.error}`);
        }
    }

    private async rpc<T>(label: string, call: () => Promise<T>): Promise<T>
    {
        let lastError: unknown;
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
        throw new Error(`${label} failed after ${RPC_ATTEMPTS} attempts: ${errorMessage(lastError)}`);
    }

    private async run(): Promise<void>
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
                    if (!receipt || !receipt.contractAddress)
                    {
                        throw new Error(`no receipt or contract address for creation transaction ${transaction.hash}`);
                    }
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
