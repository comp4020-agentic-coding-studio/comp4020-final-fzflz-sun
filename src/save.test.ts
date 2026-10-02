import { describe, expect, it } from "vitest";
import { checkProgression, clearedAreas, newRun, upgradeSave, validateSave, type SaveData } from "./save.ts";
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

describe("phases", () => {
  it("a fresh run lists every elite and boss at phase 0", () => {
    expect(fresh().phases).toEqual({ "ridge-captain": 0, "lair-boss": 0 });
  });
  it.each([
    ["missing phase", (s: any) => delete s.phases["lair-boss"]],
    ["phase past the cycle", (s: any) => (s.phases["lair-boss"] = 4)],
    ["phase for a grunt", (s: any) => (s.phases["west-1"] = 0)],
  ])("rejects %s", (_n, mutate) => {
    const s = clone(fresh());
    mutate(s);
    expect(validateSave(s).ok).toBe(false);
  });
});

describe("v1 -> current migration", () => {
  const v1 = (enemies: Record<string, number>, extra: Record<string, unknown> = {}) => ({
    v: 1, runId: "run_oldsave1", runNumber: 3, startedAt: 1_700_000_000_000, savedAt: 1_700_000_100_000,
    reason: "victory", outcome: "playing", player: { hp: 17, x: 700, y: 420 },
    enemies: { "west-1": 6, "west-2": 6, "south-1": 6, "north-1": 6, "north-2": 6, "north-3": 6, "lair-guard": 6, "lair-boss": 40, ...enemies },
    stats: { fights: 4, wins: 3, flees: 1, kills: 2 }, ...extra,
  });

  it("produces a valid current save and keeps player, stats and identity", () => {
    const up = upgradeSave(v1({ "west-1": 0, "west-2": 0 })) as SaveData;
    expect(validateSave(up).ok).toBe(true);
    expect(up.v).toBe(3);
    expect(up.places["west-1"]).toBeUndefined(); // dead: no place
    expect(up.places["south-1"]).toEqual({ x: 560, y: 1010, cx: 560, cy: 1010, homing: false });
    expect(up.player).toEqual({ hp: 17, x: 700, y: 420 });
    expect(up.stats).toEqual({ fights: 4, wins: 3, flees: 1, kills: 2 });
    expect(up.runNumber).toBe(3);
  });

  it("confirmed-dead enemies stay dead; wounded ones keep their HP", () => {
    const up = upgradeSave(v1({ "west-1": 0, "south-1": 2, "lair-boss": 17 })) as SaveData;
    expect(up.enemies["west-1"]).toBe(0);
    expect(up.enemies["south-1"]).toBe(2);
    expect(up.enemies["lair-boss"]).toBe(17);
  });

  it("new enemies join an unfinished camp at full HP, but a camp cleared in v1 stays cleared", () => {
    const open = upgradeSave(v1({})) as SaveData;
    expect(open.enemies["north-mage"]).toBe(6 + 3); // mage max HP 9
    expect(open.enemies["swarm-1"]).toBe(3);
    const cleared = upgradeSave(v1({ "north-1": 0, "north-2": 0, "north-3": 0 })) as SaveData;
    expect(cleared.enemies["north-mage"]).toBe(0);
    expect(clearedAreas(cleared)).toContain("north");
  });

  it("a finished v1 run keeps its result (new enemies didn't exist in it)", () => {
    const allDead = Object.fromEntries(["west-1", "west-2", "south-1", "north-1", "north-2", "north-3", "lair-guard", "lair-boss"].map((k) => [k, 0]));
    const won = upgradeSave(v1(allDead, { outcome: "won" })) as SaveData;
    expect(validateSave(won).ok).toBe(true);
    expect(won.outcome).toBe("won");
    const dead = upgradeSave(v1({}, { outcome: "dead", reason: "death", player: { hp: 0, x: 700, y: 420 } })) as SaveData;
    expect(validateSave(dead).ok).toBe(true);
    expect(dead.enemies["swarm-1"]).toBe(0);
  });

  it("scales a living enemy's HP if its max HP changed (rounded up, never to 0)", () => {
    const buffed = ENEMY_SPAWNS.map((sp) => (sp.id === "north-1" ? { ...sp, maxHp: 9 } : sp));
    expect((upgradeSave(v1({ "north-1": 3 }), buffed) as SaveData).enemies["north-1"]).toBe(5); // ceil(3 * 9 / 6)
    expect((upgradeSave(v1({ "north-1": 6 }), buffed) as SaveData).enemies["north-1"]).toBe(9);
    const nerfed = ENEMY_SPAWNS.map((sp) => (sp.id === "lair-boss" ? { ...sp, maxHp: 4 } : sp));
    expect((upgradeSave(v1({ "lair-boss": 1 }), nerfed) as SaveData).enemies["lair-boss"]).toBe(1); // ceil(0.1) -> 1, not 0
    expect((upgradeSave(v1({ "lair-boss": 0 }), nerfed) as SaveData).enemies["lair-boss"]).toBe(0);
  });

  it("current saves and junk pass through unchanged", () => {
    const cur = fresh();
    expect(upgradeSave(cur)).toBe(cur);
    expect(upgradeSave(null)).toBeNull();
    expect(upgradeSave({ v: 9 })).toEqual({ v: 9 });
  });
});

describe("places (v3)", () => {
  const withPlace = (id: string, q: Partial<SaveData["places"][string]>) => {
    const s = clone(fresh());
    s.places[id] = { ...s.places[id], ...q };
    return s;
  };

  it("a fresh run places everyone at their spawn, centered there, not homing", () => {
    const s = fresh();
    expect(Object.keys(s.places).length).toBe(ENEMY_SPAWNS.length);
    expect(s.places["lair-boss"]).toEqual({ x: 1905, y: 615, cx: 1905, cy: 615, homing: false });
  });

  it("accepts a grunt pulled across the map with a new center there, and a boss walking home", () => {
    expect(validateSave(withPlace("west-1", { x: 1500, y: 900, cx: 1490, cy: 910 })).ok).toBe(true);
    expect(validateSave(withPlace("lair-boss", { x: 1700, y: 640, homing: true })).ok).toBe(true);
  });

  it.each([
    ["a position off the map", "west-1", { x: -5 }],
    ["a center off the map", "west-1", { cy: 1400 }],
    ["a boss centered away from its lair", "lair-boss", { cx: 1500 }],
    ["a homing grunt", "west-1", { homing: true }],
  ])("rejects %s", (_n, id, q) => {
    expect(validateSave(withPlace(id, q as never)).ok).toBe(false);
  });

  it("places must list exactly the living enemies", () => {
    const s = clone(fresh());
    s.enemies["west-1"] = 0;
    expect(validateSave(s).ok).toBe(false); // still has a place for a dead enemy
    delete s.places["west-1"];
    expect(validateSave(s).ok).toBe(true);
    delete s.places["west-2"];
    expect(validateSave(s).ok).toBe(false); // a living enemy without a place
  });

  it("a v2 save gets everyone living placed at spawn; HP, deaths and phases unchanged", () => {
    const v2 = clone(fresh()) as any;
    v2.v = 2;
    delete v2.places;
    v2.enemies["west-1"] = 0;
    v2.enemies["south-1"] = 2;
    v2.phases["lair-boss"] = 3;
    const up = upgradeSave(v2) as SaveData;
    expect(validateSave(up).ok).toBe(true);
    expect(up.places["west-1"]).toBeUndefined();
    expect(up.places["south-1"]).toEqual({ x: 560, y: 1010, cx: 560, cy: 1010, homing: false });
    expect(up.enemies["south-1"]).toBe(2);
    expect(up.phases["lair-boss"]).toBe(3);
  });
});
