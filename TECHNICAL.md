# Technical reference

This package is an MCP stdio server that delegates coding work to `codex exec`. The MCP host supplies a validated tool request; the server constructs and runs one Codex CLI invocation, reduces its JSONL stream to progress and result metadata, and returns the completed result to the host. Every command Codex runs is auto-approved, in every mode, so any mode can write anywhere the user account can reach. Configuration-specific behavior, including environment variables, networking, timeouts and Codex resolution, is documented in [CONFIGURATION.md](CONFIGURATION.md).

## Architecture

| Module | Ownership |
|---|---|
| `src/server.js` | Starts the stdio MCP server, registers `delegate`, `cancel`, and `doctor`, defines their input schemas, sends progress notifications, and serializes each tool response as compact JSON text. Exports `delegateOutputShape` as the in-repository delegate-result contract. |
| `src/delegate.js` | Validates a delegation, performs review preflight checks, creates temporary result/schema files, acquires and releases an operation lease, runs Codex, normalizes the result, and parses plan-mode output. |
| `src/command.js` | Defines modes and defaults, validates delegate input, and builds the `codex exec` argument vector and stdin prompt for initial, resumed, and review runs. |
| `src/run-codex.js` | Spawns Codex, consumes its JSONL output, reports progress, collects thread, usage, and edit-tool metadata, reads the final-message file, and classifies the completed process result. |
| `src/proc.js` | Tests child-process liveness and terminates a process tree. |
| `src/ops.js` | Tracks active delegations, assigns delegation IDs, associates running delegations with Codex thread IDs, and implements cancellation. |
| `src/resolve-codex.js` | Resolves, probes, caches, and refreshes the Codex CLI used by delegation and diagnostics. See [CONFIGURATION.md](CONFIGURATION.md) for resolution behavior. |
| `src/doctor.js` | Produces setup diagnostics for the plugin, MCP client, Codex CLI, login state, workspace, runtime, and optional CLI help-surface checks. |
| `src/git-preflight.js` | Checks that a review workspace is a Git repository and validates applicable review targets before Codex is spawned. |
| `src/edit-tool-files.js` | Extracts paths from native Codex `file_change` events and normalizes them relative to the workspace. |
| `src/version.js` | Defines the package version reported by the server and doctor. |

## Tool contract

All three tools use strict input schemas. Unknown input fields are rejected.

No tool declares an MCP `outputSchema`, and no tool returns `structuredContent`. Every tool returns exactly one compact JSON text block. Declaring an `outputSchema` obliges the server to also send `structuredContent`; a host that reads both it and the text block, including Codex, places the payload in the model context twice.

`src/server.js` exports `delegateOutputShape` as the in-repository contract for a successful delegate result. `test/server.test.js` enforces a strict copy of that shape, so a field added in `src/delegate.js` must also be added to the contract.

### `delegate`

`delegate` runs one Codex task. Its inputs are:

| Field | Type | Required | Notes |
|---|---|---:|---|
| `spec` | string | Yes | The task brief. |
| `mode` | `agent` \| `plan` \| `ask` \| `review` | No | Defaults to `agent`. |
| `workspace` | string | No | Must name an existing directory. It is required when `resumeThreadId` is provided. |
| `resumeThreadId` | string | No | Not valid with `review`. |
| `model` | string | No | Must be non-empty when supplied. |
| `reasoningEffort` | `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | No | Uses the configured default when omitted. |
| `fast` | boolean | No | Defaults to `false`. |
| `webSearch` | boolean | No | Defaults to `true`. See [CONFIGURATION.md](CONFIGURATION.md). |
| `timeoutMs` | integer | No | Must be from 1,000 through 86,400,000. See [CONFIGURATION.md](CONFIGURATION.md). |
| `reviewTarget` | object | In `review` mode | `{ kind: "uncommitted" }`, `{ kind: "base", branch }`, or `{ kind: "commit", sha }`. It is not valid in other modes. |

A successful result contains these fields. Optional fields are omitted when they carry no signal.

| Field | Type | Meaning |
|---|---|---|
| `result` | string | The authoritative final Codex message, present whole on `completed` only; every other status returns an empty string rather than a partial or streamed substitute. For a valid plan, this is the plan overview rather than a second copy of the plan JSON. |
| `status` | `"completed"` \| `"failed"` \| `"interrupted"` | Final run status. `completed` guarantees the final-message file was read. |
| `reason` | `"cancelled"` \| `"startup-timeout"` \| `"hard-cap"` \| `"agent-error"` \| `"died-mid-turn"` \| `"exit-nonzero"` \| `"result-unavailable"` | Present for an applicable non-completed result. `result-unavailable` means an otherwise finished run produced no readable final message — or, in plan mode, a final message that was not a valid plan. |
| `threadId` | string | Codex thread ID, when reported. |
| `delegationId` | string | Server-created ID for this delegation. It is announced in progress before the process starts and is returned for every result. |
| `resumed` | boolean | Present when a resume was requested; true only when Codex reported the requested thread ID. |
| `workspace` | string | Resolved workspace used for the run. |
| `cliVersion` | string | Resolved Codex CLI version, when available. |
| `usage` | object | Reported token counts: optional `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, and `reasoningOutputTokens`. |
| `filesReportedByEditTools` | string[] | Paths reported by native Codex edit-tool `file_change` events, normalized relative to the workspace where possible. It does not include files written by shell commands. |
| `plan` | object | Present for valid plan-mode output: `{ overview: string, steps: Array<{ title: string, detail: string }> }`. |
| `warnings` | string[] | Non-fatal warnings collected during the run. |
| `exitCode` | integer | Present only for a non-completed result when a usable exit code is available. |

If delegation throws before returning a result, the tool returns an error payload with `error` and `message`, and includes `details` when the error supplies it. The MCP response is marked as an error.

### `cancel`

`cancel` stops delegations owned by this server and waits for their processes to settle. Its inputs are optional:

| Field | Type | Meaning |
|---|---|---|
| `delegationId` | string | Cancels one delegation. This is the only handle available before Codex reports a thread ID. |
| `threadId` | string | Cancels every active delegation using that Codex thread. |

With neither field, it cancels every active delegation. If both are supplied, `delegationId` is used.

The normal result has one of the following forms:

| `status` | Additional fields |
|---|---|
| `"nothing-active"` | None. |
| `"not-found"` | `id`, an identifier with no active run — already finished or never seen; either way there is nothing to cancel. |
| `"cancelled"` | `cause: "user"`; `id` when a specific identifier was requested; and `cancelled`, an array of `{ delegationId, threadId }` records. |

If cancellation itself fails, the tool returns an error payload with `error: "cancel_failed"` and `message`, and marks the MCP response as an error.

### `doctor`

`doctor` reports diagnostics without running a model turn. Its inputs are:

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `deep` | boolean | No | Defaults to `false`. When true, runs help-only checks for `exec`, `exec review`, and `exec resume`. |
| `workspace` | string | No | Workspace to inspect; defaults to the server process working directory. |

Its result fields are:

| Field | Contents |
|---|---|
| `plugin` | `{ name, version }`. |
| `client` | `{ name, version, capabilities }` from the connected MCP client; name and version can be `null`. |
| `codex` | On success, `{ found: true, command, source, version }` and optional `notes`; otherwise `{ found: false, error, code }`. |
| `login` | `status` is `ok`, `failed`, or `skipped`; it also reports applicable `exitCode`, `detail`, or `reason`. |
| `recursionGuard` | `{ depth, active }`. |
| `workspace` | `{ path, exists, isDirectory }` and, when determinable for a directory, `isGitRepo`. |
| `runtime` | `{ node, platform, arch, cwd, transport }`; `transport` is `"stdio"`. |
| `warnings` | Diagnostic warnings. |
| `deep` | Present only when requested. It reports whether checks ran and, when they do, the `exec`, `exec review`, and `exec resume` surfaces with `ok`, `exitCode`, `hasJson`, and `hasOutputLastMessage`. |

## Local development

The project uses Node's built-in test runner. The `test/` directory mirrors the main modules with focused unit tests, plus package-manifest and version-sync coverage.

Run the normal test suite with:

```sh
npm test
```

Run the TypeScript check for the JavaScript sources with:

```sh
npm run typecheck
```

Run the package smoke test with:

```sh
npm run test:pack
```

`test:pack` creates a tarball, installs it into a temporary project, verifies the package contents, starts the installed MCP server through a symlinked package location, and confirms that it lists `delegate`, `cancel`, and `doctor`.

`.github/workflows/test.yml` runs these CI gates:

- The `test` job runs on Ubuntu, Windows, and macOS with Node 20 and 22, plus Ubuntu with Node 24. Each matrix entry runs `npm ci`, `npm test`, `npm pack --dry-run`, and `npm run test:pack`.
- The Ubuntu Node 22 `checks` job runs `npm run typecheck`, requires source coverage of at least 95% lines, 87% branches, and 90% functions, and runs `npm audit --omit=dev --audit-level=high`.
- The Ubuntu Node 22 `min-deps` job installs `@modelcontextprotocol/sdk@1.22.0` without saving it and runs `npm test`, ensuring the declared minimum SDK remains supported.
