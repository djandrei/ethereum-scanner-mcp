import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server.js';
import { JobStore } from '../src/job-store.js';
import { loadConfig } from '../src/config.js';
import { template, templateScenario } from './stub-provider.js';

const EXPECTED_TOOLS = [
    'cancel_scan', 'get_network_status', 'get_scan_results', 'get_scan_status',
    'hex_signature', 'hexaize_query', 'list_scans', 'match_bytecode', 'start_scan'
];

async function connect(overrides = {})
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

async function waitFor(client, jobId)
{
    for (let i = 0; i < 100; i++)
    {
        const { structuredContent } = await client.callTool({ name: 'get_scan_status', arguments: { jobId } });
        if (['completed', 'failed', 'cancelled'].includes(structuredContent.state))
        {
            return structuredContent;
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
        assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `${tool.name} has annotations`);
    }
});

test('hex_signature mirrors the hex utility', async () =>
{
    const { client } = await connect();
    const result = await client.callTool({ name: 'hex_signature', arguments: { input: 'transferFrom(address,address,uint256)' } });
    assert.deepEqual(result.structuredContent, {
        input: 'transferFrom(address,address,uint256)',
        hash: '0x23b872dd7302113369cda2901243429419bec145408fa8b352b3dd92b66c680b',
        selector: '0x23b872dd'
    });
    const selectorOnly = await client.callTool({ name: 'hex_signature', arguments: { input: 'transferFrom(address,address,uint256)', selectorOnly: true } });
    assert.equal(selectorOnly.content[0].text, '0x23b872dd');
});

test('hexaize_query returns errors as tool errors, not protocol errors', async () =>
{
    const { client } = await connect();
    const bad = await client.callTool({ name: 'hexaize_query', arguments: { query: '<<a()>> && 1' } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /invalid query: unexpected character '1' at position 11/);

    const good = await client.callTool({ name: 'hexaize_query', arguments: { query: '<<transfer(address,uint256)>>' } });
    assert.equal(good.structuredContent.hexaizedQuery, '<a9059cbb>');
});

test('match_bytecode works from an argument or an address', async () =>
{
    const { client } = await connect();
    const fromArg = await client.callTool({ name: 'match_bytecode', arguments: { query: '<<0x549262ba>>', bytecode: template[0].contractBytecode } });
    assert.equal(fromArg.structuredContent.match, true);
    assert.equal(fromArg.structuredContent.source, 'argument');

    const fromRpc = await client.callTool({ name: 'match_bytecode', arguments: { query: '<<0x549262ba>>', address: template[1].contractAddress } });
    assert.equal(fromRpc.structuredContent.match, true);
    assert.equal(fromRpc.structuredContent.source, 'rpc');

    const neither = await client.callTool({ name: 'match_bytecode', arguments: { query: '<<0x549262ba>>' } });
    assert.equal(neither.isError, true);
    const badAddress = await client.callTool({ name: 'match_bytecode', arguments: { query: '<<0x549262ba>>', address: '0x123' } });
    assert.equal(badAddress.isError, true);
});

test('get_network_status masks the endpoint URL', async () =>
{
    const { client } = await connect();
    const { structuredContent } = await client.callTool({ name: 'get_network_status', arguments: {} });
    assert.deepEqual(structuredContent, {
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
    const started = await client.callTool({ name: 'start_scan', arguments: { query: '<<0x549262ba>>', blockStart: 1, blockEnd: 3 } });
    assert.equal(started.isError, undefined);
    const { jobId } = started.structuredContent;
    assert.match(jobId, /^scan-/);

    const status = await waitFor(client, jobId);
    assert.equal(status.state, 'completed');
    assert.equal(status.matchCount, 2);
    assert.equal(status.blocksScanned, 3);

    const results = await client.callTool({ name: 'get_scan_results', arguments: { jobId } });
    assert.equal(results.structuredContent.total, 2);
    assert.equal(results.structuredContent.matches.length, 2);
    assert.equal('contractBytecode' in results.structuredContent.matches[0], false);
    assert.equal('transactionData' in results.structuredContent.matches[0], false);

    const page = await client.callTool({ name: 'get_scan_results', arguments: { jobId, offset: 1, limit: 1, includeBytecode: true } });
    assert.equal(page.structuredContent.matches.length, 1);
    assert.equal(page.structuredContent.matches[0].contractBytecode, template[1].contractBytecode);

    const list = await client.callTool({ name: 'list_scans', arguments: {} });
    assert.equal(list.structuredContent.jobs.length, 1);
    assert.equal(list.structuredContent.jobs[0].jobId, jobId);

    const unknown = await client.callTool({ name: 'get_scan_status', arguments: { jobId: 'scan-nope' } });
    assert.equal(unknown.isError, true);
});

test('start_scan defaults blockEnd to the network head and applies CLI flag defaults', async () =>
{
    const { client, jobStore } = await connect({ SCANNER_MAX_BLOCKS_PER_SCAN: '200' });
    const started = await client.callTool({ name: 'start_scan', arguments: { query: '<<0x549262ba>>', blockStart: 95 } });
    assert.equal(started.structuredContent.blockEnd, 100);
    const job = jobStore.get(started.structuredContent.jobId);
    assert.equal(job.params.searchRuntime, true);
    assert.equal(job.params.searchCreation, false);
    assert.equal(job.params.delayMs, 0);
    await job.done;
});

test('start_scan rejects bad ranges, over-long ranges and concurrency overflow', async () =>
{
    const { client } = await connect();
    const reversed = await client.callTool({ name: 'start_scan', arguments: { query: '<<0x549262ba>>', blockStart: 5, blockEnd: 1 } });
    assert.equal(reversed.isError, true);
    assert.match(reversed.content[0].text, /block start 5 cannot be greater than block end 1/);

    const tooLong = await client.callTool({ name: 'start_scan', arguments: { query: '<<0x549262ba>>', blockStart: 1, blockEnd: 11 } });
    assert.equal(tooLong.isError, true);
    assert.match(tooLong.content[0].text, /range of 11 blocks exceeds the limit of 10/);

    const invalid = await client.callTool({ name: 'start_scan', arguments: { query: 'nope', blockStart: 1, blockEnd: 2 } });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /invalid query/);

    const first = await client.callTool({ name: 'start_scan', arguments: { query: '<<0x549262ba>>', blockStart: 1, blockEnd: 3, delayMs: 1000 } });
    const second = await client.callTool({ name: 'start_scan', arguments: { query: '<<0x549262ba>>', blockStart: 1, blockEnd: 3 } });
    assert.equal(second.isError, true);
    assert.match(second.content[0].text, /concurrency limit of 1/);

    const cancelled = await client.callTool({ name: 'cancel_scan', arguments: { jobId: first.structuredContent.jobId } });
    assert.ok(['cancelling', 'cancelled'].includes(cancelled.structuredContent.state));
    const final = await waitFor(client, first.structuredContent.jobId);
    assert.equal(final.state, 'cancelled');
});

test('finished jobs are evicted beyond the retention limit', async () =>
{
    const { client, jobStore } = await connect({ SCANNER_MAX_FINISHED_JOBS: '1' });
    const ids = [];
    for (let i = 0; i < 3; i++)
    {
        const started = await client.callTool({ name: 'start_scan', arguments: { query: '<<0x549262ba>>', blockStart: 3, blockEnd: 3 } });
        ids.push(started.structuredContent.jobId);
        await waitFor(client, ids[i]);
    }
    jobStore.evictFinished();
    assert.deepEqual(jobStore.list().map(job => job.jobId), [ids[2]]);
});

test('list_scans orders jobs started in the same millisecond by start order', async () =>
{
    const { client, jobStore } = await connect({ SCANNER_MAX_CONCURRENT_SCANS: '5' });
    const ids = [];
    for (let i = 0; i < 3; i++)
    {
        const started = await client.callTool({ name: 'start_scan', arguments: { query: '<<0x549262ba>>', blockStart: 3, blockEnd: 3 } });
        ids.push(started.structuredContent.jobId);
        jobStore.get(ids[i]).createdAt = 0;
    }
    const list = await client.callTool({ name: 'list_scans', arguments: {} });
    assert.deepEqual(list.structuredContent.jobs.map(job => job.jobId), [ids[2], ids[1], ids[0]]);
    await Promise.all(ids.map(id => jobStore.get(id).done));
});
