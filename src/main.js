import { spawn } from 'node:child_process';
import http from 'node:http';
import { pipeline } from 'node:stream';

import { Actor, log } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const grafanaUrl = input.grafanaUrl?.trim();
const serviceAccountToken = input.serviceAccountToken?.trim();
const credentialsMissing = !grafanaUrl || !serviceAccountToken;

const PUBLIC_PORT = Actor.config.get('containerPort');
const UPSTREAM_PORT = 8000;
const MCP_PATH = '/mcp';

const MISSING_CREDENTIALS_MESSAGE = 'Grafana credentials are not configured, so tools that query Grafana will fail. '
    + 'Create a task for this Actor with "Grafana URL" and "Grafana service account token" filled in, '
    + 'and connect your MCP client to the task\'s Standby URL.';

if (credentialsMissing) log.warning(MISSING_CREDENTIALS_MESSAGE);

// Read-only by design: --disable-write removes every tool that changes Grafana state.
const child = spawn('mcp-grafana', [
    '--transport', 'streamable-http',
    '--address', `127.0.0.1:${UPSTREAM_PORT}`,
    '--endpoint-path', MCP_PATH,
    '--disable-write',
    ...(credentialsMissing ? ['--instructions-append', MISSING_CREDENTIALS_MESSAGE] : []),
], {
    env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Dummy URL keeps the server bootable without credentials, so tools/list still works.
        GRAFANA_URL: grafanaUrl || 'http://127.0.0.1:1',
        GRAFANA_SERVICE_ACCOUNT_TOKEN: serviceAccountToken,
        GRAFANA_ORG_ID: input.orgId?.toString(),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
});

let shuttingDown = false;
child.on('exit', async (code, signal) => {
    if (shuttingDown) return;
    log.error('mcp-grafana exited', { code, signal });
    await Actor.exit({ exitCode: 1, statusMessage: 'mcp-grafana exited unexpectedly' });
});

// Only MCP transport headers reach mcp-grafana. Everything else is dropped, notably Authorization and
// X-Grafana-* (URL, credentials and org come from the Actor input only) and Origin (mcp-grafana rejects it).
const FORWARDED_HEADERS = [
    'content-type', 'content-length', 'accept', 'user-agent',
    'mcp-session-id', 'mcp-protocol-version', 'last-event-id',
];

function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

const logPipelineError = (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') log.warning('Proxy stream failed', { error: err.message });
};

function proxy(req, res) {
    const headers = Object.fromEntries(
        FORWARDED_HEADERS.filter((name) => req.headers[name] !== undefined).map((name) => [name, req.headers[name]]),
    );
    const upstream = http.request({
        host: '127.0.0.1',
        port: UPSTREAM_PORT,
        method: req.method,
        path: req.url,
        headers,
    }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        pipeline(upstreamRes, res, logPipelineError);
    });
    upstream.on('error', (err) => {
        log.warning('Upstream request failed', { error: err.message });
        if (!res.headersSent) sendJson(res, 502, { error: 'MCP server not reachable yet, retry shortly.' });
        else res.destroy();
    });
    pipeline(req, upstream, logPipelineError);
}

const server = http.createServer((req, res) => {
    if (req.headers['x-apify-container-server-readiness-probe']) {
        return sendJson(res, 200, { status: 'ok' });
    }

    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === MCP_PATH) return proxy(req, res);
    if (pathname === '/' && req.method === 'GET') {
        return sendJson(res, 200, {
            name: 'Grafana MCP Server (read-only)',
            mcpEndpoint: MCP_PATH,
            configured: !credentialsMissing,
        });
    }
    return sendJson(res, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}` });
});

server.listen(PUBLIC_PORT, () => {
    log.info(`Grafana MCP Server listening on port ${PUBLIC_PORT}, MCP endpoint ${MCP_PATH}`, { grafanaUrl });
});

const shutdown = () => {
    shuttingDown = true;
    server.close();
    child.kill('SIGTERM');
};
Actor.on('aborting', shutdown);
Actor.on('migrating', shutdown);
