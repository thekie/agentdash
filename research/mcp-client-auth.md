# MCP client auth for a self-hosted agentdash

Question: can mainstream MCP clients connect to a self-hosted Streamable HTTP server, possibly on `http://localhost`, that authenticates each Agent with a static bearer token? If not, what do they need instead, and what is the minimum auth agentdash must implement for the two-agent demo (Claude Code + Claude Desktop)?

Sources were read on 2026-11-01. Every claim links to the page that owns it.

## Summary

| Client | Remote Streamable HTTP with static `Authorization` header | OAuth (when the server asks for it) | `http://localhost` | Least-friction path to agentdash |
| - | - | - | - | - |
| **Claude Code** | Yes: `claude mcp add --transport http ... --header "Authorization: Bearer ..."`, or `headers` / `headersHelper` in `.mcp.json` [1] | DCR, CIMD (auto-discovered), or pre-registered `--client-id` with loopback callback [1][2] | Yes, the client runs locally [1] | Direct HTTP plus static header |
| **Claude Desktop**, custom connector (Settings > Connectors) | Only via "Request headers", which is beta for a limited set of organizations [2][3] | DCR, CIMD ("Claude's published identity", recommended), or your own client ID; callback `https://claude.ai/api/mcp/auth_callback` [2][3] | **No.** Connections come from Anthropic's cloud, not the device; private or firewalled servers do not connect [4]. The URL field asks for HTTPS [3] | Not usable for a localhost server |
| **Claude Desktop**, local config (`claude_desktop_config.json`) or desktop extension (`.mcpb`) | Not directly: local config entries are stdio commands [5]. A stdio bridge supplies the header | Handled by the bridge, if needed | Yes, the bridge runs on the device [4][6] | `npx mcp-remote http://localhost:PORT/mcp --header "Authorization:${AUTH_HEADER}"` |
| **Cursor** | Yes: `url` plus `headers`, with `${env:NAME}` interpolation [7] | DCR (public client), or static `CLIENT_ID`/`CLIENT_SECRET`; desktop callback `http://localhost:8787/callback`. CIMD not documented [7] | Yes, the docs' own example is `http://localhost:3000/mcp` [7] | Direct HTTP plus static header |
| **VS Code** (Copilot) | Yes: `type: "http"`, `headers` with `${input:...}` (`password: true`) [8] | CIMD preferred over DCR since 1.106 [9]; pre-registered `oauth.clientId` since 1.123 [10] | Yes, documented local URL example [8] | Direct HTTP plus static header |
| **ChatGPT** (custom MCP server / developer mode) | **No.** It "cannot present custom API keys"; options are OAuth, no auth, or mixed [11][12] | OAuth 2.1 + PKCE with CIMD (preferred), DCR, or predefined clients; no client-credentials grant [11] | **No** in practice: the server is reached from OpenAI's side (published egress IPs, OpenAI client cert) [11]; local testing goes through an HTTPS tunnel or OpenAI's "Secure MCP Tunnel" option [12][13] | Out of reach for a localhost v1 |

## Per client

### Claude Code

- Static header: `claude mcp add --transport http secure-api https://api.example.com/mcp --header "Authorization: Bearer your-token"`. `.mcp.json` supports environment variable expansion in `url` and `headers`, and a `headersHelper` command for generated headers [1].
- When a `headersHelper` returns an `Authorization` header, Claude Code "uses that credential as the server's authentication and doesn't fall back to OAuth for the server" [1].
- OAuth: supports servers that use DCR or a Client ID Metadata Document, discovered automatically, plus `--client-id` / `--client-secret` / `--callback-port` for pre-registered clients. Claude Code uses its own CIMD and a loopback redirect `http://localhost:<ephemeral>/callback`, separate from the hosted Claude apps' client [1][2].
- On the v2 MCP runtime it only sends OAuth credentials to token endpoints on HTTPS or on `localhost`/`127.0.0.1`/`::1` [1]. This only matters if agentdash ever ships OAuth.

### Claude Desktop

Claude Desktop has two separate mechanisms, and only one of them can reach a server on the Owner's machine.

1. **Custom connectors (remote).** Configured through the Claude account and brokered by Anthropic: "Claude connects to your remote MCP server from Anthropic's cloud infrastructure, rather than from your local device", for claude.ai, Desktop, Cowork and mobile alike. "Servers hosted on a private corporate network, behind a VPN, or blocked by a firewall won't connect" [4]. Traffic originates from `160.79.104.0/21` [2].
   - Auth types Claude supports: `oauth_dcr`, `oauth_cimd` (both default), `oauth_anthropic_creds`, `custom_connection`, `none` (default), and `static_headers`, which is "Beta, for a limited set of organizations" [2]. Owners without access do not see the **Request headers** section [3].
   - A `401` is required to start sign-in; Claude reads `resource_metadata` from `WWW-Authenticate`, falls back to probing `/.well-known/oauth-protected-resource`, uses only the first `authorization_servers` entry, requires S256 PKCE, and uses CIMD only when the AS advertises `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported` [2].
   - The private-network answer is MCP tunnels, which are a research preview for Enterprise organizations and still expect OAuth on each server [14].
   - Result: a custom connector cannot reach `http://localhost:PORT` on the Owner's machine, whatever auth agentdash implements. It would need a public HTTPS URL (own tunnel or hosting) and, for most accounts, OAuth or no auth.
2. **Local MCP servers.** `claude_desktop_config.json` entries launch a local process (`command`, `args`, `env`) over stdio [5]. The support article calls these "a separate mechanism" that uses the local network [4]. Desktop extensions (`.mcpb` bundles) are the packaged form of the same thing and run on the device [6].
   - A stdio-to-HTTP bridge here gives Claude Desktop the same static-header connection Claude Code has. `mcp-remote` (0.15.2, published 2026-10-20) accepts `--header`, defaults to `http-first` transport, and allows plain `http://` for `localhost`/`127.0.0.1` without `--allow-http` (source: `src/lib/utils.ts`) [15].
   - Windows Desktop does not escape spaces inside `args`; the README's workaround is `"Authorization:${AUTH_HEADER}"` with `AUTH_HEADER="Bearer <token>"` in `env`. `--header-file` keeps the token out of the process list [15].

Example entry for the demo:

```json
{
  "mcpServers": {
    "agentdash": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:4242/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <agent token>" }
    }
  }
}
```

### Cursor

`url` plus optional `headers`; `url` and `headers` interpolate `${env:NAME}`. Streamable HTTP supported. OAuth uses authorization code + PKCE with DCR (Cursor registers as a public client) or a static `auth` block with `CLIENT_ID` and optional `CLIENT_SECRET`. Fixed callbacks: `https://www.cursor.com/agents/mcp/oauth/callback` (web) and `http://localhost:8787/callback` (desktop). The docs do not mention CIMD [7].

### VS Code

`type: "http"` (or `"sse"`), `url`, `headers`, e.g. `"Authorization": "Bearer ${input:api-token}"` with a `password: true` input. VS Code tries Streamable HTTP first and falls back to SSE [8]. CIMD is preferred over DCR when the authorization server supports it (1.106) [9]; a pre-registered OAuth client ID can be set in `mcp.json` with the secret in OS secret storage (1.123) [10]. Input variables are not supported in portable configs and such servers are not forwarded to Copilot harness sessions [16].

### ChatGPT

Authentication options are "OAuth, No authentication, and OAuth or no authentication"; transports are SSE and streaming HTTP [12]. ChatGPT "does not support machine-to-machine OAuth grants" and cannot present "custom API keys or customer-provided mTLS certificates"; OAuth registration uses CIMD (preferred), DCR or predefined clients [11]. Requests come from OpenAI's infrastructure (servers can allowlist OpenAI's egress ranges or verify its client certificate) [11], so a localhost server needs an HTTPS tunnel or OpenAI's Secure MCP Tunnel option [12][13]. Plan access per OpenAI's help article: developer mode with full MCP for Business and Enterprise/Edu, read/fetch-only for Pro [17]; the article could not be fetched directly (HTTP 403), so this comes from its search snippet.

## Recommendation for agentdash v1

**Minimum auth: the static per-Agent bearer token from the stack decision. No OAuth in v1.**

- Claude Code connects directly: `claude mcp add --transport http agentdash http://localhost:PORT/mcp --header "Authorization: Bearer <token>"`.
- Claude Desktop connects through a local stdio bridge (`mcp-remote` with `--header`) in `claude_desktop_config.json`. OAuth would not help here: the custom connector path cannot reach localhost at all, because its requests come from Anthropic's cloud [4].
- Cursor and VS Code work with the same static header, so the "connect your agent" docs cover four clients with one auth scheme.
- ChatGPT is out of v1 scope. It would need a public HTTPS endpoint plus OAuth (or no auth), which conflicts with the self-hosted localhost setup.

Implementation notes for the middleware:

- On a missing or wrong token, answer `401` with `WWW-Authenticate: Bearer` and **no** `resource_metadata`, and serve nothing under `/.well-known/oauth-*`. Claude clients start OAuth discovery from a `401` with that pointer or from those well-known paths [2]; with neither, the failure stays a plain auth error instead of a broken sign-in flow.
- Accept the token only from the `Authorization` header, never a query parameter [2].
- Keep Host/Origin validation in front of `/mcp` (DNS rebinding).
- Optional nicety, not required for the demo: a `npx agentdash connect --token ...` stdio bridge or an `.mcpb` desktop extension would remove the `mcp-remote` dependency for Claude Desktop users [6].

**When OAuth becomes worth it:** if agentdash is ever reachable on a public HTTPS URL and should work as a Claude (web/Desktop/mobile) custom connector or in ChatGPT. Then implement OAuth 2.1 + PKCE with CIMD, plus DCR as fallback, because Claude only picks CIMD when both metadata values are advertised [2] and Cursor documents only DCR [7].

## Sources

1. Claude Code, "Connect Claude Code to tools via MCP": https://code.claude.com/docs/en/mcp
2. Claude, "Authentication for connectors": https://claude.com/docs/connectors/building/authentication
3. Claude, "Add a connector that isn't in the directory": https://claude.com/docs/connectors/custom/add-unlisted
4. Claude Help Center, "Getting started with custom connectors using remote MCP": https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp
5. MCP docs, "Connect to local MCP servers": https://modelcontextprotocol.io/docs/develop/connect-local-servers
6. Claude, desktop extensions (MCPB), section "Install a local connector in the desktop app" of [3]; https://github.com/modelcontextprotocol/mcpb
7. Cursor, "Model Context Protocol": https://cursor.com/docs/context/mcp
8. VS Code, "MCP configuration reference": https://code.visualstudio.com/docs/copilot/reference/mcp-configuration
9. VS Code 1.106 release notes (CIMD): https://github.com/microsoft/vscode-docs/blob/main/release-notes/v1_106.md
10. VS Code 1.123 release notes (pre-registered client ID): https://code.visualstudio.com/updates/v1_123
11. OpenAI, Apps SDK / plugins "Authentication": https://developers.openai.com/apps-sdk/build/auth (also https://developers.openai.com/plugins/build/auth)
12. OpenAI, "Add custom MCP server": https://developers.openai.com/api/docs/guides/custom-mcp-server
13. OpenAI, "Connect from ChatGPT": https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
14. Claude, "MCP tunnels": https://claude.com/docs/connectors/mcp-tunnels/overview
15. `mcp-remote` README and `src/lib/utils.ts`: https://github.com/geelen/mcp-remote ; `npm view mcp-remote` (0.15.2, 2026-10-20)
16. VS Code, "Add and manage MCP servers": https://code.visualstudio.com/docs/copilot/customization/mcp-servers
17. OpenAI Help, "Developer mode and MCP apps in ChatGPT": https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta
