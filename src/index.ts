#!/usr/bin/env node

/**
 * Entry point: MCP server for nodejs-ethereum-scanner.
 * Speaks stdio by default; Streamable HTTP with bearer auth when
 * MCP_HTTP_PORT is set.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig, type Config } from './config.js';
import { createProvider, maskUrl } from './rpc.js';
import { JobStore } from './job-store.js';
import { createServer } from './server.js';
import { startHttpServer, MCP_PATH } from './http.js';

// stdout carries the MCP protocol stream in stdio mode. ethers logs
// network-detection retries with console.log, so route everything to stderr.
console.log = (...args: unknown[]) => console.error(...args);

function log(message: string): void
{
    process.stderr.write(`[ethereum-scanner-mcp] ${message}\n`);
}

async function main(): Promise<void>
{
    let config: Config;
    try
    {
        config = loadConfig();
    }
    catch (error)
    {
        log(`configuration error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }

    const provider = createProvider(config.rpcUrl);
    provider.on('error', (error: Error) => log(`provider error: ${error.message}`));

    const jobStore = new JobStore(config);
    const createSession = () => createServer({ config, provider, jobStore, log });

    if (config.http)
    {
        const http = config.http;
        if (http.allowedHosts !== null && http.allowedHosts.length === 0)
        {
            log('warning: MCP_HTTP_ALLOWED_HOSTS not set for a non-loopback bind; Host header is not validated');
        }
        const handle = await startHttpServer({ config: http, createSession, log });
        log(`ready; http://${http.host}:${handle.port}${MCP_PATH} (bearer auth); rpc ${maskUrl(config.rpcUrl)}`);

        const shutdown = (signal: string) =>
        {
            log(`${signal} received; shutting down`);
            handle.close().then(() => process.exit(0), () => process.exit(1));
        };
        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));
        return;
    }

    const server = createSession();
    await server.connect(new StdioServerTransport());
    log(`ready; stdio; rpc ${maskUrl(config.rpcUrl)}`);
}

main().catch((error: unknown) =>
{
    log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
});
