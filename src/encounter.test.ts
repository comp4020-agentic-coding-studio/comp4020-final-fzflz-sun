import { describe, expect, it } from "vitest";
import { JOIN_RADIUS, LEASH_FACTOR, nextAIStates, selectRoster, type AIState, type Explorer, type PackInfo } from "./encounter.ts";
import { ENEMY_SPAWNS, GROUPS, GROUP_BY_ID, UNITS, groupAnchor } from "./world.ts";

const P = { x: 1000, y: 600 };
type E = Explorer<string>;
const unit = (key: string, dx: number, dy = 0, o: Partial<E> = {}): E => ({
  ref: key, key, alive: true, state: "chasing", x: P.x + dx, y: P.y + dy,
  group: null, groupKind: "skirmish", aggroRange: 210, engageRange: 40, ...o,
});
const pack = (key: string, group: string, dx: number, dy = 0, state: AIState = "chasing") =>
  unit(key, dx, dy, { group, groupKind: "pack", state });

describe("who joins a fight", () => {
  it("no fight until a chasing enemy reaches its engage range", () => {
    expect(selectRoster([unit("a", 41), unit("b", 100)], P)).toBeNull();
    expect(selectRoster([unit("idle", 10, 0, { state: "idle" })], P)).toBeNull();
  });

  it("skirmishers: nearby chasers join, far ones don't, idle/returning/dead never do", () => {
    const r = selectRoster([
      unit("touch", 30), unit("near", JOIN_RADIUS - 1), unit("far", JOIN_RADIUS + 1),
      unit("idle", 20, 0, { state: "idle" }), unit("back", 25, 0, { state: "returning" }), unit("ghost", 20, 0, { alive: false }),
    ], P);
    expect(r).toEqual(["touch", "near"]);
  });

  it("an alerted pack joins whole when one member touches you, even members beyond the join radius", () => {
    const r = selectRoster([pack("s1", "hollow", 30), pack("s2", "hollow", 300), pack("s3", "hollow", 340)], P);
    expect(r).toEqual(["s1", "s2", "s3"]);
  });

  it("an unalerted pack nearby stays out", () => {
    const r = selectRoster([unit("touch", 30), pack("m1", "north", 60, 0, "idle"), pack("m2", "north", 90, 0, "idle")], P);
    expect(r).toEqual(["touch"]);
  });

  it("a chasing pack near the player merges in with all its members; no duplicates", () => {
    const r = selectRoster([
      unit("touch", 30),
      pack("a1", "ridge", 200), pack("a2", "ridge", 500), // a1 near the player -> whole ridge pack
      pack("b1", "hollow", 35), pack("b2", "hollow", 45), // b1 also triggers
    ], P);
    expect(r).toEqual(["touch", "a1", "a2", "b1", "b2"]);
    expect(new Set(r).size).toBe(r!.length);
  });

  it("no recursion: a far pack member joining doesn't pull in chasers near it", () => {
    const r = selectRoster([
      pack("s1", "hollow", 30), pack("s2", "hollow", 600),
      unit("nearS2", 650), // a skirmisher chasing, but next to s2, far from the player
      pack("o1", "lair", 640), // another chasing pack next to s2
    ], P);
    expect(r).toEqual(["s1", "s2"]);
  });

  it("the join radius is 260", () => {
    expect(JOIN_RADIUS).toBe(260);
  });
});

describe("how enemies notice and give up", () => {
  const packs = new Map<string, PackInfo>([["hollow", { anchor: { x: P.x + 150, y: P.y }, leash: 420 }]]);

  it("skirmishers notice and leash one at a time (a pair can be split)", () => {
    const list = [unit("near", 150, 0, { state: "idle" }), unit("far", 300, 0, { state: "idle" })];
    expect([...nextAIStates(list, P, packs)]).toEqual([["near", "chasing"]]);
    const leash = [unit("c", 210 * LEASH_FACTOR + 1)];
    expect([...nextAIStates(leash, P, packs)]).toEqual([["c", "returning"]]);
  });

  it("noticing one pack member alerts the whole pack, and only that pack", () => {
    const list = [
      pack("s1", "hollow", 150, 0, "idle"), pack("s2", "hollow", 260, 0, "idle"), pack("s3", "hollow", 300, 0, "idle"),
      pack("o1", "other", 230, 0, "idle"),
    ];
    const ch = nextAIStates(list, P, new Map([...packs, ["other", { anchor: { x: P.x + 230, y: P.y }, leash: 420 }]]));
    expect(ch.get("s1")).toBe("chasing");
    expect(ch.get("s2")).toBe("chasing");
    expect(ch.get("s3")).toBe("chasing");
    expect(ch.has("o1")).toBe(false); // 230 > its 210 aggro, and alerts don't cross packs
  });

  it("the pack gives up together past its leash, and can be re-alerted on the way home", () => {
    const far = { x: P.x + 150 - 500, y: P.y }; // 500 from the anchor
    const list = [pack("s1", "hollow", 100), pack("s2", "hollow", 150)];
    const out = nextAIStates(list, far, packs);
    expect(out.get("s1")).toBe("returning");
    expect(out.get("s2")).toBe("returning");
    const back = [pack("s1", "hollow", 150, 0, "returning"), pack("s2", "hollow", 300, 0, "returning")];
    const re = nextAIStates(back, P, packs);
    expect(re.get("s1")).toBe("chasing");
    expect(re.get("s2")).toBe("chasing");
  });

  it("dead or engaged members don't count", () => {
    const list = [pack("s1", "hollow", 150, 0, "idle"), pack("s2", "hollow", 100, 0, "idle")];
    list[1].alive = false;
    expect([...nextAIStates(list, P, packs).keys()]).toEqual(["s1"]);
  });
});

describe("the map's camps", () => {
  it("every pack's members sit close together, well inside the pack's leash", () => {
    for (const g of GROUPS.filter((gr) => gr.kind === "pack")) {
      const a = groupAnchor(g.id);
      for (const s of ENEMY_SPAWNS.filter((sp) => sp.group === g.id)) {
        const d = Math.hypot(s.x - a.x, s.y - a.y);
        expect(d, `${s.id}`).toBeLessThan(120);
        expect(d + UNITS[s.role].aggroRange, `${s.id}: noticing must happen inside the leash`).toBeLessThan(g.leash);
      }
    }
  });

  it("packs are far enough apart that one pack's chase doesn't drag the player into another's aggro by itself", () => {
    const packs = GROUPS.filter((g) => g.kind === "pack");
    for (let i = 0; i < packs.length; i++)
      for (let j = i + 1; j < packs.length; j++) {
        const a = groupAnchor(packs[i].id);
        const b = groupAnchor(packs[j].id);
        expect(Math.hypot(a.x - b.x, a.y - b.y), `${packs[i].id}-${packs[j].id}`).toBeGreaterThan(480);
      }
  });

  it("the two west scouts can be pulled one at a time", () => {
    const [a, b] = ENEMY_SPAWNS.filter((s) => s.group === "west");
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(UNITS.brute.aggroRange);
  });

  it("every group referenced by a spawn exists", () => {
    for (const s of ENEMY_SPAWNS) expect(GROUP_BY_ID.has(s.group), s.id).toBe(true);
  });
});
