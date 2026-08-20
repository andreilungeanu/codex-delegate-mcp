# Configuration

Everything here is optional. The defaults are what the project runs on, and a malformed or
negative value falls back to its default rather than breaking every call.

## Defaults

| Setting | Default | Notes |
|---|---|---|
| `model` | `gpt-5.6-luna` | Per call. Override only when asked for. |
| `reasoningEffort` | `xhigh` | `gpt-5.6-*` reject `minimal`; older models reject `none`. |
| `webSearch` | `true` | Web search. Does not affect the worker's shell network. See below. |
| `fast` | `false` | Codex Fast mode (`service_tier=fast`); higher credit use. |
| `timeoutMs` | `3600000` | Hard cap for the whole run. |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_DELEGATE_COMMAND` | auto | Absolute path to a Codex binary, skipping resolution. |
| `CODEX_DELEGATE_STARTUP_MS` | `60000` | Spawn to first JSONL event. `0` disables. |
| `CODEX_DELEGATE_HARD_CAP_MS` | `3600000` | Whole run; a per-call `timeoutMs` overrides it. |
| `CODEX_DELEGATE_HEARTBEAT_MS` | `30000` | Progress heartbeat while quiet. `0` disables. |

`CODEX_DELEGATE_DEPTH` is set on the child process as a recursion marker. If it is already set
when `delegate` is called, the call is refused — a delegated agent must not spawn another one.

## Running several at once

Delegations run concurrently, as many as you start.

Give them **disjoint workspaces** — necessary, though not sufficient: `workspace` is the worker's
working directory, and a run can reach outside it (see [SECURITY.md](SECURITY.md)). Two agents writing one
tree overwrite each other, and the git diff cannot say which did what.

Every run announces a `delegationId` in its progress stream before it spawns, and returns it
with the result. That is the handle `cancel` takes, and it is the only one that exists while a
run is still starting up — Codex does not publish a thread id until the child is up, so a run
that wedges during launch has nothing else to name it. `cancel` also accepts a `threadId`, which
cancels every delegation on that thread (a resume and the turn it resumes share one). With
neither, it cancels everything active.

## Web search

Codex runs connected. `webSearch: true` is the default, which sets `web_search="live"` in every
mode.

`webSearch: false` turns that off and nothing else. It does **not** seal a run, and nothing does —
the worker's shell reaches the network either way.

## Timeouts

Codex emits nothing while a shell command runs or the model reasons, so **a quiet run is not a
stuck run** and mid-turn silence is never timed out. Only two guards bound a run:

- a **60s spawn-to-first-output deadline** — silence here does mean a wedged launcher;
- a **1h hard cap** on the whole run.

If a task legitimately runs longer, raise `timeoutMs` on the call rather than disabling a guard.

## Codex resolution

Resolution order is the `CODEX_DELEGATE_COMMAND` override, then the newest standalone install
under `~/.codex/packages/standalone/releases/`, then `codex` on `PATH`.

On Windows the standalone binary wins whenever both are present, because a `PATH` entry that
turns out to be a `.cmd` shim cannot be spawned without a shell. If resolution looks wrong, run
the `doctor` tool — it re-resolves from scratch and reports what it found.
