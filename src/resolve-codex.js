import process from "node:process";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

export class CodexResolveError extends Error {
  constructor(message, { code = "codex_resolve_failed", details = {} } = {}) {
    super(message);
    this.name = "CodexResolveError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Resolved on every call, never cached: `codex update` installs the new release beside
 * the old one, which stays on disk, so a stored path kept running the old CLI and refused
 * its new models until a restart. The lookup costs ~80ms on Windows (`where` plus
 * `codex --version`), which is small next to a delegation.
 */
export function resolveCodex({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  runVersion = defaultRunVersion,
  lookupOnPath = whichOnPath,
} = {}) {
  const warnings = [];
  const candidates = [];

  const override = String(env.CODEX_DELEGATE_COMMAND || "").trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new CodexResolveError(
        `CODEX_DELEGATE_COMMAND must be an absolute path (got "${override}").`,
        { code: "override_not_absolute" }
      );
    }
    if (!existsSync(override) || !statSync(override).isFile()) {
      throw new CodexResolveError(`CODEX_DELEGATE_COMMAND not found: ${override}`, {
        code: "override_missing",
      });
    }
    candidates.push({ command: override, source: "override" });
  }

  const standalone = findNewestStandalone(homeDir, platform);
  if (standalone) candidates.push({ command: standalone, source: "standalone" });

  const pathLookup = lookupOnPath("codex", platform, env);
  const which = typeof pathLookup === "string" ? pathLookup : pathLookup?.command;
  if (typeof pathLookup === "object" && pathLookup?.unusable) {
    warnings.push(
      "Codex on PATH is a .cmd shim that cannot be spawned directly; install the standalone Codex or set CODEX_DELEGATE_COMMAND to codex.exe."
    );
  }
  if (which) {
    // Prefer the standalone binary on Windows: a PATH entry that turns out to be
    // a wrapper cannot be spawned directly, and we know the standalone is an .exe.
    if (platform === "win32" && standalone) {
      warnings.push(
        "Preferring the standalone Codex binary on Windows: a PATH entry can be a wrapper rather than a directly spawnable executable."
      );
    } else {
      const shimTarget = typeof pathLookup === "object" ? pathLookup : null;
      candidates.push({
        command: which,
        commandArgs: shimTarget?.commandArgs ?? [],
        source: "path",
        ...(shimTarget?.shim ? { shim: shimTarget.shim } : {}),
      });
    }
  }

  if (!candidates.length) {
    // The warnings are the diagnosis: the shim note is written for exactly this
    // machine, and "not found" alone gives it nothing to act on.
    throw new CodexResolveError(
      "Codex CLI not found. Install Codex, or set CODEX_DELEGATE_COMMAND to an absolute binary path.",
      { code: "not_found", details: warnings.length ? { warnings } : {} }
    );
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      // The version is reported, never gated on. A floor here could only ever say
      // "older than what we happened to test", and refusing an install on that
      // basis breaks setups that work to protect against ones we never tried.
      const commandArgs = candidate.commandArgs ?? [];
      const version = parseVersion(runVersion(candidate.command, commandArgs));
      return {
        command: candidate.command,
        // Go before every Codex argument: the bin script when an npm shim resolves to node.
        commandArgs,
        source: candidate.source,
        ...(candidate.shim ? { shim: candidate.shim } : {}),
        version: version ? formatVersion(version) : null,
        warnings,
      };
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    // Re-wrap only to carry the notes: the message and code stay the caller's
    // contract, and a plain error from a probe keeps its shape when there is
    // nothing to add.
    if (!warnings.length) throw lastError;
    throw new CodexResolveError(lastError.message || "Failed to resolve a usable Codex CLI.", {
      code: lastError.code ?? "codex_resolve_failed",
      details: { ...lastError.details, warnings },
    });
  }
}

function findNewestStandalone(homeDir, platform) {
  const releases = path.join(homeDir, ".codex", "packages", "standalone", "releases");
  if (!existsSync(releases)) return null;
  let names;
  try {
    names = readdirSync(releases);
  } catch {
    // A file, a broken symlink, or a directory we cannot list: same answer as
    // a missing tree, so the override and PATH still get a turn.
    return null;
  }
  let best = null;
  let bestVer = null;
  for (const name of names) {
    const ver = parseVersion(name);
    if (!ver) continue;
    const bin = path.join(
      releases,
      name,
      "bin",
      platform === "win32" ? "codex.exe" : "codex"
    );
    if (!existsSync(bin)) continue;
    if (!bestVer || compareSemver(ver, bestVer) > 0) {
      bestVer = ver;
      best = bin;
    }
  }
  return best;
}

/**
 * @returns {string | { command: string | null, commandArgs?: string[], shim?: string, unusable?: boolean } | null}
 */
export function whichOnPath(command, platform, env, run = spawnSync) {
  const probe = platform === "win32" ? "where" : "which";
  // Synchronous: a hung probe freezes the server. SIGKILL: SIGTERM is catchable.
  const result = run(probe, [command], {
    encoding: "utf8",
    env,
    timeout: 5000,
    killSignal: "SIGKILL",
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) return null;
  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (platform !== "win32") return lines[0] || null;

  const executable = lines.find((line) => /\.exe$/i.test(line));
  if (executable) return executable;
  // An npm or pnpm codex.cmd runs bin/codex.js with node. Its target runs directly: the .cmd needs
  // cmd.exe, which would parse the caller's text in the argv.
  for (const line of lines) {
    const target = /\.cmd$/i.test(line) ? readCmdShim(line) : null;
    if (target) return { ...target, shim: line };
  }
  return lines.length ? { command: null, unusable: true } : null;
}

/**
 * The program an npm or pnpm .cmd shim runs, or null, matched as npm's read-cmd-shim does. A .js
 * target gets this server's node, as the shim does when no node.exe sits beside it.
 * @returns {{ command: string, commandArgs: string[] } | null}
 */
export function readCmdShim(file, nodePath = process.execPath) {
  let text;
  try {
    if (statSync(file).size > 64 * 1024) return null;
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const relative = text.match(/"%(?:~dp0|dp0%)\\([^"]+?)"\s+%[*]/)?.[1];
  if (!relative) return null;
  const target = path.join(path.dirname(file), ...relative.split(/[\\/]/).filter(Boolean));
  try {
    if (!statSync(target).isFile()) return null;
  } catch {
    return null;
  }
  if (/\.exe$/i.test(target)) return { command: target, commandArgs: [] };
  if (/\.[cm]?js$/i.test(target)) return { command: nodePath, commandArgs: [target] };
  return null;
}

function defaultRunVersion(command, commandArgs = []) {
  const result = spawnSync(command, [...commandArgs, "--version"], {
    encoding: "utf8",
    timeout: 5000,
    killSignal: "SIGKILL",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new CodexResolveError(`codex --version failed (exit ${result.status})`, {
      code: "version_probe_failed",
      details: { stderr: String(result.stderr || "").slice(0, 400) },
    });
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

/** @returns {[number, number, number] | null} */
export function parseVersion(text) {
  const m = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function formatVersion([maj, min, pat]) {
  return `${maj}.${min}.${pat}`;
}
