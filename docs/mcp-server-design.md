# Ethereum Scanner MCP Server — Design

Status: implemented (v0.1.0)
Date: 2026-10-08
Target project: `evmap` (sibling repository, directory `evm-scanner`)
This repository: `ethereum-scanner-mcp`

## 1. Purpose

Expose the capabilities of the `evmap` CLI to MCP clients
(Claude Code, Claude Desktop, any Model Context Protocol host) so that an LLM
can discover smart contracts on an Ethereum network by querying creation data
and runtime bytecode, without shelling out to the CLI and without parsing
console output.

The server is a thin adapter. It owns no scanning logic of its own beyond the
block-iteration loop; query parsing and bytecode matching are delegated to the
scanner's `utils/search-utils.js` so that MCP results and CLI results agree.

## 2. Background: what the scanner does

The CLI (`./evmap`) iterates a block range on a JSON-RPC endpoint, finds
contract-creation transactions (`tx.to == null`), fetches the receipt,
balance and runtime code, and evaluates a boolean query against the creation
data and/or runtime bytecode. The query language wraps tokens in `<< >>`:

| Token | Meaning |
|---|---|
| `<<transfer(address,uint256)>>` | Solidity signature, hashed to its 4-byte selector |
| `<<0x21[0-9]{4}3131>>` | Raw hex, treated as a case-insensitive regular expression |
| `! <<...>>` | NOT |
| `&&`, `\|\|`, `( )` | AND, OR, grouping |

`SearchUtils.hexaizeQuery()` rewrites `<< >>` into `< >` tokens holding bare
hex; `SearchUtils.evaluateQuery()` substitutes `0`/`1` per token and hands the
remaining arithmetic expression to `mathjs` `eval()`.

A second CLI, `./evmap-hex`, returns the keccak256 hash or 4-byte selector of a
signature.

Match records written by the CLI (`--output-file`) have this shape and the
MCP server reuses it unchanged:

```json
{
  "blockNumber": 7264284,
  "transactionHash": "0x...",
  "contractAddress": "0x...",
  "ownerAddress": "0x...",
  "transactionNonce": 0,
  "transactionValue": "0",
  "contractBalance": "0",
  "transactionData": "0x...",
  "contractBytecode": "0x..."
}
```

## 3. Goals and non-goals

### Goals

- Every read-only capability of `evmap` and `evmap-hex` is reachable through an MCP tool.
- Scans that take minutes or hours run as background jobs; no tool call blocks longer than one RPC round trip.
- Query semantics are identical to the CLI (same `search-utils.js` code path).
- Output stays small enough for an LLM context: bytecode is excluded unless asked for.
- Zero changes to the `evmap` repository are required for v1.

### Non-goals (v1)

- `--on-match` shell commands and `--action-script` modules. These execute arbitrary code on the host; exposing them to an LLM client is a security decision outside this design. See §9.
- Writing scan results to caller-specified files. Results are returned through tools; persistence is listed under future work.
- Signer / deployment helpers in `contract-utils.js`. The scanner itself does not use them.
- Multi-network routing. One server process targets one RPC endpoint.
- OAuth. The HTTP transport (§6.1) uses a static bearer token; OAuth 2.1 resource-server support is future work.

## 4. Integration strategy

Three options were considered.

| Option | How | Pros | Cons |
|---|---|---|---|
| A. Subprocess wrapper | Spawn `./evmap --output-file <tmp> --status`, parse stdout for progress, read the JSON file for matches | No duplication; scanner untouched | `process.exit()` on validation errors exits with code 0, so failure must be detected by text; progress parsed from console lines; one extra `getTransaction` RPC call per transaction in the block; cannot cancel cleanly mid-block |
| B. In-process, reuse the query engine, own the loop (**recommended**) | `require` the scanner's `utils/search-utils.js`; implement the block loop in the server with its own provider | Structured progress, cancellation, errors; identical query semantics; stdout stays clean for stdio transport | ~80 lines of loop logic mirror `evmap`'s `main()` and must be kept in step |
| C. Refactor the scanner into a library | Extract `scanBlocks(params, callbacks)` into the scanner repo; CLI and MCP both call it | Single source of truth for the loop | Requires changes in the other repository; out of scope for v1 |

**Decision: option B for v1, with option C as the strategic follow-up.**
The scanner's `main()` is inseparable from console printing and
`process.exit()`, both fatal for a stdio MCP server (anything written to
stdout corrupts the protocol stream). Reusing only `search-utils.js`, which is
pure (string in, boolean out) and has no console side effects, keeps the
query language single-sourced while giving the server a loop it can observe
and stop.

The loop deviates from the CLI in one deliberate way: it fetches each block
with its transactions prefetched (`getBlock(n, true)`), which is one RPC call
per block instead of one per transaction. Contract-creation detection,
receipt, balance and code fetches are unchanged.

### Dependency on the scanner

`package.json` declares the scanner as a local dependency:

```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.32.1",
  "ethers": "^6.17.0",
  "zod": "<version in the SDK's peer range>",
  "evmap": "file:../evm-scanner"
}
```

`search-utils.js` is loaded by deep path
(`evmap/utils/search-utils.js`). The scanner package has
no `exports` field, so deep imports are permitted. Its own pinned
dependencies (`ethers` 4.0.23, `mathjs` 5.4.2) resolve from its own
`node_modules`; they do not conflict with the server's `ethers` v6 because
`search-utils.js` only needs `ethers.utils.id` from v4 and never touches a
provider.

The `file:` dependency can be swapped for a git URL once the scanner is
tagged. Either way `npm install` must have been run inside the scanner
directory first (or the git install will do it).

## 5. Architecture

```
MCP client (Claude Code / Desktop)
        │  JSON-RPC over stdio
        ▼
┌──────────────────────────────────────────────────────┐
│ ethereum-scanner-mcp                                 │
│                                                      │
│  src/index.ts      parse config, pick transport      │
│  src/http.ts       Streamable HTTP + bearer auth,    │
│                    one McpServer per session         │
│  src/server.ts     register tools                    │
│  src/config.ts     env → Config (validated)          │
│  src/rpc.ts        ethers v6 JsonRpcProvider,        │
│                    network status, ScanProvider type │
│  src/query.ts      validate + hexaize + match        │
│                    (wraps scanner SearchUtils)       │
│  src/scan-job.ts   one job: loop, progress, cancel   │
│  src/job-store.ts  in-memory registry, limits        │
└──────────────┬───────────────────────────────────────┘
               │ require('evmap/utils/search-utils.js')
               ▼
   evmap (unchanged)
               │
               ▼
   Ethereum JSON-RPC endpoint (ETH_RPC_URL)
```

Language: TypeScript (strict), compiled by `tsc` to ES modules in `dist/`.
`search-utils.js` is CommonJS and untyped; `query.ts` loads it through
`createRequire` and casts it to a small local interface covering the four
members the server uses. The scan loop depends on a `ScanProvider`
interface (the six provider methods it calls) rather than on ethers'
`JsonRpcProvider` class, so tests substitute a stub without mocking
ethers.

Logging goes to `stderr` only. Nothing in the server may write to `stdout`.

## 6. Transport and configuration

Transport: `StdioServerTransport` by default. When `MCP_HTTP_PORT` is set
the server instead listens with the SDK's `StreamableHTTPServerTransport`
behind static bearer-token authentication (§6.1). Only one mode runs per
process.

Configuration is read from environment variables at startup. Tools cannot
override the RPC endpoint; see §9.

| Variable | Default | Meaning |
|---|---|---|
| `ETH_RPC_URL` | `http://localhost:8545` | JSON-RPC endpoint. Mirrors `--url`; the `--client`/`--port` form is expressed as a URL. |
| `SCANNER_DEFAULT_DELAY_MS` | `1000` | Pause between blocks when a scan does not specify one. Mirrors `--delay`. |
| `SCANNER_MAX_BLOCKS_PER_SCAN` | `1000` | Upper bound on `blockEnd - blockStart + 1`. |
| `SCANNER_MAX_CONCURRENT_SCANS` | `2` | Running jobs allowed at once. |
| `SCANNER_MAX_FINISHED_JOBS` | `20` | Finished jobs retained in memory before the oldest is evicted. |
| `SCANNER_MAX_MATCHES_PER_SCAN` | `1000` | A scan stops with state `completed` and `truncated: true` when reached. |
| `SCANNER_RPC_TIMEOUT_MS` | `30000` | Per-call timeout. ethers v6 queues requests indefinitely while it retries network detection, so every call is raced against this. |
| `MCP_HTTP_PORT` | unset | Enables HTTP mode when set. `0` binds an ephemeral port. |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address in HTTP mode. |
| `MCP_AUTH_TOKEN` | required in HTTP mode | Static bearer token, at least 32 characters. Generate with `openssl rand -hex 32`. |
| `MCP_HTTP_ALLOWED_HOSTS` | derived | Comma-separated `Host` header values accepted (DNS rebinding protection). Defaults to the loopback forms of the bound port when `MCP_HTTP_HOST` is loopback; otherwise the check is off and a startup warning is logged. |

Example Claude Code registration (stdio):

```json
{
  "mcpServers": {
    "ethereum-scanner": {
      "command": "node",
      "args": ["/path/to/ethereum-scanner-mcp/dist/src/index.js"],
      "env": { "ETH_RPC_URL": "https://mainnet.infura.io/v3/<key>" }
    }
  }
}
```

### 6.1 HTTP mode and authentication

Why a static token: the server has one operator and one RPC key. A single
shared secret, checked on every request, is the smallest mechanism that
lets remote MCP clients (claude.ai connectors, Claude Code with
`--transport http`, another machine) reach the server. OAuth 2.1 adds
per-user identity, expiry and revocation at the cost of an identity
provider and public endpoints; the SDK's `mcpAuthRouter` and
`requireBearerAuth` make it a bounded follow-up on top of this transport.

Request handling in `src/http.ts`, in order:

1. Path must be `/mcp`; anything else is 404.
2. `Authorization: Bearer <token>` must match `MCP_AUTH_TOKEN`. The
   comparison hashes both sides with SHA-256 and uses
   `crypto.timingSafeEqual`, so neither timing nor length leaks. Failure
   is 401 with `WWW-Authenticate: Bearer realm="ethereum-scanner-mcp"`,
   logged with the remote address but never the presented token.
3. `Mcp-Session-Id` routes to an existing session, or 404 if unknown.
4. A request without a session must be a POST; a new `McpServer` and
   transport are created for it. The transport itself rejects anything
   but `initialize` with 400, in which case the half-open session is
   discarded.
5. The transport validates the `Host` header against the allowed list
   (403 on mismatch) before any JSON-RPC processing.

Sessions: one `McpServer` instance per MCP session, all sharing the job
store, provider and config. Any authenticated caller therefore sees and
can cancel any scan; the token is a single trust domain by design. A
client DELETE closes its session. Clients that disappear without DELETE
leave sessions behind (the transport has no idle timeout), so beyond
`MAX_SESSIONS` (64) the oldest session is closed to make room.

Shutdown: SIGINT and SIGTERM close every session's transport, then the
listener, including open SSE connections.

TLS is out of scope for the process: run it behind a reverse proxy that
terminates HTTPS, or keep it on loopback. Over plain HTTP the token is
visible on the wire.

Example Claude Code registration (HTTP):

```
claude mcp add --transport http ethereum-scanner http://127.0.0.1:8080/mcp \
  --header "Authorization: Bearer <token>"
```

## 7. Tool catalog

All tools return `structuredContent` (JSON) plus a short text summary in
`content`. Errors are returned as `isError: true` with a one-line message;
the server never throws across the protocol boundary.

### 7.1 `hex_signature`

Mirrors `./evmap-hex`.

Input:

| Field | Type | Required | Notes |
|---|---|---|---|
| `input` | string | yes | Solidity signature, e.g. `transfer(address,uint256)` |
| `selectorOnly` | boolean | no | Default `false`. `true` mirrors `--signature`. |

Output: `{ "input": "...", "hash": "0x...", "selector": "0x........" }`.
Both values are always returned; `selectorOnly` only changes the text summary.

### 7.2 `hexaize_query`

Validate a query and show the hexaized form the scanner will evaluate.
Intended for the LLM to check a query before starting a long scan.

Input: `{ "query": string }`.

Output:

```json
{
  "query": "<<transfer(address,uint256)>> && ! <<0x21[0-9]{4}3131>>",
  "hexaizedQuery": "<a9059cbb> && ! <21[0-9]{4}3131>",
  "tokens": [
    { "raw": "transfer(address,uint256)", "kind": "signature", "hex": "a9059cbb" },
    { "raw": "0x21[0-9]{4}3131", "kind": "hex", "hex": "21[0-9]{4}3131" }
  ]
}
```

Validation errors (see §9.1) are returned as tool errors.

### 7.3 `match_bytecode`

Evaluate a query against one piece of bytecode. Exactly one of `bytecode` or
`address` must be given. With `address`, the runtime code is fetched from the
RPC endpoint.

Input:

| Field | Type | Required |
|---|---|---|
| `query` | string | yes |
| `bytecode` | string (0x-hex) | one of |
| `address` | string (0x address) | one of |

Output: `{ "match": true, "hexaizedQuery": "...", "bytecodeLength": 1234, "source": "argument" | "rpc" }`.

### 7.4 `get_network_status`

Mirrors the "network / chain id / block#" block printed by the CLI.

Input: none.

Output: `{ "url": "<redacted>", "networkName": "homestead", "chainId": 1, "blockNumber": 20123456, "blockGasLimit": "30000000" }`.

`url` is reported with any userinfo and API key path segment masked, since
public provider URLs embed credentials.

### 7.5 `start_scan`

Starts a background scan job and returns immediately.

Input:

| Field | Type | Required | Mirrors | Notes |
|---|---|---|---|---|
| `query` | string | yes | `--query` | Validated per §9.1 |
| `blockStart` | integer ≥ 0 | yes | `--block-start` | |
| `blockEnd` | integer ≥ blockStart | no | `--block-end` | Defaults to the current network block number, resolved at start |
| `searchCreation` | boolean | no | `--search-creation` | |
| `searchRuntime` | boolean | no | `--search-runtime` | If neither flag is `true`, `searchRuntime` defaults to `true`, as in the CLI |
| `onlyNonZeroBalance` | boolean | no | `--balance` | |
| `delayMs` | integer ≥ 0 | no | `--delay` | Default `SCANNER_DEFAULT_DELAY_MS` |

Output: `{ "jobId": "scan-01J...", "state": "running", "blockStart": n, "blockEnd": m, "hexaizedQuery": "..." }`.

Rejections: invalid query; range exceeds `SCANNER_MAX_BLOCKS_PER_SCAN`;
concurrency limit reached; RPC unreachable when resolving `blockEnd`.

### 7.6 `get_scan_status`

Input: `{ "jobId": string }`.

Output:

```json
{
  "jobId": "scan-01J...",
  "state": "running",
  "blockStart": 7264275,
  "blockEnd": 7264290,
  "currentBlock": 7264283,
  "blocksScanned": 9,
  "contractsExamined": 14,
  "matchCount": 1,
  "truncated": false,
  "startedAt": "2026-10-08T20:01:02Z",
  "finishedAt": null,
  "error": null,
  "warnings": ["block 7264279: cannot retrieve contract bytecode, consider searching creation"]
}
```

`warnings` carries the two advisory messages the CLI prints inline, capped at
50 entries.

### 7.7 `get_scan_results`

Input:

| Field | Type | Required | Notes |
|---|---|---|---|
| `jobId` | string | yes | |
| `offset` | integer ≥ 0 | no | Default 0 |
| `limit` | integer 1..200 | no | Default 50 |
| `includeBytecode` | boolean | no | Default `false`. When `false`, `transactionData` and `contractBytecode` are omitted from each match. |

Output: `{ "jobId": "...", "state": "...", "total": 2, "offset": 0, "limit": 50, "matches": [ ...match records... ] }`.

Results can be read while the job is still running; `total` grows until the
job finishes. Match records use the exact field names of the CLI output file
so a client can round-trip them into the CLI's `--summary` format.

### 7.8 `cancel_scan`

Input: `{ "jobId": string }`. Sets the job's abort flag; the loop exits at
its next RPC call or inter-block sleep, so cancellation is prompt even in
the middle of a block with many contract creations. Matches found so far are
kept. Output: the same object as `get_scan_status`, with `state`
`cancelling` or `cancelled`. Cancelling a finished job is a no-op that
returns the current status.

### 7.9 `list_scans`

Input: none. Output: `{ "jobs": [ { jobId, state, blockStart, blockEnd, currentBlock, matchCount, startedAt, finishedAt } ] }`, most recent first.

### Tool annotations

All tools are annotated `readOnlyHint: true` except `start_scan` and
`cancel_scan`, which mutate server state (not chain state) and are annotated
`readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`
(start) / `true` (cancel). `openWorldHint: true` on everything that hits the
RPC endpoint.

## 8. Scan job model

### States

```
running ──► completed
   │
   ├──────► failed        (RPC error after retries, or internal error)
   │
   └──► cancelling ──► cancelled
```

A job is immutable once in `completed`, `failed` or `cancelled`.

### Loop (per job)

```
for block in blockStart..blockEnd:
    if aborted: state = cancelled; return
    sleep(delayMs)
    block = provider.getBlock(n, prefetchTxs=true)
    if block is null: warn("invalid block n"); continue
    for tx in block.prefetchedTransactions:
        if tx.to != null: continue
        receipt  = provider.getTransactionReceipt(tx.hash)
        balance  = provider.getBalance(receipt.contractAddress)
        code     = provider.getCode(receipt.contractAddress)
        if onlyNonZeroBalance and balance == 0: continue
        matched = (searchCreation and foundMatch(tx.data))
               or (searchRuntime  and foundMatch(code))
        if matched: append match record; if matches == max: truncated; finish
    currentBlock = n; blocksScanned++
state = completed
```

This is the CLI's `main()` loop with the console calls removed. The empty
data / empty bytecode advisories are kept as `warnings` entries.

### Failure handling

- A transient RPC error on a single call is retried with the CLI's policy: 5 attempts with exponential backoff of 1 s, 2 s, 4 s, 8 s capped at 16 s (ethers v6 already retries some network errors; the job adds a bounded outer retry). Each retry is logged to stderr with the call, the attempt count and the reason. After the last attempt the job moves to `failed` with the error message and keeps the matches found so far.
- The CLI fetches each transaction by hash and skips one the provider returns as `null`. The server instead fetches whole blocks with their transactions prefetched; a malformed transaction entry makes `getBlock` fail, so after the retries the job is `failed` with the block named in the error. There is no per-transaction skip on this path.
- Provider construction errors (bad URL) fail at server startup, not per job, and are reported on stderr.
- An unhandled exception in the loop is caught at the job boundary and recorded as `failed`; it never crashes the server process.

### Limits and memory

- Match records are held in memory, including bytecode (up to 24 KiB runtime + creation data each). With `SCANNER_MAX_MATCHES_PER_SCAN = 1000` and 20 retained jobs the worst case is on the order of 1 GiB; defaults should be lowered on constrained hosts. The limits exist for this reason.
- Jobs are lost when the server process exits. This is acceptable for v1 because the MCP host owns the process lifetime; persistence is future work.
- Each RPC call is retried up to 5 times with exponential backoff (1 s base, 16 s cap) and raced against `SCANNER_RPC_TIMEOUT_MS`.

### Identifiers

`jobId` is `scan-` plus a ULID or `crypto.randomUUID()`. The value is opaque
to clients.

## 9. Security

### 9.1 Query validation (trust boundary: LLM-supplied text → `mathjs` eval)

`search-utils.js` passes everything that is not a `< >` token straight into
`mathjs` `eval()`. The CLI trusts its operator; the MCP server must not trust
the model. Before a query reaches `SearchUtils`, `query.js` enforces a strict
grammar:

```
query    := term ( ('&&' | '||') term )*
term     := '!'? token | '(' query ')'
token    := '<<' body '>>'
body     := signature | hexpattern
signature:= identifier '(' [types] ')'        e.g. transfer(address,uint256)
hexpattern:= '0x' regex-over-[0-9a-fA-F] plus the metacharacters . [ ] { } ( ) | * + ? , -
```

`!` is accepted only directly before a token. `SearchUtils` resolves
`! <token>` itself but would hand `! ( ... )` to `mathjs`, where `!` is the
factorial operator.

Anything outside this grammar is rejected with a tool error naming the
offending position. Consequences:

- No bare identifiers, numbers or function calls can reach `mathjs`.
- Only `&&`, `||`, `!`, parentheses and `<< >>` tokens survive, so the expression `mathjs` sees is pure `0/1` arithmetic.

Additional limits: query length ≤ 2048 characters; ≤ 32 tokens; each hex
pattern must compile with `new RegExp()` and is rejected if it contains
nested quantifiers (`(a+)+`, `(a*)*`), the common ReDoS shape. Bytecode
inputs are bounded by the EVM (24 KiB runtime; creation data by block gas
limit), which bounds regex runtime for non-pathological patterns.

### 9.2 HTTP clients (trust boundary: network → server)

Applies only in HTTP mode. Every request is authenticated before any
parsing beyond the URL path (§6.1). Loopback binds validate the `Host`
header by default to defeat DNS rebinding from a browser on the same
machine. The token is compared in constant time and never logged. There is
no per-user identity: holders of the token are one trust domain and share
the job store.

### 9.3 RPC endpoint (trust boundary: server → network)

The endpoint comes from `ETH_RPC_URL` only. Tools do not accept a URL, so a
model cannot point the server at internal services (SSRF) or exfiltrate the
API key by changing the host. `get_network_status` masks the URL.

### 9.4 Host execution

`--on-match` and `--action-script` are intentionally not exposed. They are
equivalent to a bash tool on the host and would need host-side gating that
MCP tool annotations alone cannot provide. If needed later, the safe shape is
a server-side allowlist of named actions configured by the operator, never a
command string from the model.

### 9.5 Resource exhaustion

Concurrency, block-range and match-count limits (§6) bound CPU, memory and
RPC spend. The `delayMs` floor is 0 to match the CLI; operators on
rate-limited providers should set `SCANNER_DEFAULT_DELAY_MS` and the model
is told in the tool description that lower delays risk 429s.

### 9.6 Input validation

All tool inputs are declared as zod schemas and validated by the SDK before
handlers run. Addresses are checksummed/validated with ethers `isAddress`;
hex strings must match `^0x[0-9a-fA-F]*$`.

## 10. Project layout

```
ethereum-scanner-mcp/
├── docs/
│   └── mcp-server-design.md      this document
├── src/
│   ├── index.ts                  entry point (#!/usr/bin/env node)
│   ├── server.ts                 McpServer + tool registration
│   ├── http.ts                   Streamable HTTP transport, bearer auth, sessions
│   ├── config.ts
│   ├── rpc.ts
│   ├── query.ts
│   ├── scan-job.ts
│   └── job-store.ts
├── test/
│   ├── query.test.ts
│   ├── scan-job.test.ts
│   ├── server.test.ts            tools exercised through the SDK's in-memory transport
│   ├── http.test.ts              real listener on an ephemeral port: auth, Host check, sessions, eviction, shutdown
│   └── stub-provider.ts          fake provider built from the scanner's template-output.json
├── dist/                         tsc output (ignored by git); bin points at dist/src/index.js
├── tsconfig.json                 strict, NodeNext, rootDir ".", outDir "dist"
├── package.json                  "type": "module", "bin": { "ethereum-scanner-mcp": "dist/src/index.js" }
├── LICENSE.md
└── .gitignore
```

Build: `npm run build` (`tsc`). Test runner: `tsc && node --test` over
`dist/test`; `node --test` is built into Node, so the only development
dependencies are `typescript` and `@types/node`.

## 11. Verification plan

### Unit tests (no network)

- `query.test.ts`
  - Accepts the README examples and `template-input-signature`; hexaized output equals the CLI's (`<a9059cbb>` for `transfer(address,uint256)`).
  - Rejects: bare identifiers, numbers, `import(...)`, unbalanced `<<`, nested quantifiers, over-length queries.
  - `match_bytecode` on the two entries of the scanner's `template-output.json` returns `true` for a selector present in that bytecode (`<<0x549262ba>>`) and `false` for an absent one.
- `server.test.ts` connects an SDK `Client` to the server over `InMemoryTransport` and exercises every tool, including error paths, pagination, concurrency and eviction.
- `http.test.ts` starts the real HTTP listener on port 0 and checks: 401 without, with a wrong, or with a non-bearer credential; 404 on other paths; 403 on a foreign `Host` header with no session left behind; an explicit `MCP_HTTP_ALLOWED_HOSTS` list replacing the loopback default; a non-loopback bind accepting any `Host`; 400 for a non-initialize request without a session; 500 with no session left behind when opening a session fails; a full handshake and tool call through the SDK's `StreamableHTTPClientTransport`; two sessions sharing the job store; DELETE ending a session; oldest-session eviction at the cap; `close()` ending sessions and the listener. One test spawns the compiled entry point in HTTP mode, parses the bound port from its stderr, checks a 401 and a successful initialize, and asserts a clean exit on SIGTERM with nothing written to stdout.

Not covered, by choice: concurrent requests on one session, eviction racing an in-flight request, the SDK transport's body-size and malformed-JSON handling, and the timing property of the token comparison.
- `scan-job.test.ts` with a stub provider
  - A 3-block range where block 2 contains one creation tx yields one match with all nine fields and the CLI's field names.
  - `onlyNonZeroBalance` filters a zero-balance contract.
  - `searchCreation` only / `searchRuntime` only / both behave as in the CLI.
  - Cancel between blocks ends in `cancelled` with partial results.
  - A provider that throws moves the job to `failed` and keeps earlier matches.
  - Match cap sets `truncated: true`.

### Integration check (manual, needs an RPC endpoint)

1. Run the CLI and the MCP server against the same endpoint, same range (the README example `7264275..7264290`, `<<transfer(address,uint256)>>`, `--search-creation`).
2. Compare the CLI's `--output-file` array with `get_scan_results(includeBytecode: true)`. They must be identical as JSON, order included.

### Protocol check

`npx @modelcontextprotocol/inspector node dist/src/index.js` lists nine tools and
each tool call returns `structuredContent` matching its declared output
schema.

## 12. CLI coverage matrix

| CLI option / command | MCP equivalent |
|---|---|
| `--url`, `--client`, `--port` | `ETH_RPC_URL` (server config) |
| `--delay` | `start_scan.delayMs`, `SCANNER_DEFAULT_DELAY_MS` |
| `--block-start`, `--block-end` | `start_scan.blockStart/blockEnd` |
| `--query` | `start_scan.query` |
| `--query-file` | not needed; client passes the text |
| `--search-creation`, `--search-runtime` | `start_scan.searchCreation/searchRuntime` |
| `--balance` | `start_scan.onlyNonZeroBalance` |
| `--output-file` | `get_scan_results` |
| `--status` | `get_scan_status` |
| `--verbose` | `get_scan_results.includeBytecode` |
| `--summary` | `get_scan_results` with default `includeBytecode: false` |
| `--on-match`, `--action-script` | excluded (§9.3) |
| `evmap-hex --input [--signature]` | `hex_signature` |
| network status printout | `get_network_status` |

## 13. Future work

- **Option C** from §4: extract the loop into the scanner repository as a library module and delete `scan-job.js`'s copy.
- **Persistence**: write finished jobs to a server-configured directory (`SCANNER_OUTPUT_DIR/<jobId>.json`) in the CLI's output-file format so results survive restarts and can feed the CLI's `--summary`.
- **MCP resources**: expose `scan://jobs/{jobId}/results` as a resource for hosts that prefer resources over paginated tool calls.
- **Progress notifications**: send MCP `notifications/progress` from `start_scan` when the client supplies a `progressToken`, removing the need to poll.
- **OAuth 2.1** on the HTTP transport: publish protected-resource metadata and validate tokens from an external authorization server via the SDK's `mcpAuthRouter` / `ProxyOAuthServerProvider`, replacing the shared static token with per-user identity.
- **Named endpoints**: `ETH_RPC_URLS` map plus a `network` parameter on tools, keeping the no-arbitrary-URL rule.

## 14. Decisions on the open questions

1. `blockEnd` defaults to the network head, as in the CLI. On a node that is not fully synced the head reports 0 and `start_scan` rejects with "block start N cannot be greater than block end 0", which is the documented CLI known issue surfaced as a tool error.
2. The scanner is a `file:../evm-scanner` dependency, declared under its package name `evmap`. Both repositories are developed side by side; switch to a git URL once the scanner is tagged.
3. `SCANNER_MAX_BLOCKS_PER_SCAN` defaults to 1000, not 10000, because 10,000 mainnet blocks at a 1 s delay plus per-contract RPC calls takes several hours on a public provider. Operators with a local node raise it through the environment variable.
