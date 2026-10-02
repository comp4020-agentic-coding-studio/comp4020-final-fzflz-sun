import { JSDOM } from "jsdom";
import { Marked } from "marked";
import { readFileSync } from "node:fs";
import { describe, expect, inject, it } from "vitest";

// Checks against the RUNNING app (spec/global-setup.ts finds it) for the
// promises README.md makes about saving and about /readme/ itself.
const baseUrl = inject("baseUrl");

/** A minimal cookie-jar client: one instance = one anonymous visitor. */
function visitor() {
  let cookie = "";
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: (await res.json()) as any, setCookie: set };
  };
}

async function startRun(api: ReturnType<typeof visitor>) {
  const first = await api("GET", "/api/save");
  const r = await api("POST", "/api/runs", { baseRevision: first.body.revision });
  expect(r.status).toBe(200);
  return r.body as { revision: number; save: any };
}

describe("saves", () => {
  it("gives each new visitor an HttpOnly cookie and an empty save", async () => {
    const api = visitor();
    const r = await api("GET", "/api/save");
    expect(r.status).toBe(200);
    expect(r.body.save).toBeNull();
    expect(r.setCookie).toMatch(/HttpOnly/i);
    expect(r.setCookie).toMatch(/SameSite=Lax/i);
  });

  it("keeps a checkpoint and returns it on the next visit", async () => {
    const api = visitor();
    const run = await startRun(api);
    const save = { ...run.save, reason: "victory", savedAt: run.save.savedAt + 10 };
    save.enemies = { ...save.enemies, "west-1": 0 };
    save.places = Object.fromEntries(Object.entries(save.places).filter(([k]) => k !== "west-1")); // the dead have no place
    save.stats = { fights: 1, wins: 1, flees: 0, kills: 1 };
    save.player = { ...save.player, hp: 17 };
    expect((await api("PUT", "/api/save", { baseRevision: run.revision, save })).status).toBe(200);
    const back = await api("GET", "/api/save");
    expect(back.body.save.enemies["west-1"]).toBe(0);
    expect(back.body.save.player.hp).toBe(17);
    expect(back.body.save.reason).toBe("victory");
  });

  it("keeps two visitors' saves apart", async () => {
    const a = visitor();
    const b = visitor();
    const runA = await startRun(a);
    await startRun(b);
    const save = { ...runA.save, savedAt: runA.save.savedAt + 1, player: { ...runA.save.player, hp: 5 }, reason: "flee" };
    save.stats = { ...save.stats, fights: 1, flees: 1 };
    expect((await a("PUT", "/api/save", { baseRevision: runA.revision, save })).status).toBe(200);
    expect((await a("GET", "/api/save")).body.save.player.hp).toBe(5);
    expect((await b("GET", "/api/save")).body.save.player.hp).toBe(24);
  });

  it("refuses a write based on a stale revision (two tabs can't overwrite each other)", async () => {
    const api = visitor();
    const run = await startRun(api);
    const save = { ...run.save, savedAt: run.save.savedAt + 1, reason: "engage", stats: { ...run.save.stats, fights: 1 } };
    expect((await api("PUT", "/api/save", { baseRevision: run.revision, save })).status).toBe(200);
    const stale = await api("PUT", "/api/save", { baseRevision: run.revision, save: { ...save, savedAt: save.savedAt + 1 } });
    expect(stale.status).toBe(409);
  });

  it("rejects malformed saves and impossible progress", async () => {
    const api = visitor();
    const run = await startRun(api);
    const bad = await api("PUT", "/api/save", { baseRevision: run.revision, save: { ...run.save, player: { hp: 999, x: 1, y: 1 } } });
    expect(bad.status).toBe(400);

    const places = Object.fromEntries(Object.entries(run.save.places).filter(([k]) => k !== "west-1"));
    const killed = { ...run.save, savedAt: run.save.savedAt + 1, enemies: { ...run.save.enemies, "west-1": 0 }, places };
    killed.stats = { ...killed.stats, kills: 1 };
    const ok = await api("PUT", "/api/save", { baseRevision: run.revision, save: killed });
    expect(ok.status).toBe(200);
    const revived = { ...killed, savedAt: killed.savedAt + 1, enemies: { ...killed.enemies, "west-1": 6 }, places: run.save.places };
    expect((await api("PUT", "/api/save", { baseRevision: ok.body.revision, save: revived })).status).toBe(422);
  });

  it("starting a new run keeps the old one in history; erasing needs the confirm word", async () => {
    const api = visitor();
    const run1 = await startRun(api);
    const run2 = await api("POST", "/api/runs", { baseRevision: run1.revision });
    expect(run2.body.save.runNumber).toBe(2);
    expect(run2.body.runs.map((r: any) => [r.runNumber, r.outcome])).toEqual([[1, "abandoned"]]);

    expect((await api("POST", "/api/erase", {})).status).toBe(400);
    expect((await api("GET", "/api/save")).body.save.runNumber).toBe(2);
    const erased = await api("POST", "/api/erase", { confirm: "erase" });
    expect(erased.body.save).toBeNull();
    expect(erased.body.runs).toEqual([]);
  });
});

describe("/readme/", () => {
  const text = (html: string) => new JSDOM(html).window.document.body.textContent ?? "";
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

  it("publishes the README's full text in the server's HTML, not just its headings", async () => {
    const md = readFileSync("README.md", "utf8");
    const expected = squash(text(new Marked({ gfm: true }).parse(md, { async: false })));
    const served = squash(text(await (await fetch(new URL("/readme/", baseUrl))).text()));
    expect(expected.length).toBeGreaterThan(200);
    expect(served).toContain(expected);
  });

  it("serves every image the README links", async () => {
    const md = readFileSync("README.md", "utf8");
    const images = [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((src) => !/^https?:/.test(src));
    for (const src of images) {
      const res = await fetch(new URL(src, new URL("/readme/", baseUrl)));
      expect(res.status, src).toBe(200);
      expect(res.headers.get("content-type"), src).toMatch(/^image\//);
    }
  });
});

describe("the game page", () => {
  it("serves the built game with its script assets", async () => {
    const html = await (await fetch(new URL("/", baseUrl))).text();
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) {
      const res = await fetch(new URL(src, baseUrl));
      expect(res.status, src).toBe(200);
      expect(res.headers.get("content-type"), src).toMatch(/javascript/);
    }
  });
});
