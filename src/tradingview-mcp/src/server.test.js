// End-to-end check of the real stdio entry point: spawn `node src/server.js`,
// point it at a local stand-in for TradingView, and drive a full MCP handshake
// over its stdin/stdout.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER_PATH = fileURLToPath(new URL('./server.js', import.meta.url));

const SYMBOL_SEARCH_FIXTURE = {
    symbols: [
        {
            symbol: '<em>AAPL</em>',
            description: 'Apple Inc.',
            type: 'stock',
            exchange: 'NASDAQ',
            currency_code: 'USD',
        },
    ],
};

/** Stand-in for TradingView: echoes the requested columns back as row values. */
function startUpstream() {
    const requests = [];
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const body = raw ? JSON.parse(raw) : undefined;
            requests.push({ method: req.method, url: req.url, body });
            res.setHeader('content-type', 'application/json');

            if (req.url.startsWith('/symbol_search/v3/')) {
                res.end(JSON.stringify(SYMBOL_SEARCH_FIXTURE));
                return;
            }
            if (req.url.endsWith('/scan')) {
                const values = body.columns.map((column) =>
                    column.startsWith('Recommend.') ? 0.55 : `v:${column}`,
                );
                res.end(JSON.stringify({ totalCount: 1, data: [{ s: 'NASDAQ:AAPL', d: values }] }));
                return;
            }
            res.statusCode = 404;
            res.end('{}');
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, requests, origin: `http://127.0.0.1:${port}` });
        });
    });
}

/** Spawn the server and expose a request/response helper over its stdio. */
function startServer(origin) {
    const child = spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            TRADINGVIEW_SCANNER_ORIGIN: origin,
            TRADINGVIEW_SYMBOL_SEARCH_ORIGIN: origin,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pending = new Map();
    const unmatched = [];
    let stderr = '';

    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
    });

    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
        if (!line.trim()) return;
        const message = JSON.parse(line);
        const waiter = pending.get(message.id ?? null);
        if (waiter) {
            pending.delete(message.id ?? null);
            waiter(message);
        } else {
            unmatched.push(message);
        }
    });

    const waitFor = (id) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`No response for id ${id}`)), 5000);
            pending.set(id, (message) => {
                clearTimeout(timer);
                resolve(message);
            });
        });

    return {
        child,
        unmatched,
        get stderr() {
            return stderr;
        },
        send(message) {
            const wait = message.id === undefined ? null : waitFor(message.id);
            child.stdin.write(`${JSON.stringify(message)}\n`);
            return wait;
        },
        sendRaw(line) {
            const wait = waitFor(null);
            child.stdin.write(`${line}\n`);
            return wait;
        },
        stop() {
            child.stdin.end();
            return new Promise((resolve) => child.on('exit', resolve));
        },
    };
}

describe('stdio server', () => {
    let upstream;
    let server;

    beforeAll(async () => {
        upstream = await startUpstream();
        server = startServer(upstream.origin);
    });

    afterAll(async () => {
        await server?.stop();
        upstream?.server.close();
    });

    it('completes the MCP handshake', async () => {
        const res = await server.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
        });

        expect(res.result.serverInfo.name).toBe('tradingview-mcp');
        expect(res.result.instructions).toMatch(/not investment advice/);

        // The initialized notification must not produce a response.
        expect(server.send({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    });

    it('lists its tools', async () => {
        const res = await server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        expect(res.result.tools.map((t) => t.name)).toEqual([
            'search_symbol',
            'get_quote',
            'get_technical_analysis',
            'screen_market',
        ]);
    });

    it('calls search_symbol against the upstream', async () => {
        const res = await server.send({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'search_symbol', arguments: { query: 'apple' } },
        });

        const payload = JSON.parse(res.result.content[0].text);
        expect(payload.matches[0].ticker).toBe('NASDAQ:AAPL');
        expect(upstream.requests.at(-1).url).toMatch(/^\/symbol_search\/v3\/\?text=apple/);
    });

    it('calls get_technical_analysis and labels the gauges', async () => {
        const res = await server.send({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: {
                name: 'get_technical_analysis',
                arguments: { ticker: 'NASDAQ:AAPL', interval: '1h' },
            },
        });

        const payload = JSON.parse(res.result.content[0].text);
        expect(payload.summary).toEqual({ rating: 'STRONG_BUY', value: 0.55 });
        expect(payload.indicators.RSI).toBe('v:RSI|60');
        expect(upstream.requests.at(-1).url).toBe('/america/scan');
    });

    it('returns a tool error when the upstream has no data for the market', async () => {
        const res = await server.send({
            jsonrpc: '2.0',
            id: 5,
            method: 'tools/call',
            params: { name: 'get_quote', arguments: { tickers: ['NASDAQ:AAPL'], market: 'nope!' } },
        });

        expect(res.result.isError).toBe(true);
        expect(res.result.content[0].text).toMatch(/Invalid market/);
    });

    it('answers a malformed line with a parse error and keeps serving', async () => {
        const res = await server.sendRaw('not json at all');
        expect(res.error.code).toBe(-32700);

        const ping = await server.send({ jsonrpc: '2.0', id: 6, method: 'ping' });
        expect(ping.result).toEqual({});
    });

    it('keeps stdout free of anything but protocol messages', () => {
        // Every stdout line parsed as JSON-RPC above; the banner goes to stderr.
        expect(server.unmatched).toEqual([]);
        expect(server.stderr).toMatch(/ready on stdio/);
    });
});
