#!/usr/bin/env node
// TradingView MCP server, stdio transport.
//
// MCP clients launch this file with `node src/server.js` and speak JSON-RPC
// over stdin/stdout, one message per line. stdout carries protocol traffic
// ONLY — anything diagnostic goes to stderr, or it corrupts the stream.

import { createInterface } from 'node:readline';

import { PARSE_ERROR, SERVER_INFO, handleMessage, rpcError } from './mcp.js';
import { createTradingViewClient } from './tradingview.js';

// The origin overrides exist so the integration test can point the real server
// at a local stub; there is nothing to configure for normal use.
const client = createTradingViewClient({
    scannerOrigin: process.env.TRADINGVIEW_SCANNER_ORIGIN || undefined,
    symbolSearchOrigin: process.env.TRADINGVIEW_SYMBOL_SEARCH_ORIGIN || undefined,
    timeoutMs: Number(process.env.TRADINGVIEW_TIMEOUT_MS) || undefined,
});

function send(message) {
    // One write per message keeps whole lines intact when calls overlap.
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function processLine(line) {
    let payload;
    try {
        payload = JSON.parse(line);
    } catch {
        send(rpcError(null, PARSE_ERROR, 'Invalid JSON'));
        return;
    }

    if (Array.isArray(payload)) {
        const responses = (
            await Promise.all(payload.map((msg) => handleMessage(msg, client)))
        ).filter(Boolean);
        if (responses.length > 0) send(responses);
        return;
    }

    const response = await handleMessage(payload, client);
    if (response) send(response);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    // Requests run concurrently: a slow scan must not stall a ping behind it.
    processLine(text).catch((err) => {
        process.stderr.write(`[${SERVER_INFO.name}] ${err?.stack || err}\n`);
    });
});

rl.on('close', () => process.exit(0));

process.stderr.write(`[${SERVER_INFO.name}] v${SERVER_INFO.version} ready on stdio\n`);
