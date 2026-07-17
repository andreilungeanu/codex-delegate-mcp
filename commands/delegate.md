---
description: Delegate to OpenAI Codex via codex-delegate-mcp (see delegate skill)
argument-hint: <task description>
---

Follow the **delegate** skill (`/codex-delegate-mcp:delegate` or auto-invoked) for the full
workflow. Task: **$ARGUMENTS**

1. Pass a self-contained inline brief in `spec` (goal, scope, acceptance criteria) — do not create a spec file unless the user asks to persist it.
2. Call the `delegate` MCP tool — do not invoke `codex` directly.
3. Review the diff and confirm acceptance criteria.
