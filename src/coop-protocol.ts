// The co-op WebSocket wire format, shared by the server (server/coop/ws.ts,
// server/coop/room.ts) and the client (src/coop-main.ts), so the two sides
// can't drift silently the way an inline object literal on each end could.

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
   * The server's last-accepted action sequence number for this player in
   * this fight. A refreshed client's own counter always starts back at 0, so
   * it adopts this value (never going backwards) before sending its next
   * action — otherwise that action is indistinguishable from a stale replay
   * and the server correctly rejects it.
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
