# Configuration

Everything here is optional. The defaults are what the project runs on, and a malformed or
negative value falls back to its default rather than arming a guard that fails every call.

## Defaults

| Setting | Default | Notes |
|---|---|---|
| `model` | `gpt-5.6-terra` | Per call. Override only when asked for. |
| `reasoningEffort` | `high` | `gpt-5.6-*` reject `minimal`; older models reject `none`. |
| `network` | `false` | Agent mode only. Also gates web search. |
| `fast` | `false` | Codex Fast mode (`service_tier=fast`); higher credit use. |
| `timeoutMs` | `3600000` | Hard cap for the whole run. |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_DELEGATE_COMMAND` | auto | Absolute path to a Codex binary, skipping resolution. |
| `CODEX_DELEGATE_STARTUP_MS` | `60000` | Spawn to first JSONL event. `0` disables. |
| `CODEX_DELEGATE_HARD_CAP_MS` | `3600000` | Whole run; a per-call `timeoutMs` overrides it. |
| `CODEX_DELEGATE_HEARTBEAT_MS` | `30000` | Progress heartbeat while quiet. `0` disables. |
| `CODEX_DELEGATE_WINDOWS_SANDBOX` | `elevated` | Windows sandbox mode; `off` omits the flag entirely. |

`CODEX_DELEGATE_DEPTH` is set on the child process as a recursion marker. If it is already set
when `delegate` is called, the call is refused — a delegated agent must not spawn another one.

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

## Windows sandbox

`--ignore-user-config` strips any `[windows]` sandbox setting from your own Codex config, and
without one `workspace-write` degrades to read-only. The default `elevated` restores it, but it
needs an elevated session: on a normal one Codex cannot spawn the sandbox helper at all
(`CreateProcessAsUserW failed: 5`) and every shell command fails. Set
`CODEX_DELEGATE_WINDOWS_SANDBOX=off` to omit the flag, or to another mode Codex accepts.
