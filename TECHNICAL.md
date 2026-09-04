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
| `src/doctor.js` | Produces setup diagnostics for the plugin, MCP client, Codex CLI, login state, workspace, runtime, and optional CLI help-surface and model-catalog checks. |
| `src/model-catalog.js` | Reads the Codex model catalog (`codex debug models`) for the model preflight and the doctor drift checks. |
| `src/git-preflight.js` | Checks that a review workspace is a Git repository and validates applicable review targets before Codex is spawned. |
| `src/edit-tool-files.js` | Extracts paths from native Codex `file_change` events and normalizes them relative to the workspace. |
| `src/version.js` | Defines the package version reported by the server and doctor. |

## Tool contract

All three tools use strict input schemas. Unknown input fields are rejected.

No tool declares an MCP `outputSchema`, and no tool returns `structuredContent`. Every tool returns exactly one compact JSON text block. Declaring an `outputSchema` obliges the server to also send `structuredContent`; a host that reads both it and the text block, including Codex, places the payload in the model context twice.

`src/server.js` exports `delegateOutputShape` as the in-repository contract for a successful delegate result. `test/server.test.js` enforces a strict copy of that shape, so a field added in `src/delegate.js` must also be added to the contract.

Caller-facing input, result, cancel, and mode semantics live in [skills/delegate/reference.md](skills/delegate/reference.md). Environment knobs, timeouts, and Codex resolution live in [CONFIGURATION.md](CONFIGURATION.md).

`doctor` reports diagnostics without a model turn (`deep` adds help-surface and catalog checks). Its payload is the tool result itself.

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

CI is [`.github/workflows/test.yml`](.github/workflows/test.yml): matrix `npm test` / `test:pack`, plus Ubuntu Node 22 typecheck, coverage floors, audit, and a min-deps job against `@modelcontextprotocol/sdk@1.22.0`.
