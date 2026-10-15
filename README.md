# ethereum-scanner-mcp

MCP server that exposes the [evmap](../nodejs-ethereum-scanner) EVM
smart contract scanner to MCP clients such as Claude Code and Claude Desktop.
See [docs/mcp-server-design.md](docs/mcp-server-design.md) for the design.

## Installation

The scanner is consumed as a local `file:` dependency, so the two
repositories must sit side by side and the scanner must have its own
dependencies installed:

```
$ (cd ../nodejs-ethereum-scanner && npm install)
$ npm install
$ npm run build
```

The server is written in TypeScript and compiled to `dist/` by `tsc`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ETH_RPC_URL` | `http://localhost:8545` | JSON-RPC endpoint |
| `SCANNER_DEFAULT_DELAY_MS` | `1000` | Pause between blocks |
| `SCANNER_MAX_BLOCKS_PER_SCAN` | `1000` | Largest block range one scan may cover |
| `SCANNER_MAX_CONCURRENT_SCANS` | `2` | Running scans allowed at once |
| `SCANNER_MAX_FINISHED_JOBS` | `20` | Finished scans kept in memory |
| `SCANNER_MAX_MATCHES_PER_SCAN` | `1000` | Matches after which a scan stops |
| `SCANNER_RPC_TIMEOUT_MS` | `30000` | Per-call RPC timeout |
| `MCP_HTTP_PORT` | unset | Switch from stdio to Streamable HTTP on this port |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address in HTTP mode |
| `MCP_AUTH_TOKEN` | required in HTTP mode | Bearer token, at least 32 characters |
| `MCP_HTTP_ALLOWED_HOSTS` | loopback forms | Accepted `Host` header values, comma-separated |

### stdio (default)

Claude Code registration (`.mcp.json` or `claude mcp add`):

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

### HTTP with bearer authentication

Setting `MCP_HTTP_PORT` makes the server listen on `/mcp` instead of
speaking stdio. Every request must carry `Authorization: Bearer <token>`
matching `MCP_AUTH_TOKEN`.

```
$ export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
$ MCP_HTTP_PORT=8080 ETH_RPC_URL=https://mainnet.infura.io/v3/<key> node dist/src/index.js
```

```
$ claude mcp add --transport http ethereum-scanner http://127.0.0.1:8080/mcp \
    --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

The server binds to loopback by default and validates the `Host` header
against the loopback forms of its port. To expose it on a network set
`MCP_HTTP_HOST` and `MCP_HTTP_ALLOWED_HOSTS`, and put a TLS-terminating
reverse proxy in front; over plain HTTP the token travels in the clear.
All token holders share one job store and can see and cancel each other's
scans.

## Tools

| Tool | Purpose |
|---|---|
| `hex_signature` | keccak256 hash and 4-byte selector of a function signature (the `evmap-hex` utility) |
| `hexaize_query` | Validate a query and show the hexaized form the scanner evaluates |
| `match_bytecode` | Evaluate a query against one bytecode, given inline or fetched by address |
| `get_network_status` | Network name, chain id, block number, gas limit |
| `start_scan` | Start a background scan of a block range; returns a job id |
| `get_scan_status` | Progress, state, match count, warnings |
| `get_scan_results` | Paginated matches; bytecode omitted unless `includeBytecode` |
| `cancel_scan` | Stop a running scan, keeping matches found so far |
| `list_scans` | Known scan jobs, most recent first |

Query syntax is the scanner's: `<<transfer(address,uint256)>>` for a
signature, `<<0x21[0-9]{4}3131>>` for a hex regular expression, combined
with `&&`, `||`, `!` and parentheses.

`--on-match` and `--action-script` are deliberately not exposed.

## Tests

```
$ npm test
```

This compiles the sources and tests, then runs the suite with Node's
built-in test runner.
