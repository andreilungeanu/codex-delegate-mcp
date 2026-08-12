# Installing codex-delegate-mcp

Instructions for an AI agent (Cline, Claude Code, …) setting this server up on the user's machine.

## Prerequisites

1. **Node.js 20+** — `node --version`.
2. **OpenAI Codex CLI** — `codex --version`. If missing, install it per <https://developers.openai.com/codex/cli>.
3. **A logged-in Codex account** — run `codex login`. This opens a browser and is interactive:
   **ask the user to run it themselves**, do not attempt it in a background shell.

The server itself needs no install step; `npx` fetches it on first run.

## Configuration

Add to the MCP settings file (`cline_mcp_settings.json` for Cline):

```json
{
  "mcpServers": {
    "codex-delegate": {
      "command": "npx",
      "args": ["-y", "codex-delegate-mcp"]
    }
  }
}
```

No API keys and no environment variables are required. Auth is the Codex CLI's own session.

## Verify

Call the `doctor` tool. It reports the Node version, how the Codex CLI was resolved, whether the
CLI session is logged in, and whether the workspace is a git repository, naming whatever is
missing. A clean `doctor` means `delegate` is ready.

## Optional environment variables

| Variable | Purpose |
| --- | --- |
| `CODEX_DELEGATE_COMMAND` | Absolute path to a Codex binary, skipping resolution. |
| `CODEX_DELEGATE_STARTUP_MS` | Spawn-to-first-output deadline; `0` disables. |
| `CODEX_DELEGATE_HARD_CAP_MS` | Absolute cap on a single delegation (default 1 h). |
| `CODEX_DELEGATE_HEARTBEAT_MS` | Progress heartbeat while the run is quiet; `0` disables. |

Defaults are documented in [CONFIGURATION.md](CONFIGURATION.md); leave them unset unless the
user asks.
