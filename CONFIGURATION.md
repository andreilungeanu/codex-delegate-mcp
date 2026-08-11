# Configuration

Everything here is optional. The defaults are what the project runs on, and a malformed or
negative value falls back to its default rather than arming a guard that fails every call.

## Defaults

| Setting | Default | Notes |
|---|---|---|
| `model` | `gpt-5.6-terra` | Per call. Override only when asked for. |
| `reasoningEffort` | `high` | `gpt-5.6-*` reject `minimal`; older models reject `none`. |
| `network` | `true` | Web search. Does not affect the worker's shell network. See below. |
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

Concurrency is only safe across **disjoint workspaces**. Two agents writing one tree overwrite
each other, and the git diff cannot say which one did what. Starting a delegation while another
is running in the same directory, or in one that contains it, adds a warning to the result; it
is not refused, because plenty of concurrent runs over one tree only read it. Note that no mode
guarantees that any more — see [Sandbox](#sandbox).

Every run announces a `delegationId` in its progress stream before it spawns, and returns it
with the result. That is the handle `cancel` takes, and it is the only one that exists while a
run is still starting up — Codex does not publish a thread id until the child is up, so a run
that wedges during launch has nothing else to name it. `cancel` also accepts a `threadId`, which
cancels every delegation on that thread (a resume and the turn it resumes share one). With
neither, it cancels everything active.

## Network

Codex runs connected. `network: true` is the default, which sets `web_search="live"` in every
mode.

`network: false` turns off web search and nothing else. It does **not** seal a run. The flag that
used to close the worker's shell egress, `sandbox_workspace_write.network_access`, only bound the
`workspace-write` sandbox, and the bridge no longer sets a sandbox — so the shell reaches the
network either way. Verified: a `network: false` run fetched a public URL successfully.

## Timeouts

Codex emits nothing while a shell command runs or the model reasons, so **a quiet run is not a
stuck run** and mid-turn silence is never timed out. Only two guards bound a run:

- a **60s spawn-to-first-output deadline** — silence here does mean a wedged launcher;
- a **1h hard cap** on the whole run.

If a task legitimately runs longer, raise `timeoutMs` on the call rather than disabling a guard.

## Codex resolution

Resolution order is the `CODEX_DELEGATE_COMMAND` override, then the newest standalone install
under `~/.codex/packages/standalone/releases/`, then `codex` on `PATH`.

On Windows the standalone binary is preferred deliberately: the `PATH` entry is often a `.cmd`
shim, which cannot be spawned directly without a shell. If resolution looks wrong, run the
`doctor` tool — it re-resolves from scratch and reports what it found.

## Sandbox

There is none. The bridge passes `--sandbox danger-full-access` in every mode, including `ask`,
`plan` and `review`, and there is no setting to change it.

Codex's own sandbox blocked a command it ran from spawning a process of its own — `EPERM` under
both `workspace-write` and `read-only`. That stopped the worker running `npm test`, `node --test`
or any build tool, since all of those spawn. Disk access was never the constraint: writes to the
workspace and to the OS temp directory both succeeded under `workspace-write`.

What that costs, measured on an `ask`-mode run:

| | with `workspace-write` | now |
|---|---|---|
| write inside the workspace | works | works |
| spawn a child process | `EPERM` | works |
| `node --test` | fails | passes |
| write to your home directory | `EPERM` | **works** |
| shell reaches the network with `network: false` | blocked | **works** |

Nothing confines the worker to the workspace, to the repository, or to anything else your user
account can reach. Every mode is write-capable, `approval_policy` is `never`, so nothing prompts
first. Review the git diff after every run, not only after `agent` runs.
