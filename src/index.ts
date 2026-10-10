#!/usr/bin/env node

/**
 * Entry point: stdio MCP server for nodejs-ethereum-scanner.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig, type Config } from './config.js';
import { createProvider, maskUrl } from './rpc.js';
import { JobStore } from './job-store.js';
import { createServer } from './server.js';

// stdout carries the MCP protocol stream. ethers logs network-detection
// retries with console.log, so route everything to stderr.
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
    const server = createServer({ config, provider, jobStore, log });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log(`ready; rpc ${maskUrl(config.rpcUrl)}`);
}

main().catch((error: unknown) =>
{
    log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
});
