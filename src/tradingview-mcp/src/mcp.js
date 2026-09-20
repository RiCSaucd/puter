// Minimal MCP (Model Context Protocol) message handling, transport-agnostic.
//
// `handleMessage()` takes one parsed JSON-RPC message and returns the response
// object, or `null` for notifications (which must not produce a response).
// server.js frames these over stdio.

import { TOOL_MAP, listTools, asText } from './tools.js';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

export const SERVER_INFO = {
    name: 'tradingview-mcp',
    title: 'TradingView MCP Server',
    version: '0.1.0',
};

export const INSTRUCTIONS =
    'TradingView MCP server. Read-only market data pulled from the public endpoints ' +
    'tradingview.com itself uses: symbol lookup (search_symbol), price snapshots (get_quote), ' +
    "TradingView's technical-analysis gauges (get_technical_analysis), and screener queries " +
    '(screen_market). Every tool takes a fully qualified EXCHANGE:SYMBOL ticker, so start with ' +
    'search_symbol when you only have a name. Prices are delayed exactly as they are on the ' +
    'site, and the ratings are mechanical indicator readings — not investment advice.';

// JSON-RPC error codes.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

export function rpcError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolError(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Handle a single JSON-RPC message.
 *
 * @param {object} msg     The parsed JSON-RPC message.
 * @param {object} client  The TradingView client from tradingview.js.
 */
export async function handleMessage(msg, client) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        return rpcError(msg?.id ?? null, INVALID_REQUEST, 'Invalid JSON-RPC request');
    }

    const { id, method, params } = msg;
    const isNotification = id === undefined;

    try {
        switch (method) {
            case 'initialize': {
                const requested = params?.protocolVersion;
                const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
                    ? requested
                    : PROTOCOL_VERSION;
                return rpcResult(id, {
                    protocolVersion,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: SERVER_INFO,
                    instructions: INSTRUCTIONS,
                });
            }

            case 'ping':
                return rpcResult(id, {});

            case 'notifications/initialized':
            case 'notifications/cancelled':
            case 'notifications/roots/list_changed':
                return null; // notifications get no response

            case 'tools/list':
                return rpcResult(id, { tools: listTools() });

            case 'tools/call':
                return await handleToolCall(id, params, client);

            default:
                if (isNotification) return null;
                return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
    } catch (err) {
        if (isNotification) return null;
        return rpcError(id, INTERNAL_ERROR, err?.message || 'Internal error');
    }
}

async function handleToolCall(id, params, client) {
    const name = params?.name;
    const tool = name && TOOL_MAP.get(name);
    if (!tool) {
        return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
    }

    try {
        const value = await tool.handler(client, params.arguments || {});
        return rpcResult(id, { content: [{ type: 'text', text: asText(value) }] });
    } catch (err) {
        // Surface tool failures as tool errors, not transport errors, so MCP
        // clients show them inline and the model can correct its arguments.
        return rpcResult(id, toolError(err?.message || 'Tool execution failed'));
    }
}
