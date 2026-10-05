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
 * @param {{ command?: string | null, execFileImpl?: any, timeoutMs?: number }} options
 * @returns {Promise<any[] | null>}
 */
export async function readModelCatalog({ command, execFileImpl = execFileAsync, timeoutMs = 8000 }) {
  if (!command) return null;
  let stdout = "";
  try {
    ({ stdout } = await execFileImpl(command, ["debug", "models"], {
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

/**
 * Every advertised level, each once, preserving the ordering within each model's list.
 * Shared levels connect partial lists. Unrelated levels keep the order first seen;
 * contradictory lists fall back to that order for the levels left unresolved.
 */
export function listedEfforts(models) {
  /** @type {Map<string, Set<string>>} */
  const next = new Map();
  for (const model of models || []) {
    if (model?.visibility !== "list") continue;
    const efforts = modelEfforts([model], model.slug) || [];
    efforts.forEach((effort, index) => {
      if (!next.has(effort)) next.set(effort, new Set());
      if (index > 0 && efforts[index - 1] !== effort) next.get(efforts[index - 1]).add(effort);
    });
  }
  const pending = new Map([...next.keys()].map((effort) => [effort, 0]));
  for (const successors of next.values()) {
    for (const effort of successors) pending.set(effort, pending.get(effort) + 1);
  }
  const ordered = [];
  while (pending.size) {
    const ready = [...pending].find(([, predecessors]) => predecessors === 0);
    if (!ready) return [...ordered, ...pending.keys()];
    const [effort] = ready;
    ordered.push(effort);
    pending.delete(effort);
    for (const successor of next.get(effort)) pending.set(successor, pending.get(successor) - 1);
  }
  return ordered;
}
