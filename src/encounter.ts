// Who joins a fight. Pure so the rule the README and the how-to describe is
// tested directly, not just implied by main.ts.

/** Chasing enemies within this distance of the player when a fight triggers join it. */
export const JOIN_RADIUS = 260;

export interface RosterCandidate<T> {
  ref: T;
  alive: boolean;
  state: "idle" | "chasing" | "returning" | "engaged";
  x: number;
  y: number;
  engageRange: number;
}

/**
 * A fight starts when a chasing enemy reaches its engage range. It then takes
 * every *chasing* enemy within JOIN_RADIUS of the player. Idle or returning
 * enemies never join, however close; chasers further back stay out of this
 * fight (frozen with the rest of the map while it runs) and are still
 * chasing when it ends. Returns null when no fight triggers.
 */
export function selectRoster<T>(cands: RosterCandidate<T>[], player: { x: number; y: number }, joinRadius = JOIN_RADIUS): T[] | null {
  const dist = (c: RosterCandidate<T>) => Math.hypot(c.x - player.x, c.y - player.y);
  const chasing = cands.filter((c) => c.alive && c.state === "chasing");
  if (!chasing.some((c) => dist(c) <= c.engageRange)) return null;
  return chasing.filter((c) => dist(c) <= joinRadius).map((c) => c.ref);
}
