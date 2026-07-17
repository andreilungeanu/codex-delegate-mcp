# Security

## What this plugin does

`codex-delegate-mcp` spawns the **OpenAI Codex CLI** (`codex exec`) in your workspace with
approval policy `never`. Agent-mode tasks can modify, create, or delete files under the
chosen `workspace` directory (Codex sandbox: `workspace-write`).

Treat every `delegate` call like handing an engineer write access to that tree. Your MCP
host (Claude Code, etc.) is the orchestrator: it should scope the brief, then review
`filesReportedByAgent` and the git diff.

## Recommendations

- Point `workspace` at the smallest directory that contains the task.
- Review `filesReportedByAgent` and the git diff before committing.
- Use `mode: "plan"` or `mode: "ask"` when you do not want writes.
- Keep `network` false unless the task needs it.
- Run verification (tests, lint) after delegation — the delegate skill asks the host to do this.

## Reporting vulnerabilities

Email the maintainer listed in `package.json`. Do not file a public issue with exploit details.
