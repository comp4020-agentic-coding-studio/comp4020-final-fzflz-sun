import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETRY_DELAYS, SaveClient, SaveFlowError } from "./net.ts";
import { checkProgression, newRun, validateSave, type SaveData } from "./save.ts";

// A fake /api with the real server's write rules (revision check, progression
// check, archive-on-new-run, erase), where each request can be held and then
// delivered or failed, so the tests choose the order things happen in.
interface Held {
  method: string;
  path: string;
  body: any;
  deliver: () => void;
  fail: () => void;
}

class FakeServer {
  revision = 0;
  save: SaveData | null = null;
  runs: { runNumber: number; outcome: string; reason: string; wins: number }[] = [];
  log: string[] = [];
  holding = false;
  held: Held[] = [];
  failNext = 0; // fail this many requests (network error) when they arrive
  private n = 0;

  fetch = (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    return new Promise((resolve, reject) => {
      const deliver = () => resolve(this.handle(method, url, body));
      const fail = () => {
        this.log.push(`${method} ${url} -> network error`);
        reject(new TypeError("Failed to fetch"));
      };
      if (this.failNext > 0) {
        this.failNext--;
        return fail();
      }
      if (this.holding) this.held.push({ method, path: url, body, deliver, fail });
      else deliver();
    });
  };

  private reply(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private payload() {
    return { revision: this.revision, save: this.save, runs: this.runs.slice().reverse() };
  }

  handle(method: string, path: string, body: any): Response {
    if (method === "GET" && path === "/api/save") return this.reply(200, this.payload());
    if (method === "PUT" && path === "/api/save") {
      this.log.push(`PUT ${body.save.reason}@${body.baseRevision}`);
      if (body.baseRevision !== this.revision || !this.save) return this.reply(409, { error: "stale", ...this.payload() });
      const v = validateSave(body.save);
      if (!v.ok) return this.reply(400, { error: v.error });
      const problem = checkProgression(this.save, v.save);
      if (problem) return this.reply(422, { error: problem });
      this.save = v.save;
      this.revision++;
      return this.reply(200, { revision: this.revision, savedAt: v.save.savedAt });
    }
    if (method === "POST" && path === "/api/runs") {
      this.log.push(`POST runs@${body.baseRevision}`);
      if (body.baseRevision !== this.revision) return this.reply(409, { error: "stale", ...this.payload() });
      if (this.save) {
        const s = this.save;
        this.runs.push({ runNumber: s.runNumber, outcome: s.outcome === "playing" ? "abandoned" : s.outcome, reason: s.reason, wins: s.stats.wins });
      }
      this.save = newRun(`run_number${++this.n}`, (this.save?.runNumber ?? 0) + 1, Date.now());
      this.revision++;
      return this.reply(200, this.payload());
    }
    if (method === "POST" && path === "/api/erase") {
      this.log.push("POST erase");
      this.save = null;
      this.runs = [];
      this.revision = 0;
      return this.reply(200, this.payload());
    }
    return this.reply(404, { error: "no" });
  }

  /** Stops holding and delivers held requests one at a time, in arrival order. */
  async releaseAll() {
    this.holding = false;
    await flush();
    while (this.held.length) {
      this.held.shift()!.deliver();
      await flush();
    }
  }
}

// Lets queued promise chains and Response body reads settle. setImmediate,
// because the tests fake setTimeout to control retry backoff.
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

/** A checkpoint that won the run's last fight and cleared every camp. */
function victoryOf(s: SaveData, outcome: "won" | "dead" | "playing" = "won"): SaveData {
  const killAll = outcome === "won";
  return {
    ...s,
    savedAt: s.savedAt + 1000,
    reason: outcome === "dead" ? "death" : "victory",
    outcome,
    player: { ...s.player, hp: outcome === "dead" ? 0 : 11 },
    enemies: killAll ? Object.fromEntries(Object.keys(s.enemies).map((k) => [k, 0])) : { ...s.enemies, "west-1": 0 },
    stats: { fights: 1, wins: outcome === "dead" ? 0 : 1, flees: 0, kills: killAll ? 8 : 1 },
  };
}

async function setup() {
  const server = new FakeServer();
  const client = new SaveClient(server.fetch);
  await client.load();
  const first = await client.startRun();
  // a mid-run checkpoint already on the server
  client.save({ ...first.save!, savedAt: first.save!.savedAt + 10, reason: "engage", stats: { ...first.save!.stats, fights: 1 } });
  await flush();
  return { server, client, run: server.save! };
}

describe("SaveClient ordering: final checkpoint vs new run", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("victory still in flight when New run is pressed: the run is archived as won, not abandoned", async () => {
    const { server, client, run } = await setup();
    server.holding = true;
    client.save(victoryOf(run));
    await flush();
    const started = client.startRun();
    await flush();
    expect(server.held.map((h) => h.method)).toEqual(["PUT"]); // the new-run request waits behind the save
    await server.releaseAll();
    const p = await started;
    expect(server.runs.at(-1)).toMatchObject({ runNumber: 1, outcome: "won", reason: "victory" });
    expect(p.save!.runNumber).toBe(2);
    expect(client.status.kind).toBe("saved");
    expect(server.log.slice(-2)).toEqual(["PUT victory@2", "POST runs@3"]);
  });

  it("victory already confirmed: New run uses the revision that save produced (no false conflict)", async () => {
    const { server, client, run } = await setup();
    client.save(victoryOf(run, "dead"));
    await flush();
    expect(client.status.kind).toBe("saved");
    const p = await client.startRun();
    expect(p.save!.runNumber).toBe(2);
    expect(server.runs.at(-1)).toMatchObject({ outcome: "dead", reason: "death" });
    expect(server.log.at(-1)).toBe(`POST runs@${server.revision - 1}`);
  });

  it("victory waiting in retry backoff: New run sends it immediately, then starts", async () => {
    const { server, client, run } = await setup();
    server.failNext = 1;
    client.save(victoryOf(run));
    await flush();
    expect(client.status.kind).toBe("retrying");
    await client.startRun();
    expect(server.runs.at(-1)).toMatchObject({ outcome: "won" });
    // the old retry timer must not fire a second PUT into the new run
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] * 3);
    expect(server.log.filter((l) => l.startsWith("PUT victory"))).toHaveLength(1);
  });

  it("if the final checkpoint can't be sent, no new run starts and the result is kept for retry", async () => {
    const { server, client, run } = await setup();
    server.failNext = 2;
    client.save(victoryOf(run));
    await flush();
    const runsBefore = server.log.filter((l) => l.startsWith("POST runs")).length;
    await expect(client.startRun()).rejects.toMatchObject({ reason: "unsaved" });
    expect(server.log.filter((l) => l.startsWith("POST runs")).length).toBe(runsBefore);
    expect(client.status).toMatchObject({ kind: "failed", retryable: true });
    expect(client.unsaved).toBe(true);
    // the next attempt (network back) saves the result and then starts the run
    const p = await client.startRun();
    expect(server.runs.at(-1)).toMatchObject({ outcome: "won" });
    expect(p.save!.runNumber).toBe(2);
  });

  it("choosing to discard an unsendable result starts the run without it, explicitly", async () => {
    const { server, client, run } = await setup();
    server.failNext = 2;
    client.save(victoryOf(run));
    await flush();
    await expect(client.startRun()).rejects.toBeInstanceOf(SaveFlowError);
    await client.startRun({ discardUnsaved: true });
    expect(server.runs.at(-1)).toMatchObject({ outcome: "abandoned", reason: "engage" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.log.filter((l) => l.startsWith("PUT victory"))).toHaveLength(0);
  });

  it("New run pressed repeatedly (button + key + double click) starts exactly one run", async () => {
    const { server, client, run } = await setup();
    server.holding = true;
    client.save(victoryOf(run));
    const a = client.startRun();
    const b = client.startRun();
    const c = client.startRun();
    expect(a).toBe(b);
    expect(b).toBe(c);
    await server.releaseAll();
    await Promise.all([a, b, c]);
    expect(server.log.filter((l) => l.startsWith("POST runs"))).toHaveLength(2); // setup's run + this one
    expect(server.save!.runNumber).toBe(2);
  });

  it("a slow checkpoint from the old run can't overwrite the new run", async () => {
    const { server, client, run } = await setup();
    const started = client.startRun();
    await started;
    // a late checkpoint built from the old run (e.g. a stray callback) is refused by the server and never overwrites run 2
    client.save(victoryOf(run));
    await flush();
    expect(server.save!.runNumber).toBe(2);
    expect(client.status).toMatchObject({ kind: "failed", retryable: false });
  });
});

describe("SaveClient ordering: erase", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("erase waits for an in-flight save, then wins; nothing from before lands afterwards", async () => {
    const { server, client, run } = await setup();
    server.holding = true;
    client.save(victoryOf(run, "playing"));
    await flush();
    const erased = client.erase();
    await flush();
    expect(server.held.map((h) => h.method)).toEqual(["PUT"]);
    await server.releaseAll();
    await erased;
    expect(server.save).toBeNull();
    expect(server.runs).toEqual([]);
    expect(client.status.kind).toBe("idle");
    expect(client.revision).toBe(0);
  });

  it("a retry scheduled before erase never fires after it", async () => {
    const { server, client, run } = await setup();
    server.failNext = 1;
    client.save(victoryOf(run, "playing"));
    await flush();
    expect(client.status.kind).toBe("retrying");
    await client.erase();
    const before = server.log.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.log.length).toBe(before);
    expect(server.save).toBeNull();
    expect(client.unsaved).toBe(false);
  });

  it("after erase, a fresh run starts from revision 0 and saves normally", async () => {
    const { client, server } = await setup();
    await client.erase();
    const p = await client.startRun();
    expect(p.save!.runNumber).toBe(1);
    client.save({ ...p.save!, savedAt: p.save!.savedAt + 1, reason: "engage", stats: { ...p.save!.stats, fights: 1 } });
    await flush();
    expect(client.status.kind).toBe("saved");
    expect(server.save!.reason).toBe("engage");
  });
});

describe("SaveClient status honesty", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("never reports Saved while the newest checkpoint is unconfirmed", async () => {
    const { server, client, run } = await setup();
    const seen: string[] = [];
    client.onStatus((s) => seen.push(s.kind));
    server.holding = true;
    client.save(victoryOf(run, "playing"));
    await flush();
    expect(client.status.kind).toBe("saving");
    server.held.shift()!.fail();
    await flush();
    expect(client.status.kind).toBe("retrying");
    expect(seen).not.toContain("saved");
    server.holding = false;
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
    await flush();
    expect(client.status.kind).toBe("saved");
  });

  it("gives up after the retry budget and offers a manual retry", async () => {
    const { server, client, run } = await setup();
    server.failNext = 1 + RETRY_DELAYS.length;
    client.save(victoryOf(run, "playing"));
    for (const d of RETRY_DELAYS) await vi.advanceTimersByTimeAsync(d);
    await flush();
    expect(client.status).toMatchObject({ kind: "failed", retryable: true });
    client.retryNow();
    await flush();
    expect(client.status.kind).toBe("saved");
  });
});
