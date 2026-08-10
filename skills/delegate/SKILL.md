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

For the full input and result field semantics, the mode rules, and the concurrency and timeout
guarantees, read [reference.md](reference.md) in this skill directory.

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
3. **Review** — read `warnings` first, then `filesReportedByEditTools`, then the git diff; run tests/lint. The diff is what actually changed; the field only tells you which of it Codex edited directly.
   - A `warnings` entry always means something real; an empty `warnings` does not mean a clean run. The bridge sees failures Codex reports as failed tool calls, not ones it narrates in prose — a run that could not do the work often says so in `result` and nowhere else. A failed-tool-call warning means the reply may describe work that did not happen: verify against the diff before believing it.
   - `resultSource: "stream-fallback"` means the run never finished and `result` is the last thing Codex said, not an answer. Resume the thread.
   - If criteria fail: resume the **same thread** with `resumeThreadId` and a specific fix brief (pass the same `workspace`).
   - If a resume returns `resumed: false` with a new `threadId`, Codex minted a fresh thread and prior context did not carry over.
   - After 2 failed resumes, start a fresh thread with a rewritten brief.
4. **Report** — summarize what changed and whether acceptance criteria are met.

## Running several at once

Delegations run concurrently. Worth doing for **the same question to different models** (one
call per `model`, then compare) and for **independent work in independent directories** (one
worker per `workspace`). Not worth doing when the tasks touch the same files — two agents
writing one tree overwrite each other and the diff cannot attribute the damage. Split by
directory, or serialize.

To cancel one of several, pass its `delegationId`. See [reference.md](reference.md).

## Defaults

| Parameter | Default | Notes |
|---|---|---|
| `mode` | `agent` | `plan` / `ask` / `review` as needed |
| `model` | `gpt-5.6-terra` | Override **only** when the user asks for another model |
| `reasoningEffort` | `high` | Override **only** when the user asks (none\|minimal\|low\|medium\|high\|xhigh\|max). gpt-5.6-* reject `minimal`; older models reject `none`. A rejected value fails the turn and the model's own message says which values it takes |
| `fast` | `false` | Codex Fast mode (`service_tier` / `/fast`). Leave false; set true **only** when the user asks |
| `network` | `true` | Web search plus shell network. Pass `false` to seal a run |
| `workspace` | server cwd | Pass it — the default is the MCP **server's** cwd, not always your project root. Smallest directory holding the task's files; none → project root. Never one created for the call. **Required when resuming** — `codex exec resume` has no `--cd`, so an omitted workspace would run the thread in the server's directory, not the one it started in |

Other models (e.g. `gpt-5.6-sol`, `gpt-5.6-luna`) are available — pass `model` when the user requests one.

## Plan mode

1. `delegate(spec, mode="plan")` → save `threadId`, read `plan`.
2. Present the plan; wait for approval.
3. `delegate("implement the approved plan", mode="agent", resumeThreadId=<threadId>, workspace=<same workspace>)`.

## Review mode

Pass exactly one `reviewTarget`:

- `{ "kind": "uncommitted" }`
- `{ "kind": "base", "branch": "main" }`
- `{ "kind": "commit", "sha": "..." }`

Review cannot be resumed. Put focus instructions in `spec`.

## Reading the result

The result is one compact JSON block. Fields that carry no signal are omitted, so anything
present is worth reading. Check `status` before trusting `result`: a run that spawns and then
fails returns normally rather than raising, so a caller that only catches errors reads a
failure as an empty success.

Read `warnings` first, then `filesReportedByEditTools`, then the git diff. Every field's exact
meaning — and what its absence proves — is in [reference.md](reference.md).

## Timeouts

A quiet run is not a stuck run: Codex emits nothing while a shell command runs or the model
reasons, so long silent stretches are normal and are not timed out. Guards are a 60s
spawn-to-first-output deadline and a 1h hard cap (`timeoutMs`). Raise `timeoutMs` for work
that legitimately runs longer.
