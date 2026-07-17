/**
 * Owns at most one in-flight delegate. Cancel can run while delegate awaits.
 */
export class OperationRegistry {
  #active = null;

  acquire({ threadId = null, cancel } = {}) {
    if (typeof cancel !== "function") throw new TypeError("cancel must be a function");
    if (this.#active) {
      const err = new Error("Another Codex delegation is already active.");
      err.code = "operation_in_progress";
      err.details = { threadId: this.#active.threadId };
      throw err;
    }
    const record = {
      threadId: threadId || null,
      cancel,
      cancelPromise: null,
      cancellation: null,
    };
    this.#active = record;
    return {
      updateThreadId: (id) => {
        if (this.#active === record && id) record.threadId = id;
      },
      getCancellation: () => record.cancellation,
      release: () => {
        if (this.#active === record) this.#active = null;
      },
    };
  }

  async cancel({ threadId, cause = "user" } = {}) {
    const active = this.#active;
    if (!active) return { status: "nothing-active" };
    if (threadId && active.threadId && active.threadId !== threadId) {
      return { status: "not-owned", threadId, activeThreadId: active.threadId };
    }
    if (!active.cancelPromise) {
      active.cancellation = { status: "cancelling", cause };
      active.cancelPromise = Promise.resolve()
        .then(() => active.cancel({ cause }))
        .then(() => {
          active.cancellation = { status: "cancelled", cause };
          return { status: "cancelled", threadId: active.threadId, cause };
        })
        .catch((err) => {
          active.cancellation = {
            status: "failed",
            cause,
            message: err?.message || String(err),
          };
          throw err;
        });
    }
    return active.cancelPromise;
  }

  snapshot() {
    if (!this.#active) return { active: false };
    return {
      active: true,
      threadId: this.#active.threadId,
      cancellation: this.#active.cancellation,
    };
  }
}

export function createOperationRegistry() {
  return new OperationRegistry();
}
