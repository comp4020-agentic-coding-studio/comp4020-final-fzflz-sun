// Who joins a fight. Pure, so the rule the README and the how-to describe is
// tested directly. Movement and alerts live in src/roam.ts.
import { LINK_RADIUS, linkClusters, type RoamState } from "./roam.ts";

/** Chasing enemies within this distance of the trigger's anchor player join it. */
export const JOIN_RADIUS = 260;
/**
 * Free, alive, online teammates within this distance of the anchor also join
 * a co-op fight. Bigger than JOIN_RADIUS (teammates are allies, not threats
 * to be cautious about pulling in), but well under the >480px gap between
 * any two camps (see encounter.test.ts), so it can never bridge two camps.
 */
export const PLAYER_JOIN_RADIUS = 320;

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
  /** which player this enemy is chasing; null unless state is "chasing" */
  targetId: string | null;
}

/** A player as the encounter trigger sees them: single-player passes one of these. */
export interface EncounterPlayer {
  id: string;
  x: number;
  y: number;
  alive: boolean;
  /** already in another fight: eligible to keep exploring, not to join this one */
  busy: boolean;
}

export interface RosterResult<T> {
  enemies: T[];
  /** whichever player's real position, at the trigger instant, this fight formed around */
  anchorId: string;
  /** every player pulled in, anchor included, in `players` order */
  playerIds: string[];
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * A fight starts when a chasing enemy reaches the engage range of the player
 * it's actually chasing (its `targetId`); that player becomes the fight's
 * anchor. The roster is: that enemy; every chaser within JOIN_RADIUS of the
 * anchor; and for each of those in a pack, the chasing pack-mates linked to
 * it (chains of members at most LINK_RADIUS apart). The expansion stops
 * there: joining doesn't pull in whoever happens to be near a joiner, and a
 * pack-mate far across the map (a guard pulled away from its boss, or the
 * boss back in its lair) stays out. Idle, calm and homing enemies never join.
 * No duplicates, in roster order.
 *
 * Other free, alive, online players within PLAYER_JOIN_RADIUS of the anchor's
 * position also join, by distance to the anchor alone — never a chain through
 * one teammate to reach another. A trigger whose target isn't a resolvable
 * player (already gone) is skipped, not used as an anchor.
 *
 * Returns null when no fight triggers. If simultaneous triggers in `list`
 * target different players, only the first (in list order) forms this call's
 * fight; call again for the rest once this roster's enemies are marked busy.
 */
export function selectRoster<T>(
  list: Explorer<T>[],
  players: EncounterPlayer[],
  enemyJoinRadius = JOIN_RADIUS,
  playerJoinRadius = PLAYER_JOIN_RADIUS,
): RosterResult<T> | null {
  const byId = new Map(players.map((p) => [p.id, p]));
  const chasing = list.filter((e) => e.alive && e.state === "chasing");
  const triggers = chasing.filter((e) => {
    const target = e.targetId ? byId.get(e.targetId) : undefined;
    return target && dist(e, target) <= e.engageRange;
  });
  if (!triggers.length) return null;
  const anchorId = triggers[0].targetId!;
  const anchor = byId.get(anchorId)!;
  const sameAnchor = triggers.filter((e) => e.targetId === anchorId);

  const clusters = linkClusters(chasing.map((e) => ({ e, group: e.group, groupKind: e.groupKind, pos: { x: e.x, y: e.y } })), LINK_RADIUS);
  const clusterOf = new Map<Explorer<T>, Explorer<T>[]>();
  for (const c of clusters) for (const m of c) clusterOf.set(m.e, c.map((x) => x.e));
  const picked = new Set<Explorer<T>>();
  const take = (e: Explorer<T>) => {
    for (const m of clusterOf.get(e) ?? [e]) picked.add(m);
  };
  for (const e of sameAnchor) take(e);
  for (const e of chasing) if (dist(e, anchor) <= enemyJoinRadius) take(e);

  const playerIds = [anchorId, ...players.filter((p) => p.id !== anchorId && p.alive && !p.busy && dist(p, anchor) <= playerJoinRadius).map((p) => p.id)];

  return { enemies: list.filter((e) => picked.has(e)).map((e) => e.ref), anchorId, playerIds };
}
