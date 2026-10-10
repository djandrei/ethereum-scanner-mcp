/**
 * Server configuration, read from environment variables at startup.
 * Tools cannot override any of these values at runtime.
 */

/** Present only when MCP_HTTP_PORT is set; otherwise the server speaks stdio. */
export interface HttpConfig
{
    port: number;
    host: string;
    /** Static bearer token every request must present. */
    authToken: string;
    /**
     * Host header values accepted. null means "loopback defaults derived from
     * the bound port" (set when binding to a loopback address without
     * MCP_HTTP_ALLOWED_HOSTS); an empty list disables the check.
     */
    allowedHosts: string[] | null;
}

export interface Config
{
    rpcUrl: string;
    defaultDelayMs: number;
    maxBlocksPerScan: number;
    maxConcurrentScans: number;
    maxFinishedJobs: number;
    maxMatchesPerScan: number;
    rpcTimeoutMs: number;
    http: HttpConfig | null;
}

export const MIN_AUTH_TOKEN_LENGTH = 32;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Host header values a loopback-bound server accepts by default. */
export function loopbackAllowedHosts(port: number): string[]
{
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

type IntegerVariable =
    | 'SCANNER_DEFAULT_DELAY_MS'
    | 'SCANNER_MAX_BLOCKS_PER_SCAN'
    | 'SCANNER_MAX_CONCURRENT_SCANS'
    | 'SCANNER_MAX_FINISHED_JOBS'
    | 'SCANNER_MAX_MATCHES_PER_SCAN'
    | 'SCANNER_RPC_TIMEOUT_MS';

const DEFAULT_RPC_URL = 'http://localhost:8545';

const INTEGER_DEFAULTS: Record<IntegerVariable, number> = {
    SCANNER_DEFAULT_DELAY_MS: 1000,
    SCANNER_MAX_BLOCKS_PER_SCAN: 1000,
    SCANNER_MAX_CONCURRENT_SCANS: 2,
    SCANNER_MAX_FINISHED_JOBS: 20,
    SCANNER_MAX_MATCHES_PER_SCAN: 1000,
    SCANNER_RPC_TIMEOUT_MS: 30000
};

type Environment = Record<string, string | undefined>;

function readInteger(env: Environment, name: IntegerVariable, min: number): number
{
    const raw = env[name];
    if (raw === undefined || raw === '')
    {
        return INTEGER_DEFAULTS[name];
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min)
    {
        throw new Error(`${name} must be an integer >= ${min}, got '${raw}'`);
    }
    return value;
}

function loadHttpConfig(env: Environment): HttpConfig | null
{
    const rawPort = env.MCP_HTTP_PORT;
    if (rawPort === undefined || rawPort === '')
    {
        return null;
    }
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
    {
        throw new Error(`MCP_HTTP_PORT must be an integer between 0 and 65535, got '${rawPort}'`);
    }

    const host = env.MCP_HTTP_HOST || '127.0.0.1';

    const authToken = env.MCP_AUTH_TOKEN;
    if (!authToken)
    {
        throw new Error('MCP_AUTH_TOKEN is required when MCP_HTTP_PORT is set');
    }
    if (authToken.length < MIN_AUTH_TOKEN_LENGTH)
    {
        throw new Error(`MCP_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters`);
    }

    let allowedHosts: string[] | null;
    const rawAllowed = env.MCP_HTTP_ALLOWED_HOSTS;
    if (rawAllowed !== undefined && rawAllowed !== '')
    {
        allowedHosts = rawAllowed.split(',').map(value => value.trim()).filter(value => value.length > 0);
    }
    else if (LOOPBACK_HOSTS.has(host))
    {
        // Loopback binds are the DNS rebinding target; protect them by default.
        // The list is derived once the port is actually bound (it may be 0 here).
        allowedHosts = null;
    }
    else
    {
        allowedHosts = [];
    }

    return { port, host, authToken, allowedHosts };
}

export function loadConfig(env: Environment = process.env): Config
{
    const rpcUrl = env.ETH_RPC_URL || DEFAULT_RPC_URL;
    let parsed: URL;
    try
    {
        parsed = new URL(rpcUrl);
    }
    catch
    {
        throw new Error(`ETH_RPC_URL is not a valid URL: '${rpcUrl}'`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    {
        throw new Error(`ETH_RPC_URL must use http or https, got '${parsed.protocol}'`);
    }

    return {
        rpcUrl,
        defaultDelayMs: readInteger(env, 'SCANNER_DEFAULT_DELAY_MS', 0),
        maxBlocksPerScan: readInteger(env, 'SCANNER_MAX_BLOCKS_PER_SCAN', 1),
        maxConcurrentScans: readInteger(env, 'SCANNER_MAX_CONCURRENT_SCANS', 1),
        maxFinishedJobs: readInteger(env, 'SCANNER_MAX_FINISHED_JOBS', 0),
        maxMatchesPerScan: readInteger(env, 'SCANNER_MAX_MATCHES_PER_SCAN', 1),
        rpcTimeoutMs: readInteger(env, 'SCANNER_RPC_TIMEOUT_MS', 1000),
        http: loadHttpConfig(env)
    };
}
