# Codex Delegate MCP

**Stop burning your frontier agent's limits on boilerplate.**

Delegate implementation to the **OpenAI Codex CLI** — your agent writes the brief and reviews the diff.

[![npm version](https://img.shields.io/npm/v/codex-delegate-mcp)](https://www.npmjs.com/package/codex-delegate-mcp)
[![npm downloads](https://img.shields.io/npm/dt/codex-delegate-mcp)](https://www.npmjs.com/package/codex-delegate-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-listed-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=codex-delegate)
[![codex-delegate-mcp MCP server](https://glama.ai/mcp/servers/andreilungeanu/codex-delegate-mcp/badges/score.svg)](https://glama.ai/mcp/servers/andreilungeanu/codex-delegate-mcp)
[![node](https://img.shields.io/node/v/codex-delegate-mcp)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://github.com/andreilungeanu/codex-delegate-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/andreilungeanu/codex-delegate-mcp/actions/workflows/test.yml)

<img src="assets/logo-light.png" alt="Codex Delegate MCP logo" width="150" align="left" hspace="15">

Use your best coding agent where its judgment matters most: understanding the task, shaping the plan, and reviewing the result.

Codex Delegate is the MCP bridge that lets Claude Code, Cursor, Copilot — or any MCP client — hand implementation to the **OpenAI Codex CLI**, then get a clean, structured result back for review.

<br clear="left">

## 🧠 Frontier quality, kept

Your assistant does what frontier models are actually for: understands the task, writes a precise brief, reviews the finished diff. Codex holds its own as the implementer — guided and checked by a smarter orchestrator. The result reads like frontier work, because a frontier model planned it and signed off on it.

## ⚡ Done faster

Codex tears through multi-file edits while a frontier chat model would still be streaming the first file. You delegate, keep working with your assistant, and the diff shows up done.

## 🔋 Your limits stop being the bottleneck

Delegated work runs on the **OpenAI Codex CLI** and its own usage — separate from your orchestrator's chat quota. Your Claude, Cursor, or Copilot subscription spends tokens on the brief and the review; Codex does the grinding. On API? That's the per-token grind moved off your main bill.

# 

![You and your agent understand the task, write the brief and review the diff; the MCP delegate tool hands that brief to the OpenAI Codex CLI, which implements it and edits your workspace; one compact JSON result comes back with what changed, which files, and the thread id](assets/flow.png)

![A delegate result: one compact JSON block with the final answer, status, thread and delegation ids, workspace, Codex CLI version, per-turn token usage, and the files the edit tools reported changing](assets/result-json.png)

## Features

- 🤝 **Native plugins** — install into Claude Code, Cursor, or GitHub Copilot CLI and just say *"delegate this to Codex"*. The shared skill teaches your agent how to delegate well.
- 📦 **Clean, typed results** — one compact JSON block: the final answer, `status`, the files Codex edited, and per-turn token counts. Fields that carry no signal are omitted, so anything present is worth reading.
- 📋 **Four modes** — `agent` edits, `plan` returns a schema-validated plan you approve before anything is written, `ask` is read-only Q&A, and `review` runs Codex's own reviewer over uncommitted work, a base branch, or a single commit.
- 🧵 **Resume** — continue the same Codex thread with `resumeThreadId`, and get told if the context didn't actually carry over.
- 🧑‍🤝‍🧑 **Parallel, and cancellable for real** — fan a question across models or put independent workers on independent directories; `cancel` returns once the process has *ended*, not once the kill was requested.
- 🩺 **Self-diagnosing** — a `doctor` tool that tells you exactly what's missing if setup isn't right.
- 🔌 **Works everywhere MCP does** — VS Code, JetBrains, Windsurf, Visual Studio, and more.

The caveats are documented rather than buried: what an empty `warnings` does *not* prove, and when `result` is salvage instead of an answer, are in the [delegate reference](skills/delegate/reference.md).

## Install

You need [Node.js 20+](https://nodejs.org/) and the [OpenAI Codex CLI](https://github.com/openai/codex), already logged in (`codex login`).

### Claude Code

```shell
/plugin marketplace add andreilungeanu/codex-delegate-mcp
/plugin install codex-delegate-mcp@codex-delegate-mcp
```

Then just ask:

> Delegate to Codex: migrate src/api from callbacks to async/await and update the tests, then walk me through what changed.

That's the whole loop — Claude writes the brief, Codex grinds through the files, Claude walks you through the diff.

### Cursor

Add an MCP server in **Cursor Settings → MCP** (or project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "codex-delegate-mcp": {
      "command": "npx",
      "args": ["-y", "codex-delegate-mcp"]
    }
  }
}
```

Then ask Cursor to delegate implementation to Codex the same way.

### GitHub Copilot CLI

```shell
copilot plugin install andreilungeanu/codex-delegate-mcp
```

### More clients

<details>
<summary><strong>VS Code</strong> — one-click install, or <code>.vscode/mcp.json</code></summary>

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=codex-delegate-mcp&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22codex-delegate-mcp%22%5D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=codex-delegate-mcp&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22codex-delegate-mcp%22%5D%7D&quality=insiders)

```json
{
  "servers": {
    "codex-delegate-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "codex-delegate-mcp"]
    }
  }
}
```

Or run **Chat: Install Plugin From Source** with this repository's URL.

</details>

<details>
<summary><strong>JetBrains AI Assistant</strong> — Settings → Tools → AI Assistant → MCP</summary>

Under **Settings → Tools → AI Assistant → Model Context Protocol (MCP)**, add a server with command `npx` and arguments `-y codex-delegate-mcp`.

</details>

<details>
<summary><strong>Windsurf</strong> — <code>~/.codeium/windsurf/mcp_config.json</code></summary>

```json
{
  "mcpServers": {
    "codex-delegate-mcp": {
      "command": "npx",
      "args": ["-y", "codex-delegate-mcp"]
    }
  }
}
```

Heads-up: Cascade caps you at 100 tools across all servers.

</details>

<details>
<summary><strong>Visual Studio 2022</strong> — <code>%USERPROFILE%\.mcp.json</code></summary>

```json
{
  "servers": {
    "codex-delegate-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "codex-delegate-mcp"]
    }
  }
}
```

Requires 17.14+. Note the top-level key is `servers`, not `mcpServers`.

</details>

### Kiro, Kilo Code, and any other MCP client

Add the following server to the client's MCP config:

```json
{
  "mcpServers": {
    "codex-delegate-mcp": {
      "command": "npx",
      "args": ["-y", "codex-delegate-mcp"]
    }
  }
}
```

MIT © [Andrei Lungeanu](https://github.com/andreilungeanu)

<sub>[Configuration](CONFIGURATION.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md) · [Terms](TERMS.md) · [Changelog](CHANGELOG.md)</sub>
