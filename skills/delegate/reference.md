# delegate reference

What a result field or failure `reason` means and what to do next.

## Result

One compact JSON text block; a `delegate` run as an MCP task returns it as the task's result.
Fields that carry no signal are omitted, so anything present is worth reading.

| Field | When present | Meaning |
| --- | --- | --- |
| `status` | always | `completed`, `failed` or `interrupted`. A run that spawns and then fails returns normally rather than raising. |
| `result` | always | Codex's final message on `completed`; empty on every other status, where the thread and `warnings` say what happened. Partial answers are never substituted. |
| `reason` | not `completed` | See the table below. |
| `warnings` | non-empty | Read first. Codex's own notices (a rerouted model, a deprecated setting) appear on every status. Tool calls Codex reported as failed or declined appear only when the run did not complete, and failures it only narrates in prose never do, so absence is not a clean bill of health. |
| `filesReportedByEditTools` | non-empty | Files Codex's edit tool reported. Files written by a shell command are not listed. Paths inside the workspace are relative; others are absolute. The git diff is the better record. |
| `resumed` | resume requested | `false`: Codex started a fresh thread and the prior context did not carry over. |
| `usage` | when reported | Cumulative token counts for the thread (`scope: "thread"`), earlier turns included; do not sum across results for one thread. Absent in `review`. |
| `delegationId` | always | This run's `cancel` handle; also announced in progress before spawn. For an MCP task, the task id. |
| `threadId` | when Codex reported one | Pass as `resumeThreadId` to continue. |
| `plan` | `plan` mode, valid plan | The structured plan. |
| `exitCode` | not `completed`, code observed | Process exit code; absent after a signal. |
| `workspace` | always | |
| `cliVersion` | version known | |

| `reason` | Next step |
| --- | --- |
| `cancelled` | Stopped by `cancel` or the host. Resume the thread if the work should continue. |
| `startup-timeout` | No JSONL event from Codex before the startup deadline (60s by default). Run `doctor`. |
| `hard-cap` | The whole-run cap elapsed. Resume the thread; a longer `timeoutMs` is the user's call. |
| `agent-error` | Codex reported the turn failed; `warnings` carries its error. Act on that error before resuming. |
| `died-mid-turn`, `exit-nonzero` | The process ended without finishing the turn. Check the diff for partial work, then resume the thread. |
| `result-unavailable` | The run finished but its final message was missing, unreadable or (in `plan`) not a valid plan. Resume the thread and ask for a concise final answer. |

## Resume

Pass the `workspace` the thread started in: `codex exec resume` has no `--cd`, so the turn runs
wherever the child is spawned. A `review`, or a run that failed before Codex published a thread,
cannot be resumed; rerun it instead. For a `delegate` run as an MCP task, the task id works as
`resumeThreadId` while this server process runs. IDs beginning with `-` are rejected.

## Review

`reviewTarget` is exactly one of `{ "kind": "uncommitted" }`, `{ "kind": "base", "branch": "main" }`
or `{ "kind": "commit", "sha": "..." }`. A review whose repository or target does not resolve is
refused before anything spawns.

## Models and effort

The `model` and `reasoningEffort` fields list what the installed CLI advertised at server start;
`doctor deep` lists each model's levels. When the catalog is readable, an unknown model is
refused before the run, naming the ids the CLI takes; otherwise the id is forwarded and Codex
decides. An unadvertised effort is forwarded with a warning; Codex may normalize or
reject it. The catalog omits some accepted values: on CLI 0.156.1, `none` was accepted by luna
and sol and refused by `gpt-6-astra`. On luna models, `ultra` lowers to plain `max`. On models
that advertise `ultra`, it turns on the CLI's own task delegation; work those subagents do is
absent from `usage` and `filesReportedByEditTools`.
