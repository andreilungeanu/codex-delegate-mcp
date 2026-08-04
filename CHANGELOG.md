# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [1.14.0] - 2026-08-04

One delegation at a time became several, and the brief stopped travelling on the command line.
Both were long-standing limits the code had reasons for; the reasons no longer held.

### Added

- Delegations run **concurrently**, as many as you start. Each gets a `delegationId`, announced in
  its progress stream *before* it spawns and returned with the result — the only cancel handle that
  exists while a run is still starting up, since Codex publishes no thread id until the child is up.
- `cancel` addresses one run by `delegationId`, or every run on a thread by `threadId` (a resume and
  the turn it resumes share one), or all of them when given neither.
- Starting a delegation in a workspace that overlaps a running one warns. Two agents writing one
  tree overwrite each other and the diff cannot say which did what. It is a warning, not a refusal:
  several read-only runs over one tree are fine.
- A `typecheck` script and CI gate (`tsc --noEmit` over `src`), which found a union that was never
  narrowed and a version tuple typed as a plain array.

### Changed

- **Breaking**: `cancel` statuses are now `cancelled`, `nothing-active`, `not-running` and
  `not-found`. `not-owned` is gone — with several runs live, an id either names one or it does not.
  A thread whose turn has ended reports `not-running` (still resumable), not `not-found`.
- **Breaking**: `CODEX_DELEGATE_WINDOWS_SANDBOX="off"` is removed. It omitted the flag, which
  degrades `workspace-write` to read-only, so every write was denied on a turn that still reported
  `completed`. Any value the bridge does not recognize is now passed to Codex as given, with a
  warning: the knob exists to survive a Codex change we have not shipped support for, and a list of
  modes we already knew about cannot do that.
- The Codex version is reported, never gated on. The old `0.144.0` floor was the version installed
  when the CLI was first investigated, not a measured minimum, and refusing an install on that basis
  breaks setups that work to guard against ones nobody tried. `doctor` drops `versionGate`.
- Node 20 is the declared floor, matching what CI has always tested.
- `MAX_ARGV_CHARS` is now `MAX_REVIEW_ARGV_CHARS` and applies to `review` alone.

### Fixed

- The brief travels on **stdin**, so it no longer appears in the child's command line, which any
  local process can read (`/proc/*/cmdline`, or WMI on Windows) — and briefs are told to quote the
  user's exact values. This also lifts the 28,000-character cap: a 60,000-character brief now runs.
  `review` is unchanged, since its target flags rule out a positional prompt.
- `SECURITY.md` named a result field the bridge does not ship (`filesReportedByAgent`).
- Lockfile refreshed past two high-severity advisories reaching us through the MCP SDK
  (`ip-address` SSRF, `fast-uri` host confusion). Neither is reachable from a stdio server.

## [1.13.0] - 2026-08-04

A live audit against Codex 0.145.0 found the default Windows configuration broken: every shell
command failed, in every mode, and the run still reported `status: "completed"`.

### Fixed

- The Windows sandbox defaults to `unelevated`. `elevated` needs an elevated session — on a normal
  one Codex cannot spawn its sandbox helper (`CreateProcessAsUserW failed: 5`) and every command
  fails. The flag is in `commonFlags`, so this hit `ask`, `plan` and `review` too.
- `CODEX_DELEGATE_WINDOWS_SANDBOX="off"` now warns in `agent` mode: it degrades `workspace-write`
  to read-only, so writes are denied on a turn that still completes. `CONFIGURATION.md` documents
  all three modes instead of recommending this one.
- An unknown sandbox mode falls back to the default with a warning, rather than reaching Codex and
  failing the run at config load.
- `doctor` files resolver notes under `codex.notes`, so `warnings` is empty when nothing is wrong.
  It also reports the effective Windows sandbox mode and checks the `workspace` it is given.

### Changed

- **Breaking**: `review` rejects a non-repository workspace or an unresolvable base/commit before
  spawning (`invalid_workspace` / `invalid_review_target`). The base check consults remotes as well
  as local refs, since Codex resolves `main` to `origin/main`; a git that cannot run blocks nothing.
- **Breaking**: `usage` is omitted when every count is 0 — `codex exec review` always reports zeros.
- Each Codex item is announced once, on `item.started`. Both events used to emit, so every command
  and edit notified twice and completion was announced as "running".
- The docs no longer claim an empty `warnings` means a clean run: the bridge sees failures Codex
  reports as failed tool calls, not ones it narrates in prose.

## [1.12.0] - 2026-08-03

A stress test drove the bridge end to end — real MCP client, real `spawn`, a scripted Codex — and
found four defects, every one of them on a path a run only takes once something has already gone
wrong. A successful run is unchanged.

### Fixed

- **A killed-but-unreaped run lost its entire result.** When the kill deadline fired on a process
  tree that refused to die, `exitCode` settled as `null`, and `null` is not a number: output
  validation rejected the payload *after* the handler had succeeded. The caller got
  `MCP error -32602` in place of the thread id (so the work could not be resumed), the list of
  files already edited — after a write-capable run — and both warnings. The exit code is now
  coerced where it is assigned, and a field that cannot be vouched for is dropped rather than
  allowed to take the result down with it. One consequence of the old behaviour: the
  "a process may still be running" warning was unreachable by construction, because the only
  condition that produced it was the one that destroyed the payload carrying it.
- **A background process holding stdout wedged the whole server for that process's lifetime.**
  The run awaited `'close'`, which fires only once every stdio pipe is closed, not when Codex
  exits. Anything Codex started that inherited stdout — a dev server, a watcher — kept the
  delegation open for as long as it ran: 30 235 ms for a 30 s orphan, against a Codex that had
  exited and written its answer in about 200 ms. The single-slot registry stayed held for the
  duration, so every later `delegate` was rejected with `operation_in_progress` and `cancel` was
  blocked behind the same wait — for up to the one-hour hard cap. The exit code now comes from
  `'exit'`, and the pipe drain is a bounded race measured from the exit; the same case returns in
  about 2.4 s with a warning naming the cause. The existing `DRAIN_MS` bound described exactly
  this scenario but was applied to the readline close and unref'd, so it never bound anything.
- **The result cap did not cover the stream-fallback path.** `maxResultBytes` guarded the
  final-message file, but the `agent_message` substituted when that file is missing was passed
  through at whatever size the CLI streamed it: a 64 MB message came back verbatim, 128 MB on the
  wire, reported as `status: "completed"`. A run whose authoritative file is missing is the more
  likely one to be pathological, not the less. Both paths are capped now.
- **`stderrTail` kept the wrong end of stderr.** Capture stopped at the first 64 KB and the tail
  was then taken of that prefix, so the diagnosis — which a dying process writes last — was
  precisely the part discarded. With 1 MB of noise ahead of `fatal: …`, the caller received 2 008
  characters of padding and never saw the reason. stderr is now kept as a rolling tail.

### Changed

- An over-cap result is truncated, with a warning saying so, instead of being discarded. The old
  behaviour answered a too-long result with an empty one.
- The thread id, the edited-file list and the plan step list are bounded — 200 characters, 500
  entries, 200 steps — each with a warning when the bound bites. All three are chosen by the child
  process and were echoed back verbatim; a 50 000-character thread id was stored in the operation
  registry and returned to the caller. An over-long thread id is refused rather than truncated: a
  truncated id resumes nothing and matches no cancel, while looking like it should do both.
- The text copy of a delegate result is no longer pretty-printed. It duplicates
  `structuredContent` for hosts that do not read structured output, and indenting the larger of
  the two copies cost about 15% of every result.

## [1.11.0] - 2026-07-25

A subtraction release. A review of every commit since 1.7.0 asked which fixes were load-bearing
and which were belt-and-suspenders; this removes the ones that guarded against nothing, plus a
field name that promised more than it delivered.

### Changed

- **Breaking**: `filesReportedByAgent` is now `filesReportedByEditTools`. Codex emits
  `file_change` for its own edit tool and nothing else, so files written by a shell command it
  ran — a formatter, a codegen script, `sed` — never appeared in the list. The old name read as
  "everything the agent touched" and quietly wasn't. The narrower list is still worth having:
  it says what Codex edited *itself*, which a diff against a dirty tree cannot.
- **Breaking**: `finalMessageAvailable` is gone from the result. `status`, `reason` and
  `resultSource` already said whether the answer was authoritative.
- **Breaking**: `idle-timeout` is gone from the `reason` enum, along with the
  `CODEX_DELEGATE_IDLE_MS` knob. 1.7.0 established that a mid-turn idle guard cannot tell a
  quiet run from a wedged one and defaulted it off; keeping it as dead-by-default configuration
  was the wrong half of that fix. A run is bounded by the startup deadline and the hard cap.
- Warnings that restated a field were dropped: the resume mismatch (`resumed: false` says it),
  the stream-fallback caveat (`resultSource` says it), and "final result unavailable"
  (`status` plus `reason` say it). Tool and server descriptions no longer restate defaults the
  schema already encodes.

### Removed

- The result-file `stat` before the read. The cap is 10MB; reading that and then rejecting it
  was never the OOM the guard was written for, and it cost a syscall and a TOCTOU gap on every
  successful run. The size check now runs on what was read.
- The executable path in the argv length estimate. `MAX_ARGV_CHARS` reserves 4,767 characters
  under the Windows limit and a Codex binary path is about 100, so the guard could not fire.

## [1.10.0] - 2026-07-25

Three findings from an independent audit of the delegate surface: an input that vanished, an
answer sent twice, and a cancel that answered before it was true.

### Changed

- **Breaking**: unknown tool inputs are rejected instead of silently dropped. The schemas were
  permissive, so zod stripped anything it did not recognise — a mistyped `resumeThredId` meant
  no resume, no error, and a thread's context quietly lost. The error names the offending key.
- **Breaking**: in `plan` mode `result` is the plan's `overview`, not the plan JSON repeated.
  The final message *is* the plan, so returning it verbatim shipped the same payload twice —
  most of a plan envelope was duplicate. `plan.overview` and `plan.steps` are unchanged, and a
  final message that does not parse as a plan still comes back in `result` untouched.
- `cancel` resolves once the process has actually ended rather than once the kill was
  requested. It previously returned `cancelled` off an un-awaited abort, so the caller could be
  told a delegation was over while Codex was still running. The kill deadline bounds the wait,
  so a process tree that refuses to die cannot hang the cancel either.

## [1.9.0] - 2026-07-25

A result-contract pass. 1.8.0 made failure legible; this makes the envelope worth reading —
a live `ask` returning one word carried roughly 400 characters of metadata, most of it the
same on every call.

### Changed

- **Breaking**: `status`, `exitCode`, `timedOut` and `cancelled` were four fields encoding one
  outcome. They collapse to `status` plus `reason` — `cancelled`, `startup-timeout`,
  `idle-timeout`, `hard-cap`, `agent-error`, `died-mid-turn`, `exit-nonzero` — which says which
  of the several ways to not finish actually happened. `reason` is omitted on a completed run,
  and `exitCode` is kept only when the run did not complete.
- **Breaking**: `mode` is gone from the result. It echoed the caller's own input.
- **Breaking**: `warnings`, `filesReportedByAgent` and `resumed` are omitted when they carry no
  signal — empty arrays, and `resumed` when no resume was requested. A field present on every
  call teaches the caller to stop reading it, and `warnings` is where real defects appear.
  Absence of `warnings` now means a clean run.

### Fixed

- The argv length limit counts the executable path. It measured only the arguments, so a spec
  just under the ceiling could still overflow `CreateProcess` behind a long binary path.
- A cached Codex resolution is revalidated before use. Reinstalling or moving the binary left
  the bridge spawning a path that no longer existed, failing every delegation until a restart.

### Internal

- `doctor` has tests: it was the least-covered module in the repo at 10% of lines, now 97%. Its
  subprocess calls are injectable so the login probe and the deep surface probe can be exercised
  without a real CLI.
- CI runs the matrix on Node 20 as well as 22 and 24, and the coverage floor rises to 93/85/87.
  Node 18 is still declared in `engines` but not exercised.

## [1.8.0] - 2026-07-25

A correctness pass driven by live probing against Codex CLI 0.145.0. The theme is that the
result envelope used to look the same whether a run worked or not; now failure is legible.

### Fixed

- A failed turn reports the reason Codex gave. `turn.failed` carries the diagnosis in
  `error.message` and an `error` event repeats it; neither was read, so a rejected argument
  came back as `result: ""` with no explanation. The one stderr line that was promoted,
  `Reading additional input from stdin...`, is boilerplate Codex prints on every non-TTY run —
  it is now filtered rather than presented as the fault.
- A turn whose tool calls all failed no longer reads as a clean success. Codex marks the item
  `status: "failed"`; only `item.type` was read, so a run where every command was denied
  returned `status: "completed"` with a reply describing work that never happened.
- The 90s idle timer no longer kills healthy runs. Codex emits nothing for the body of a shell
  command or a long reasoning pass — a captured session showed three frames followed by 120s of
  silence — so any command outrunning the timer was tree-killed just before finishing. `idleMs`
  was also unreachable: nothing passed it and no env var set it.
- A kill that fails to reap the process tree can no longer wedge the server. `taskkill` can
  report success and leave the tree up; the awaited `close` then never arrived, the lease was
  never released, and every later delegation failed with `operation_in_progress`.
- The temp directory is removed on every exit path. It was created before `buildCodexArgs` and
  `acquire`, so an oversized spec or a concurrent call leaked one per attempt.
- A cancel landing after a clean finish is no longer reported as `cancelled: true`.
- The result file is size-checked before it is read, instead of being loaded and then rejected.
- The `where`/`which` probe is time-boxed. It is synchronous, so a wedged probe froze the whole
  server: no progress, no `cancel`, no stdio.
- A `close` that arrives with lines still queued no longer drops them; a late `turn.failed`
  could otherwise read as success.

### Added

- `usage` — per-turn token counts (`inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`,
  `outputTokens`, `reasoningOutputTokens`). Codex has always sent these on `turn.completed`.
- `resultSource: "stream-fallback"` — when a run is interrupted before the authoritative
  `--output-last-message` file is written, the last streamed message is returned with a warning
  saying it is not the final answer. A completed run never falls back to narration.
- `CODEX_DELEGATE_STARTUP_MS` (60s spawn-to-first-output deadline), `CODEX_DELEGATE_IDLE_MS`
  (opt-in mid-turn idle, off by default), `CODEX_DELEGATE_HARD_CAP_MS`,
  `CODEX_DELEGATE_HEARTBEAT_MS`. A malformed or negative value falls back to its default.
- `CODEX_DELEGATE_WINDOWS_SANDBOX` overrides the hardcoded `windows.sandbox="elevated"`; `off`
  omits the flag. `elevated` needs an elevated session — on a normal one Codex cannot spawn its
  sandbox helper (`CreateProcessAsUserW failed: 5`) and every shell command fails.
- A `still working` progress heartbeat naming elapsed time, silence age, and the running
  command, and the thread id in the first progress notification.
- `reasoningEffort` accepts `none`, which the gpt-5.6 models take. They reject `minimal`, which
  older models take; a rejected value now returns the model's own list of what it accepts.
- CI gates on a coverage floor and a high-severity `npm audit`; the lockfile moved off the
  `fast-uri` advisory.

### Changed

- **Breaking**: `workspace` must exist and be a directory. A typo used to reach Codex and be
  created by its first write, so it looked like success at every layer.
- **Breaking**: `workspace` is required when `resumeThreadId` is set. `codex exec resume` has
  no `--cd`, so an omitted workspace silently ran the thread in the server's own directory
  while carrying the original workspace's context — a cross-repository write with no signal.
- **Breaking**: resolver setup notes no longer appear in a delegate result's `warnings`. They
  described the setup, not the run, and fired on every call; `doctor` reports them. `warnings`
  is now empty on a clean run, so anything in it is real.

## [1.7.0] - 2026-07-17

### Changed

- README positions Claude Code, Cursor, and Copilot as orchestrator hosts; dropped unused Codex-as-host plugin packaging
- Doctor resolves the Codex CLI fresh on every run and probes login/help surfaces asynchronously
- Delegate input/output schemas, tool descriptions, and server instructions derive from shared command constants (no more hardcoded default drift)
- stderr capture is capped by bytes (not UTF-16 chars) and decoded once after exit

### Fixed

- Process cleanup (timers, abort listener, readline) now runs even when spawn fails
- Already-cancelled requests no longer spawn Codex just to kill it
- Windows PATH resolution skips unspawnable `.cmd` shims with a clear warning instead of failing later with EINVAL
- Cancel tool returns a structured error instead of crashing if cancellation fails

## [1.6.0] - 2026-07-17

### Changed

- Replaced git porcelain `touchedFiles` with native JSONL `filesReportedByAgent`
- Timeout model is now 90s idle (activity-reset) + 1h hard cap (`timeoutMs`)
- Resume argv includes `--skip-git-repo-check`
- Failures include a stderr tail in warnings
- Empty/whitespace `model` is rejected instead of silently defaulting
- README, plugin packaging, marketplace manifests, and slash command

### Fixed

- Doctor deep-check no longer matches bare `-o` in help text
- Oversized specs are rejected before hitting the Windows argv limit

## [1.5.0] - 2026-07-16

### Changed

- Codex Fast mode defaults to Standard (`fast=false`, leave unset). Enable only when the user asks (`fast=true` → `service_tier="fast"` + `features.fast_mode=true`).

## [1.4.0] - 2026-07-16

### Fixed

- Explicitly force Codex Fast mode off on every run (`service_tier="default"`, `features.fast_mode=false`). Leaving it unset is not enough under catalog-driven Fast tiers.

## [1.3.0] - 2026-07-16

### Changed

- Default worker model is `gpt-5.6-terra` with `reasoningEffort=high` (needed because `--ignore-user-config` skips `~/.codex/config.toml`)
- Fast mode stays always off / not exposed; orchestrator overrides model or effort only when the user asks

## [1.2.0] - 2026-07-16

### Fixed

- Timeout no longer sets `cancelled=true` (only `timedOut`)
- Cancel with a caller `threadId` requires an exact match — stale ids cannot cancel a turn that has not published its thread id yet
- Whitespace-only `model` / `reasoningEffort` no longer become empty CLI flags
- Ask mode rejects `--output-schema` (plan-only)
- Exit 0 while turn is still `in_progress` is failed, not completed (no partial final)
- Plan mode validates plan JSON shape before exposing `plan`

### Tests

- Added sneaky unhappy-path suite for races, ownership, argv edge cases, and fail-closed finals

## [1.1.0] - 2026-07-16

### Fixed

- Prefer `turn.failed` over exit-code ambiguity when classifying run status
- Make process kill and PATH lookup injectable so cancel/resolver tests do not hang on Windows

### Tests

- Expanded unhappy-path coverage: empty spec, network/mode conflicts, resume+review, timeouts, plan schema requirements, fail-closed finals, cancel ownership, invalid model/live probes
- Live smoke verified ask/plan/agent/review/resume/cancel against Codex CLI 0.144.4

## [1.0.0] - 2026-07-16

### Added

- Lean MCP worker bridge for OpenAI Codex CLI (`codex exec --json`)
- Tools: `delegate`, `cancel`, `doctor`
- Modes: `agent`, `plan`, `ask`, and native `review`
- Fail-closed final answers via `--output-last-message`
- Concurrent cancel with single-flight operation registry
- Git-based `touchedFiles` when the workspace is a repo
- Claude / Codex / Copilot-oriented install docs and delegate skill
