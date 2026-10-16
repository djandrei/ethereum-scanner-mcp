/**
 * Streamable HTTP transport with static bearer-token authentication.
 *
 * Enabled only when MCP_HTTP_PORT is set. Every request must carry
 * `Authorization: Bearer <MCP_AUTH_TOKEN>`; the comparison is constant
 * time. Each MCP session gets its own McpServer instance connected to its
 * own transport, while the job store and provider are shared, so scans
 * started in one session are visible to every authenticated caller.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { loopbackAllowedHosts, type HttpConfig } from './config.js';
import type { Logger } from './scan-job.js';

export const MCP_PATH = '/mcp';
/**
 * Clients that vanish without a DELETE leave their session behind, since the
 * transport has no idle timeout. Beyond this many sessions the oldest one is
 * closed to make room.
 */
export const MAX_SESSIONS = 64;

export interface HttpServerOptions
{
    config: HttpConfig;
    /** Builds a fresh McpServer for each session; dependencies are shared by the factory. */
    createSession: () => McpServer;
    log: Logger;
}

export interface HttpServerHandle
{
    server: Server;
    /** Port actually bound; differs from config when configured as 0. */
    port: number;
    sessionCount(): number;
    close(): Promise<void>;
}

interface Session
{
    server: McpServer;
    transport: StreamableHTTPServerTransport;
}

export function tokenMatches(presented: string, expected: string): boolean
{
    // Hash both sides so the comparison length never depends on the input.
    const a = createHash('sha256').update(presented).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

function bearerToken(request: IncomingMessage): string | null
{
    const header = request.headers.authorization;
    if (!header)
    {
        return null;
    }
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match?.[1] ?? null;
}

function sendJsonError(response: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void
{
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

export function startHttpServer({ config, createSession, log }: HttpServerOptions): Promise<HttpServerHandle>
{
    const sessions = new Map<string, Session>();
    // Resolved after listen(), when the bound port is known. Sessions can only
    // be opened once the server is listening, so this is set before first use.
    let allowedHosts: string[] = [];

    async function openSession(): Promise<Session>
    {
        const server = createSession();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: allowedHosts.length > 0,
            allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
            onsessioninitialized: sessionId =>
            {
                sessions.set(sessionId, { server, transport });
                log(`session ${sessionId} opened (${sessions.size} active)`);
            },
            onsessionclosed: sessionId =>
            {
                sessions.delete(sessionId);
                log(`session ${sessionId} closed (${sessions.size} active)`);
            }
        });
        transport.onclose = () =>
        {
            const sessionId = transport.sessionId;
            if (sessionId !== undefined && sessions.get(sessionId)?.transport === transport)
            {
                sessions.delete(sessionId);
                log(`session ${sessionId} closed (${sessions.size} active)`);
            }
        };
        await server.connect(transport);
        return { server, transport };
    }

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void>
    {
        const url = new URL(request.url ?? '/', 'http://placeholder');
        if (url.pathname !== MCP_PATH)
        {
            sendJsonError(response, 404, 'not found');
            return;
        }

        const presented = bearerToken(request);
        if (presented === null || !tokenMatches(presented, config.authToken))
        {
            log(`unauthorized request from ${request.socket.remoteAddress ?? 'unknown'}`);
            sendJsonError(response, 401, 'unauthorized', { 'WWW-Authenticate': 'Bearer realm="evm-scanner-mcp"' });
            return;
        }

        const sessionHeader = request.headers['mcp-session-id'];
        const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

        if (sessionId !== undefined)
        {
            const session = sessions.get(sessionId);
            if (!session)
            {
                sendJsonError(response, 404, 'session not found');
                return;
            }
            await session.transport.handleRequest(request, response);
            return;
        }

        if (request.method !== 'POST')
        {
            sendJsonError(response, 400, 'missing mcp-session-id header');
            return;
        }
        if (sessions.size >= MAX_SESSIONS)
        {
            // Map iteration order is insertion order, so the first entry is the oldest.
            const [oldestId, oldest] = sessions.entries().next().value as [string, Session];
            sessions.delete(oldestId);
            log(`session limit of ${MAX_SESSIONS} reached; closing oldest session ${oldestId}`);
            await oldest.transport.close();
        }

        // No session yet: this must be an initialize request. The transport
        // enforces that itself and rejects anything else with 400.
        const session = await openSession();
        await session.transport.handleRequest(request, response);
        if (session.transport.sessionId === undefined)
        {
            await session.transport.close();
        }
    }

    const server = createHttpServer((request, response) =>
    {
        handle(request, response).catch((error: unknown) =>
        {
            log(`request error: ${error instanceof Error ? error.message : String(error)}`);
            if (!response.headersSent)
            {
                sendJsonError(response, 500, 'internal error');
            }
            else
            {
                response.end();
            }
        });
    });

    return new Promise((resolve, reject) =>
    {
        server.once('error', reject);
        server.listen(config.port, config.host, () =>
        {
            server.off('error', reject);
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : config.port;
            allowedHosts = config.allowedHosts ?? loopbackAllowedHosts(port);
            resolve({
                server,
                port,
                sessionCount: () => sessions.size,
                close: async () =>
                {
                    for (const session of sessions.values())
                    {
                        await session.transport.close();
                    }
                    sessions.clear();
                    await new Promise<void>((done, fail) =>
                    {
                        server.close(error => (error ? fail(error) : done()));
                        // Open SSE streams would otherwise keep the listener alive.
                        server.closeAllConnections();
                    });
                }
            });
        });
    });
}
