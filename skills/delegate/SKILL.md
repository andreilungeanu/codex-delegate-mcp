---
name: delegate
description: >
  Delegate implementation to OpenAI Codex via the codex-delegate-mcp MCP delegate tool.
  Use when the user says delegate to Codex, hand off to Codex, offload this to Codex,
  use Codex for coding, plan before building with Codex, review with Codex, or resume
  a Codex delegation. Do not shell out to codex — use the delegate MCP tool.
---

# Delegate to Codex

You orchestrate; Codex implements. Use the **codex-delegate-mcp** MCP server — never run
`codex` from the shell for these tasks.

For the full input and result field semantics, the mode rules, and how concurrency and timeouts
behave, read [reference.md](reference.md) in this skill directory.

## When to delegate

- **Trivial** (one-liner, rename, typo): do it yourself.
- **Medium** (multi-file feature or refactor): one `delegate` call.
- **Large or risky**: `mode: "plan"` first; implement after approval.
- Advisory questions → `mode: "ask"`. Code review of a diff/commit → `mode: "review"`.

## Workflow

1. **Build the brief inline** in `spec`:
   - **Goal** — the outcome, precisely.
   - **Scope** — which files/directories are in play.
   - **Decisions already made** — quote the user's exact values verbatim.
   - **Done when** — verifiable acceptance criteria.
   Point at files to read; don't paste large code blocks.
2. **Call `delegate`** on codex-delegate-mcp.
3. **Review** — field meanings are in [reference.md](reference.md). Check `status` before trusting `result`, then `warnings`, then `filesReportedByEditTools`, then the git diff; run tests/lint. The diff is the better record of what changed.
   - If criteria fail: resume the **same thread** with `resumeThreadId` and a specific fix brief (pass the same `workspace`).
   - If a resume returns `resumed: false` with a new `threadId`, Codex minted a fresh thread and prior context did not carry over.
   - After 2 failed resumes, start a fresh thread with a rewritten brief.
4. **Report** — summarize what changed and whether acceptance criteria are met.

## Running several at once

Delegations run concurrently. Worth doing for **the same question to different models** (one
call per `model`, then compare) and for **independent work in independent directories** (one
worker per `workspace`). Not worth doing when the tasks touch the same files — two agents
writing one tree overwrite each other and the diff cannot say which did what. Split by
directory, or serialize.

To cancel one of several, pass its `delegationId`. See [reference.md](reference.md).

Leave `model`, `reasoningEffort` and `fast` at their defaults unless the user asks. Other models
(the `gpt-6-*` and `gpt-5.6-*` families) are available — pass `model` only on request. `workspace` is
required on every call, resumes included — pass the one the thread started in, or the
resumed turn runs somewhere else.

## Plan mode

1. `delegate(spec, mode="plan")` → save `threadId`, read `plan`.
2. Present the plan; wait for approval.
3. `delegate("implement the approved plan", mode="agent", resumeThreadId=<threadId>, workspace=<same workspace>)`.

## Review mode

Pass exactly one `reviewTarget`. Shapes, resume rule, and preflight: [reference.md](reference.md#review). Put focus instructions in `spec`.

## Timeouts

A quiet run is not a stuck run. Guards, the 1h cap, and `timeoutMs` are in [reference.md](reference.md#timeouts) and [CONFIGURATION.md](../../CONFIGURATION.md).
