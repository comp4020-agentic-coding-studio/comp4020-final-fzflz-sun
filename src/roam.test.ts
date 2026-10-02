import { describe, expect, it } from "vitest";
import {
  CALM_TIME, DISENGAGE_DELAY, LAIR_RADIUS, LEASH_FACTOR, LINK_RADIUS, linkClusters, pickWanderTarget, roamTick,
  type Pt, type RoamEvent, type RoamUnit,
} from "./roam.ts";
import { SPAWN_BY_ID, UNITS, WORLD_HEIGHT, WORLD_WIDTH, memberOffset, wanderRadiusOf } from "./world.ts";

const WORLD = { w: WORLD_WIDTH, h: WORLD_HEIGHT };
const DT = 1 / 30;

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A unit as main.ts builds it from a map spawn, optionally somewhere else. */
function fromSpawn(id: string, at?: Pt, pace = 0.4): RoamUnit {
  const sp = SPAWN_BY_ID.get(id)!;
  const def = UNITS[sp.role];
  const pos = at ? { ...at } : { x: sp.x, y: sp.y };
  return {
    key: id, alive: true, tier: def.tier, role: sp.role, group: sp.group,
    groupKind: sp.group === "west" || sp.group === "south" || sp.group === "north-sentry" ? "skirmish" : "pack",
    pos, spawn: { x: sp.x, y: sp.y }, center: { ...pos }, offset: memberOffset(id),
    aggroRange: def.aggroRange, engageRange: def.engageRange, speed: def.speed, bodyRadius: def.radius,
    wanderRadius: wanderRadiusOf(id), wanderPace: pace, state: "idle", stateUntil: 0,
    wanderTarget: null, pauseUntil: 0, moveSince: 0, outSince: null,
  };
}
function spawnCenter(u: RoamUnit) {
  u.center = { ...u.spawn };
  return u;
}

/** Runs `secs` of exploration with the player following `playerAt(t)`. */
function sim(units: RoamUnit[], secs: number, playerAt: (t: number) => Pt, seed = 1, t0 = 0) {
  const r = rng(seed);
  const events: { t: number; ev: RoamEvent }[] = [];
  const track: Pt[][] = units.map(() => []);
  for (let t = t0; t < t0 + secs; t += DT) {
    for (const ev of roamTick(units, { now: t, dt: DT, player: playerAt(t), rnd: r, world: WORLD })) events.push({ t, ev });
    units.forEach((u, i) => track[i].push({ ...u.pos }));
  }
  return { events, track };
}
const FAR: Pt = { x: 100, y: 100 };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

describe("idle wandering", () => {
  it("moves, pauses, and stays inside its wander radius for a long time", () => {
    const u = spawnCenter(fromSpawn("west-1"));
    const { track } = sim([u], 120, () => FAR);
    const pts = track[0];
    const maxOff = Math.max(...pts.map((p) => dist(p, u.center)));
    expect(maxOff).toBeLessThanOrEqual(u.wanderRadius + 0.5);
    const moved = pts.filter((p, i) => i > 0 && dist(p, pts[i - 1]) > 0.01).length;
    const still = pts.length - 1 - moved;
    expect(moved).toBeGreaterThan(pts.length * 0.2); // it really walks
    expect(still).toBeGreaterThan(pts.length * 0.2); // and really pauses
    const speeds = pts.slice(1).map((p, i) => dist(p, pts[i]) / DT);
    expect(Math.max(...speeds)).toBeLessThan(UNITS.brute.speed); // slower than a chase
  });

  it("never leaves the map, never stalls, never produces NaN at a map corner", () => {
    for (const c of [{ x: 5, y: 5 }, { x: WORLD_WIDTH - 5, y: 5 }, { x: 5, y: WORLD_HEIGHT - 5 }, { x: WORLD_WIDTH - 5, y: WORLD_HEIGHT - 5 }]) {
      const u = fromSpawn("west-1", c);
      const { track } = sim([u], 60, () => ({ x: 1100, y: 650 }), 7);
      for (const p of track[0]) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(u.bodyRadius);
        expect(p.x).toBeLessThanOrEqual(WORLD_WIDTH - u.bodyRadius);
        expect(p.y).toBeGreaterThanOrEqual(u.bodyRadius);
        expect(p.y).toBeLessThanOrEqual(WORLD_HEIGHT - u.bodyRadius);
      }
      const distinct = new Set(track[0].map((p) => `${Math.round(p.x / 5)},${Math.round(p.y / 5)}`)).size;
      expect(distinct).toBeGreaterThan(5); // keeps picking new reachable targets
    }
  });

  it("wander targets are inside the disc and on the map", () => {
    const r = rng(3);
    for (let i = 0; i < 500; i++) {
      const t = pickWanderTarget({ x: 10, y: 1290 }, 70, r, WORLD, 14);
      expect(t.x).toBeGreaterThanOrEqual(14);
      expect(t.y).toBeLessThanOrEqual(WORLD_HEIGHT - 14);
      expect(dist(t, { x: 10, y: 1290 })).toBeLessThanOrEqual(70 + 14 * Math.SQRT2);
    }
  });

  it("units pause for different lengths (no lockstep)", () => {
    const a = spawnCenter(fromSpawn("west-1", undefined, 0.35));
    const b = spawnCenter(fromSpawn("west-2", undefined, 0.45));
    const { track } = sim([a, b], 30, () => FAR, 11);
    const sig = (pts: Pt[]) => pts.map((p, i) => (i && dist(p, pts[i - 1]) > 0.01 ? 1 : 0)).join("");
    expect(sig(track[0])).not.toBe(sig(track[1]));
  });
});

describe("grunts and elites: pulled away, settle where they gave up", () => {
  it("a loner chases out of its area, gives up after the delay, and makes a new center there", () => {
    const u = spawnCenter(fromSpawn("west-1"));
    const leash = u.aggroRange * LEASH_FACTOR;
    // the player lures it 600 px east, then runs further away
    const lure = (t: number) => (t < 6 ? { x: u.spawn.x + 100 + t * 100, y: u.spawn.y } : { x: u.spawn.x + 2000, y: u.spawn.y });
    const { events } = sim([u], 14, lure);
    const settled = events.find((e) => e.ev.kind === "settled");
    expect(settled).toBeTruthy();
    expect(dist(u.center, u.spawn)).toBeGreaterThan(300); // not back home
    expect(dist(u.pos, u.center)).toBeLessThanOrEqual(u.wanderRadius + 1); // wandering around the new spot
    expect(leash).toBeCloseTo(283.5);
  });

  it("hovering around the leash edge for less than the delay doesn't end the chase", () => {
    const u = spawnCenter(fromSpawn("west-1", { x: 600, y: 400 }));
    u.state = "chasing";
    const leash = u.aggroRange * LEASH_FACTOR;
    // jump beyond the leash for half the delay, back inside, repeat
    const half = DISENGAGE_DELAY / 2;
    const at = (t: number) => ({ x: u.pos.x + (Math.floor(t / half) % 2 === 0 ? leash + 20 : leash - 40), y: u.pos.y });
    const { events } = sim([u], 4, at);
    expect(events.some((e) => e.ev.kind === "settled")).toBe(false);
  });

  it("after giving up it ignores the player for a moment, then can notice again", () => {
    const u = spawnCenter(fromSpawn("west-1", { x: 900, y: 400 }));
    u.state = "chasing";
    const p = { x: 900 + 400, y: 400 };
    const { events } = sim([u], DISENGAGE_DELAY + 0.2, () => p);
    expect(events.some((e) => e.ev.kind === "settled")).toBe(true);
    expect(u.state).toBe("calm");
    const near = { x: u.pos.x + 50, y: u.pos.y };
    sim([u], CALM_TIME - 0.3, () => near, 1, DISENGAGE_DELAY + 0.3);
    expect(u.state).toBe("calm");
    sim([u], 0.5, () => near, 1, DISENGAGE_DELAY + CALM_TIME + 0.1);
    expect(u.state).toBe("chasing");
  });

  it("two loners are handled on their own (one can be pulled, the other keeps wandering)", () => {
    const a = spawnCenter(fromSpawn("west-1"));
    const b = spawnCenter(fromSpawn("west-2"));
    const p = { x: a.spawn.x - 150, y: a.spawn.y };
    sim([a, b], 0.5, () => p);
    expect(a.state).toBe("chasing");
    expect(b.state).toBe("idle");
  });
});

describe("packs move as one", () => {
  const swarm = () => ["swarm-1", "swarm-2", "swarm-3"].map((id) => spawnCenter(fromSpawn(id)));

  it("noticing one alerts every linked member", () => {
    const s = swarm();
    sim(s, 0.2, () => ({ x: s[0].spawn.x - 150, y: s[0].spawn.y }));
    expect(s.map((u) => u.state)).toEqual(["chasing", "chasing", "chasing"]);
  });

  it("gives up together and settles around a shared new center, members near their offsets", () => {
    const s = swarm();
    // lure it west, then break away far enough that even swarmlings (115/s) can't close the gap in time
    const lure = (t: number) => (t < 5 ? { x: 990 - 150 - t * 90, y: 1050 } : { x: 100, y: 100 });
    sim(s, 12, lure);
    expect(s.every((u) => u.state === "idle" || u.state === "calm")).toBe(true);
    const c0 = { x: s[0].center.x - s[0].offset.x, y: s[0].center.y - s[0].offset.y };
    for (const u of s) {
      expect(u.center.x - u.offset.x).toBeCloseTo(c0.x); // one shared center
      expect(u.center.y - u.offset.y).toBeCloseTo(c0.y);
    }
    expect(c0.x).toBeLessThan(800); // somewhere new, west of the hollow
    const spread = Math.max(...s.flatMap((a) => s.map((b) => dist(a.pos, b.pos))));
    expect(spread).toBeLessThan(LINK_RADIUS); // still recognisably one pack
  });

  it("a lagging mage doesn't end the chase while its grunts are still close", () => {
    const g1 = fromSpawn("north-1", { x: 1000, y: 600 });
    const mage = fromSpawn("north-mage", { x: 1000 + 600, y: 600 });
    for (const u of [g1, mage]) u.state = "chasing";
    const p = { x: 1000 - 100, y: 600 };
    const { events } = sim([g1, mage], 2, () => p);
    expect(events.some((e) => e.ev.kind === "settled")).toBe(false);
  });

  it("alerts don't cross the map: a guard far from its boss forms its own cluster", () => {
    const boss = spawnCenter(fromSpawn("lair-boss"));
    const guard = fromSpawn("lair-guard", { x: 600, y: 300 });
    const guard2 = fromSpawn("lair-guard-2", { x: 640, y: 320 });
    expect(linkClusters([boss, guard, guard2]).map((c) => c.map((u) => u.key).sort())).toEqual([["lair-boss"], ["lair-guard", "lair-guard-2"]]);
    sim([boss, guard, guard2], 0.2, () => ({ x: 600 - 120, y: 300 }));
    expect([guard.state, guard2.state, boss.state]).toEqual(["chasing", "chasing", "idle"]);
    boss.state = "idle";
    guard.state = guard2.state = "calm";
    guard.stateUntil = guard2.stateUntil = 1e9;
    sim([boss, guard, guard2], 0.2, () => ({ x: boss.pos.x - 150, y: boss.pos.y }));
    expect([boss.state, guard.state, guard2.state]).toEqual(["chasing", "calm", "calm"]);
  });
});

describe("the boss goes home", () => {
  it("chases, turns back at the edge of its lair, walks home ignoring the player, then calms", () => {
    const boss = spawnCenter(fromSpawn("lair-boss"));
    const lure = (t: number) => ({ x: boss.spawn.x - 120 - t * 70, y: boss.spawn.y }); // leads it west
    const { events } = sim([boss], 30, lure);
    const turned = events.find((e) => e.ev.kind === "homing");
    const home = events.find((e) => e.ev.kind === "homed");
    expect(turned).toBeTruthy();
    expect(home).toBeTruthy();
    expect(home!.t).toBeGreaterThan(turned!.t);
    expect(dist(boss.center, boss.spawn)).toBe(0);
    expect(dist(boss.pos, boss.spawn)).toBeLessThanOrEqual(boss.wanderRadius + 1);
  });

  it("never strays beyond its lair radius (+ one frame)", () => {
    const boss = spawnCenter(fromSpawn("lair-boss"));
    const { track } = sim([boss], 30, (t) => ({ x: boss.spawn.x - 120 - t * 70, y: boss.spawn.y }));
    const maxOut = Math.max(...track[0].map((p) => dist(p, boss.spawn)));
    expect(maxOut).toBeLessThanOrEqual(LAIR_RADIUS + UNITS.boss.speed * DT + 0.5);
  });

  it("while homing it can't be pulled back into a chase", () => {
    const boss = fromSpawn("lair-boss", { x: 1700, y: 615 });
    boss.state = "homing";
    sim([boss], 1, () => ({ x: boss.pos.x - 60, y: boss.pos.y }));
    expect(boss.state).toBe("homing");
  });

  it("its guards stay where they gave up while it goes home", () => {
    const boss = fromSpawn("lair-boss", { x: 1500, y: 615 });
    const guard = fromSpawn("lair-guard", { x: 1460, y: 640 });
    for (const u of [boss, guard]) u.state = "chasing";
    const away = { x: 600, y: 615 };
    sim([boss, guard], 20, () => away);
    expect(dist(boss.pos, boss.spawn)).toBeLessThanOrEqual(boss.wanderRadius + 1);
    expect(dist(guard.center, guard.spawn)).toBeGreaterThan(200);
  });
});

describe("fights and pauses", () => {
  it("units in a fight are never moved or changed by exploration", () => {
    const u = fromSpawn("west-1", { x: 500, y: 500 });
    u.state = "engaged";
    sim([u], 3, () => ({ x: 510, y: 500 }));
    expect(u.pos).toEqual({ x: 500, y: 500 });
    expect(u.state).toBe("engaged");
  });
});
