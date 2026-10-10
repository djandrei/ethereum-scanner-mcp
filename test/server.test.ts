import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { createServer } from '../src/server.js';
import { JobStore } from '../src/job-store.js';
import { loadConfig } from '../src/config.js';
import type { ScanStatus } from '../src/scan-job.js';
import { templateA, templateB, templateScenario } from './stub-provider.js';

const EXPECTED_TOOLS = [
    'cancel_scan', 'get_network_status', 'get_scan_results', 'get_scan_status',
    'hex_signature', 'hexaize_query', 'list_scans', 'match_bytecode', 'start_scan'
];

type Structured = Record<string, any>;

async function connect(overrides: Record<string, string> = {})
{
    const config = loadConfig({
        ETH_RPC_URL: 'https://mainnet.example.org/v3/0123456789abcdef0123456789abcdef',
        SCANNER_DEFAULT_DELAY_MS: '0',
        SCANNER_MAX_BLOCKS_PER_SCAN: '10',
        SCANNER_MAX_CONCURRENT_SCANS: '1',
        ...overrides
    });
    const provider = templateScenario();
    const jobStore = new JobStore(config);
    const server = createServer({ config, provider, jobStore, log: () => {} });
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, jobStore, provider };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {})
{
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    return { result, text, data: (result.structuredContent ?? {}) as Structured };
}

async function waitFor(client: Client, jobId: string): Promise<ScanStatus>
{
    for (let i = 0; i < 100; i++)
    {
        const { data } = await call(client, 'get_scan_status', { jobId });
        if (['completed', 'failed', 'cancelled'].includes(data.state))
        {
            return data as ScanStatus;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('job did not finish');
}

test('lists the nine tools', async () =>
{
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), EXPECTED_TOOLS);
    for (const tool of tools)
    {
        assert.ok(tool.outputSchema, `${tool.name} has an output schema`);
        assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} has annotations`);
    }
});

test('hex_signature mirrors the hex utility', async () =>
{
    const { client } = await connect();
    const { data } = await call(client, 'hex_signature', { input: 'transferFrom(address,address,uint256)' });
    assert.deepEqual(data, {
        input: 'transferFrom(address,address,uint256)',
        hash: '0x23b872dd7302113369cda2901243429419bec145408fa8b352b3dd92b66c680b',
        selector: '0x23b872dd'
    });
    const { text } = await call(client, 'hex_signature', { input: 'transferFrom(address,address,uint256)', selectorOnly: true });
    assert.equal(text, '0x23b872dd');
});

test('hexaize_query returns errors as tool errors, not protocol errors', async () =>
{
    const { client } = await connect();
    const bad = await call(client, 'hexaize_query', { query: '<<a()>> && 1' });
    assert.equal(bad.result.isError, true);
    assert.match(bad.text, /invalid query: unexpected character '1' at position 11/);

    const good = await call(client, 'hexaize_query', { query: '<<transfer(address,uint256)>>' });
    assert.equal(good.data.hexaizedQuery, '<a9059cbb>');
});

test('match_bytecode works from an argument or an address', async () =>
{
    const { client } = await connect();
    const fromArg = await call(client, 'match_bytecode', { query: '<<0x549262ba>>', bytecode: templateA.contractBytecode });
    assert.equal(fromArg.data.match, true);
    assert.equal(fromArg.data.source, 'argument');

    const fromRpc = await call(client, 'match_bytecode', { query: '<<0x549262ba>>', address: templateB.contractAddress });
    assert.equal(fromRpc.data.match, true);
    assert.equal(fromRpc.data.source, 'rpc');

    const neither = await call(client, 'match_bytecode', { query: '<<0x549262ba>>' });
    assert.equal(neither.result.isError, true);
    const badAddress = await call(client, 'match_bytecode', { query: '<<0x549262ba>>', address: '0x123' });
    assert.equal(badAddress.result.isError, true);
});

test('get_network_status masks the endpoint URL', async () =>
{
    const { client } = await connect();
    const { data } = await call(client, 'get_network_status');
    assert.deepEqual(data, {
        url: 'https://mainnet.example.org/v3/***',
        networkName: 'stub',
        chainId: 1337,
        blockNumber: 100,
        blockGasLimit: '30000000'
    });
});

test('scan lifecycle: start, status, results, list', async () =>
{
    const { client } = await connect();
    const started = await call(client, 'start_scan', { query: '<<0x549262ba>>', blockStart: 1, blockEnd: 3 });
    assert.equal(started.result.isError, undefined);
    const jobId = started.data.jobId as string;
    assert.match(jobId, /^scan-/);

    const status = await waitFor(client, jobId);
    assert.equal(status.state, 'completed');
    assert.equal(status.matchCount, 2);
    assert.equal(status.blocksScanned, 3);

    const results = await call(client, 'get_scan_results', { jobId });
    assert.equal(results.data.total, 2);
    assert.equal(results.data.matches.length, 2);
    assert.equal('contractBytecode' in results.data.matches[0], false);
    assert.equal('transactionData' in results.data.matches[0], false);

    const page = await call(client, 'get_scan_results', { jobId, offset: 1, limit: 1, includeBytecode: true });
    assert.equal(page.data.matches.length, 1);
    assert.equal(page.data.matches[0].contractBytecode, templateB.contractBytecode);

    const list = await call(client, 'list_scans');
    assert.equal(list.data.jobs.length, 1);
    assert.equal(list.data.jobs[0].jobId, jobId);

    const unknown = await call(client, 'get_scan_status', { jobId: 'scan-nope' });
    assert.equal(unknown.result.isError, true);
});

test('start_scan defaults blockEnd to the network head and applies CLI flag defaults', async () =>
{
    const { client, jobStore } = await connect({ SCANNER_MAX_BLOCKS_PER_SCAN: '200' });
    const started = await call(client, 'start_scan', { query: '<<0x549262ba>>', blockStart: 95 });
    assert.equal(started.data.blockEnd, 100);
    const job = jobStore.get(started.data.jobId);
    assert.ok(job);
    assert.equal(job.params.searchRuntime, true);
    assert.equal(job.params.searchCreation, false);
    assert.equal(job.params.delayMs, 0);
    await job.done;
});

test('start_scan rejects bad ranges, over-long ranges and concurrency overflow', async () =>
{
    const { client } = await connect();
    const reversed = await call(client, 'start_scan', { query: '<<0x549262ba>>', blockStart: 5, blockEnd: 1 });
    assert.equal(reversed.result.isError, true);
    assert.match(reversed.text, /block start 5 cannot be greater than block end 1/);

    const tooLong = await call(client, 'start_scan', { query: '<<0x549262ba>>', blockStart: 1, blockEnd: 11 });
    assert.equal(tooLong.result.isError, true);
    assert.match(tooLong.text, /range of 11 blocks exceeds the limit of 10/);

    const invalid = await call(client, 'start_scan', { query: 'nope', blockStart: 1, blockEnd: 2 });
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.text, /invalid query/);

    const first = await call(client, 'start_scan', { query: '<<0x549262ba>>', blockStart: 1, blockEnd: 3, delayMs: 1000 });
    const second = await call(client, 'start_scan', { query: '<<0x549262ba>>', blockStart: 1, blockEnd: 3 });
    assert.equal(second.result.isError, true);
    assert.match(second.text, /concurrency limit of 1/);

    const cancelled = await call(client, 'cancel_scan', { jobId: first.data.jobId });
    assert.ok(['cancelling', 'cancelled'].includes(cancelled.data.state));
    const final = await waitFor(client, first.data.jobId);
    assert.equal(final.state, 'cancelled');
});

test('finished jobs are evicted beyond the retention limit', async () =>
{
    const { client, jobStore } = await connect({ SCANNER_MAX_FINISHED_JOBS: '1' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
    {
        const started = await call(client, 'start_scan', { query: '<<0x549262ba>>', blockStart: 3, blockEnd: 3 });
        ids.push(started.data.jobId);
        await waitFor(client, started.data.jobId);
    }
    jobStore.evictFinished();
    assert.deepEqual(jobStore.list().map(job => job.jobId), [ids[2]]);
});

test('list_scans orders jobs started in the same millisecond by start order', async () =>
{
    const { client, jobStore } = await connect({ SCANNER_MAX_CONCURRENT_SCANS: '5' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
    {
        const started = await call(client, 'start_scan', { query: '<<0x549262ba>>', blockStart: 3, blockEnd: 3 });
        ids.push(started.data.jobId);
    }
    const list = await call(client, 'list_scans');
    assert.deepEqual(list.data.jobs.map((job: Structured) => job.jobId), [ids[2], ids[1], ids[0]]);
    await Promise.all(ids.map(id => jobStore.get(id)?.done));
});
