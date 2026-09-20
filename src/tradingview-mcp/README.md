# TradingView MCP Server

An [MCP](https://modelcontextprotocol.io) server that gives an MCP client
(Claude, Cursor, etc.) **read-only market data from TradingView**: symbol
lookup, price snapshots, TradingView's own technical-analysis gauges, and
screener queries.

It runs over **stdio** and has **no dependencies** and **nothing to
authenticate** — `node src/server.js` is the whole thing. It talks to the same
public endpoints tradingview.com's web app calls.

## Setup

Add it to your MCP client's config, pointing at this file's absolute path:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/path/to/tradingview-mcp/src/server.js"]
    }
  }
}
```

Replace `/path/to/tradingview-mcp` with where this package lives — in this
repository that is `<repo>/src/tradingview-mcp`, so the full argument reads
`.../puter/src/tradingview-mcp/src/server.js`. The config file itself is
`~/Library/Application Support/Claude/claude_desktop_config.json` for Claude
Desktop (`%APPDATA%\Claude\` on Windows), or `.mcp.json` in your project for
Claude Code.

In Claude Code you can skip the file and register it directly:

```bash
claude mcp add tradingview -- node "$(pwd)/src/tradingview-mcp/src/server.js"
```

Requires Node 18 or newer (it uses the built-in `fetch`).

## Tools

| Tool | Description |
| --- | --- |
| `search_symbol` | Resolve a name or ticker ("Apple", "bitcoin") to fully qualified TradingView tickers. |
| `get_quote` | Price snapshot for up to 50 tickers: last, change, open/high/low, volume, market cap, P/E, EPS. |
| `get_technical_analysis` | TradingView's summary / moving-average / oscillator gauges for a ticker on a timeframe, plus the underlying indicator values. |
| `screen_market` | Run a screener query over a market: filter on any screener field, sort, and read back a snapshot per match. |

Every tool takes tickers in **`EXCHANGE:SYMBOL`** form (`NASDAQ:AAPL`,
`BINANCE:BTCUSDT`, `FX:EURUSD`). Start with `search_symbol` when you only have
a name.

### Markets

`get_quote`, `get_technical_analysis`, and `screen_market` take an optional
`market`, which selects the scanner TradingView queries. It defaults to
`america` (US equities); other common values are `crypto`, `forex`, `india`,
`uk`, `germany`, `japan`, `canada`, and `australia`. A ticker only resolves in
the market its exchange belongs to.

### Intervals

`get_technical_analysis` accepts `interval` (default `1d`):

| Value | Timeframe |
| --- | --- |
| `1m` | 1 minute |
| `5m` | 5 minutes |
| `15m` | 15 minutes |
| `30m` | 30 minutes |
| `1h` | 1 hour |
| `2h` | 2 hours |
| `4h` | 4 hours |
| `1d` | 1 day (default) |
| `1w` | 1 week |
| `1mo` | 1 month |

One month is `1mo`, not `1M` — the names are case-insensitive, so a
case-folding client can't turn "one minute" into "one month".

### Ratings

The three gauges are reported as both a label and the raw number TradingView
computes, using the site's own cutoffs over `[-1, 1]`:

| Value | Rating |
| --- | --- |
| `-1.0` … `-0.5` | `STRONG_SELL` |
| `-0.5` … `-0.1` | `SELL` |
| `-0.1` … `0.1` | `NEUTRAL` |
| `0.1` … `0.5` | `BUY` |
| `0.5` … `1.0` | `STRONG_BUY` |

### Screener filters

`screen_market` filters are `{ field, operation, value }` objects, ANDed
together. `operation` is one of `greater`, `egreater`, `less`, `eless`,
`equal`, `nequal`, `in_range`, `not_in_range`, `match`, or `crosses`
(`in_range` / `not_in_range` take a `[min, max]` array). For example, US large
caps up more than 3% today, most active first:

```json
{
  "market": "america",
  "filters": [
    { "field": "market_cap_basic", "operation": "greater", "value": 10000000000 },
    { "field": "change", "operation": "greater", "value": 3 }
  ],
  "sort_by": "volume",
  "limit": 20
}
```

## Limits and caveats

- **Unofficial endpoints.** TradingView publishes no data API. This server
  calls the undocumented endpoints its website uses, which can change shape,
  start rate-limiting, or disappear without notice. Failures come back as tool
  errors naming the HTTP status.
- **Delayed data.** Quotes are delayed exactly as they are on tradingview.com.
  This is not a real-time market feed.
- **Read-only.** There are no write tools, no account, and no credentials — the
  server never places an order or touches a TradingView account.
- **Not investment advice.** The gauges are mechanical indicator readings.

## Development

```bash
node src/server.js   # start the server on stdio
npm test             # vitest; run `npm install` at the repo root first
```

The suite covers the TradingView client, the tool handlers, the MCP protocol
layer, and one end-to-end test that spawns the real `src/server.js` against a
local stand-in for TradingView and drives a full MCP handshake over stdio.

`TRADINGVIEW_SCANNER_ORIGIN` and `TRADINGVIEW_SYMBOL_SEARCH_ORIGIN` override
the upstream origins, and `TRADINGVIEW_TIMEOUT_MS` the per-request timeout
(default 15000). They exist so that test can point the server at its stub;
normal use needs no configuration.

## Layout

| File | Responsibility |
| --- | --- |
| `src/server.js` | stdio entry point: JSON-RPC line framing, process wiring. |
| `src/mcp.js` | MCP protocol layer: `initialize`, `tools/list`, `tools/call`. |
| `src/tools.js` | Tool definitions, input schemas, and handlers. |
| `src/tradingview.js` | HTTP client for the TradingView scanner and symbol search. |

stdout carries protocol traffic only; diagnostics go to stderr.
