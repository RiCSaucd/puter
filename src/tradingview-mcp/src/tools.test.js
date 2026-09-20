import { describe, expect, it } from 'vitest';

import { TOOL_MAP, listTools } from './tools.js';
import { createTradingViewClient } from './tradingview.js';

const json = (payload) =>
    new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

/** Run a tool against a real client whose only stub is the HTTP boundary. */
function harness(responder) {
    const requests = [];
    const client = createTradingViewClient({
        fetchImpl: async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : undefined;
            requests.push({ url: String(url), body });
            return responder({ url: String(url), body });
        },
    });
    const call = (name, args = {}) => TOOL_MAP.get(name).handler(client, args);
    return { call, requests };
}

describe('tools/list', () => {
    it('advertises every tool with a JSON-Schema input and no handler', () => {
        const tools = listTools();
        expect(tools.map((t) => t.name)).toEqual([
            'search_symbol',
            'get_quote',
            'get_technical_analysis',
            'screen_market',
        ]);
        for (const tool of tools) {
            expect(tool.description.length).toBeGreaterThan(0);
            expect(tool.inputSchema.type).toBe('object');
            expect(tool).not.toHaveProperty('handler');
        }
    });
});

describe('search_symbol', () => {
    const payload = {
        symbols: [
            {
                symbol: 'AAPL',
                description: 'Apple Inc.',
                type: 'stock',
                exchange: 'NASDAQ',
                currency_code: 'USD',
            },
        ],
    };

    it('returns the resolved tickers with a count', async () => {
        const { call } = harness(() => json(payload));
        const result = await call('search_symbol', { query: 'apple' });

        expect(result).toEqual({
            query: 'apple',
            count: 1,
            matches: [
                {
                    ticker: 'NASDAQ:AAPL',
                    symbol: 'AAPL',
                    exchange: 'NASDAQ',
                    description: 'Apple Inc.',
                    type: 'stock',
                    currency: 'USD',
                },
            ],
        });
    });

    it('clamps an out-of-range limit instead of failing', async () => {
        const many = { symbols: Array.from({ length: 60 }, () => payload.symbols[0]) };
        const { call } = harness(() => json(many));

        expect(await call('search_symbol', { query: 'a', limit: 999 })).toHaveProperty('count', 50);
        expect(await call('search_symbol', { query: 'a', limit: 0 })).toHaveProperty('count', 1);
    });
});

describe('get_quote', () => {
    it('requests the quote columns and flattens rows onto the ticker', async () => {
        const { call, requests } = harness(({ body }) =>
            json({
                totalCount: 1,
                data: [{ s: 'NASDAQ:AAPL', d: body.columns.map((c) => `v:${c}`) }],
            }),
        );

        const result = await call('get_quote', { tickers: ['nasdaq:aapl'] });

        expect(requests[0].url).toBe('https://scanner.tradingview.com/america/scan');
        expect(requests[0].body.symbols.tickers).toEqual(['NASDAQ:AAPL']);
        expect(requests[0].body.columns).toContain('market_cap_basic');
        expect(result.quotes[0]).toMatchObject({
            ticker: 'NASDAQ:AAPL',
            close: 'v:close',
            change: 'v:change',
        });
        expect(result).not.toHaveProperty('not_found');
    });

    it('lists tickers the scanner returned nothing for', async () => {
        const { call } = harness(({ body }) =>
            json({ totalCount: 1, data: [{ s: 'NASDAQ:AAPL', d: body.columns.map(() => null) }] }),
        );

        const result = await call('get_quote', { tickers: ['NASDAQ:AAPL', 'NASDAQ:NOPE'] });
        expect(result.not_found).toEqual(['NASDAQ:NOPE']);
    });

    it('honours the requested market', async () => {
        const { call, requests } = harness(() => json({ totalCount: 0, data: [] }));
        await call('get_quote', { tickers: ['BINANCE:BTCUSDT'], market: 'crypto' });
        expect(requests[0].url).toBe('https://scanner.tradingview.com/crypto/scan');
    });

    it('rejects an empty list and an oversized batch', async () => {
        const { call } = harness(() => json({ totalCount: 0, data: [] }));
        await expect(call('get_quote', { tickers: [] })).rejects.toThrow(/at least one ticker/);
        await expect(
            call('get_quote', { tickers: Array.from({ length: 51 }, (_, i) => `X:S${i}`) }),
        ).rejects.toThrow(/at most 50 entries/);
    });
});

describe('get_technical_analysis', () => {
    const gauges = { 'Recommend.All': 0.61, 'Recommend.MA': 0.72, 'Recommend.Other': -0.15 };

    function analysisHarness() {
        return harness(({ body }) =>
            json({
                totalCount: 1,
                data: [
                    {
                        s: 'NASDAQ:AAPL',
                        // Strip any interval suffix to find the gauge value.
                        d: body.columns.map((column) => {
                            const base = column.split('|')[0];
                            return base in gauges ? gauges[base] : `v:${column}`;
                        }),
                    },
                ],
            }),
        );
    }

    it('labels each gauge and returns indicators under suffix-free names', async () => {
        const { call, requests } = analysisHarness();
        const result = await call('get_technical_analysis', { ticker: 'NASDAQ:AAPL' });

        expect(requests[0].body.columns).toContain('Recommend.All');
        expect(result).toMatchObject({
            ticker: 'NASDAQ:AAPL',
            interval: '1d',
            summary: { rating: 'STRONG_BUY', value: 0.61 },
            moving_averages: { rating: 'STRONG_BUY', value: 0.72 },
            oscillators: { rating: 'SELL', value: -0.15 },
        });
        expect(result.indicators.RSI).toBe('v:RSI');
        expect(result.indicators).not.toHaveProperty('Recommend.All');
    });

    it('suffixes every column for a non-daily interval but keeps output names stable', async () => {
        const { call, requests } = analysisHarness();
        const result = await call('get_technical_analysis', {
            ticker: 'NASDAQ:AAPL',
            interval: '1h',
        });

        expect(requests[0].body.columns).toContain('RSI|60');
        expect(requests[0].body.columns).toContain('Recommend.All|60');
        expect(result.interval).toBe('1h');
        expect(result.indicators.RSI).toBe('v:RSI|60');
        expect(result.summary.rating).toBe('STRONG_BUY');
    });

    it('explains an empty result instead of returning a blank analysis', async () => {
        const { call } = harness(() => json({ totalCount: 0, data: [] }));
        await expect(
            call('get_technical_analysis', { ticker: 'NASDAQ:NOPE' }),
        ).rejects.toThrow(/No TradingView data for "NASDAQ:NOPE"/);
    });

    it('requires a ticker and a known interval', async () => {
        const { call } = analysisHarness();
        await expect(call('get_technical_analysis', { ticker: ' ' })).rejects.toThrow(
            /`ticker` is required/,
        );
        await expect(
            call('get_technical_analysis', { ticker: 'NASDAQ:AAPL', interval: '3h' }),
        ).rejects.toThrow(/Unknown interval/);
    });
});

describe('screen_market', () => {
    it('translates filters into the scanner shape and sorts descending by default', async () => {
        const { call, requests } = harness(({ body }) =>
            json({
                totalCount: 412,
                data: [{ s: 'NASDAQ:AAPL', d: body.columns.map((c) => `v:${c}`) }],
            }),
        );

        const result = await call('screen_market', {
            filters: [
                { field: 'market_cap_basic', operation: 'greater', value: 1e10 },
                { field: 'change', operation: 'in_range', value: [1, 5] },
            ],
            sort_by: 'change',
            limit: 10,
        });

        expect(requests[0].body.filter).toEqual([
            { left: 'market_cap_basic', operation: 'greater', right: 1e10 },
            { left: 'change', operation: 'in_range', right: [1, 5] },
        ]);
        expect(requests[0].body.sort).toEqual({ sortBy: 'change', sortOrder: 'desc' });
        expect(requests[0].body.range).toEqual([0, 10]);
        expect(result).toMatchObject({ market: 'america', matched: 412, returned: 1 });
        expect(result.results[0].ticker).toBe('NASDAQ:AAPL');
    });

    it('omits filter and sort when none were asked for', async () => {
        const { call, requests } = harness(() => json({ totalCount: 0, data: [] }));
        await call('screen_market', {});

        expect(requests[0].body).not.toHaveProperty('filter');
        expect(requests[0].body).not.toHaveProperty('sort');
        expect(requests[0].body.range).toEqual([0, 25]);
    });

    it('rejects an unsupported filter operation before calling TradingView', async () => {
        const { call, requests } = harness(() => json({ totalCount: 0, data: [] }));
        await expect(
            call('screen_market', { filters: [{ field: 'change', operation: 'gt', value: 1 }] }),
        ).rejects.toThrow(/Unknown filter operation "gt"/);
        expect(requests).toHaveLength(0);
    });

    it('caps the row count', async () => {
        const { call, requests } = harness(() => json({ totalCount: 0, data: [] }));
        await call('screen_market', { limit: 5000 });
        expect(requests[0].body.range).toEqual([0, 100]);
    });
});
