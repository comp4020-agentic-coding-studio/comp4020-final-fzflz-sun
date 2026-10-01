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

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];

class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super((body as { error?: string })?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, data);
  return data;
}

/**
 * Talks to /api. "Saved" is only ever reported after the server answered 200
 * for that exact checkpoint. Writes are serialised and carry the revision they
 * were based on, so two tabs can't silently overwrite each other: the second
 * gets a conflict instead.
 */
export class SaveClient {
  revision = 0;
  status: SaveStatus = { kind: "idle" };
  private pending: SaveData | null = null;
  private inflight = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: ((s: SaveStatus) => void)[] = [];
  enabled = true;

  onStatus(fn: (s: SaveStatus) => void) {
    this.listeners.push(fn);
  }

  private set(s: SaveStatus) {
    this.status = s;
    for (const fn of this.listeners) fn(s);
  }

  disable(why: string) {
    this.enabled = false;
    this.set({ kind: "off", why });
  }

  get unsaved(): boolean {
    return this.enabled && (this.inflight || this.pending !== null);
  }

  async load(): Promise<SavePayload> {
    const p = (await call("GET", "/api/save")) as SavePayload;
    this.revision = p.revision;
    // What the server just returned is, by definition, what it has saved.
    if (p.save) this.set({ kind: "saved", at: p.save.savedAt });
    return p;
  }

  async startRun(): Promise<SavePayload> {
    this.pending = null;
    const p = (await call("POST", "/api/runs", { baseRevision: this.revision })) as SavePayload;
    this.revision = p.revision;
    this.attempt = 0;
    this.set({ kind: "saved", at: Date.now() });
    return p;
  }

  async erase(): Promise<SavePayload> {
    this.pending = null;
    const p = (await call("POST", "/api/erase", { confirm: "erase" })) as SavePayload;
    this.revision = p.revision;
    this.set({ kind: "idle" });
    return p;
  }

  /** Queue a checkpoint; a newer one replaces any not yet sent. */
  save(data: SaveData) {
    if (!this.enabled) return;
    if (this.status.kind === "conflict") return;
    this.pending = data;
    if (this.retryTimer) return; // a scheduled retry will pick up the newest
    void this.flush();
  }

  retryNow() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    void this.flush();
  }

  private async flush() {
    if (this.inflight || !this.pending) return;
    const data = this.pending;
    this.pending = null;
    this.inflight = true;
    this.set({ kind: "saving" });
    try {
      const r = (await call("PUT", "/api/save", { baseRevision: this.revision, save: data })) as { revision: number };
      this.revision = r.revision;
      this.attempt = 0;
      this.inflight = false;
      if (this.pending) return void this.flush();
      this.set({ kind: "saved", at: Date.now() });
    } catch (e) {
      this.inflight = false;
      if (!this.pending) this.pending = data; // keep the newest unsent checkpoint
      if (e instanceof HttpError && e.status === 409) {
        this.pending = null;
        this.set({ kind: "conflict", error: e.message });
      } else if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
        this.pending = null;
        this.set({ kind: "failed", error: `server rejected the save: ${e.message}`, retryable: false });
      } else if (this.attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[this.attempt++];
        this.set({ kind: "retrying", attempt: this.attempt, error: e instanceof Error ? e.message : "network error" });
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.flush();
        }, delay);
      } else {
        this.set({ kind: "failed", error: "can't reach the server", retryable: true });
      }
    }
  }
}
