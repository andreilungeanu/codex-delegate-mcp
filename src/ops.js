import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Owns the in-flight delegations. Cancel can run while delegate awaits.
 *
 * Two structures, not one: `#active` is keyed by a delegation id this server
 * mints, because that id exists from the moment a run is acquired, while Codex's
 * thread id only arrives once the child announces it — a run that wedges before
 * then would otherwise have no handle at all. `#byThread` maps thread id to a
 * *set* of delegation ids, because a resume shares its thread id with the turn it
 * resumes: both are live, both are cancellable, and storing one delegation per
 * thread id would let whichever finished first deregister the other.
 */
class OperationRegistry {
  /** @type {Map<string, any>} */
  #active = new Map();
  /** @type {Map<string, Set<string>>} */
  #byThread = new Map();

  /** @param {{ threadId?: string | null, workspace?: string | null, cancel?: Function }} [options] */
  acquire({ threadId = null, workspace = null, cancel } = {}) {
    if (typeof cancel !== "function") throw new TypeError("cancel must be a function");

    const warnings = this.#overlapWarnings(workspace);
    const delegationId = randomUUID();
    const record = {
      delegationId,
      threadId: threadId || null,
      workspace: workspace || null,
      cancel,
      cancelPromise: null,
    };
    this.#active.set(delegationId, record);
    this.#indexThread(record);

    return {
      delegationId,
      warnings,
      /** @param {string} id */
      updateThreadId: (id) => {
        if (!id || this.#active.get(delegationId) !== record) return;
        if (record.threadId === id) return;
        // A resume that did not resume: `resume A` can come back as a new thread B,
        // which is the case `resumed: false` reports. Leaving A pointing here made a
        // cancel aimed at the thread that ended kill the run that replaced it.
        this.#deindexThread(record);
        record.threadId = id;
        this.#indexThread(record);
      },
      release: () => {
        if (this.#active.get(delegationId) !== record) return;
        this.#active.delete(delegationId);
        this.#deindexThread(record);
      },
    };
  }

  /**
   * `id` names either a delegation id or a Codex thread id; a thread id cancels
   * every delegation running on it. Omitting it cancels everything active: with
   * several running there is no defensible way to pick one.
   *
   * @param {{ id?: string | null, threadId?: string | null, cause?: string }} [options]
   */
  async cancel({ id = null, threadId = null, cause = "user" } = {}) {
    const wanted = id || threadId || null;

    if (!wanted) {
      if (this.#active.size === 0) return { status: "nothing-active" };
      const targets = [...this.#active.values()];
      await this.#cancelSelected(targets, cause);
      return { status: "cancelled", cause, cancelled: targets.map(summarize) };
    }

    const targets = this.#resolveTargets(wanted);
    if (targets.length === 0) {
      // Inactive is inactive: an id with no active run is not-found, whether it
      // finished a moment ago or never ran. Nothing can cancel it either way.
      return { status: "not-found", id: wanted };
    }
    await this.#cancelSelected(targets, cause);
    return { status: "cancelled", cause, id: wanted, cancelled: targets.map(summarize) };
  }

  /** @param {any} record */
  #cancelOne(record, cause) {
    if (!record.cancelPromise) {
      // Started here, not on a later microtask. Shutdown dispatches cancellation and
      // exits without awaiting anything, so a start deferred through
      // `Promise.resolve().then(…)` would never run at all. The try is what that
      // deferral used to buy: a cancel that throws synchronously still has to land
      // in cancelPromise rather than escape this call.
      let started;
      try {
        started = Promise.resolve(record.cancel({ cause }));
      } catch (err) {
        started = Promise.reject(err);
      }
      record.cancelPromise = started;
    }
    return record.cancelPromise;
  }

  /** @param {any[]} records */
  async #cancelSelected(records, cause) {
    const outcomes = await Promise.allSettled(
      records.map((record) => this.#cancelOne(record, cause))
    );
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure) throw failure.reason;
  }

  /** @param {string} wanted */
  #resolveTargets(wanted) {
    const direct = this.#active.get(wanted);
    if (direct) return [direct];
    const ids = this.#byThread.get(wanted);
    if (!ids) return [];
    return [...ids].map((did) => this.#active.get(did)).filter(Boolean);
  }

  /** @param {any} record */
  #indexThread(record) {
    if (!record.threadId) return;
    const ids = this.#byThread.get(record.threadId);
    if (ids) ids.add(record.delegationId);
    else this.#byThread.set(record.threadId, new Set([record.delegationId]));
  }

  /** @param {any} record */
  #deindexThread(record) {
    if (!record.threadId) return;
    const ids = this.#byThread.get(record.threadId);
    if (!ids) return;
    ids.delete(record.delegationId);
    if (ids.size === 0) this.#byThread.delete(record.threadId);
  }

  /**
   * Two agents writing one tree clobber each other, and neither the bridge nor the
   * git diff can say which one did what. Worth saying out loud; not worth refusing,
   * because some runs really do only read.
   *
   * @param {string | null} workspace
   */
  #overlapWarnings(workspace) {
    if (!workspace) return [];
    const warnings = [];
    for (const record of this.#active.values()) {
      if (!record.workspace || !overlaps(record.workspace, workspace)) continue;
      warnings.push(
        `Another delegation is already running in an overlapping workspace (${record.workspace}). Concurrent agents writing one tree overwrite each other, and the git diff cannot say which one did what.`
      );
      break;
    }
    return warnings;
  }
}

/** @param {any} record */
function summarize(record) {
  return { delegationId: record.delegationId, threadId: record.threadId };
}

/** True when either path is the other, or contains it. */
function overlaps(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (left === right) return true;
  const rel = path.relative(left, right);
  const inside = (r) => r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
  return inside(rel) || inside(path.relative(right, left));
}

export function createOperationRegistry() {
  return new OperationRegistry();
}
