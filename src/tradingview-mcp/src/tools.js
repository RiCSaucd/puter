// MCP tool definitions + handlers.
//
// Each entry has a JSON-Schema `inputSchema` (advertised via tools/list) and a
// `handler(client, args)` receiving the TradingView client from tradingview.js;
// the MCP layer wraps whatever a handler returns into a text content block.

import { INTERVALS, intervalSuffix, normalizeMarket, ratingLabel } from './tradingview.js';

const MAX_TICKERS = 50;
const MAX_SCREEN_ROWS = 100;

const MARKET_NOTE =
    'TradingView scanner market, e.g. "america" (US equities), "crypto", "forex", "india", ' +
    '"uk", "germany", "japan", "canada", "australia". Defaults to "america".';

const TICKER_NOTE =
    'Fully qualified TradingView ticker in EXCHANGE:SYMBOL form, e.g. "NASDAQ:AAPL", ' +
    '"BINANCE:BTCUSDT", "FX:EURUSD". Use search_symbol first if you only have a name.';

// Quote/screener columns. TradingView returns `null` for columns a given
// instrument does not have (a crypto pair has no P/E), which is expected.
const QUOTE_COLUMNS = [
    'name',
    'description',
    'type',
    'exchange',
    'currency',
    'close',
    'change',
    'change_abs',
    'open',
    'high',
    'low',
    'volume',
    'market_cap_basic',
    'price_earnings_ttm',
    'earnings_per_share_basic_ttm',
    'sector',
];

// The three gauges TradingView shows above its technical-analysis widget.
const RECOMMENDATION_COLUMNS = {
    summary: 'Recommend.All',
    moving_averages: 'Recommend.MA',
    oscillators: 'Recommend.Other',
};

const INDICATOR_COLUMNS = [
    'close',
    'change',
    'volume',
    'RSI',
    'Stoch.K',
    'Stoch.D',
    'CCI20',
    'ADX',
    'AO',
    'Mom',
    'MACD.macd',
    'MACD.signal',
    'BB.upper',
    'BB.lower',
    'EMA10',
    'SMA10',
    'EMA20',
    'SMA20',
    'EMA50',
    'SMA50',
    'EMA100',
    'SMA100',
    'EMA200',
    'SMA200',
];

const SCREENER_OPERATIONS = [
    'greater',
    'egreater',
    'less',
    'eless',
    'equal',
    'nequal',
    'in_range',
    'not_in_range',
    'match',
    'crosses',
];

function clamp(value, fallback, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.trunc(n), 1), max);
}

function requireTicker(ticker) {
    const value = String(ticker ?? '').trim();
    if (!value) throw new Error('A `ticker` is required, e.g. "NASDAQ:AAPL".');
    return value.toUpperCase();
}

function toScreenerFilter(filters) {
    if (!Array.isArray(filters) || filters.length === 0) return undefined;
    return filters.map(({ field, operation, value }) => {
        if (!field) throw new Error('Each filter needs a `field`, e.g. "market_cap_basic".');
        if (!SCREENER_OPERATIONS.includes(operation)) {
            throw new Error(
                `Unknown filter operation "${operation}". Expected one of: ${SCREENER_OPERATIONS.join(', ')}`,
            );
        }
        return { left: field, operation, right: value };
    });
}

export const TOOLS = [
    {
        name: 'search_symbol',
        description:
            'Resolve a company name, ticker, or free-text query to fully qualified TradingView ' +
            'tickers (EXCHANGE:SYMBOL). Call this FIRST whenever you only have a name ("Apple", ' +
            '"bitcoin"), because every other tool in this server needs the EXCHANGE:SYMBOL form. ' +
            'Returns the matching symbol, exchange, description, instrument type, and currency.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Name or ticker to search for, e.g. "Apple", "AAPL", "bitcoin".',
                },
                exchange: {
                    type: 'string',
                    description: 'Optional exchange filter, e.g. "NASDAQ", "NYSE", "BINANCE".',
                },
                type: {
                    type: 'string',
                    enum: ['stock', 'futures', 'forex', 'crypto', 'index', 'bond', 'economic'],
                    description: 'Optional instrument type filter.',
                },
                limit: {
                    type: 'integer',
                    description: 'Maximum matches to return (1-50, default 10).',
                },
            },
            required: ['query'],
        },
        async handler(client, { query, exchange, type, limit }) {
            const matches = await client.searchSymbols({
                text: query,
                exchange,
                type,
                limit: clamp(limit, 10, 50),
            });
            return { query, count: matches.length, matches };
        },
    },

    {
        name: 'get_quote',
        description:
            'Get the latest price snapshot for one or more TradingView tickers: last price, ' +
            'percent and absolute change, day open/high/low, volume, market cap, P/E, and EPS. ' +
            'Quotes are delayed exactly as they are on tradingview.com — this is not a real-time ' +
            'market data feed, and it is not investment advice.',
        inputSchema: {
            type: 'object',
            properties: {
                tickers: {
                    type: 'array',
                    items: { type: 'string' },
                    description: `Tickers to quote (1-${MAX_TICKERS}). ${TICKER_NOTE}`,
                },
                market: { type: 'string', description: MARKET_NOTE },
            },
            required: ['tickers'],
        },
        async handler(client, { tickers, market }) {
            const list = (Array.isArray(tickers) ? tickers : [tickers])
                .map((t) => String(t ?? '').trim().toUpperCase())
                .filter(Boolean);
            if (list.length === 0) throw new Error('`tickers` must contain at least one ticker.');
            if (list.length > MAX_TICKERS) {
                throw new Error(`\`tickers\` accepts at most ${MAX_TICKERS} entries per call.`);
            }

            const { rows } = await client.scan({
                market,
                tickers: list,
                columns: QUOTE_COLUMNS,
            });

            const quotes = rows.map((row) => ({ ticker: row.ticker, ...row.values }));
            const missing = list.filter((t) => !quotes.some((q) => q.ticker === t));
            return missing.length ? { quotes, not_found: missing } : { quotes };
        },
    },

    {
        name: 'get_technical_analysis',
        description:
            "Get TradingView's technical-analysis gauges for a ticker on a given timeframe — the " +
            'same STRONG_BUY / BUY / NEUTRAL / SELL / STRONG_SELL ratings shown on the site, split ' +
            'into an overall summary, a moving-averages gauge, and an oscillators gauge — plus the ' +
            'underlying indicator values (RSI, Stochastic, CCI, ADX, Awesome Oscillator, Momentum, ' +
            'MACD, Bollinger Bands, and the EMA/SMA ladder). Ratings are mechanical indicator ' +
            'readings, not investment advice.',
        inputSchema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: TICKER_NOTE },
                interval: {
                    type: 'string',
                    enum: Object.keys(INTERVALS),
                    description:
                        'Timeframe to analyze. "1mo" is one month; "1m" is one minute. Defaults to "1d".',
                },
                market: { type: 'string', description: MARKET_NOTE },
            },
            required: ['ticker'],
        },
        async handler(client, { ticker, interval = '1d', market }) {
            const symbol = requireTicker(ticker);
            const suffix = intervalSuffix(interval);
            const base = [...Object.values(RECOMMENDATION_COLUMNS), ...INDICATOR_COLUMNS];
            const columns = base.map((column) => `${column}${suffix}`);

            const { rows } = await client.scan({ market, tickers: [symbol], columns });
            if (rows.length === 0) {
                throw new Error(
                    `No TradingView data for "${symbol}" in market "${normalizeMarket(market)}". ` +
                        'Check the ticker with search_symbol and make sure the market matches its exchange.',
                );
            }

            // Drop the interval suffix so callers see stable indicator names.
            const values = {};
            base.forEach((column, index) => {
                values[column] = rows[0].values[columns[index]];
            });

            const gauges = {};
            for (const [gauge, column] of Object.entries(RECOMMENDATION_COLUMNS)) {
                gauges[gauge] = { rating: ratingLabel(values[column]), value: values[column] };
                delete values[column];
            }

            return {
                ticker: rows[0].ticker || symbol,
                interval: String(interval).toLowerCase(),
                ...gauges,
                indicators: values,
            };
        },
    },

    {
        name: 'screen_market',
        description:
            "Run a TradingView stock screener query: filter a market by any screener field, sort " +
            'the results, and read back a price snapshot for each match. Use it for questions like ' +
            '"biggest US gainers today" (sort by "change" descending) or "large caps under a P/E of ' +
            '15" (filter market_cap_basic greater 1e10 and price_earnings_ttm less 15).',
        inputSchema: {
            type: 'object',
            properties: {
                market: { type: 'string', description: MARKET_NOTE },
                filters: {
                    type: 'array',
                    description: 'Screener filters, ANDed together. Omit to screen the whole market.',
                    items: {
                        type: 'object',
                        properties: {
                            field: {
                                type: 'string',
                                description:
                                    'Screener field, e.g. "change", "close", "volume", ' +
                                    '"market_cap_basic", "price_earnings_ttm", "sector".',
                            },
                            operation: {
                                type: 'string',
                                enum: SCREENER_OPERATIONS,
                                description:
                                    'Comparison to apply. "egreater"/"eless" are the inclusive ' +
                                    'forms; "in_range" takes a [min, max] array value.',
                            },
                            value: {
                                description:
                                    'Value to compare against: a number, a string, or a [min, max] ' +
                                    'array for "in_range"/"not_in_range".',
                            },
                        },
                        required: ['field', 'operation', 'value'],
                    },
                },
                sort_by: {
                    type: 'string',
                    description: 'Field to sort by, e.g. "change", "volume", "market_cap_basic".',
                },
                sort_order: {
                    type: 'string',
                    enum: ['asc', 'desc'],
                    description: 'Sort direction (default "desc").',
                },
                limit: {
                    type: 'integer',
                    description: `Maximum rows to return (1-${MAX_SCREEN_ROWS}, default 25).`,
                },
            },
        },
        async handler(client, { market, filters, sort_by, sort_order = 'desc', limit }) {
            const rowLimit = clamp(limit, 25, MAX_SCREEN_ROWS);
            const { totalCount, rows } = await client.scan({
                market,
                columns: QUOTE_COLUMNS,
                filter: toScreenerFilter(filters),
                sort: sort_by
                    ? { sortBy: sort_by, sortOrder: sort_order === 'asc' ? 'asc' : 'desc' }
                    : undefined,
                range: [0, rowLimit],
            });

            return {
                market: normalizeMarket(market),
                matched: totalCount,
                returned: rows.length,
                results: rows.map((row) => ({ ticker: row.ticker, ...row.values })),
            };
        },
    },
];

export const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** Build the tools/list payload (strips internal handlers). */
export function listTools() {
    return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** Pretty-print a value for a text content block. */
export function asText(value) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
