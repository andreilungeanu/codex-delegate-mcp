# delegate tool reference

Read this when you need the full meaning of a result field, the rules for a mode, or how
concurrency and timeouts behave. [SKILL.md](SKILL.md) carries the workflow itself.

## Input

| Field | Default | Description |
| --- | --- | --- |
| `spec` | — | The task brief: goal, scope, decisions already made (quote the user's exact values verbatim), acceptance criteria. Point at files to read or mimic rather than pasting code. |
| `mode` | `agent` | `agent` edits, `plan` returns a structured plan, `ask` answers questions, `review` runs Codex's native review. An instruction to Codex, not a limit the bridge enforces — every mode can write. |
| `model` | `gpt-5.6-terra` | Codex model id. Other families (`gpt-5.6-sol`, `gpt-5.6-luna`) are available; pass one only when the user asks. |
| `reasoningEffort` | `high` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `gpt-5.6-*` reject `minimal`; older models reject `none`. A rejected value fails the turn, and the model's own message names what it takes. |
| `fast` | `false` | Codex Fast mode (`service_tier=fast`). Higher credit use — only when the user asks. |
| `webSearch` | `true` | Web search. `false` disables it and nothing else — the worker's shell reaches the network either way. |
| `workspace` | server cwd | Working directory for Codex. The default is the **MCP server process's** cwd, which for `npx` and plugin launches is not necessarily your project root — pass it explicitly. Smallest directory holding the task's files; with no such directory the project root is the floor. Must already exist; never create one for the call. |
| `resumeThreadId` | — | Resume an existing Codex thread. Pass the same `workspace`: `codex exec resume` has no `--cd`, so an omitted one runs the thread in the server's directory rather than the one it started in. |
| `timeoutMs` | `3600000` | Hard cap for the whole run. |
| `reviewTarget` | — | Required in `review` mode, rejected elsewhere. Exactly one of the three forms below. |

Environment variables and Codex binary resolution are documented in
[CONFIGURATION.md](../../CONFIGURATION.md).

## Return value

Every tool returns one compact JSON text block. Fields that carry no signal are omitted, so
anything present is worth reading.

| Field | When present | Meaning |
| --- | --- | --- |
| `result` | always | The final answer. Empty only when nothing could be salvaged. **Check `status` before trusting it** — a run that spawns and then fails returns normally rather than raising, so a caller that only catches errors reads a failure as an empty success. |
| `status` | always | `completed`, `failed` or `interrupted`. |
| `reason` | not `completed` | `cancelled`, `startup-timeout`, `hard-cap`, `agent-error`, `died-mid-turn`, `exit-nonzero`. |
| `resultSource` | salvage only | `stream-fallback` — the run never finished and `result` is the last thing Codex said, not an answer. Resume the thread. |
| `warnings` | non-empty only | Real diagnostics; read them first. Absence is **not** a clean bill of health: the bridge sees failures Codex reports as failed or declined tool calls, not ones it narrates in prose. Such a warning reports what Codex reported, not a verdict: Codex marks a command `failed` on any non-zero exit, which is normal for tests and type-checks, but it can also mean execution was blocked. Verify any claim that depends on those calls. |
| `filesReportedByEditTools` | non-empty only | Only what Codex's edit tool reported. Files written by a shell command it ran are **not** listed, and neither is anything written outside the workspace. Read the git diff; it is the better record, not a complete one. |
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
other and the diff cannot say which did what. The result warns when workspaces overlap, but
the warning arrives after the runs are already racing. Split by directory, or serialize.

To cancel: `delegationId` cancels one run, `threadId` cancels every delegation on that thread,
and passing neither cancels all of them. `cancel` waits for the processes to end rather than
returning on the kill request, with a status of `cancelled`, `nothing-active`, `not-running` or
`not-found`. A tree that outlives the kill deadline returns anyway and says so in `warnings`.

## Timeouts

A quiet run is not a stuck run. Codex emits nothing while a shell command runs or the model
reasons, so long silent stretches are normal and are not timed out. The only guards are a 60s
spawn-to-first-output deadline and the 1h hard cap (`timeoutMs`). Raise `timeoutMs` for work
that legitimately runs longer.
