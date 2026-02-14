# Cloudflare Workers MCP Dev

> Cloudflare Workers development with MCP servers for bindings, builds, observability, containers, and browser rendering.

## Overview

This plugin provides access to Cloudflare's managed MCP servers for developing and debugging Cloudflare Workers applications. Each MCP server connects via OAuth and provides specialized tools for different aspects of Workers development.

## MCP Servers Included

| Server | Purpose |
|--------|---------|
| **cloudflare-bindings** | Build Workers with storage (KV, R2, D1, Durable Objects), AI, and compute primitives |
| **cloudflare-docs** | Access up-to-date Cloudflare Developer Documentation |
| **cloudflare-builds** | Manage and monitor Workers Builds deployments |
| **cloudflare-observability** | Debug logs, analytics, and error traces for Workers |
| **cloudflare-containers** | Spin up sandbox development environments on demand |
| **cloudflare-browser** | Fetch web pages, convert to markdown, and take screenshots |

## Installation

```bash
# Add the constellos marketplace
claude plugin marketplace add https://github.com/constellos/claude-code

# Install this plugin
claude plugin install cloudflare-workers-mcp-dev@constellos
```

Or add to your project's `.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "cloudflare-workers-mcp-dev@constellos": true
  }
}
```

## Authentication

Each MCP server requires OAuth authentication with your Cloudflare account. On first use, you'll be prompted to authorize access through Cloudflare's OAuth flow.

## Use Cases

- **Building Workers**: Use bindings server to interact with KV, R2, D1, and Durable Objects
- **Debugging**: Use observability server to browse invocation logs and isolate errors
- **Documentation**: Use docs server to get current Cloudflare documentation
- **Testing**: Use containers server for isolated sandbox environments
- **Web Scraping**: Use browser server for screenshots and page content extraction

## References

- [Cloudflare MCP Servers Documentation](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/)
- [mcp-remote package](https://www.npmjs.com/package/mcp-remote)
- [cloudflare/mcp-server-cloudflare](https://github.com/cloudflare/mcp-server-cloudflare)

## License

MIT
