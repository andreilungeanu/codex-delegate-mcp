import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The catalog runs to ~280 KB and every model adds to it; the 1 MB default would start failing. */
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/**
 * `codex debug models` renders the model catalog as JSON without spending quota. Read
 * rather than assumed: a copied list goes stale — `xhigh`, `max` and `ultra` each shipped
 * upstream and stayed unreachable here until someone compared the two lists by hand, and
 * a hand-kept model list missed each model Codex shipped between two of this bridge's
 * releases.
 *
 * Returns null instead of throwing. Every caller treats a catalog it cannot read as one
 * that objects to nothing: `debug` is a debugging surface and can move, and neither
 * diagnostics nor a delegation should fail because it did.
 *
 * Not `--bundled`, which skips the refresh and answers a different catalog.
 * Refusing a model on that dump would refuse one the live CLI would have run.
 *
 * @param {{ command?: string | null, commandArgs?: string[], execFileImpl?: any, timeoutMs?: number }} options
 * @returns {Promise<any[] | null>}
 */
export async function readModelCatalog({ command, commandArgs = [], execFileImpl = execFileAsync, timeoutMs = 8000 }) {
  if (!command) return null;
  let stdout = "";
  try {
    ({ stdout } = await execFileImpl(command, [...commandArgs, "debug", "models"], {
      encoding: "utf8",
      timeout: timeoutMs,
      // SIGKILL: SIGTERM is catchable and would outlive the timeout.
      killSignal: "SIGKILL",
      windowsHide: true,
      shell: false,
      maxBuffer: MAX_CATALOG_BYTES,
    }));
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed?.models) ? parsed.models : null;
  } catch {
    return null;
  }
}

/** The slugs a caller may name, hidden ones included — see assertKnownModel. */
export function catalogSlugs(models) {
  return (models || []).map((model) => model?.slug).filter((slug) => typeof slug === "string");
}

/** The slugs a caller is offered. `visibility` decides what to advertise, not what runs. */
export function listedSlugs(models) {
  return (models || [])
    .filter((model) => model?.visibility === "list")
    .map((model) => model?.slug)
    .filter((slug) => typeof slug === "string");
}

/** The levels one model advertises, or null when its list is absent, empty or malformed. */
export function modelEfforts(models, slug) {
  const entry = (models || []).find((model) => model?.slug === slug);
  if (!Array.isArray(entry?.supported_reasoning_levels)) return null;
  const efforts = entry.supported_reasoning_levels.map((level) => level?.effort);
  if (efforts.some((effort) => typeof effort !== "string" || !effort.trim())) return null;
  return efforts.length ? efforts : null;
}

/** Every advertised level, each once, in the order first seen. */
export function listedEfforts(models) {
  const efforts = new Set();
  for (const model of models || []) {
    if (model?.visibility === "list") for (const effort of modelEfforts([model], model.slug) || []) efforts.add(effort);
  }
  return [...efforts];
}
