# Installing codex-delegate-mcp

Instructions for an AI agent (Cline, Claude Code, …) setting this server up on the user's machine.

## Prerequisites

1. **Node.js 20+** — `node --version`.
2. **OpenAI Codex CLI** — `codex --version`. If missing, install it per <https://developers.openai.com/codex/cli>.
3. **A logged-in Codex account** — run `codex login`. This opens a browser and is interactive:
   **ask the user to run it themselves**, do not attempt it in a background shell.

The server itself needs no install step; `npx` fetches it on first run.

## Configuration

Add a local stdio server. Many hosts use a top-level `mcpServers` object:

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

Host-specific files and shapes — including OpenCode and Kilo Code (`mcp` + `type: "local"` + `command` as one array) and Zed (`context_servers`) — are in the README. Do not paste `mcpServers` into those three.

No API keys and no environment variables are required. Auth is the Codex CLI's own session. Optional knobs: [CONFIGURATION.md](CONFIGURATION.md).

## Verify

Call the `doctor` tool. It reports the Node version, how the Codex CLI was resolved, whether the
CLI session is logged in, and whether the workspace is a git repository, naming whatever is
missing. A clean `doctor` means `delegate` is ready.
