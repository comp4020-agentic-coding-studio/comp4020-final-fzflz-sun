import type { SaveData } from "./save.ts";

export interface RunSummary {
  runId: string;
  runNumber: number;
  outcome: string;
  kills: number;
  wins: number;
  endedAt: number;
}

export interface SavePayload {
  revision: number;
  save: SaveData | null;
  runs: RunSummary[];
}

export type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "retrying"; attempt: number; error: string }
  | { kind: "failed"; error: string; retryable: boolean }
  | { kind: "conflict"; error: string }
  | { kind: "off"; why: string };

export const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];

export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super((body as { error?: string })?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Why a new run (or erase) couldn't go ahead. `unsaved`: the last checkpoint couldn't reach the server. */
export class SaveFlowError extends Error {
  reason: "unsaved" | "rejected" | "conflict";
  constructor(reason: SaveFlowError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type FlushResult = "ok" | "network" | "rejected" | "conflict" | "stale";

/**
 * The only path from the game to /api writes. Every write (a checkpoint, a new
 * run, an erase) runs one at a time through `exclusive`, in the order asked,
 * and each carries the revision the previous write produced. So:
 *
 * - a new run first sends any checkpoint that is waiting, in flight or in
 *   retry backoff, and only then archives the run, which is why a final
 *   victory or death is what lands in history, not the checkpoint before it;
 *   if that checkpoint can't be sent the new run doesn't start (SaveFlowError)
 *   unless the caller explicitly discards it;
 * - starting a run or erasing bumps `generation`; a response, retry or queued
 *   flush from an older generation is ignored, so it can't touch the new run;
 * - "Saved" is only set after the server answered 200 for the newest checkpoint.
 *
 * Two tabs still can't overwrite each other: the server answers 409 to a
 * write based on a stale revision, and this client then stops saving.
 */
export class SaveClient {
  revision = 0;
  status: SaveStatus = { kind: "idle" };
  enabled = true;

  private generation = 0;
  private pending: SaveData | null = null;
  private sending = false;
  private flushQueued = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private runOp: Promise<SavePayload> | null = null;
  private eraseOp: Promise<SavePayload> | null = null;
  private listeners: ((s: SaveStatus) => void)[] = [];
  private fetchImpl: FetchLike;

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  onStatus(fn: (s: SaveStatus) => void) {
    this.listeners.push(fn);
  }

  private set(s: SaveStatus) {
    this.status = s;
    for (const fn of this.listeners) fn(s);
  }

  disable(why: string) {
    this.enabled = false;
    this.clearRetry();
    this.pending = null;
    this.generation++;
    this.set({ kind: "off", why });
  }

  /** True while any checkpoint hasn't been confirmed by the server. */
  get unsaved(): boolean {
    return this.enabled && (this.pending !== null || this.sending || this.flushQueued || this.retryTimer !== null);
  }

  /** True while a new run or an erase is being carried out. */
  get busy(): boolean {
    return this.runOp !== null || this.eraseOp !== null;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status, data);
    return data;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  async load(): Promise<SavePayload> {
    return this.exclusive(async () => {
      const p = (await this.call("GET", "/api/save")) as SavePayload;
      this.revision = p.revision;
      // What the server just returned is, by definition, what it has saved.
      if (p.save) this.set({ kind: "saved", at: p.save.savedAt });
      return p;
    });
  }

  /** Queue a checkpoint; a newer one replaces any not yet sent. */
  save(data: SaveData) {
    if (!this.enabled || this.status.kind === "conflict") return;
    this.pending = data;
    if (this.retryTimer) return; // the scheduled retry sends the newest checkpoint
    this.queueFlush();
  }

  retryNow() {
    this.clearRetry();
    this.attempt = 0;
    this.queueFlush();
  }

  private queueFlush() {
    if (this.flushQueued || !this.enabled) return;
    this.flushQueued = true;
    const gen = this.generation;
    void this.exclusive(async () => {
      this.flushQueued = false;
      if (gen !== this.generation) return;
      if ((await this.sendPending(gen)) === "network") this.scheduleRetry(gen);
    });
  }

  private scheduleRetry(gen: number) {
    if (this.attempt >= RETRY_DELAYS.length) {
      this.set({ kind: "failed", error: "can't reach the server", retryable: true });
      return;
    }
    const delay = RETRY_DELAYS[this.attempt++];
    this.set({ kind: "retrying", attempt: this.attempt, error: "network error" });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (gen === this.generation) this.queueFlush();
    }, delay);
  }

  /** Sends checkpoints until none is waiting. Must run inside `exclusive`. */
  private async sendPending(gen: number): Promise<FlushResult> {
    let sent = false;
    while (this.pending) {
      if (gen !== this.generation) return "stale";
      const data = this.pending;
      this.pending = null;
      this.sending = true;
      this.set({ kind: "saving" });
      let r: { revision: number };
      try {
        r = (await this.call("PUT", "/api/save", { baseRevision: this.revision, save: data })) as { revision: number };
      } catch (e) {
        this.sending = false;
        if (gen !== this.generation) return "stale";
        if (!this.pending) this.pending = data; // keep the newest unsent checkpoint
        if (e instanceof HttpError && e.status === 409) {
          this.pending = null;
          this.set({ kind: "conflict", error: e.message });
          return "conflict";
        }
        if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
          this.pending = null;
          this.set({ kind: "failed", error: `server rejected the save: ${e.message}`, retryable: false });
          return "rejected";
        }
        return "network";
      }
      this.sending = false;
      if (gen !== this.generation) return "stale";
      this.revision = r.revision;
      this.attempt = 0;
      sent = true;
    }
    if (sent) this.set({ kind: "saved", at: Date.now() });
    return "ok";
  }

  /**
   * Ends the current run and starts the next. Any waiting checkpoint is sent
   * first, so the run is archived with its real outcome. Repeated calls while
   * one is in progress share it, so a double click or a key repeat starts one run.
   */
  startRun(opts: { discardUnsaved?: boolean } = {}): Promise<SavePayload> {
    if (this.runOp) return this.runOp;
    this.runOp = this.exclusive(async () => {
      this.clearRetry();
      this.attempt = 0;
      if (opts.discardUnsaved) this.pending = null;
      const flushed = await this.sendPending(this.generation);
      if (flushed === "network") {
        this.set({ kind: "failed", error: "your last checkpoint hasn't reached the server", retryable: true });
        throw new SaveFlowError("unsaved", "your last result hasn't reached the server yet");
      }
      if (flushed === "conflict") throw new SaveFlowError("conflict", "your progress changed in another tab");
      if (flushed === "rejected" && !opts.discardUnsaved) {
        throw new SaveFlowError("rejected", "the server rejected your last checkpoint");
      }
      let p: SavePayload;
      try {
        p = (await this.call("POST", "/api/runs", { baseRevision: this.revision })) as SavePayload;
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) {
          this.set({ kind: "conflict", error: e.message });
          throw new SaveFlowError("conflict", e.message);
        }
        throw e;
      }
      this.generation++;
      this.pending = null;
      this.revision = p.revision;
      this.set({ kind: "saved", at: Date.now() });
      return p;
    }).finally(() => {
      this.runOp = null;
    });
    return this.runOp;
  }

  /** Deletes this visitor's save and history. Unsent checkpoints are dropped on purpose. */
  erase(): Promise<SavePayload> {
    if (this.eraseOp) return this.eraseOp;
    this.eraseOp = this.exclusive(async () => {
      this.clearRetry();
      this.attempt = 0;
      this.pending = null;
      this.generation++;
      const p = (await this.call("POST", "/api/erase", { confirm: "erase" })) as SavePayload;
      this.revision = p.revision;
      this.set({ kind: "idle" });
      return p;
    }).finally(() => {
      this.eraseOp = null;
    });
    return this.eraseOp;
  }
}
