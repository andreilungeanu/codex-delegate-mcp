import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The catalog runs to ~280 KB and every model adds to it; the 1 MB default would start failing. */
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/**
 * `codex debug models` renders the model catalog as JSON without spending quota. Read
 * rather than assumed: this bridge's model and reasoning-level constants are copies, and
 * copies go stale — `xhigh`, `max` and `ultra` each shipped upstream and stayed
 * unreachable here until someone compared the two lists by hand.
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
