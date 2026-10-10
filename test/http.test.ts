import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, loopbackAllowedHosts, MIN_AUTH_TOKEN_LENGTH } from '../src/config.js';
import { startHttpServer, tokenMatches, MAX_SESSIONS } from '../src/http.js';
import { createServer } from '../src/server.js';
import { JobStore } from '../src/job-store.js';
import { templateScenario } from './stub-provider.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

const BASE_ENV = {
    ETH_RPC_URL: 'http://127.0.0.1:8545',
    SCANNER_DEFAULT_DELAY_MS: '0',
    MCP_HTTP_PORT: '0',
    MCP_AUTH_TOKEN: TOKEN
};

async function startServer(overrides: Record<string, string> = {})
{
    const config = loadConfig({ ...BASE_ENV, ...overrides });
    assert.ok(config.http);
    const provider = templateScenario();
    const jobStore = new JobStore(config);
    const handle = await startHttpServer({
        config: config.http,
        createSession: () => createServer({ config, provider, jobStore, log: () => {} }),
        log: () => {}
    });
    return { handle, jobStore, url: new URL(`http://127.0.0.1:${handle.port}/mcp`) };
}

async function connectClient(url: URL, token: string)
{
    const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
    });
    const client = new Client({ name: 'http-test', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
}

/** Terminates the session (DELETE) and closes the client, as a well-behaved client does on exit. */
async function disconnect({ client, transport }: Awaited<ReturnType<typeof connectClient>>)
{
    await transport.terminateSession();
    await client.close();
}

/** Raw request helper that allows a custom Host header, which fetch forbids. */
function rawRequest(url: URL, options: { method?: string; headers?: Record<string, string>; body?: string } = {})
{
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) =>
    {
        const request = httpRequest({
            host: url.hostname,
            port: url.port,
            path: url.pathname,
            method: options.method ?? 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                ...options.headers
            }
        }, response =>
        {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
        });
        request.on('error', reject);
        request.end(options.body ?? '{}');
    });
}

async function withServer(run: (context: Awaited<ReturnType<typeof startServer>>) => Promise<void>, overrides: Record<string, string> = {})
{
    const context = await startServer(overrides);
    try
    {
        await run(context);
    }
    finally
    {
        await context.handle.close();
    }
}

test('config: HTTP mode is off unless MCP_HTTP_PORT is set', () =>
{
    assert.equal(loadConfig({ ETH_RPC_URL: 'http://127.0.0.1:8545' }).http, null);
});

test('config: HTTP mode requires a sufficiently long token', () =>
{
    assert.throws(() => loadConfig({ MCP_HTTP_PORT: '8080' }), /MCP_AUTH_TOKEN is required/);
    assert.throws(() => loadConfig({ MCP_HTTP_PORT: '8080', MCP_AUTH_TOKEN: 'short' }), new RegExp(`at least ${MIN_AUTH_TOKEN_LENGTH}`));
    assert.throws(() => loadConfig({ MCP_HTTP_PORT: '99999', MCP_AUTH_TOKEN: TOKEN }), /MCP_HTTP_PORT/);
});

test('config: loopback binds get rebinding protection by default, others only when configured', () =>
{
    const loopback = loadConfig({ MCP_HTTP_PORT: '8080', MCP_AUTH_TOKEN: TOKEN }).http;
    assert.deepEqual(loopback, { port: 8080, host: '127.0.0.1', authToken: TOKEN, allowedHosts: null });
    assert.deepEqual(loopbackAllowedHosts(8080), ['127.0.0.1:8080', 'localhost:8080', '[::1]:8080']);

    const open = loadConfig({ MCP_HTTP_PORT: '8080', MCP_AUTH_TOKEN: TOKEN, MCP_HTTP_HOST: '0.0.0.0' }).http;
    assert.deepEqual(open?.allowedHosts, []);

    const explicit = loadConfig({
        MCP_HTTP_PORT: '8080', MCP_AUTH_TOKEN: TOKEN, MCP_HTTP_HOST: '0.0.0.0',
        MCP_HTTP_ALLOWED_HOSTS: 'scanner.example.org, scanner.example.org:8080'
    }).http;
    assert.deepEqual(explicit?.allowedHosts, ['scanner.example.org', 'scanner.example.org:8080']);
});

test('tokenMatches is exact', () =>
{
    assert.equal(tokenMatches(TOKEN, TOKEN), true);
    assert.equal(tokenMatches(TOKEN + 'x', TOKEN), false);
    assert.equal(tokenMatches('', TOKEN), false);
});

test('rejects requests without or with a wrong bearer token', async () =>
{
    await withServer(async ({ url, handle }) =>
    {
        const missing = await rawRequest(url, { headers: { Host: `127.0.0.1:${handle.port}` } });
        assert.equal(missing.status, 401);
        assert.match(String(missing.headers['www-authenticate']), /^Bearer realm=/);
        assert.match(missing.body, /unauthorized/);

        const wrong = await rawRequest(url, { headers: { Host: `127.0.0.1:${handle.port}`, Authorization: `Bearer ${TOKEN}x` } });
        assert.equal(wrong.status, 401);

        const basic = await rawRequest(url, { headers: { Host: `127.0.0.1:${handle.port}`, Authorization: 'Basic abc' } });
        assert.equal(basic.status, 401);
        assert.equal(handle.sessionCount(), 0);
    });
});

test('rejects unknown paths and rebinding Host headers', async () =>
{
    await withServer(async ({ url, handle }) =>
    {
        const other = await rawRequest(new URL('/other', url), {
            headers: { Host: `127.0.0.1:${handle.port}`, Authorization: `Bearer ${TOKEN}` }
        });
        assert.equal(other.status, 404);

        const rebinding = await rawRequest(url, {
            headers: { Host: 'evil.example.org', Authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
                protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } })
        });
        assert.equal(rebinding.status, 403);
        assert.equal(handle.sessionCount(), 0, 'a rejected initialize leaves no session behind');
    });
});

test('rejects a non-initialize request without a session and unknown session ids', async () =>
{
    await withServer(async ({ url, handle }) =>
    {
        const headers = { Host: `127.0.0.1:${handle.port}`, Authorization: `Bearer ${TOKEN}` };
        const noSession = await rawRequest(url, {
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        });
        assert.equal(noSession.status, 400, noSession.body);
        assert.equal(handle.sessionCount(), 0);

        const unknown = await rawRequest(url, { headers: { ...headers, 'mcp-session-id': 'nope' } });
        assert.equal(unknown.status, 404);

        const get = await rawRequest(url, { method: 'GET', headers });
        assert.equal(get.status, 400);
    });
});

test('an authenticated client completes the MCP handshake and calls tools', async () =>
{
    await withServer(async ({ url, handle }) =>
    {
        const connection = await connectClient(url, TOKEN);
        assert.equal(handle.sessionCount(), 1);

        const { tools } = await connection.client.listTools();
        assert.equal(tools.length, 9);

        const result = await connection.client.callTool({ name: 'hex_signature', arguments: { input: 'transfer(address,uint256)' } }) as CallToolResult;
        assert.equal((result.structuredContent as { selector: string }).selector, '0xa9059cbb');

        await connection.transport.terminateSession();
        assert.equal(handle.sessionCount(), 0, 'DELETE ends the session');
        await connection.client.close();
    });
});

test('sessions share the job store', async () =>
{
    await withServer(async ({ url, handle }) =>
    {
        const alice = await connectClient(url, TOKEN);
        const bob = await connectClient(url, TOKEN);
        assert.equal(handle.sessionCount(), 2);

        const started = await alice.client.callTool({ name: 'start_scan', arguments: { query: '<<0x549262ba>>', blockStart: 3, blockEnd: 3 } }) as CallToolResult;
        const jobId = (started.structuredContent as { jobId: string }).jobId;

        const list = await bob.client.callTool({ name: 'list_scans', arguments: {} }) as CallToolResult;
        const jobs = (list.structuredContent as { jobs: Array<{ jobId: string }> }).jobs;
        assert.deepEqual(jobs.map(job => job.jobId), [jobId]);

        await disconnect(alice);
        await disconnect(bob);
        assert.equal(handle.sessionCount(), 0);
    });
});

test('an unauthenticated client fails to connect', async () =>
{
    await withServer(async ({ url }) =>
    {
        await assert.rejects(connectClient(url, 'wrong-token-0123456789abcdef0123456789'), /401|Unauthorized/i);
    });
});

test('close() ends open sessions and stops listening', async () =>
{
    const context = await startServer();
    const { client } = await connectClient(context.url, TOKEN);
    assert.equal(context.handle.sessionCount(), 1);
    await context.handle.close();
    assert.equal(context.handle.sessionCount(), 0);
    assert.equal(context.handle.server.listening, false);
    await client.close().catch(() => {});
});


test('the oldest session is evicted when the session limit is reached', async () =>
{
    await withServer(async ({ url, handle }) =>
    {
        const first = await connectClient(url, TOKEN);
        const others = [];
        for (let i = 1; i < MAX_SESSIONS; i++)
        {
            others.push(await connectClient(url, TOKEN));
        }
        assert.equal(handle.sessionCount(), MAX_SESSIONS);

        const extra = await connectClient(url, TOKEN);
        assert.equal(handle.sessionCount(), MAX_SESSIONS);
        await assert.rejects(first.client.listTools(), /404|session/i);
        assert.equal((await extra.client.listTools()).tools.length, 9);

        await first.client.close();
        for (const connection of [...others, extra])
        {
            await disconnect(connection);
        }
    });
});
