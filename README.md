# Codex Delegate MCP

**Keep the brains. Delegate the build.**

Use your best coding agent where its judgment matters most: understanding the task, shaping the plan, and reviewing the result.

Codex Delegate is the MCP bridge that lets Claude Code, ChatGPT/Codex, Copilot — or any MCP client — hand implementation to the **OpenAI Codex CLI**, then get a clean, structured result back for review.

```
You  →  your agent (plans & reviews)
              │  MCP delegate tool
              ▼
        Codex CLI (implements)
              │  edits your workspace
              ▼
        Clean result: what changed, which files, the thread id
```

This is a **worker** for an orchestrator host — not a replacement for Codex's first-party `codex mcp-server`, and not a heavyweight security appliance. The host writes the brief and reviews the diff; this bridge runs a controlled `codex exec --json` turn and returns evidence the host can trust.

## Features

- **Native workflows** — `agent` (workspace-write), `ask` / `plan` (read-only), and Codex-native `review`
- **Truthful finals** — only `--output-last-message` after a clean exit counts as the answer (no JSONL guesswork)
- **Cancel that works** — one in-flight op with concurrent `cancel` + process-tree kill
- **Resume** — return `threadId`, continue with `resumeThreadId`
- **Clean results** — final text, touched files (git when available), warnings, status
- **Doctor** — setup diagnostics; `deep` is help-only (no model quota)
- **Works everywhere MCP does** — Claude Code, Codex, VS Code, Copilot, and more

## Requirements

- Node.js 18+
- OpenAI Codex CLI **0.144.0+** (tested on 0.144.x), already logged in

Optional: set `CODEX_DELEGATE_COMMAND` to an absolute Codex binary. On Windows the standalone install under `~/.codex/packages/standalone/releases/` is preferred over the PATH shim.

## Quick start (local checkout)

```powershell
Set-Location D:\codex-delegate-mcp2
npm install
npm test
```

Point an MCP host at:

```text
node D:\codex-delegate-mcp2\src\server.js
```

### Claude Code

```powershell
claude mcp add --transport stdio --scope user codex-delegate-mcp -- node D:\codex-delegate-mcp2\src\server.js
```

Then ask:

> Delegate to Codex: migrate src/api from callbacks to async/await and update the tests, then walk me through what changed.

### ChatGPT desktop / Codex

```powershell
codex mcp add codex-delegate-mcp -- node D:\codex-delegate-mcp2\src\server.js
```

### VS Code / Copilot

```json
{
  "servers": {
    "codex-delegate-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["D:\\codex-delegate-mcp2\\src\\server.js"]
    }
  }
}
```

## Tools

### `delegate`

| Input | Notes |
|---|---|
| `spec` | Required brief: goal, scope, decisions, acceptance criteria |
| `mode` | `agent` (default) \| `plan` \| `ask` \| `review` |
| `workspace` | Optional working directory |
| `resumeThreadId` | Resume a prior Codex thread |
| `model` / `reasoningEffort` | Defaults: `gpt-5.6-terra` / `high`. Override only when the user asks |
| `fast` | Default `false` (Standard). Set `true` only when the user asks for Fast (`/fast`) |
| `network` | Default `false`; only in `agent` |
| `timeoutMs` | Optional overall timeout |
| `reviewTarget` | Required for `review`: `uncommitted` \| `{kind:"base",branch}` \| `{kind:"commit",sha}` |

### `cancel`

Cancel the in-flight run. Optional `threadId` for ownership check. Returns `cancelled` \| `nothing-active` \| `not-owned`.

### `doctor`

Shallow: resolve Codex, login status, recursion guard, runtime. `deep: true` probes `exec` / `review` / `resume` help only (no model calls).

## Mode behavior

| Mode | Sandbox | Notes |
|---|---|---|
| `agent` | workspace-write | Network off unless `network: true` |
| `ask` | read-only | Plain final answer |
| `plan` | read-only | `--output-schema` + JSON plan in `plan` |
| `review` | read-only | Native `codex exec review`; no resume |

Every run uses `approval_policy=never`, `--ignore-user-config`, hooks disabled, and `--skip-git-repo-check` so non-git workspaces still work. Prefer a git repo so `touchedFiles` is useful.

## License

MIT © Andrei Lungeanu

[Security](SECURITY.md) · [Privacy](PRIVACY.md) · [Terms](TERMS.md) · [Changelog](CHANGELOG.md)
