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
}

export interface CoopActionErrorMsg {
  type: "actionError";
  error: string;
}

export type CoopServerMsg = CoopHelloMsg | CoopStateMsg | CoopFightMsg | CoopFightEndedMsg | CoopHandMsg | CoopActionErrorMsg;

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
