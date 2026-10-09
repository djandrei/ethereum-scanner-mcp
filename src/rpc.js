/**
 * JSON-RPC access. Wraps an ethers v6 JsonRpcProvider so that every call
 * has a timeout: ethers v6 queues requests indefinitely while it retries
 * network detection, which would otherwise hang a tool call forever.
 */

import { JsonRpcProvider } from 'ethers';

export function createProvider(url)
{
    return new JsonRpcProvider(url);
}

export function withTimeout(promise, timeoutMs, label)
{
    let timer;
    const timeout = new Promise((_, reject) =>
    {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Returns the same fields the CLI prints under "network / chain id / block#".
 */
export async function getNetworkStatus(provider, timeoutMs)
{
    const network = await withTimeout(provider.getNetwork(), timeoutMs, 'getNetwork');
    const blockNumber = await withTimeout(provider.getBlockNumber(), timeoutMs, 'getBlockNumber');
    const block = await withTimeout(provider.getBlock('latest'), timeoutMs, 'getBlock');

    return {
        networkName: network.name,
        chainId: Number(network.chainId),
        blockNumber,
        blockGasLimit: block ? block.gasLimit.toString() : null
    };
}

/**
 * Hides credentials embedded in provider URLs: userinfo, the query string,
 * and any path segment long enough to be an API key.
 */
export function maskUrl(url)
{
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').map(segment =>
        segment.length >= 16 ? '***' : segment);
    return `${parsed.protocol}//${parsed.host}${segments.join('/')}`;
}
