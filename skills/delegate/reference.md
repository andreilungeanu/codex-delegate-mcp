# delegate tool reference

Read this when you need the full meaning of a result field, the rules for a mode, or how
concurrency and timeouts behave. [SKILL.md](SKILL.md) carries the workflow itself.

## Input

| Field | Default | Description |
| --- | --- | --- |
| `spec` | — | The task brief: goal, scope, decisions already made (quote the user's exact values verbatim), acceptance criteria. Point at files to read or mimic rather than pasting code. |
| `mode` | `agent` | `agent` edits, `plan` returns a structured plan, `ask` answers questions, `review` runs Codex's native review. An instruction to Codex, not a limit the bridge enforces — every mode can write. |
| `model` | `gpt-5.6-terra` | Codex model id. Other families (`gpt-5.6-sol`, `gpt-5.6-luna`) are available; pass one only when the user asks. A model outside the listed set is checked against the CLI before the run starts, and an unknown one is refused with the ids it does take. |
| `reasoningEffort` | `high` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. `ultra` is `gpt-5.6-sol` and `gpt-5.6-terra` only; `gpt-5.6-*` reject `minimal`; older models reject `none`. A rejected value fails the turn, and the model's own message names what it takes. |
| `fast` | `false` | Codex Fast mode (`service_tier=fast`). Higher credit use — only when the user asks. |
| `webSearch` | `true` | Web search. `false` disables it and nothing else — the worker's shell reaches the network either way. |
| `workspace` | required | Working directory for Codex. Smallest directory holding the task's files; with no such directory the project root is the floor. Must already exist; never create one for the call. |
| `resumeThreadId` | — | Resume an existing Codex thread. Pass the workspace the thread started in: `codex exec resume` has no `--cd`, so the turn runs wherever the child is spawned. |
| `timeoutMs` | `3600000` | Hard cap for the whole run. |
| `reviewTarget` | — | Required in `review` mode, rejected elsewhere. Exactly one of the three forms below. |

Environment variables and Codex binary resolution are documented in
[CONFIGURATION.md](../../CONFIGURATION.md).

## Return value

Every tool returns one compact JSON text block. Fields that carry no signal are omitted, so
anything present is worth reading.

| Field | When present | Meaning |
| --- | --- | --- |
| `result` | always | The authoritative final message on `status: "completed"` — empty or partial answers are never substituted. Empty on every other status; the thread and warnings carry what happened instead. **Check `status` before trusting it** — a run that spawns and then fails returns normally rather than raising, so a caller that only catches errors reads a failure as an empty success. |
| `status` | always | `completed`, `failed` or `interrupted`. |
| `reason` | not `completed` | `cancelled`, `startup-timeout`, `hard-cap`, `agent-error`, `died-mid-turn`, `exit-nonzero`, `result-unavailable`. The last means the run finished but its final message was missing, unreadable, or (in plan mode) not a valid plan — resume the thread for a concise final answer. |
| `warnings` | non-empty only | Real diagnostics; read them first. Absence is **not** a clean bill of health: the bridge sees failures Codex reports as failed or declined tool calls, not ones it narrates in prose. Such a warning reports what Codex reported, not a verdict; it carries its own reading of that status. |
| `filesReportedByEditTools` | non-empty only | Only what Codex's edit tool reported. Files written by a shell command it ran are **not** listed. Paths inside the workspace are relative to it; anything the edit tool touched outside it is listed as an absolute path. Read the git diff; it is the better record, not a complete one. |
| `resumed` | resume requested | `false` means Codex minted a fresh thread and prior context did not carry over. |
| `usage` | when reported | Per-turn token counts. Absent in `review`, which reports all zeros. |
| `exitCode` | not `completed` | Process exit code. |
| `delegationId` | always | This run's cancel handle. Also announced in progress before the run spawns, which makes it the only handle for a run that wedges during startup. |
| `threadId` | when Codex reported one | Pass as `resumeThreadId` to continue this thread. |
| `workspace`, `cliVersion`, `plan` | as applicable | |

## Modes

### plan

Workflow in [SKILL.md](SKILL.md#plan-mode).

### review

Pass exactly one `reviewTarget`:

- `{ "kind": "uncommitted" }`
- `{ "kind": "base", "branch": "main" }`
- `{ "kind": "commit", "sha": "..." }`

Review cannot be resumed, and it reports all-zero `usage`. Put focus instructions in `spec`.
A review whose repo or target does not resolve is refused before anything spawns.

### ask

Q&A, not read-only: `mode` is an instruction to Codex, not a limit the bridge enforces. Every
command is auto-approved, and a run can write outside the workspace, so review the git diff
after an `ask` run too.

## Running several at once

Delegations run concurrently, each cancellable by its own `delegationId`. Worth doing for:

- **the same question to different models** — one call per `model`, then compare;
- **independent work in independent directories** — one worker per `workspace`.

Not worth doing when the tasks touch the same files. Two agents writing one tree overwrite each
other and the diff cannot say which did what. Split by directory, or serialize.

To cancel: `delegationId` cancels one run, `threadId` cancels every delegation on that thread,
and passing neither cancels all of them. `cancel` waits for the processes to end rather than
returning on the kill request, with a status of `cancelled`, `nothing-active` or `not-found`.
`not-found` means no active run has this ID — the run already finished, or the id never
belonged to one; either way there is nothing to cancel. A tree that outlives the kill deadline
returns anyway and says so in `warnings`.

## Timeouts

A quiet run is not a stuck run. Codex emits nothing while a shell command runs or the model
reasons, so long silent stretches are normal and are not timed out. The only guards are a 60s
spawn-to-first-output deadline and the 1h hard cap (`timeoutMs`). Raise `timeoutMs` for work
that legitimately runs longer.
