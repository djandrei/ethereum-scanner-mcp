import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScanJob } from '../src/scan-job.js';
import { createMatcher } from '../src/query.js';
import { template, templateScenario, createStubProvider, creationTx } from './stub-provider.js';

const CLI_FIELDS = [
    'blockNumber', 'transactionHash', 'contractAddress', 'ownerAddress', 'transactionNonce',
    'transactionValue', 'contractBalance', 'transactionData', 'contractBytecode'
];

function makeJob(provider, params, limits = {})
{
    return new ScanJob({
        provider,
        matcher: createMatcher(params.query),
        params: {
            blockStart: 1,
            blockEnd: 3,
            searchCreation: false,
            searchRuntime: true,
            onlyNonZeroBalance: false,
            delayMs: 0,
            ...params
        },
        limits: { maxMatches: 1000, rpcTimeoutMs: 1000, rpcBackoffMs: 1, ...limits }
    });
}

test('finds both template contracts with the CLI field names', async () =>
{
    const job = makeJob(templateScenario(), { query: '<<0x549262ba>>' }).start();
    await job.done;

    assert.equal(job.state, 'completed');
    assert.equal(job.blocksScanned, 3);
    assert.equal(job.contractsExamined, 2);
    assert.equal(job.matches.length, 2);
    assert.deepEqual(Object.keys(job.matches[0]), CLI_FIELDS);
    assert.deepEqual(job.matches[0], { ...template[0], blockNumber: 1 });
    assert.deepEqual(job.matches[1], { ...template[1], blockNumber: 2, contractBalance: '5' });
    assert.equal(job.truncated, false);
    assert.equal(job.error, null);
});

test('skips non-creation transactions without fetching receipts', async () =>
{
    const provider = templateScenario();
    const job = makeJob(provider, { query: '<<0x549262ba>>' }).start();
    await job.done;

    const receiptCalls = provider.calls.filter(call => call.startsWith('getTransactionReceipt'));
    assert.equal(receiptCalls.length, 2);
    assert.equal(provider.calls.filter(call => call.startsWith('getBlock(')).length, 3);
});

test('onlyNonZeroBalance filters zero-balance contracts', async () =>
{
    const job = makeJob(templateScenario(), { query: '<<0x549262ba>>', onlyNonZeroBalance: true }).start();
    await job.done;
    assert.equal(job.matches.length, 1);
    assert.equal(job.matches[0].contractAddress, template[1].contractAddress);
});

test('searchCreation and searchRuntime select the data source', async () =>
{
    // Creation data is identical to runtime code plus the constructor prefix, so
    // use a query that only the constructor prefix satisfies: 61001b61002064.
    const creationOnly = '<<0x61001b61002064>>';

    const runtime = makeJob(templateScenario(), { query: creationOnly }).start();
    await runtime.done;
    assert.equal(runtime.matches.length, 0);

    const creation = makeJob(templateScenario(), { query: creationOnly, searchCreation: true, searchRuntime: false }).start();
    await creation.done;
    assert.equal(creation.matches.length, 2);

    const both = makeJob(templateScenario(), { query: creationOnly, searchCreation: true, searchRuntime: true }).start();
    await both.done;
    assert.equal(both.matches.length, 2);
});

test('warns on invalid blocks and empty bytecode', async () =>
{
    const [a] = template;
    const provider = createStubProvider({
        blocks: { 1: null, 2: [creationTx(a)] },
        receipts: { [a.transactionHash]: { contractAddress: a.contractAddress, from: a.ownerAddress, blockNumber: 2 } },
        codes: {}
    });
    const job = makeJob(provider, { query: '<<0x549262ba>>', blockEnd: 2 }).start();
    await job.done;

    assert.equal(job.state, 'completed');
    assert.equal(job.matches.length, 0);
    assert.deepEqual(job.warnings, [
        'block 1: invalid block',
        'block 2: cannot retrieve contract bytecode from provider, consider searching creation'
    ]);
});

test('cancel stops at the next RPC call and keeps partial results', async () =>
{
    const provider = templateScenario();
    const job = makeJob(provider, { query: '<<0x549262ba>>', delayMs: 50 });
    const original = provider.getBlock.bind(provider);
    provider.getBlock = async (number, prefetch) =>
    {
        if (number === 2)
        {
            job.cancel();
        }
        return original(number, prefetch);
    };
    job.start();
    await job.done;

    assert.equal(job.state, 'cancelled');
    assert.equal(job.matches.length, 1);
    assert.equal(job.currentBlock, 2);
    assert.equal(provider.calls.filter(call => call.includes(template[1].transactionHash)).length, 0);
    assert.ok(job.finishedAt);
});

test('cancel during the inter-block delay returns promptly', async () =>
{
    const job = makeJob(templateScenario(), { query: '<<0x549262ba>>', delayMs: 60000 }).start();
    await new Promise(resolve => setTimeout(resolve, 10));
    job.cancel();
    await job.done;
    assert.equal(job.state, 'cancelled');
    assert.equal(job.matches.length, 0);
});

test('cancel on a finished job is a no-op', async () =>
{
    const job = makeJob(templateScenario(), { query: '<<0x549262ba>>' }).start();
    await job.done;
    job.cancel();
    assert.equal(job.state, 'completed');
});

test('RPC failure after retries moves the job to failed and keeps earlier matches', async () =>
{
    const provider = templateScenario();
    const original = provider.getBlock.bind(provider);
    provider.getBlock = async (number, prefetch) =>
    {
        if (number === 2)
        {
            throw new Error('boom');
        }
        return original(number, prefetch);
    };
    const job = makeJob(provider, { query: '<<0x549262ba>>' }).start();
    await job.done;

    assert.equal(job.state, 'failed');
    assert.match(job.error, /getBlock\(2\) failed after 3 attempts: boom/);
    assert.equal(job.matches.length, 1);
    assert.equal(provider.calls.filter(call => call === 'getBlock(2)').length, 0);
});

test('a hanging RPC call times out instead of blocking forever', async () =>
{
    const provider = templateScenario();
    provider.getBlock = () => new Promise(() => {});
    const job = makeJob(provider, { query: '<<0x549262ba>>' }, { rpcTimeoutMs: 20 }).start();
    await job.done;
    assert.equal(job.state, 'failed');
    assert.match(job.error, /timed out after 20 ms/);
});

test('match cap sets truncated and completes early', async () =>
{
    const job = makeJob(templateScenario(), { query: '<<0x549262ba>>' }, { maxMatches: 1 }).start();
    await job.done;

    assert.equal(job.state, 'completed');
    assert.equal(job.truncated, true);
    assert.equal(job.matches.length, 1);
    assert.equal(job.blocksScanned, 1);
    assert.match(job.warnings[0], /match cap of 1 reached/);
});
