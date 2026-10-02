// Who joins a fight. Pure, so the rule the README and the how-to describe is
// tested directly. Movement and alerts live in src/roam.ts.
import { LINK_RADIUS, linkClusters, type RoamState } from "./roam.ts";

/** Chasing enemies within this distance of the player when a fight triggers join it. */
export const JOIN_RADIUS = 260;

export interface Explorer<T> {
  ref: T;
  key: string;
  alive: boolean;
  state: RoamState;
  x: number;
  y: number;
  group: string | null;
  groupKind: "skirmish" | "pack";
  aggroRange: number;
  engageRange: number;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * A fight starts when a chasing enemy reaches its engage range. It takes:
 * that enemy; every chaser within JOIN_RADIUS of the player; and for each of
 * those in a pack, the chasing pack-mates linked to it (chains of members at
 * most LINK_RADIUS apart). The expansion stops there: joining doesn't pull in
 * whoever happens to be near a joiner, and a pack-mate far across the map (a
 * guard pulled away from its boss, or the boss back in its lair) stays out.
 * Idle, calm and homing enemies never join. No duplicates, in roster order.
 * Returns null when no fight triggers.
 */
export function selectRoster<T>(list: Explorer<T>[], player: { x: number; y: number }, joinRadius = JOIN_RADIUS): T[] | null {
  const chasing = list.filter((e) => e.alive && e.state === "chasing");
  const triggers = chasing.filter((e) => dist(e, player) <= e.engageRange);
  if (!triggers.length) return null;
  const clusters = linkClusters(chasing.map((e) => ({ e, group: e.group, groupKind: e.groupKind, pos: { x: e.x, y: e.y } })), LINK_RADIUS);
  const clusterOf = new Map<Explorer<T>, Explorer<T>[]>();
  for (const c of clusters) for (const m of c) clusterOf.set(m.e, c.map((x) => x.e));
  const picked = new Set<Explorer<T>>();
  const take = (e: Explorer<T>) => {
    for (const m of clusterOf.get(e) ?? [e]) picked.add(m);
  };
  for (const e of triggers) take(e);
  for (const e of chasing) if (dist(e, player) <= joinRadius) take(e);
  return list.filter((e) => picked.has(e)).map((e) => e.ref);
}
