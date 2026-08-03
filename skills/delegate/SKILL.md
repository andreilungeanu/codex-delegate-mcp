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

## Defaults

| Parameter | Default | Notes |
|---|---|---|
| `mode` | `agent` | `plan` / `ask` / `review` as needed |
| `model` | `gpt-5.6-terra` | Override **only** when the user asks for another model |
| `reasoningEffort` | `high` | Override **only** when the user asks (none\|minimal\|low\|medium\|high\|xhigh). gpt-5.6-* reject `minimal`; older models reject `none`. A rejected value fails the turn and the model's own message says which values it takes |
| `fast` | `false` | Codex Fast mode (`service_tier` / `/fast`). Leave false; set true **only** when the user asks |
| `network` | `true` | Web search plus shell network. Pass `false` to seal a run |
| `workspace` | current cwd | Smallest directory that fits the task. **Required when resuming** — `codex exec resume` has no `--cd`, so an omitted workspace would run the thread in the server's directory, not the one it started in |

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

Fields that carry no signal are omitted, so anything present is worth reading.

| Field | When present | Meaning |
|---|---|---|
| `result` | always | The final answer. Empty only when nothing could be salvaged. |
| `status` | always | `completed` \| `failed` \| `interrupted` |
| `reason` | not `completed` | `cancelled`, `startup-timeout`, `hard-cap`, `agent-error`, `died-mid-turn`, `exit-nonzero` |
| `resultSource` | salvage only | `stream-fallback` — `result` is the last thing Codex said, not a final answer |
| `warnings` | non-empty only | Real diagnostics. Read first — but absence is not proof of a clean run |
| `filesReportedByEditTools` | non-empty only | Only what Codex's edit tool reported. Files written by a shell command it ran are **not** listed. The git diff is authoritative. |
| `resumed` | resume requested | `false` means a fresh thread was minted and prior context was lost |
| `usage` | when reported | Per-turn token counts. Absent in `review`, which reports all zeros |
| `exitCode` | not `completed` | Process exit code |
| `threadId`, `workspace`, `cliVersion`, `plan` | as applicable | |

## Timeouts

A quiet run is not a stuck run: Codex emits nothing while a shell command runs or the model
reasons, so long silent stretches are normal and are not timed out. Guards are a 60s
spawn-to-first-output deadline and a 1h hard cap (`timeoutMs`). Raise `timeoutMs` for work
that legitimately runs longer.
