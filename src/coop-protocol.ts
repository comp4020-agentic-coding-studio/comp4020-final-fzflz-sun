// The co-op WebSocket wire format, shared by the server (server/coop/ws.ts,
// server/coop/room.ts) and the client (src/coop-main.ts), so the two sides
// can't drift silently the way an inline object literal on each end could.

/**
 * A room member's display name is attacker-controlled (the server only
 * trims/truncates it — see server/coop/ws.ts's cleanName — it never strips
 * or blocks HTML) and is shown back to other players, including inside
 * src/coop-main.ts's innerHTML-built fight dock. Anything interpolated into
 * HTML from a name (or any other player-supplied string) must go through
 * this first, or a crafted name like `<svg/onload=...>` would execute in
 * every client that renders it. A matching private copy already exists in
 * src/main.ts and server/readme.ts for solo; this one is exported so both
 * sides of co-op share exactly one implementation instead of a third copy
 * silently drifting from the other two.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Kaplay's own text() has a separate styled-text grammar (see its $n() in
 * node_modules/kaplay/dist/kaplay.js): an unescaped `[` or `]` is style-tag
 * syntax, and a trailing unescaped `\` is an escape-sequence error. A name
 * like `[Sun]` reaching src/coop-main.ts's makeLabel() unescaped throws
 * "Styled text error: unclosed tags ..." inside applyState()'s per-player
 * loop, aborting that whole snapshot for every client that receives it.
 * escapeHtml above protects the DOM sink only — this protects Kaplay's
 * canvas-text sink, which has entirely different special characters.
 * Backslash must be escaped first, or a `\` inserted while escaping `[`/`]`
 * would itself need re-escaping.
 */
export function escapeKaplayText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export interface CoopPlayerView {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  hp: number;
  /** only meaningful while fightId is set */
  block: number;
  ready: boolean;
  online: boolean;
  /** the fight this player is currently in, or null while free exploring */
  fightId: string | null;
}

export interface CoopEnemyView {
  id: string;
  role: string;
  tier: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: string;
  fightId: string | null;
}

export interface CoopHelloMsg {
  type: "hello";
  selfId: string;
  room: { code: string; members: { id: string; name: string; color: string }[] };
  /**
   * This player's authoritative fight membership right now, so a client
   * reconnecting over an *existing* socket (not a fresh page load — those
   * start with no fight state anyway) can tell whether to drop any fight
   * dock it still has in memory. If a fight concluded entirely while this
   * player was disconnected, the server has no other message to send them
   * (there's no catch-up `fight`/`leftFight` for a fight that's already
   * gone) — this field is how `hello` alone can still carry that fact.
   */
  fightId: string | null;
}

export interface CoopStateMsg {
  type: "state";
  t: number;
  players: CoopPlayerView[];
  enemies: CoopEnemyView[];
}

/** Same shape as src/combat.ts's UnitIntent, so "words match the code" across the wire too. */
export type CoopIntentView =
  | { kind: "attack"; value: number; ranged?: boolean; targetId: string }
  | { kind: "defend"; value: number }
  | { kind: "charge"; next: number }
  | { kind: "revive"; target: string; value: number }
  | null;

export interface CoopFightEnemyView {
  key: string;
  role: string;
  tier: string;
  hp: number;
  maxHp: number;
  downed: boolean;
  intent: CoopIntentView;
}

export interface CoopFightPlayerView {
  id: string;
  hp: number;
  block: number;
  downed: boolean;
  fled: boolean;
  ready: boolean;
}

/**
 * Sent only to the players actually in this fight (never broadcast room-wide):
 * full shared enemy HP/intent/target/downed state, exactly what the brief
 * asks teammates to see together. An outside player only sees `state`'s
 * fightId tag — that there's a fight, not what's happening in it.
 */
export interface CoopFightMsg {
  type: "fight";
  fightId: string;
  turn: number;
  phase: string;
  enemies: CoopFightEnemyView[];
  players: CoopFightPlayerView[];
}

export interface CoopFightEndedMsg {
  type: "fightEnded";
  fightId: string;
  outcome: "won" | "wiped" | "abandoned";
}

/**
 * Sent only to a player who personally left a fight that continues for
 * others (an individual flee) — there's no `fightEnded` for them since the
 * fight itself didn't end, so without this their own client would keep
 * showing the fight dock it last had. `fightEnded` still covers the whole
 * party leaving/dying/winning together.
 */
export interface CoopLeftFightMsg {
  type: "leftFight";
  fightId: string;
  outcome: "fled";
}

export interface CoopCardView {
  id: string;
  name: string;
  kind: string;
  cost: number;
  value: number;
  blurb: string;
}

/** Sent only to the one player it belongs to: a hand is never broadcast. */
export interface CoopHandMsg {
  type: "hand";
  fightId: string;
  cards: CoopCardView[];
  energy: number;
  /**
   * The server's last-ACCEPTED (not merely attempted) action sequence
   * number for this player in this fight: a rejected action (invalid card,
   * insufficient energy, bad target, ...) never advances this, so a client
   * can safely resend a corrected action at the SAME seq rather than
   * needing to guess a new one. A refreshed client's own counter always
   * starts back at 0, so it adopts this value (never going backwards)
   * before sending its next action — otherwise that action is
   * indistinguishable from a stale replay and the server correctly rejects
   * it.
   */
  lastSeq: number;
}

export interface CoopActionErrorMsg {
  type: "actionError";
  error: string;
}

export type CoopServerMsg = CoopHelloMsg | CoopStateMsg | CoopFightMsg | CoopFightEndedMsg | CoopLeftFightMsg | CoopHandMsg | CoopActionErrorMsg;

export interface CoopMoveMsg {
  type: "move";
  /** intent, not a position: -1..1 on each axis, the server integrates it */
  dx: number;
  dy: number;
}

export interface CoopPlayCardMsg {
  type: "playCard";
  seq: number;
  cardInstanceId: string;
  /** required for a "single" card, ignored otherwise */
  targetKey?: string;
}

export interface CoopEndTurnMsg {
  type: "endTurn";
  seq: number;
}

export interface CoopFleeMsg {
  type: "flee";
  seq: number;
}

export type CoopClientMsg = CoopMoveMsg | CoopPlayCardMsg | CoopEndTurnMsg | CoopFleeMsg;
