/**
 * Minimal stand-in for ethers JsonRpcProvider, built from the scanner's
 * template-output.json so the bytecode under test is real.
 */

import { createRequire } from 'node:module';
import type { RpcBlock, RpcReceipt, RpcTransaction, ScanProvider } from '../src/rpc.js';
import type { MatchRecord } from '../src/scan-job.js';

const require = createRequire(import.meta.url);
export const template = require('evmap/template-output.json') as MatchRecord[];
export const [templateA, templateB] = template as [MatchRecord, MatchRecord];

export function creationTx(record: MatchRecord, overrides: Partial<RpcTransaction> = {}): RpcTransaction
{
    return {
        hash: record.transactionHash,
        to: null,
        nonce: record.transactionNonce,
        value: BigInt(record.transactionValue),
        data: record.transactionData,
        ...overrides
    };
}

export function callTx(hash: string): RpcTransaction
{
    return { hash, to: '0x0000000000000000000000000000000000000001', nonce: 5, value: 0n, data: '0x' };
}

export interface StubOptions
{
    /** block number -> transactions; null marks an invalid block */
    blocks: Record<number, RpcTransaction[] | null>;
    receipts: Record<string, RpcReceipt>;
    balances?: Record<string, bigint>;
    codes?: Record<string, string>;
    blockNumber?: number;
}

export interface StubProvider extends ScanProvider
{
    calls: string[];
}

export function createStubProvider({ blocks, receipts, balances = {}, codes = {}, blockNumber = 100 }: StubOptions): StubProvider
{
    const calls: string[] = [];
    return {
        calls,
        async getNetwork()
        {
            calls.push('getNetwork');
            return { name: 'stub', chainId: 1337n };
        },
        async getBlockNumber()
        {
            calls.push('getBlockNumber');
            return blockNumber;
        },
        async getBlock(number: number | 'latest', prefetch?: boolean): Promise<RpcBlock | null>
        {
            calls.push(`getBlock(${number})`);
            if (number === 'latest')
            {
                return { gasLimit: 30000000n, prefetchedTransactions: [] };
            }
            const txs = blocks[number];
            if (txs === null || txs === undefined)
            {
                return null;
            }
            if (!prefetch)
            {
                throw new Error('stub only supports prefetched transactions');
            }
            return { gasLimit: 30000000n, prefetchedTransactions: txs };
        },
        async getTransactionReceipt(hash: string)
        {
            calls.push(`getTransactionReceipt(${hash})`);
            return receipts[hash] ?? null;
        },
        async getBalance(address: string)
        {
            calls.push(`getBalance(${address})`);
            return balances[address] ?? 0n;
        },
        async getCode(address: string)
        {
            calls.push(`getCode(${address})`);
            return codes[address] ?? '0x';
        }
    };
}

/** Two blocks: block 1 holds a call tx and templateA's creation, block 2 holds templateB's creation. */
export function templateScenario(): StubProvider
{
    const a = templateA;
    const b = templateB;
    return createStubProvider({
        blocks: {
            1: [callTx('0x' + 'aa'.repeat(32)), creationTx(a)],
            2: [creationTx(b)],
            3: []
        },
        receipts: {
            [a.transactionHash]: { contractAddress: a.contractAddress, from: a.ownerAddress, blockNumber: 1 },
            [b.transactionHash]: { contractAddress: b.contractAddress, from: b.ownerAddress, blockNumber: 2 }
        },
        balances: { [b.contractAddress]: 5n },
        codes: { [a.contractAddress]: a.contractBytecode, [b.contractAddress]: b.contractBytecode }
    });
}
