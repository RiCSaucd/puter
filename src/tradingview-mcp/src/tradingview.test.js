import { describe, expect, it } from 'vitest';

import {
    createTradingViewClient,
    intervalSuffix,
    normalizeMarket,
    ratingLabel,
} from './tradingview.js';

/** Build a fetch stub that records its calls and replays canned responses. */
function stubFetch(responder) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init });
        return responder(String(url), init);
    };
    return { fetchImpl, calls };
}

const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });

describe('intervalSuffix', () => {
    it('maps the daily timeframe to a bare column name', () => {
        expect(intervalSuffix('1d')).toBe('');
        expect(intervalSuffix(undefined)).toBe('');
    });

    it('keeps minutes and months distinct regardless of casing', () => {
        expect(intervalSuffix('1m')).toBe('|1');
        expect(intervalSuffix('1mo')).toBe('|1M');
        expect(intervalSuffix('1MO')).toBe('|1M');
    });

    it('rejects an unknown interval and names the valid ones', () => {
        expect(() => intervalSuffix('3h')).toThrow(/Unknown interval "3h"/);
        expect(() => intervalSuffix('3h')).toThrow(/1d/);
    });
});

describe('ratingLabel', () => {
    it("labels the gauge using TradingView's own cutoffs", () => {
        expect(ratingLabel(0.82)).toBe('STRONG_BUY');
        expect(ratingLabel(0.5)).toBe('STRONG_BUY');
        expect(ratingLabel(0.3)).toBe('BUY');
        expect(ratingLabel(0.1)).toBe('BUY');
        expect(ratingLabel(0)).toBe('NEUTRAL');
        expect(ratingLabel(-0.09)).toBe('NEUTRAL');
        expect(ratingLabel(-0.1)).toBe('SELL');
        expect(ratingLabel(-0.4)).toBe('SELL');
        expect(ratingLabel(-0.5)).toBe('STRONG_SELL');
        expect(ratingLabel(-1)).toBe('STRONG_SELL');
    });

    it('reports UNKNOWN when the gauge is missing', () => {
        expect(ratingLabel(null)).toBe('UNKNOWN');
        expect(ratingLabel(NaN)).toBe('UNKNOWN');
    });
});

describe('normalizeMarket', () => {
    it('defaults to america and lowercases', () => {
        expect(normalizeMarket(undefined)).toBe('america');
        expect(normalizeMarket('Crypto')).toBe('crypto');
    });

    it('refuses anything that could escape the URL path segment', () => {
        expect(() => normalizeMarket('../secrets')).toThrow(/Invalid market/);
        expect(() => normalizeMarket('america/scan')).toThrow(/Invalid market/);
    });
});

describe('scan', () => {
    const scanPayload = {
        totalCount: 1,
        data: [{ s: 'NASDAQ:AAPL', d: ['AAPL', 214.29, 1.37] }],
    };

    it('posts the scanner body and keys rows by requested column', async () => {
        const { fetchImpl, calls } = stubFetch(() => json(scanPayload));
        const client = createTradingViewClient({ fetchImpl });

        const result = await client.scan({
            market: 'america',
            tickers: ['NASDAQ:AAPL'],
            columns: ['name', 'close', 'change'],
        });

        expect(calls[0].url).toBe('https://scanner.tradingview.com/america/scan');
        expect(calls[0].init.method).toBe('POST');
        expect(JSON.parse(calls[0].init.body)).toEqual({
            columns: ['name', 'close', 'change'],
            symbols: { query: { types: [] }, tickers: ['NASDAQ:AAPL'] },
        });
        expect(result).toEqual({
            totalCount: 1,
            rows: [{ ticker: 'NASDAQ:AAPL', values: { name: 'AAPL', close: 214.29, change: 1.37 } }],
        });
    });

    it('passes screener filter, sort, and range through', async () => {
        const { fetchImpl, calls } = stubFetch(() => json({ totalCount: 0, data: [] }));
        const client = createTradingViewClient({ fetchImpl });

        await client.scan({
            market: 'america',
            columns: ['close'],
            filter: [{ left: 'change', operation: 'greater', right: 5 }],
            sort: { sortBy: 'change', sortOrder: 'desc' },
            range: [0, 10],
        });

        const body = JSON.parse(calls[0].init.body);
        expect(body.filter).toEqual([{ left: 'change', operation: 'greater', right: 5 }]);
        expect(body.sort).toEqual({ sortBy: 'change', sortOrder: 'desc' });
        expect(body.range).toEqual([0, 10]);
    });

    it('fills missing column values with null instead of shifting them', async () => {
        const { fetchImpl } = stubFetch(() => json({ totalCount: 1, data: [{ s: 'X:Y', d: [1] }] }));
        const client = createTradingViewClient({ fetchImpl });

        const result = await client.scan({ columns: ['close', 'change'], tickers: ['X:Y'] });
        expect(result.rows[0].values).toEqual({ close: 1, change: null });
    });

    it('requires columns', async () => {
        const client = createTradingViewClient({ fetchImpl: async () => json({}) });
        await expect(client.scan({ columns: [] })).rejects.toThrow(/non-empty `columns`/);
    });

    it('reports the HTTP status and body when TradingView rejects the call', async () => {
        const { fetchImpl } = stubFetch(() => new Response('rate limited', { status: 429 }));
        const client = createTradingViewClient({ fetchImpl });

        await expect(client.scan({ columns: ['close'], tickers: ['X:Y'] })).rejects.toThrow(
            /TradingView responded 429 .*: rate limited/,
        );
    });

    it('reports a non-JSON response rather than throwing a parser error', async () => {
        const { fetchImpl } = stubFetch(() => new Response('<html>maintenance</html>'));
        const client = createTradingViewClient({ fetchImpl });

        await expect(client.scan({ columns: ['close'], tickers: ['X:Y'] })).rejects.toThrow(
            /non-JSON response/,
        );
    });
});

describe('searchSymbols', () => {
    const searchPayload = {
        symbols_remaining: 120,
        symbols: [
            {
                symbol: '<em>AAPL</em>',
                description: 'Apple Inc.',
                type: 'stock',
                exchange: 'NASDAQ',
                currency_code: 'USD',
            },
            {
                symbol: 'AAPL',
                description: 'Apple Inc',
                type: 'stock',
                exchange: 'NYSE',
                prefix: 'BATS',
                currency_code: 'USD',
            },
        ],
    };

    it('builds EXCHANGE:SYMBOL tickers and strips highlight markup', async () => {
        const { fetchImpl, calls } = stubFetch(() => json(searchPayload));
        const client = createTradingViewClient({ fetchImpl });

        const matches = await client.searchSymbols({ text: 'apple' });

        const url = new URL(calls[0].url);
        expect(url.origin + url.pathname).toBe(
            'https://symbol-search.tradingview.com/symbol_search/v3/',
        );
        expect(url.searchParams.get('text')).toBe('apple');
        expect(matches[0]).toEqual({
            ticker: 'NASDAQ:AAPL',
            symbol: 'AAPL',
            exchange: 'NASDAQ',
            description: 'Apple Inc.',
            type: 'stock',
            currency: 'USD',
        });
    });

    it('prefers the prefix over the exchange when a symbol lists on both', async () => {
        const { fetchImpl } = stubFetch(() => json(searchPayload));
        const client = createTradingViewClient({ fetchImpl });

        const matches = await client.searchSymbols({ text: 'apple' });
        expect(matches[1].ticker).toBe('BATS:AAPL');
    });

    it('applies the exchange and type filters and the limit', async () => {
        const { fetchImpl, calls } = stubFetch(() => json(searchPayload));
        const client = createTradingViewClient({ fetchImpl });

        const matches = await client.searchSymbols({
            text: 'apple',
            exchange: 'nasdaq',
            type: 'Stock',
            limit: 1,
        });

        const url = new URL(calls[0].url);
        expect(url.searchParams.get('exchange')).toBe('NASDAQ');
        expect(url.searchParams.get('search_type')).toBe('stock');
        expect(matches).toHaveLength(1);
    });

    it('requires a query', async () => {
        const client = createTradingViewClient({ fetchImpl: async () => json({}) });
        await expect(client.searchSymbols({ text: '  ' })).rejects.toThrow(/non-empty `text`/);
    });
});
