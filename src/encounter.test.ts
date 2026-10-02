import { describe, expect, it } from "vitest";
import { JOIN_RADIUS, selectRoster, type Explorer } from "./encounter.ts";
import { LINK_RADIUS, type RoamState } from "./roam.ts";
import { ENEMY_SPAWNS, GROUPS, GROUP_BY_ID, UNITS, groupAnchor, memberOffset } from "./world.ts";

const P = { x: 1000, y: 600 };
type E = Explorer<string>;
const unit = (key: string, dx: number, dy = 0, o: Partial<E> = {}): E => ({
  ref: key, key, alive: true, state: "chasing", x: P.x + dx, y: P.y + dy,
  group: null, groupKind: "skirmish", aggroRange: 210, engageRange: 40, ...o,
});
const pack = (key: string, group: string, dx: number, dy = 0, state: RoamState = "chasing") =>
  unit(key, dx, dy, { group, groupKind: "pack", state });

describe("who joins a fight", () => {
  it("no fight until a chasing enemy reaches its engage range", () => {
    expect(selectRoster([unit("a", 41), unit("b", 100)], P)).toBeNull();
    expect(selectRoster([unit("idle", 10, 0, { state: "idle" })], P)).toBeNull();
  });

  it("skirmishers: nearby chasers join, far ones don't; idle, calm, homing and dead never do", () => {
    const r = selectRoster([
      unit("touch", 30), unit("near", JOIN_RADIUS - 1), unit("far", JOIN_RADIUS + 1),
      unit("idle", 20, 0, { state: "idle" }), unit("calm", 25, 0, { state: "calm" }),
      unit("home", 25, 0, { state: "homing" }), unit("ghost", 20, 0, { alive: false }),
    ], P);
    expect(r).toEqual(["touch", "near"]);
  });

  it("an alerted pack joins along its links, even members beyond the join radius", () => {
    const r = selectRoster([pack("s1", "hollow", 30), pack("s2", "hollow", 250), pack("s3", "hollow", 470)], P);
    expect(r).toEqual(["s1", "s2", "s3"]); // 30 -> 250 -> 470, each link <= 240
  });

  it("a pack-mate across the map (no link chain) stays out: guard far from its boss", () => {
    const r = selectRoster([pack("guard", "lair", 30), pack("boss", "lair", 30 + LINK_RADIUS + 1)], P);
    expect(r).toEqual(["guard"]);
  });

  it("an unalerted pack nearby stays out", () => {
    const r = selectRoster([unit("touch", 30), pack("m1", "north", 60, 0, "idle"), pack("m2", "north", 90, 0, "idle")], P);
    expect(r).toEqual(["touch"]);
  });

  it("a chasing pack near the player merges in with its linked members; no duplicates", () => {
    const r = selectRoster([
      unit("touch", 30),
      pack("a1", "ridge", 200), pack("a2", "ridge", 400),
      pack("b1", "hollow", 35), pack("b2", "hollow", 45),
    ], P);
    expect(r).toEqual(["touch", "a1", "a2", "b1", "b2"]);
    expect(new Set(r).size).toBe(r!.length);
  });

  it("no recursion: a far pack member joining doesn't pull in chasers near it", () => {
    const r = selectRoster([
      pack("s1", "hollow", 30), pack("s2", "hollow", 250),
      unit("nearS2", 300), // a skirmisher chasing next to s2, beyond the join radius
      pack("o1", "lair", 290), // another chasing pack next to s2
    ], P);
    expect(r).toEqual(["s1", "s2"]);
  });

  it("the join radius is 260", () => {
    expect(JOIN_RADIUS).toBe(260);
  });
});

describe("the map's camps", () => {
  it("every pack's members start linked together", () => {
    for (const g of GROUPS.filter((gr) => gr.kind === "pack")) {
      const a = groupAnchor(g.id);
      for (const s of ENEMY_SPAWNS.filter((sp) => sp.group === g.id)) {
        expect(Math.hypot(s.x - a.x, s.y - a.y), s.id).toBeLessThan(LINK_RADIUS / 2);
      }
    }
  });

  it("packs start far enough apart that their links never touch", () => {
    const packs = GROUPS.filter((g) => g.kind === "pack");
    for (let i = 0; i < packs.length; i++)
      for (let j = i + 1; j < packs.length; j++) {
        const a = groupAnchor(packs[i].id);
        const b = groupAnchor(packs[j].id);
        expect(Math.hypot(a.x - b.x, a.y - b.y), `${packs[i].id}-${packs[j].id}`).toBeGreaterThan(480);
      }
  });

  it("the two west scouts can be pulled one at a time, even after both wander towards each other", () => {
    const [a, b] = ENEMY_SPAWNS.filter((s) => s.group === "west");
    expect(Math.hypot(a.x - b.x, a.y - b.y) - 2 * UNITS.brute.wander).toBeGreaterThan(UNITS.brute.aggroRange / 2);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(UNITS.brute.aggroRange + UNITS.brute.wander);
  });

  it("pack offsets put each member back on its spawn around the pack's original center", () => {
    for (const g of GROUPS.filter((gr) => gr.kind === "pack")) {
      const mates = ENEMY_SPAWNS.filter((s) => s.group === g.id && !s.boss);
      const cx = mates.reduce((a, s) => a + s.x, 0) / mates.length;
      const cy = mates.reduce((a, s) => a + s.y, 0) / mates.length;
      for (const s of mates) {
        const o = memberOffset(s.id);
        expect(cx + o.x).toBeCloseTo(s.x);
        expect(cy + o.y).toBeCloseTo(s.y);
      }
    }
    expect(memberOffset("lair-boss")).toEqual({ x: 0, y: 0 });
    expect(memberOffset("west-1")).toEqual({ x: 0, y: 0 });
  });

  it("every group referenced by a spawn exists", () => {
    for (const s of ENEMY_SPAWNS) expect(GROUP_BY_ID.has(s.group), s.id).toBe(true);
  });
});
