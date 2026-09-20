// Read-only client for the public TradingView endpoints that tradingview.com's
// own web app calls.
//
// There is no official TradingView data API and no key to configure: these
// endpoints are undocumented, unauthenticated, and may change shape or
// rate-limit without notice. Keep every request read-only.
//
// `fetchImpl` is injectable so callers (and tests) can supply their own
// transport instead of reaching the network.

export const DEFAULT_SCANNER_ORIGIN = 'https://scanner.tradingview.com';
export const DEFAULT_SYMBOL_SEARCH_ORIGIN = 'https://symbol-search.tradingview.com';
export const DEFAULT_TIMEOUT_MS = 15000;

// TradingView encodes the timeframe as a column-name suffix ("RSI|60"); the
// daily timeframe is the bare column name. The keys deliberately avoid the
// `1m`/`1M` pair (minute vs month) — a client that lowercases its arguments
// would otherwise silently ask for a month of data instead of a minute.
export const INTERVALS = {
    '1m': '|1',
    '5m': '|5',
    '15m': '|15',
    '30m': '|30',
    '1h': '|60',
    '2h': '|120',
    '4h': '|240',
    '1d': '',
    '1w': '|1W',
    '1mo': '|1M',
};

// TradingView sends these on its own XHRs and rejects some callers without
// them; identify this client honestly in the User-Agent.
const BROWSER_HEADERS = {
    Accept: 'application/json',
    Origin: 'https://www.tradingview.com',
    Referer: 'https://www.tradingview.com/',
    'User-Agent': 'Mozilla/5.0 (compatible; tradingview-mcp)',
};

/** Resolve an interval name to the column suffix TradingView expects. */
export function intervalSuffix(interval) {
    const key = String(interval ?? '1d').toLowerCase();
    if (!Object.hasOwn(INTERVALS, key)) {
        throw new Error(
            `Unknown interval "${interval}". Expected one of: ${Object.keys(INTERVALS).join(', ')}`,
        );
    }
    return INTERVALS[key];
}

/**
 * Label a TradingView recommendation gauge. The gauges are numbers in [-1, 1];
 * these are the cutoffs the site itself uses to pick the label.
 */
export function ratingLabel(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return 'UNKNOWN';
    if (value <= -0.5) return 'STRONG_SELL';
    if (value <= -0.1) return 'SELL';
    if (value < 0.1) return 'NEUTRAL';
    if (value < 0.5) return 'BUY';
    return 'STRONG_BUY';
}

/**
 * Validate a scanner market. It becomes a URL path segment, so reject anything
 * that could escape it.
 */
export function normalizeMarket(market) {
    const value = String(market ?? 'america')
        .trim()
        .toLowerCase();
    if (!/^[a-z0-9_]+$/.test(value)) {
        throw new Error(
            `Invalid market "${market}". A market is a single path segment such as "america", "crypto", or "forex".`,
        );
    }
    return value;
}

/** TradingView highlights search matches with <em> tags; strip the markup. */
function stripHtml(value) {
    return typeof value === 'string' ? value.replace(/<[^>]*>/g, '') : '';
}

/** Pair a scanner row's positional values back up with the columns requested. */
function zipColumns(columns, values) {
    const row = {};
    columns.forEach((column, index) => {
        row[column] = values?.[index] ?? null;
    });
    return row;
}

function toSymbolMatch(raw) {
    const symbol = stripHtml(raw?.symbol);
    // `prefix` holds the real venue when a symbol is listed across several
    // (e.g. prefix "BATS" with exchange "AMEX"); it wins for ticker building.
    const exchange = stripHtml(raw?.prefix) || stripHtml(raw?.exchange);
    return {
        ticker: exchange ? `${exchange}:${symbol}` : symbol,
        symbol,
        exchange,
        description: stripHtml(raw?.description),
        type: raw?.type ?? '',
        currency: raw?.currency_code ?? '',
    };
}

export function createTradingViewClient({
    fetchImpl = globalThis.fetch,
    scannerOrigin = DEFAULT_SCANNER_ORIGIN,
    symbolSearchOrigin = DEFAULT_SYMBOL_SEARCH_ORIGIN,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    async function request(url, init = {}) {
        if (typeof fetchImpl !== 'function') {
            throw new Error('No fetch implementation available (Node 18+ required).');
        }

        let response;
        try {
            response = await fetchImpl(url, {
                ...init,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            if (err?.name === 'TimeoutError') {
                throw new Error(`TradingView request timed out after ${timeoutMs}ms: ${url}`);
            }
            throw new Error(`TradingView request failed: ${err?.message || err}`);
        }

        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
            throw new Error(
                `TradingView responded ${response.status} for ${url}${detail ? `: ${detail}` : ''}`,
            );
        }

        try {
            return await response.json();
        } catch {
            throw new Error(`TradingView returned a non-JSON response for ${url}`);
        }
    }

    return {
        /**
         * Query the screener/scanner. Pass `tickers` to look up specific
         * symbols, or `filter`/`sort`/`range` to screen a whole market.
         * Returns rows keyed by the column names that were requested.
         */
        async scan({ market, columns, tickers, filter, sort, range } = {}) {
            if (!Array.isArray(columns) || columns.length === 0) {
                throw new Error('scan() requires a non-empty `columns` array.');
            }

            const body = { columns, symbols: { query: { types: [] } } };
            if (tickers?.length) body.symbols.tickers = tickers;
            if (filter?.length) body.filter = filter;
            if (sort) body.sort = sort;
            if (range) body.range = range;

            const url = `${scannerOrigin}/${normalizeMarket(market)}/scan`;
            const payload = await request(url, {
                method: 'POST',
                headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            const data = Array.isArray(payload?.data) ? payload.data : [];
            return {
                totalCount: payload?.totalCount ?? data.length,
                rows: data.map((row) => ({
                    ticker: row?.s ?? '',
                    values: zipColumns(columns, row?.d),
                })),
            };
        },

        /** Resolve free text to TradingView tickers (EXCHANGE:SYMBOL). */
        async searchSymbols({ text, exchange, type, limit = 10 } = {}) {
            const query = String(text ?? '').trim();
            if (!query) throw new Error('searchSymbols() requires a non-empty `text`.');

            const url = new URL('/symbol_search/v3/', symbolSearchOrigin);
            url.searchParams.set('text', query);
            url.searchParams.set('hl', '0');
            url.searchParams.set('lang', 'en');
            url.searchParams.set('domain', 'production');
            if (exchange) url.searchParams.set('exchange', String(exchange).toUpperCase());
            if (type) url.searchParams.set('search_type', String(type).toLowerCase());

            const payload = await request(url.toString(), { headers: BROWSER_HEADERS });
            const symbols = Array.isArray(payload?.symbols) ? payload.symbols : [];
            return symbols.slice(0, limit).map(toSymbolMatch);
        },
    };
}
