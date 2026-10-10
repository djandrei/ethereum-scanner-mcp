/**
 * JSON-RPC access. Wraps an ethers v6 JsonRpcProvider so that every call
 * has a timeout: ethers v6 queues requests indefinitely while it retries
 * network detection, which would otherwise hang a tool call forever.
 */

import { JsonRpcProvider } from 'ethers';

/** The subset of a provider the scan loop needs; ethers' JsonRpcProvider satisfies it. */
export interface RpcTransaction
{
    readonly hash: string;
    readonly to: string | null;
    readonly nonce: number;
    readonly value: bigint;
    readonly data: string;
}

export interface RpcBlock
{
    readonly gasLimit: bigint;
    readonly prefetchedTransactions: readonly RpcTransaction[];
}

export interface RpcReceipt
{
    readonly contractAddress: string | null;
    readonly from: string;
    readonly blockNumber: number;
}

export interface ScanProvider
{
    getNetwork(): Promise<{ readonly name: string; readonly chainId: bigint }>;
    getBlockNumber(): Promise<number>;
    getBlock(block: number | 'latest', prefetchTxs?: boolean): Promise<RpcBlock | null>;
    getTransactionReceipt(hash: string): Promise<RpcReceipt | null>;
    getBalance(address: string): Promise<bigint>;
    getCode(address: string): Promise<string>;
}

export interface NetworkStatus
{
    networkName: string;
    chainId: number;
    blockNumber: number;
    blockGasLimit: string | null;
}

export function createProvider(url: string): JsonRpcProvider
{
    return new JsonRpcProvider(url);
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T>
{
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) =>
    {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Returns the same fields the CLI prints under "network / chain id / block#".
 */
export async function getNetworkStatus(provider: ScanProvider, timeoutMs: number): Promise<NetworkStatus>
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
export function maskUrl(url: string): string
{
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').map(segment =>
        segment.length >= 16 ? '***' : segment);
    return `${parsed.protocol}//${parsed.host}${segments.join('/')}`;
}
