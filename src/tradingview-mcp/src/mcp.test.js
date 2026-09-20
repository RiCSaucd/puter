import { describe, expect, it } from 'vitest';

import { INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, handleMessage } from './mcp.js';

const failingClient = {
    scan: async () => {
        throw new Error('TradingView responded 429 for /america/scan');
    },
    searchSymbols: async () => {
        throw new Error('boom');
    },
};

const request = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('initialize', () => {
    it('echoes a protocol version it supports', async () => {
        const res = await handleMessage(request('initialize', { protocolVersion: '2024-11-05' }));
        expect(res.result.protocolVersion).toBe('2024-11-05');
        expect(res.result.serverInfo.name).toBe('tradingview-mcp');
        expect(res.result.capabilities.tools).toBeDefined();
    });

    it('falls back to its own version when the client asks for an unknown one', async () => {
        const res = await handleMessage(request('initialize', { protocolVersion: '1999-01-01' }));
        expect(res.result.protocolVersion).toBe('2025-06-18');
    });
});

describe('message dispatch', () => {
    it('answers ping', async () => {
        expect(await handleMessage(request('ping'))).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    });

    it('lists tools', async () => {
        const res = await handleMessage(request('tools/list'));
        expect(res.result.tools.map((t) => t.name)).toContain('get_quote');
    });

    it('returns no response for notifications', async () => {
        expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
        expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBeNull();
    });

    it('stays silent on an unknown notification but errors on an unknown request', async () => {
        expect(await handleMessage({ jsonrpc: '2.0', method: 'made/up' })).toBeNull();

        const res = await handleMessage(request('made/up'));
        expect(res.error.code).toBe(METHOD_NOT_FOUND);
    });

    it('rejects a malformed envelope', async () => {
        const res = await handleMessage({ id: 7, method: 'ping' });
        expect(res).toMatchObject({ id: 7, error: { code: INVALID_REQUEST } });
        expect((await handleMessage(null)).error.code).toBe(INVALID_REQUEST);
    });
});

describe('tools/call', () => {
    it('returns the handler result as a JSON text block', async () => {
        const client = {
            searchSymbols: async () => [{ ticker: 'NASDAQ:AAPL', symbol: 'AAPL' }],
        };
        const res = await handleMessage(
            request('tools/call', { name: 'search_symbol', arguments: { query: 'apple' } }),
            client,
        );

        expect(res.result.isError).toBeUndefined();
        expect(JSON.parse(res.result.content[0].text)).toMatchObject({
            query: 'apple',
            count: 1,
        });
    });

    it('reports an unknown tool as an invalid-params error', async () => {
        const res = await handleMessage(request('tools/call', { name: 'nope' }));
        expect(res.error).toMatchObject({ code: INVALID_PARAMS });
        expect(res.error.message).toMatch(/Unknown tool: nope/);
    });

    // A failing upstream must reach the model as a tool error it can react to,
    // not as a transport error that aborts the call.
    it('surfaces an upstream failure as an isError tool result', async () => {
        const res = await handleMessage(
            request('tools/call', { name: 'get_quote', arguments: { tickers: ['NASDAQ:AAPL'] } }),
            failingClient,
        );

        expect(res.error).toBeUndefined();
        expect(res.result.isError).toBe(true);
        expect(res.result.content[0].text).toMatch(/429/);
    });

    it('surfaces an invalid argument as an isError tool result', async () => {
        const res = await handleMessage(
            request('tools/call', { name: 'get_quote', arguments: { tickers: [] } }),
            failingClient,
        );

        expect(res.result.isError).toBe(true);
        expect(res.result.content[0].text).toMatch(/at least one ticker/);
    });
});

describe('error propagation', () => {
    it('wraps an unexpected dispatch failure as an internal error', async () => {
        const res = await handleMessage(request('tools/call', { get name() {
            throw new Error('exploding params');
        } }));
        expect(res.error).toMatchObject({ code: INTERNAL_ERROR, message: 'exploding params' });
    });
});
