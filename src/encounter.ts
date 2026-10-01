// Who chases you and who joins a fight. Pure, so the rules the README and the
// how-to describe are tested directly. main.ts does the movement.

/** Chasing enemies within this distance of the player when a fight triggers join it. */
export const JOIN_RADIUS = 260;
/** A skirmisher gives up once you're this many times its aggro range away. */
export const LEASH_FACTOR = 1.35;

export type AIState = "idle" | "chasing" | "returning" | "engaged";

export interface Explorer<T> {
  ref: T;
  key: string;
  alive: boolean;
  state: AIState;
  x: number;
  y: number;
  group: string | null;
  groupKind: "skirmish" | "pack";
  aggroRange: number;
  engageRange: number;
}

export interface PackInfo {
  anchor: { x: number; y: number };
  leash: number;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Exploration state changes for one frame (movement, and returning -> idle at
 * home, are main.ts's job). Returns only the units whose state changes.
 *
 * - skirmish: each unit notices you within its aggro range and gives up past
 *   LEASH_FACTOR times that range, on its own, so a pair can be split.
 * - pack: one member noticing you alerts every living member of that pack,
 *   and only that pack. The pack gives up together once you're further than
 *   its leash from its anchor, and can be re-alerted on the way home.
 */
export function nextAIStates<T>(list: Explorer<T>[], player: { x: number; y: number }, packs: Map<string, PackInfo>): Map<string, AIState> {
  const out = new Map<string, AIState>();
  const live = list.filter((e) => e.alive && e.state !== "engaged");

  for (const e of live) {
    if (e.groupKind !== "skirmish") continue;
    const d = dist(e, player);
    if (e.state === "idle" && d <= e.aggroRange) out.set(e.key, "chasing");
    else if (e.state === "chasing" && d > e.aggroRange * LEASH_FACTOR) out.set(e.key, "returning");
    else if (e.state === "returning" && d <= e.aggroRange) out.set(e.key, "chasing");
  }

  const packIds = new Set(live.filter((e) => e.groupKind === "pack" && e.group).map((e) => e.group!));
  for (const g of packIds) {
    const members = live.filter((e) => e.group === g);
    const info = packs.get(g);
    if (!info) continue;
    const alerted = members.some((e) => e.state === "chasing");
    const noticed = members.some((e) => e.state !== "chasing" && dist(e, player) <= e.aggroRange);
    const outside = dist(info.anchor, player) > info.leash;
    let to: AIState | null = null;
    if (outside) {
      if (alerted) to = "returning";
    } else if (alerted || noticed) to = "chasing";
    if (!to) continue;
    for (const e of members) if (e.state !== to && !(to === "returning" && e.state === "idle")) out.set(e.key, to);
  }
  return out;
}

/**
 * A fight starts when a chasing enemy reaches its engage range. It takes:
 * that enemy; every chaser within JOIN_RADIUS of the player; and for each of
 * those that belongs to a pack, the rest of that alerted pack wherever its
 * members are. The expansion stops there: a pack member joining doesn't pull
 * in whoever happens to be near *it*. Idle and returning enemies never join,
 * so an unalerted pack stays out. No duplicates, in roster (map) order.
 * Returns null when no fight triggers.
 */
export function selectRoster<T>(list: Explorer<T>[], player: { x: number; y: number }, joinRadius = JOIN_RADIUS): T[] | null {
  const chasing = list.filter((e) => e.alive && e.state === "chasing");
  const triggers = chasing.filter((e) => dist(e, player) <= e.engageRange);
  if (!triggers.length) return null;
  const picked = new Set<Explorer<T>>();
  const take = (e: Explorer<T>) => {
    picked.add(e);
    if (e.groupKind === "pack" && e.group) for (const m of chasing) if (m.group === e.group) picked.add(m);
  };
  for (const e of triggers) take(e);
  for (const e of chasing) if (dist(e, player) <= joinRadius) take(e);
  return list.filter((e) => picked.has(e)).map((e) => e.ref);
}
