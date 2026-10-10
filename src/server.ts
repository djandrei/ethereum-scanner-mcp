/**
 * MCP tool registration. Every handler returns structuredContent plus a
 * short text summary; failures are returned as isError results and never
 * thrown across the protocol boundary.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { id as keccakId, isAddress } from 'ethers';

import type { Config } from './config.js';
import type { JobStore } from './job-store.js';
import { hexaizeQuery, createMatcher, QueryError } from './query.js';
import { getNetworkStatus, maskUrl, withTimeout, type ScanProvider } from './rpc.js';
import { ScanJob, type Logger } from './scan-job.js';

const HEX_RE = /^0[xX][0-9a-fA-F]*$/;

const matchRecordSchema = z.object({
    blockNumber: z.number().int(),
    transactionHash: z.string(),
    contractAddress: z.string(),
    ownerAddress: z.string(),
    transactionNonce: z.number().int(),
    transactionValue: z.string(),
    contractBalance: z.string(),
    transactionData: z.string().optional(),
    contractBytecode: z.string().optional()
});

const tokenSchema = z.object({
    raw: z.string(),
    kind: z.enum(['signature', 'hex']),
    hex: z.string()
});

const scanStateSchema = z.enum(['running', 'cancelling', 'completed', 'failed', 'cancelled']);

const scanStatusShape = {
    jobId: z.string(),
    state: scanStateSchema,
    query: z.string(),
    hexaizedQuery: z.string(),
    blockStart: z.number().int(),
    blockEnd: z.number().int(),
    currentBlock: z.number().int().nullable(),
    blocksScanned: z.number().int(),
    contractsExamined: z.number().int(),
    matchCount: z.number().int(),
    truncated: z.boolean(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    error: z.string().nullable(),
    warnings: z.array(z.string())
};

const scanSummaryShape = {
    jobId: z.string(),
    state: scanStateSchema,
    blockStart: z.number().int(),
    blockEnd: z.number().int(),
    currentBlock: z.number().int().nullable(),
    matchCount: z.number().int(),
    startedAt: z.string(),
    finishedAt: z.string().nullable()
};

function ok(structuredContent: Record<string, unknown>, text: string): CallToolResult
{
    return {
        content: [{ type: 'text', text }],
        structuredContent
    };
}

function fail(message: string): CallToolResult
{
    return {
        content: [{ type: 'text', text: message }],
        isError: true
    };
}

/** Wraps a handler so that any thrown error becomes an isError result. */
function guarded<TArgs extends unknown[]>(
    handler: (...args: TArgs) => Promise<CallToolResult>
): (...args: TArgs) => Promise<CallToolResult>
{
    return async (...args) =>
    {
        try
        {
            return await handler(...args);
        }
        catch (error)
        {
            if (error instanceof QueryError)
            {
                return fail(`invalid query: ${error.message}`);
            }
            return fail(error instanceof Error ? error.message : String(error));
        }
    };
}

export interface ServerDependencies
{
    config: Config;
    provider: ScanProvider;
    jobStore: JobStore;
    log: Logger;
}

export function createServer({ config, provider, jobStore, log }: ServerDependencies): McpServer
{
    const server = new McpServer({
        name: 'ethereum-scanner',
        version: '0.1.0'
    });

    const rpcTimeoutMs = config.rpcTimeoutMs;

    server.registerTool('hex_signature', {
        title: 'Hash a function signature',
        description: 'Compute the keccak256 hash and 4-byte selector of a Solidity function signature, ' +
            "e.g. 'transfer(address,uint256)'. Mirrors the scanner's hex utility.",
        inputSchema: {
            input: z.string().min(1).describe("Function signature, e.g. 'transfer(address,uint256)'"),
            selectorOnly: z.boolean().optional().describe('Report only the 4-byte selector in the text summary')
        },
        outputSchema: {
            input: z.string(),
            hash: z.string(),
            selector: z.string()
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    }, guarded(async ({ input, selectorOnly }) =>
    {
        const hash = keccakId(input);
        const selector = hash.slice(0, 10);
        return ok({ input, hash, selector }, selectorOnly ? selector : hash);
    }));

    server.registerTool('hexaize_query', {
        title: 'Validate and hexaize a query',
        description: 'Validate a scanner query and show the hexaized form the scanner evaluates. ' +
            'Query syntax: <<signature>> or <<0xhexpattern>> tokens (hex patterns are regular expressions), ' +
            "combined with &&, ||, ! (directly before a token) and parentheses. Example: " +
            "'<<transfer(address,uint256)>> && ! <<0x21[0-9]{4}3131>>'. Call this before start_scan to check a query.",
        inputSchema: {
            query: z.string().min(1).describe('Scanner query')
        },
        outputSchema: {
            query: z.string(),
            hexaizedQuery: z.string(),
            tokens: z.array(tokenSchema)
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    }, guarded(async ({ query }) =>
    {
        const result = hexaizeQuery(query);
        return ok({ ...result }, result.hexaizedQuery);
    }));

    server.registerTool('match_bytecode', {
        title: 'Match a query against one bytecode',
        description: 'Evaluate a scanner query against a single piece of bytecode. Provide either bytecode ' +
            '(0x-prefixed hex) or address (the runtime code is fetched from the configured RPC endpoint), not both.',
        inputSchema: {
            query: z.string().min(1).describe('Scanner query'),
            bytecode: z.string().regex(HEX_RE, 'bytecode must be 0x-prefixed hex').optional(),
            address: z.string().optional().describe('Contract address whose runtime code is fetched')
        },
        outputSchema: {
            match: z.boolean(),
            hexaizedQuery: z.string(),
            bytecodeLength: z.number().int(),
            source: z.enum(['argument', 'rpc'])
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
    }, guarded(async ({ query, bytecode, address }) =>
    {
        if ((bytecode === undefined) === (address === undefined))
        {
            return fail('provide exactly one of bytecode or address');
        }
        const matcher = createMatcher(query);
        let code: string;
        let source: 'argument' | 'rpc';
        if (address !== undefined)
        {
            if (!isAddress(address))
            {
                return fail(`invalid address: ${address}`);
            }
            code = await withTimeout(provider.getCode(address), rpcTimeoutMs, 'getCode');
            source = 'rpc';
        }
        else
        {
            code = bytecode as string;
            source = 'argument';
        }
        const match = matcher.matches(code);
        const bytecodeLength = code.replace(/^0[xX]/, '').length / 2;
        return ok(
            { match, hexaizedQuery: matcher.hexaizedQuery, bytecodeLength, source },
            match ? 'match' : 'no match');
    }));

    server.registerTool('get_network_status', {
        title: 'Get network status',
        description: 'Report the network name, chain id, current block number and gas limit of the configured RPC endpoint.',
        outputSchema: {
            url: z.string(),
            networkName: z.string(),
            chainId: z.number().int(),
            blockNumber: z.number().int(),
            blockGasLimit: z.string().nullable()
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
    }, guarded(async () =>
    {
        const status = await getNetworkStatus(provider, rpcTimeoutMs);
        const result = { url: maskUrl(config.rpcUrl), ...status };
        return ok(result, `${status.networkName} (chain ${status.chainId}), block ${status.blockNumber}`);
    }));

    server.registerTool('start_scan', {
        title: 'Start a contract scan',
        description: 'Start a background scan of a block range for contract-creation transactions whose creation data ' +
            'and/or runtime bytecode match the query. Returns a jobId immediately; poll get_scan_status and read ' +
            'get_scan_results. Scans are slow: each block costs one RPC call plus three per contract created, ' +
            `with delayMs between blocks. The range is capped at ${config.maxBlocksPerScan} blocks. ` +
            'Lower delays risk rate limiting on public providers.',
        inputSchema: {
            query: z.string().min(1).describe('Scanner query; see hexaize_query for the syntax'),
            blockStart: z.number().int().min(0).describe('First block to scan'),
            blockEnd: z.number().int().min(0).optional().describe('Last block to scan (inclusive); defaults to the current network block'),
            searchCreation: z.boolean().optional().describe('Match against the creation transaction data'),
            searchRuntime: z.boolean().optional().describe('Match against the deployed runtime bytecode (default when neither flag is set)'),
            onlyNonZeroBalance: z.boolean().optional().describe('Report only contracts holding a non-zero balance'),
            delayMs: z.number().int().min(0).optional().describe(`Pause between blocks in milliseconds (default ${config.defaultDelayMs})`)
        },
        outputSchema: {
            jobId: z.string(),
            state: scanStateSchema,
            blockStart: z.number().int(),
            blockEnd: z.number().int(),
            hexaizedQuery: z.string()
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    }, guarded(async (args) =>
    {
        const matcher = createMatcher(args.query);

        if (!jobStore.canStart())
        {
            return fail(`concurrency limit of ${config.maxConcurrentScans} running scans reached; wait or cancel a scan`);
        }

        const blockEnd = args.blockEnd ??
            await withTimeout(provider.getBlockNumber(), rpcTimeoutMs, 'getBlockNumber');
        if (args.blockStart > blockEnd)
        {
            return fail(`block start ${args.blockStart} cannot be greater than block end ${blockEnd}`);
        }
        const span = blockEnd - args.blockStart + 1;
        if (span > config.maxBlocksPerScan)
        {
            return fail(`range of ${span} blocks exceeds the limit of ${config.maxBlocksPerScan}`);
        }

        const searchCreation = args.searchCreation === true;
        const searchRuntime = args.searchRuntime === true || !searchCreation;

        const job = new ScanJob({
            provider,
            matcher,
            params: {
                query: args.query,
                blockStart: args.blockStart,
                blockEnd,
                searchCreation,
                searchRuntime,
                onlyNonZeroBalance: args.onlyNonZeroBalance === true,
                delayMs: args.delayMs ?? config.defaultDelayMs
            },
            limits: { maxMatches: config.maxMatchesPerScan, rpcTimeoutMs },
            log
        });
        jobStore.add(job);
        job.start();
        log(`${job.jobId} started: blocks ${args.blockStart}..${blockEnd}, query ${matcher.hexaizedQuery}`);

        return ok({
            jobId: job.jobId,
            state: job.state,
            blockStart: args.blockStart,
            blockEnd,
            hexaizedQuery: matcher.hexaizedQuery
        }, `started ${job.jobId} for blocks ${args.blockStart}..${blockEnd}`);
    }));

    server.registerTool('get_scan_status', {
        title: 'Get scan status',
        description: 'Report progress, state, match count and warnings of a scan job.',
        inputSchema: {
            jobId: z.string().describe('Job id returned by start_scan')
        },
        outputSchema: scanStatusShape,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    }, guarded(async ({ jobId }) =>
    {
        const job = jobStore.get(jobId);
        if (!job)
        {
            return fail(`unknown job ${jobId}`);
        }
        const status = job.status();
        return ok({ ...status }, `${status.state}: block ${status.currentBlock ?? '-'} of ${status.blockEnd}, ${status.matchCount} matches`);
    }));

    server.registerTool('get_scan_results', {
        title: 'Get scan results',
        description: 'Return matched contracts of a scan job, paginated. Results can be read while the scan is running. ' +
            'Bytecode fields are omitted unless includeBytecode is true because they are large.',
        inputSchema: {
            jobId: z.string().describe('Job id returned by start_scan'),
            offset: z.number().int().min(0).optional().describe('First match to return (default 0)'),
            limit: z.number().int().min(1).max(200).optional().describe('Maximum matches to return (default 50)'),
            includeBytecode: z.boolean().optional().describe('Include transactionData and contractBytecode fields')
        },
        outputSchema: {
            jobId: z.string(),
            state: scanStateSchema,
            total: z.number().int(),
            offset: z.number().int(),
            limit: z.number().int(),
            matches: z.array(matchRecordSchema)
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    }, guarded(async ({ jobId, offset = 0, limit = 50, includeBytecode = false }) =>
    {
        const job = jobStore.get(jobId);
        if (!job)
        {
            return fail(`unknown job ${jobId}`);
        }
        const page = job.matches.slice(offset, offset + limit).map(match =>
        {
            if (includeBytecode)
            {
                return { ...match };
            }
            const { transactionData: _data, contractBytecode: _code, ...rest } = match;
            return rest;
        });
        const result = { jobId, state: job.state, total: job.matches.length, offset, limit, matches: page };
        return ok(result, `${page.length} of ${result.total} matches (${job.state})`);
    }));

    server.registerTool('cancel_scan', {
        title: 'Cancel a scan',
        description: 'Request cancellation of a running scan. The scan stops at its next RPC call; results found so far are kept.',
        inputSchema: {
            jobId: z.string().describe('Job id returned by start_scan')
        },
        outputSchema: scanStatusShape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, guarded(async ({ jobId }) =>
    {
        const job = jobStore.get(jobId);
        if (!job)
        {
            return fail(`unknown job ${jobId}`);
        }
        job.cancel();
        const status = job.status();
        return ok({ ...status }, `${jobId}: ${status.state}`);
    }));

    server.registerTool('list_scans', {
        title: 'List scans',
        description: 'List known scan jobs, most recent first.',
        outputSchema: {
            jobs: z.array(z.object(scanSummaryShape))
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    }, guarded(async () =>
    {
        const jobs = jobStore.list().map(job => job.summary());
        return ok({ jobs }, `${jobs.length} jobs`);
    }));

    return server;
}
