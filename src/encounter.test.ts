import { describe, expect, it } from "vitest";
import { JOIN_RADIUS, PLAYER_JOIN_RADIUS, selectRoster, type EncounterPlayer, type Explorer } from "./encounter.ts";
import { LINK_RADIUS, type RoamState } from "./roam.ts";
import { ENEMY_SPAWNS, GROUPS, GROUP_BY_ID, UNITS, groupAnchor, memberOffset } from "./world.ts";

const P = { x: 1000, y: 600 };
type E = Explorer<string>;
const unit = (key: string, dx: number, dy = 0, o: Partial<E> = {}): E => ({
  ref: key, key, alive: true, state: "chasing", x: P.x + dx, y: P.y + dy,
  group: null, groupKind: "skirmish", aggroRange: 210, engageRange: 40, targetId: "solo", ...o,
});
const pack = (key: string, group: string, dx: number, dy = 0, state: RoamState = "chasing") =>
  unit(key, dx, dy, { group, groupKind: "pack", state });
const solo = (at: { x: number; y: number } = P): EncounterPlayer[] => [{ id: "solo", x: at.x, y: at.y, alive: true, busy: false }];
/** selectRoster, but just the enemy keys (most tests only care about those). */
const roster = (list: E[], players = solo(), enemyJoinRadius?: number, playerJoinRadius?: number) =>
  selectRoster(list, players, enemyJoinRadius, playerJoinRadius)?.enemies ?? null;

describe("who joins a fight", () => {
  it("no fight until a chasing enemy reaches its engage range", () => {
    expect(roster([unit("a", 41), unit("b", 100)])).toBeNull();
    expect(roster([unit("idle", 10, 0, { state: "idle" })])).toBeNull();
  });

  it("skirmishers: nearby chasers join, far ones don't; idle, calm, homing and dead never do", () => {
    const r = roster([
      unit("touch", 30), unit("near", JOIN_RADIUS - 1), unit("far", JOIN_RADIUS + 1),
      unit("idle", 20, 0, { state: "idle" }), unit("calm", 25, 0, { state: "calm" }),
      unit("home", 25, 0, { state: "homing" }), unit("ghost", 20, 0, { alive: false }),
    ]);
    expect(r).toEqual(["touch", "near"]);
  });

  it("an alerted pack joins along its links, even members beyond the join radius", () => {
    const r = roster([pack("s1", "hollow", 30), pack("s2", "hollow", 250), pack("s3", "hollow", 470)]);
    expect(r).toEqual(["s1", "s2", "s3"]); // 30 -> 250 -> 470, each link <= 240
  });

  it("a pack-mate across the map (no link chain) stays out: guard far from its boss", () => {
    const r = roster([pack("guard", "lair", 30), pack("boss", "lair", 30 + LINK_RADIUS + 1)]);
    expect(r).toEqual(["guard"]);
  });

  it("an unalerted pack nearby stays out", () => {
    const r = roster([unit("touch", 30), pack("m1", "north", 60, 0, "idle"), pack("m2", "north", 90, 0, "idle")]);
    expect(r).toEqual(["touch"]);
  });

  it("a chasing pack near the player merges in with its linked members; no duplicates", () => {
    const r = roster([
      unit("touch", 30),
      pack("a1", "ridge", 200), pack("a2", "ridge", 400),
      pack("b1", "hollow", 35), pack("b2", "hollow", 45),
    ]);
    expect(r).toEqual(["touch", "a1", "a2", "b1", "b2"]);
    expect(new Set(r).size).toBe(r!.length);
  });

  it("no recursion: a far pack member joining doesn't pull in chasers near it", () => {
    const r = roster([
      pack("s1", "hollow", 30), pack("s2", "hollow", 250),
      unit("nearS2", 300), // a skirmisher chasing next to s2, beyond the join radius
      pack("o1", "lair", 290), // another chasing pack next to s2
    ]);
    expect(r).toEqual(["s1", "s2"]);
  });

  it("the join radius is 260", () => {
    expect(JOIN_RADIUS).toBe(260);
  });

  it("a trigger whose target player isn't resolvable (already gone) never anchors a fight", () => {
    expect(roster([unit("a", 10, 0, { targetId: "ghost-player" })], solo())).toBeNull();
  });
});

describe("co-op: which players join", () => {
  it("a second free, alive, online player within PLAYER_JOIN_RADIUS joins the fight", () => {
    const players: EncounterPlayer[] = [
      { id: "anchor", x: P.x, y: P.y, alive: true, busy: false },
      { id: "mate", x: P.x + PLAYER_JOIN_RADIUS - 1, y: P.y, alive: true, busy: false },
    ];
    const result = selectRoster([unit("a", 30, 0, { targetId: "anchor" })], players);
    expect(result?.anchorId).toBe("anchor");
    expect(result?.playerIds).toEqual(["anchor", "mate"]);
  });

  it("a player beyond PLAYER_JOIN_RADIUS stays out", () => {
    const players: EncounterPlayer[] = [
      { id: "anchor", x: P.x, y: P.y, alive: true, busy: false },
      { id: "far", x: P.x + PLAYER_JOIN_RADIUS + 1, y: P.y, alive: true, busy: false },
    ];
    const result = selectRoster([unit("a", 30, 0, { targetId: "anchor" })], players);
    expect(result?.playerIds).toEqual(["anchor"]);
  });

  it("exactly on the boundary joins (<=), one past it doesn't", () => {
    const base: EncounterPlayer = { id: "anchor", x: P.x, y: P.y, alive: true, busy: false };
    const onLine = selectRoster([unit("a", 30, 0, { targetId: "anchor" })], [base, { id: "edge", x: P.x + PLAYER_JOIN_RADIUS, y: P.y, alive: true, busy: false }]);
    expect(onLine?.playerIds).toContain("edge");
    const justOver = selectRoster([unit("a", 30, 0, { targetId: "anchor" })], [base, { id: "edge", x: P.x + PLAYER_JOIN_RADIUS + 0.01, y: P.y, alive: true, busy: false }]);
    expect(justOver?.playerIds).not.toContain("edge");
  });

  it("an offline, dead, or already-busy teammate never joins, however close", () => {
    const anchor: EncounterPlayer = { id: "anchor", x: P.x, y: P.y, alive: true, busy: false };
    const close = (id: string, extra: Partial<EncounterPlayer>) => ({ id, x: P.x + 10, y: P.y, alive: true, busy: false, ...extra });
    const result = selectRoster(
      [unit("a", 30, 0, { targetId: "anchor" })],
      [anchor, close("dead", { alive: false }), close("busy", { busy: true })],
    );
    expect(result?.playerIds).toEqual(["anchor"]);
  });

  it("no chain expansion: a teammate near another joining teammate, but far from the anchor, stays out", () => {
    const anchor: EncounterPlayer = { id: "anchor", x: P.x, y: P.y, alive: true, busy: false };
    const near: EncounterPlayer = { id: "near", x: P.x + PLAYER_JOIN_RADIUS - 10, y: P.y, alive: true, busy: false };
    // "far" is right next to "near", but PLAYER_JOIN_RADIUS*2 from the anchor
    const far: EncounterPlayer = { id: "far", x: near.x + PLAYER_JOIN_RADIUS - 10, y: P.y, alive: true, busy: false };
    const result = selectRoster([unit("a", 30, 0, { targetId: "anchor" })], [anchor, near, far]);
    expect(result?.playerIds).toEqual(["anchor", "near"]);
  });

  it("the anchor is whichever player's target an enemy actually reached engage range against, not always players[0]", () => {
    const far: EncounterPlayer = { id: "far", x: P.x + 5000, y: P.y, alive: true, busy: false };
    const near: EncounterPlayer = { id: "near", x: P.x + 30, y: P.y, alive: true, busy: false };
    const result = selectRoster([unit("a", 30, 0, { targetId: "near" })], [far, near]);
    expect(result?.anchorId).toBe("near");
  });

  it("two players triggering two unrelated, far-apart enemies in one call only forms the first anchor's fight", () => {
    const players: EncounterPlayer[] = [
      { id: "p1", x: P.x, y: P.y, alive: true, busy: false },
      { id: "p2", x: P.x + 2000, y: P.y, alive: true, busy: false },
    ];
    const result = selectRoster(
      [unit("a", 30, 0, { targetId: "p1" }), unit("b", 2030, 0, { targetId: "p2" })],
      players,
    );
    // only p1's trigger (first in list order) forms this call's fight; a second
    // call (after "a" is marked busy/engaged) would pick up p2's separately.
    expect(result?.anchorId).toBe("p1");
    expect(result?.enemies).toEqual(["a"]);
    expect(result?.playerIds).toEqual(["p1"]); // p2 is 2000px away: not pulled in as a teammate either
  });

  it("the default player join radius is bigger than the enemy join radius, but under the inter-camp gap", () => {
    expect(PLAYER_JOIN_RADIUS).toBeGreaterThan(JOIN_RADIUS);
    expect(PLAYER_JOIN_RADIUS).toBeLessThan(480);
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
