import { spawn } from 'node:child_process';
import http from 'node:http';

import { Actor, log } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const grafanaUrl = input.grafanaUrl?.trim();
const serviceAccountToken = input.serviceAccountToken?.trim();
const credentialsMissing = !grafanaUrl || !serviceAccountToken;

const PUBLIC_PORT = Number(Actor.config.get('containerPort') ?? process.env.ACTOR_WEB_SERVER_PORT ?? 4321);
const UPSTREAM_PORT = PUBLIC_PORT === 8000 ? 8001 : 8000;
const MCP_PATH = '/mcp';

const MISSING_CREDENTIALS_MESSAGE = 'Grafana credentials are not configured. Create a task for this Actor with "Grafana URL" '
    + 'and "Grafana service account token" filled in, and connect your MCP client to the task\'s Standby URL.';

if (credentialsMissing) log.warning(MISSING_CREDENTIALS_MESSAGE);

// Read-only by design: --disable-write removes every tool that changes Grafana state.
const child = spawn('mcp-grafana', [
    '--transport', 'streamable-http',
    '--address', `127.0.0.1:${UPSTREAM_PORT}`,
    '--endpoint-path', MCP_PATH,
    '--disable-write',
], {
    env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Dummy URL keeps the server bootable without credentials, so tools/list still works.
        GRAFANA_URL: grafanaUrl || 'http://127.0.0.1:1',
        ...(serviceAccountToken ? { GRAFANA_SERVICE_ACCOUNT_TOKEN: serviceAccountToken } : {}),
        ...(input.orgId ? { GRAFANA_ORG_ID: String(input.orgId) } : {}),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
});

let shuttingDown = false;
child.on('exit', async (code, signal) => {
    if (shuttingDown) return;
    log.error('mcp-grafana exited', { code, signal });
    await Actor.exit({ exitCode: 1, statusMessage: 'mcp-grafana exited unexpectedly' });
});

// Headers that must not reach mcp-grafana: hop-by-hop, Apify auth, Origin (mcp-grafana rejects any
// request carrying one) and per-request Grafana credential overrides (credentials come from input only).
const STRIPPED_HEADERS = new Set([
    'host', 'origin', 'connection', 'authorization', 'x-apify-authorization',
    'x-grafana-url', 'x-grafana-service-account-token', 'x-grafana-api-key',
]);

function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function proxy(req, res, body) {
    const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => !STRIPPED_HEADERS.has(name)),
    );
    headers.host = `127.0.0.1:${UPSTREAM_PORT}`;
    if (body) headers['content-length'] = String(body.length);

    const upstream = http.request({
        host: '127.0.0.1',
        port: UPSTREAM_PORT,
        method: req.method,
        path: req.url,
        headers,
    }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
    });
    upstream.on('error', (err) => {
        log.warning('Upstream request failed', { error: err.message });
        if (!res.headersSent) sendJson(res, 502, { error: 'MCP server not reachable yet, retry shortly.' });
        else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    if (body) upstream.end(body);
    else req.pipe(upstream);
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function isToolCall(body) {
    try {
        const parsed = JSON.parse(body.toString('utf8'));
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        return messages.find((m) => m?.method === 'tools/call');
    } catch {
        return undefined;
    }
}

const server = http.createServer(async (req, res) => {
    if (req.headers['x-apify-container-server-readiness-probe']) {
        return sendJson(res, 200, { status: 'ok' });
    }

    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/' && req.method === 'GET') {
        return sendJson(res, 200, {
            name: 'Grafana MCP Server (read-only)',
            mcpEndpoint: MCP_PATH,
            configured: !credentialsMissing,
        });
    }
    if (pathname !== MCP_PATH) return sendJson(res, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}` });

    if (credentialsMissing && req.method === 'POST') {
        const body = await readBody(req);
        const toolCall = isToolCall(body);
        if (toolCall) {
            return sendJson(res, 200, {
                jsonrpc: '2.0',
                id: toolCall.id ?? null,
                result: { isError: true, content: [{ type: 'text', text: MISSING_CREDENTIALS_MESSAGE }] },
            });
        }
        return proxy(req, res, body);
    }

    return proxy(req, res);
});

server.listen(PUBLIC_PORT, () => {
    log.info(`Grafana MCP Server listening on port ${PUBLIC_PORT}, MCP endpoint ${MCP_PATH}`, {
        grafanaUrl: grafanaUrl ?? null,
        standby: Actor.config.get('metaOrigin') === 'STANDBY',
    });
});

const shutdown = () => {
    shuttingDown = true;
    server.close();
    child.kill('SIGTERM');
};
Actor.on('aborting', shutdown);
Actor.on('migrating', shutdown);
