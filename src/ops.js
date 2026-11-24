import { randomUUID } from "node:crypto";
import { codedError } from "./errors.js";

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
  #closed = false;

  /** @param {{ id?: string, threadId?: string | null, cancel?: Function }} [options] An MCP task passes its task id as `id`. */
  acquire({ id, threadId = null, cancel } = {}) {
    if (typeof cancel !== "function") throw new TypeError("cancel must be a function");
    if (this.#closed) {
      throw codedError("shutting_down", "The server is shutting down, so Codex was not started.");
    }

    const delegationId = id ?? randomUUID();
    if (this.#active.has(delegationId)) throw new Error(`Delegation ${delegationId} is already running.`);
    const record = {
      delegationId,
      threadId: threadId || null,
      cancel,
      cancelPromise: null,
    };
    this.#active.set(delegationId, record);
    this.#indexThread(record);

    return {
      delegationId,
      /** @param {string} id */
      updateThreadId: (id) => {
        if (!id || this.#active.get(delegationId) !== record) return;
        if (record.threadId === id) return;
        // `resume A` can come back as a new thread B (`resumed: false`); A then names the ended
        // thread, not this run.
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
   * several running there is no defensible way to pick one. Cause `shutdown` also
   * refuses every later acquire, so no delegation starts Codex past the server's exit.
   *
   * @param {{ id?: string | null, threadId?: string | null, cause?: string }} [options]
   */
  async cancel({ id = null, threadId = null, cause = "user" } = {}) {
    const wanted = id || threadId || null;
    if (cause === "shutdown") this.#closed = true;

    if (!wanted) {
      if (this.#active.size === 0) return { status: "nothing-active" };
      const targets = [...this.#active.values()];
      await this.#cancelSelected(targets, cause);
      return { status: "cancelled", cause, cancelled: targets.map(summarize) };
    }

    const targets = this.#resolveTargets(wanted);
    if (targets.length === 0) {
      return { status: "not-found", id: wanted };
    }
    await this.#cancelSelected(targets, cause);
    return { status: "cancelled", cause, id: wanted, cancelled: targets.map(summarize) };
  }

  /** @param {any} record */
  #cancelOne(record, cause) {
    record.cancelPromise ??= record.cancel({ cause });
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
}

/** @param {any} record */
function summarize(record) {
  return { delegationId: record.delegationId, threadId: record.threadId };
}

export function createOperationRegistry() {
  return new OperationRegistry();
}
