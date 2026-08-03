# Configuration

Everything here is optional. The defaults are what the project runs on, and a malformed or
negative value falls back to its default rather than arming a guard that fails every call.

## Defaults

| Setting | Default | Notes |
|---|---|---|
| `model` | `gpt-5.6-terra` | Per call. Override only when asked for. |
| `reasoningEffort` | `high` | `gpt-5.6-*` reject `minimal`; older models reject `none`. |
| `network` | `true` | Web search in every mode, plus shell network in agent mode. See below. |
| `fast` | `false` | Codex Fast mode (`service_tier=fast`); higher credit use. |
| `timeoutMs` | `3600000` | Hard cap for the whole run. |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_DELEGATE_COMMAND` | auto | Absolute path to a Codex binary, skipping resolution. |
| `CODEX_DELEGATE_STARTUP_MS` | `60000` | Spawn to first JSONL event. `0` disables. |
| `CODEX_DELEGATE_HARD_CAP_MS` | `3600000` | Whole run; a per-call `timeoutMs` overrides it. |
| `CODEX_DELEGATE_HEARTBEAT_MS` | `30000` | Progress heartbeat while quiet. `0` disables. |
| `CODEX_DELEGATE_WINDOWS_SANDBOX` | `unelevated` | Windows sandbox mode: `unelevated`, `elevated`, or `off`. |

`CODEX_DELEGATE_DEPTH` is set on the child process as a recursion marker. If it is already set
when `delegate` is called, the call is refused — a delegated agent must not spawn another one.

## Network

Codex runs connected. `network: true` is the default, which sets `web_search="live"` in every
mode and `sandbox_workspace_write.network_access=true` — so in agent mode its shell can install
dependencies and fetch things, and in the read-only modes it can still look things up.

Pass `network: false` to seal a run: no web search, no shell egress. Worth doing when the
workspace contains untrusted content, since an agent that can both read your repo and reach
the network is the combination that turns a prompt injection into an exfiltration.

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
without one `workspace-write` degrades to read-only — so the bridge passes one itself. Codex
accepts two values; `off` is the bridge's own and omits the flag.

| Mode | Shell commands | Writes | Notes |
|---|---|---|---|
| `unelevated` (default) | work | work | What a normal session should use. |
| `elevated` | **all fail** on a non-elevated session | work | Needs an elevated session: otherwise Codex cannot spawn the sandbox helper (`CreateProcessAsUserW failed: 5`). Applies to `ask`, `plan` and `review` too, not just `agent`. |
| `off` | work | **all denied** | `workspace-write` degrades to read-only. |

Both failure modes still report `status: "completed"`, because Codex treats a denied write or a
dead helper as something to mention in prose rather than a failed turn. `off` warns for that
reason; if you set `elevated`, make sure the session really is elevated.
