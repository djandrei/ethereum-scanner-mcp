/**
 * Server configuration, read from environment variables at startup.
 * Tools cannot override any of these values at runtime.
 */

export interface Config
{
    rpcUrl: string;
    defaultDelayMs: number;
    maxBlocksPerScan: number;
    maxConcurrentScans: number;
    maxFinishedJobs: number;
    maxMatchesPerScan: number;
    rpcTimeoutMs: number;
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
        rpcTimeoutMs: readInteger(env, 'SCANNER_RPC_TIMEOUT_MS', 1000)
    };
}
