import { describe, expect, it } from "vitest";
import { checkProgression, clearedAreas, newRun, validateSave, type SaveData } from "./save.ts";
import { ENEMY_SPAWNS } from "./world.ts";

const fresh = (): SaveData => newRun("run_abcdefgh", 1, 1_700_000_000_000);
const clone = (s: SaveData): SaveData => JSON.parse(JSON.stringify(s));

describe("save validation", () => {
  it("accepts a fresh run and a JSON round trip of it", () => {
    expect(validateSave(fresh()).ok).toBe(true);
    expect(validateSave(JSON.parse(JSON.stringify(fresh()))).ok).toBe(true);
  });

  it.each([
    ["unknown field", (s: any) => (s.cheat = true)],
    ["hp above max", (s: any) => (s.player.hp = 99)],
    ["fractional hp", (s: any) => (s.player.hp = 3.5)],
    ["player off the map", (s: any) => (s.player.x = -50)],
    ["unknown enemy id", (s: any) => (s.enemies.ghost = 3)],
    ["missing enemy id", (s: any) => delete s.enemies["west-1"]],
    ["enemy hp above max", (s: any) => (s.enemies["lair-boss"] = 41)],
    ["runtime id instead of stable id", (s: any) => { delete s.enemies["west-1"]; s.enemies["1"] = 6; }],
    ["bad outcome", (s: any) => (s.outcome = "paused")],
    ["dead with HP left", (s: any) => (s.outcome = "dead")],
    ["won with enemies alive", (s: any) => (s.outcome = "won")],
    ["0 HP but still playing", (s: any) => (s.player.hp = 0)],
    ["negative stat", (s: any) => (s.stats.kills = -1)],
    ["bad runId", (s: any) => (s.runId = "x")],
  ])("rejects %s", (_name, mutate) => {
    const s = clone(fresh());
    mutate(s);
    expect(validateSave(s).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    for (const x of [null, 3, "save", [], undefined]) expect(validateSave(x).ok).toBe(false);
  });
});

describe("checkpoint progression within a run", () => {
  it("allows damage, kills and stat growth", () => {
    const a = fresh();
    const b = clone(a);
    b.enemies["west-1"] = 0;
    b.enemies["west-2"] = 2;
    b.player.hp = 15;
    b.stats = { fights: 1, wins: 1, flees: 0, kills: 1 };
    b.savedAt += 1000;
    b.reason = "victory";
    expect(checkProgression(a, b)).toBeNull();
  });

  it("refuses to revive a killed enemy", () => {
    const a = fresh();
    a.enemies["west-1"] = 0;
    const b = clone(a);
    b.enemies["west-1"] = 6;
    expect(checkProgression(a, b)).toMatch(/can't come back/);
  });

  it("refuses to swap in a different run or rewrite an ended one", () => {
    const a = fresh();
    expect(checkProgression(a, { ...clone(a), runId: "run_zzzzzzzz" })).not.toBeNull();
    const dead = clone(a);
    dead.outcome = "dead";
    dead.player.hp = 0;
    expect(checkProgression(dead, clone(a))).toMatch(/ended/);
  });

  it("refuses stats or time going backwards", () => {
    const a = fresh();
    a.stats.wins = 2;
    const b = clone(a);
    b.stats.wins = 1;
    expect(checkProgression(a, b)).toMatch(/backwards/);
    const c = clone(a);
    c.savedAt -= 1;
    expect(checkProgression(a, c)).toMatch(/older/);
  });

  it("an area counts as cleared only when every enemy in it is dead", () => {
    const s = fresh();
    s.enemies["west-1"] = 0;
    expect(clearedAreas(s)).toEqual([]);
    s.enemies["west-2"] = 0;
    expect(clearedAreas(s)).toEqual(["west"]);
  });

  it("every map enemy has a unique stable id", () => {
    expect(new Set(ENEMY_SPAWNS.map((e) => e.id)).size).toBe(ENEMY_SPAWNS.length);
  });
});
