# Grafana MCP Server

Remote, **read-only** [MCP](https://modelcontextprotocol.io) server for your Grafana instance, running as an Apify Standby Actor.
It wraps the official [`grafana/mcp-grafana`](https://github.com/grafana/mcp-grafana) (v2.1.1) with `--disable-write`,
so only tools that read data from Grafana are exposed (dashboards, datasources, Prometheus, Loki, Tempo, Pyroscope, alerting, OnCall, incidents).

## Setup

1. Create a Grafana service account (a **Viewer** role is enough) and a token for it.
2. Create a **task** for this Actor and fill in:
   - **Grafana URL**, e.g. `https://grafana.example.com`
   - **Grafana service account token** (stored as a secret)
   - **Grafana organization ID** (optional)
3. In the task's Standby settings, make sure the Actor input is passed to Standby runs.
4. Copy the task's Standby URL and append `/mcp`. This is the MCP endpoint.

Every request needs an Apify API token. Prefer a scoped token that can only run this Actor/task.

## Connecting clients

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http grafana https://<task-standby-host>/mcp --header "Authorization: Bearer <APIFY_TOKEN>"` |
| Claude API (MCP connector), Claude Managed Agents | Server URL `https://<task-standby-host>/mcp`, Apify token as the bearer / authorization token |
| claude.ai, Claude Desktop | Custom connector with URL `https://<task-standby-host>/mcp?token=<APIFY_TOKEN>`. If your organization has request-header auth for connectors, use an `Authorization: Bearer <APIFY_TOKEN>` header instead of the query parameter. |

## Notes

- Grafana credentials come only from the Actor input; per-request `X-Grafana-*` overrides are stripped.
- Without credentials, the server still starts and lists tools, but every tool call returns an error explaining how to configure them.
- Pricing: free; you pay only for Apify platform usage of the Standby runs.
