// How enemies move while nobody is fighting: wander, notice, chase, give up.
// Pure (no Kaplay): roamTick mutates plain unit records, so tests can run
// minutes of simulated time and main.ts can pass its game objects straight in.
//
// Four positions are kept apart:
//   spawn  - fixed in world.ts: initial layout, old-save migration, boss home;
//   pos    - where the unit really is (exploring, chasing, saving);
//   center - what it wanders around; grunts and elites move it when they give
//            up a chase, a boss's center is always its spawn;
//   slot   - the fight formation position, never stored here or in a save.
import type { Role, Tier } from "./world.ts";

export type RoamState = "idle" | "chasing" | "calm" | "homing" | "engaged";

export interface Pt {
  x: number;
  y: number;
}

export interface RoamUnit {
  key: string;
  alive: boolean;
  tier: Tier;
  role: Role;
  group: string | null;
  groupKind: "skirmish" | "pack";
  pos: Pt;
  spawn: Pt;
  center: Pt;
  /** where this member sits relative to its pack's shared center (0,0 for loners) */
  offset: Pt;
  aggroRange: number;
  engageRange: number;
  speed: number;
  bodyRadius: number;
  wanderRadius: number;
  /** wander speed as a fraction of chase speed, slightly different per unit */
  wanderPace: number;
  state: RoamState;
  stateUntil: number;
  wanderTarget: Pt | null;
  pauseUntil: number;
  moveSince: number;
  outSince: number | null;
}

/** Pack members this close to each other share an alert, and fight together. */
export const LINK_RADIUS = 240;
/** Give up once the player is this many times the (largest) aggro range away... */
export const LEASH_FACTOR = 1.35;
/** ...continuously for this long (so hovering at the edge doesn't flip states). */
export const DISENGAGE_DELAY = 0.6;
/** After giving up: stand still and ignore the player for this long, then wander again. */
export const CALM_TIME = 1.5;
/** A boss chases only this far from its lair before going home. */
export const LAIR_RADIUS = 380;
/** A mage hangs back this far while a pack-mate is still chasing; alone, it closes in. */
export const MAGE_FOLLOW = 110;
export const PAUSE_MIN = 0.8;
export const PAUSE_SPREAD = 1.8;
/** a wander leg that takes longer than this (blocked by others) is abandoned */
export const WANDER_GIVE_UP = 5;

export interface RoamOpts {
  now: number;
  dt: number;
  player: Pt;
  rnd: () => number;
  world: { w: number; h: number };
  /** dev test fights: nobody gives up */
  noDisengage?: boolean;
}

export type RoamEvent =
  | { kind: "alerted"; keys: string[] }
  | { kind: "settled"; keys: string[]; center: Pt }
  | { kind: "homing"; key: string }
  | { kind: "homed"; key: string };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const clampPt = (p: Pt, margin: number, w: { w: number; h: number }): Pt => ({
  x: clamp(p.x, margin, w.w - margin),
  y: clamp(p.y, margin, w.h - margin),
});
const centroid = (us: { pos: Pt }[]): Pt => ({
  x: us.reduce((s, u) => s + u.pos.x, 0) / us.length,
  y: us.reduce((s, u) => s + u.pos.y, 0) / us.length,
});

/** A point inside the wander disc (uniform), kept on the map with room for the body. */
export function pickWanderTarget(center: Pt, radius: number, rnd: () => number, world: { w: number; h: number }, margin: number): Pt {
  const a = rnd() * Math.PI * 2;
  const r = radius * Math.sqrt(rnd());
  return clampPt({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r }, margin, world);
}

/**
 * Groups of same-pack units connected by links of at most LINK_RADIUS. Used
 * for alerts and fights, so a guard far from its boss forms its own cluster:
 * no cross-map alerts, no cross-map rosters.
 */
export function linkClusters<T extends { group: string | null; groupKind: string; pos: Pt }>(units: T[], radius = LINK_RADIUS): T[][] {
  const out: T[][] = [];
  const seen = new Set<T>();
  for (const u of units) {
    if (seen.has(u)) continue;
    const comp = [u];
    seen.add(u);
    if (u.groupKind === "pack" && u.group) {
      for (let i = 0; i < comp.length; i++) {
        for (const v of units) {
          if (!seen.has(v) && v.groupKind === "pack" && v.group === u.group && dist(v.pos, comp[i].pos) <= radius) {
            seen.add(v);
            comp.push(v);
          }
        }
      }
    }
    out.push(comp);
  }
  return out;
}

function settle(us: RoamUnit[], o: RoamOpts, events: RoamEvent[]) {
  if (!us.length) return;
  const c = us.length > 1 || us[0].groupKind === "pack" ? centroid(us) : { ...us[0].pos };
  for (const u of us) {
    u.center = clampPt({ x: c.x + u.offset.x, y: c.y + u.offset.y }, u.bodyRadius + 4, o.world);
    u.state = "calm";
    u.stateUntil = o.now + CALM_TIME;
    u.wanderTarget = null;
    u.outSince = null;
  }
  events.push({ kind: "settled", keys: us.map((u) => u.key), center: c });
}

function sendHome(u: RoamUnit, o: RoamOpts, events: RoamEvent[]) {
  u.center = { ...u.spawn }; // a boss's center is its lair, always
  u.state = "homing";
  u.wanderTarget = null;
  u.outSince = null;
  events.push({ kind: "homing", key: u.key });
}

/** True once `cond` has held for DISENGAGE_DELAY; resets as soon as it doesn't. */
function sustained(holder: RoamUnit, cond: boolean, now: number): boolean {
  if (!cond) {
    holder.outSince = null;
    return false;
  }
  holder.outSince ??= now;
  return now - holder.outSince >= DISENGAGE_DELAY;
}

function step(u: RoamUnit, to: Pt, speed: number, dt: number, stopAt = 0): boolean {
  const dx = to.x - u.pos.x;
  const dy = to.y - u.pos.y;
  const d = Math.hypot(dx, dy);
  if (d <= stopAt + 0.01) return true;
  const s = Math.min(speed * dt, d - stopAt);
  u.pos.x += (dx / d) * s;
  u.pos.y += (dy / d) * s;
  return d - s <= stopAt + 0.5;
}

/**
 * One exploration frame for every living unit not in a fight. Returns what
 * changed in a way worth saving (settled, homed) or showing (alerted).
 *
 * - idle units wander around their center: pick a point, walk below chase
 *   speed, pause, repeat; a unit noticing the player starts chasing, and so
 *   does every idle member of its link cluster (packs only);
 * - grunts and elites give up when the player has been out of reach for
 *   DISENGAGE_DELAY: a loner when the player is LEASH_FACTOR x its aggro
 *   away; a pack (all its chasing non-boss members together) when the player
 *   is that far from the *nearest* member, so a lagging mage can't end the
 *   chase early. They settle where they are: a new shared center at the
 *   members' centroid (plus each member's offset), then a calm pause;
 * - a boss gives up the same way, or as soon as it's LAIR_RADIUS from home,
 *   and walks back to its spawn ignoring the player, then calms.
 */
export function roamTick(units: RoamUnit[], o: RoamOpts): RoamEvent[] {
  const events: RoamEvent[] = [];
  const live = units.filter((u) => u.alive && u.state !== "engaged");

  for (const u of live) if (u.state === "calm" && o.now >= u.stateUntil) u.state = "idle";

  // noticing: idle units only; alerts spread through the noticer's link cluster
  const awake = live.filter((u) => u.state === "idle" || u.state === "chasing");
  for (const cluster of linkClusters(awake)) {
    const noticed = cluster.some((u) => u.state === "idle" && dist(u.pos, o.player) <= u.aggroRange);
    if (!noticed) continue;
    const woke = cluster.filter((u) => u.state === "idle");
    for (const u of woke) {
      u.state = "chasing";
      u.wanderTarget = null;
      u.outSince = null;
    }
    events.push({ kind: "alerted", keys: woke.map((u) => u.key) });
  }

  if (!o.noDisengage) {
    for (const u of live) {
      if (u.state !== "chasing") continue;
      if (u.tier === "boss") {
        const out = dist(u.pos, o.player) > u.aggroRange * LEASH_FACTOR;
        if (dist(u.pos, u.spawn) > LAIR_RADIUS || sustained(u, out, o.now)) sendHome(u, o, events);
      } else if (u.groupKind === "skirmish" && sustained(u, dist(u.pos, o.player) > u.aggroRange * LEASH_FACTOR, o.now)) {
        settle([u], o, events);
      }
    }
    const packIds = new Set(live.filter((u) => u.groupKind === "pack" && u.state === "chasing" && u.tier !== "boss").map((u) => u.group!));
    for (const g of packIds) {
      const chasers = live.filter((u) => u.group === g && u.state === "chasing" && u.tier !== "boss");
      const nearest = Math.min(...chasers.map((u) => dist(u.pos, o.player)));
      const leash = LEASH_FACTOR * Math.max(...chasers.map((u) => u.aggroRange));
      if (sustained(chasers[0], nearest > leash, o.now)) settle(chasers, o, events);
    }
  }

  for (const u of live) {
    const margin = u.bodyRadius;
    if (u.state === "chasing") {
      const escorted =
        u.role === "mage" && live.some((v) => v !== u && v.group === u.group && v.state === "chasing" && v.role !== "mage");
      step(u, o.player, u.speed, o.dt, escorted ? MAGE_FOLLOW : u.engageRange);
    } else if (u.state === "homing") {
      if (step(u, u.spawn, u.speed, o.dt)) {
        u.pos.x = u.spawn.x;
        u.pos.y = u.spawn.y;
        u.center = { ...u.spawn };
        u.state = "calm";
        u.stateUntil = o.now + CALM_TIME;
        events.push({ kind: "homed", key: u.key });
      }
    } else if (u.state === "idle") {
      if (o.now < u.pauseUntil) continue;
      if (!u.wanderTarget) {
        u.wanderTarget = pickWanderTarget(u.center, u.wanderRadius, o.rnd, o.world, margin + 2);
        u.moveSince = o.now;
      }
      const arrived = step(u, u.wanderTarget, u.speed * u.wanderPace, o.dt);
      if (arrived || o.now - u.moveSince > WANDER_GIVE_UP) {
        u.wanderTarget = null;
        u.pauseUntil = o.now + PAUSE_MIN + o.rnd() * PAUSE_SPREAD;
      }
    }
    u.pos.x = clamp(u.pos.x, margin, o.world.w - margin);
    u.pos.y = clamp(u.pos.y, margin, o.world.h - margin);
  }
  return events;
}

/**
 * After a fled fight: survivors are back at their pre-fight positions (the
 * formation slot is never kept). Grunts and elites settle there (a pack
 * around the centroid of its surviving members); a boss walks home unless
 * it's already in its lair spot. Returns what to save.
 */
export function settleAfterFlee(units: RoamUnit[], now: number, world: { w: number; h: number }): RoamEvent[] {
  const events: RoamEvent[] = [];
  const o: RoamOpts = { now, dt: 0, player: { x: 0, y: 0 }, rnd: Math.random, world };
  const live = units.filter((u) => u.alive);
  for (const u of live.filter((x) => x.tier === "boss")) {
    if (dist(u.pos, u.spawn) > 4) sendHome(u, o, events);
    else {
      u.state = "calm";
      u.stateUntil = now + CALM_TIME;
    }
  }
  const rest = live.filter((x) => x.tier !== "boss");
  for (const u of rest.filter((x) => x.groupKind === "skirmish")) settle([u], o, events);
  const packs = new Set(rest.filter((x) => x.groupKind === "pack").map((x) => x.group));
  for (const g of packs) settle(rest.filter((x) => x.groupKind === "pack" && x.group === g), o, events);
  return events;
}
