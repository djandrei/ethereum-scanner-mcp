/**
 * Minimal stand-in for ethers JsonRpcProvider, built from the scanner's
 * template-output.json so the bytecode under test is real.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const template = require('nodejs-ethereum-scanner/template-output.json');

export function creationTx(record, overrides = {})
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

export function callTx(hash)
{
    return { hash, to: '0x0000000000000000000000000000000000000001', nonce: 5, value: 0n, data: '0x' };
}

/**
 * @param {object} options
 * @param {Record<number, object[]|null>} options.blocks   block number -> transactions (null = invalid block)
 * @param {Record<string, object>} options.receipts        tx hash -> { contractAddress, from, blockNumber }
 * @param {Record<string, bigint>} [options.balances]      address -> balance
 * @param {Record<string, string>} [options.codes]         address -> runtime code
 */
export function createStubProvider({ blocks, receipts, balances = {}, codes = {}, blockNumber = 100 })
{
    const calls = [];
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
        async getBlock(number, prefetch)
        {
            calls.push(`getBlock(${number})`);
            if (number === 'latest')
            {
                return { gasLimit: 30000000n };
            }
            const txs = blocks[number];
            if (txs === null || txs === undefined)
            {
                return null;
            }
            return { number, prefetchedTransactions: prefetch ? txs : txs.map(tx => tx.hash) };
        },
        async getTransactionReceipt(hash)
        {
            calls.push(`getTransactionReceipt(${hash})`);
            return receipts[hash];
        },
        async getBalance(address)
        {
            calls.push(`getBalance(${address})`);
            return balances[address] ?? 0n;
        },
        async getCode(address)
        {
            calls.push(`getCode(${address})`);
            return codes[address] ?? '0x';
        }
    };
}

/** Two blocks: block 1 holds a call tx and template[0]'s creation, block 2 holds template[1]'s creation. */
export function templateScenario()
{
    const [a, b] = template;
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
