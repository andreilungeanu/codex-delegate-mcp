import process from "node:process";
import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const MIN_VERSION = "0.144.0";
const MIN = [0, 144, 0];

export class CodexResolveError extends Error {
  constructor(message, { code = "codex_resolve_failed", details = {} } = {}) {
    super(message);
    this.name = "CodexResolveError";
    this.code = code;
    this.details = details;
  }
}

let cached = null;

export function clearCodexCache() {
  cached = null;
}

export function resolveCodex(options = {}) {
  if (cached) return cached;
  cached = resolveCodexUncached(options);
  return cached;
}

export function resolveCodexUncached({
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

  const which = lookupOnPath(platform === "win32" ? "codex" : "codex", platform, env);
  if (which) {
    if (platform === "win32" && standalone) {
      warnings.push(
        "PATH Codex on Windows can degrade workspace-write under --ignore-user-config; preferring standalone binary."
      );
    } else {
      candidates.push({ command: which, source: "path" });
    }
  }

  if (!candidates.length) {
    throw new CodexResolveError(
      "Codex CLI not found. Install Codex, or set CODEX_DELEGATE_COMMAND to an absolute binary path.",
      { code: "not_found" }
    );
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const versionText = runVersion(candidate.command);
      const version = parseVersion(versionText);
      if (!version) {
        lastError = new CodexResolveError(
          `Could not parse Codex version from: ${String(versionText).slice(0, 120)}`,
          { code: "version_unparsed", details: { command: candidate.command } }
        );
        continue;
      }
      if (compareSemver(version, MIN) < 0) {
        lastError = new CodexResolveError(
          `Codex ${formatVersion(version)} is below required ${MIN_VERSION}.`,
          {
            code: "version_too_old",
            details: { command: candidate.command, version: formatVersion(version) },
          }
        );
        continue;
      }
      return {
        command: candidate.command,
        source: candidate.source,
        version: formatVersion(version),
        warnings,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new CodexResolveError("Failed to resolve a usable Codex CLI.");
}

function findNewestStandalone(homeDir, platform) {
  const releases = path.join(homeDir, ".codex", "packages", "standalone", "releases");
  if (!existsSync(releases)) return null;
  let best = null;
  let bestVer = null;
  for (const name of readdirSync(releases)) {
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

function whichOnPath(command, platform, env) {
  const probe = platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], {
    encoding: "utf8",
    env,
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) return null;
  const line = String(result.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line || null;
}

function defaultRunVersion(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
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
