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

export type CoopServerMsg = CoopHelloMsg | CoopStateMsg;

export interface CoopMoveMsg {
  type: "move";
  /** intent, not a position: -1..1 on each axis, the server integrates it */
  dx: number;
  dy: number;
}

export type CoopClientMsg = CoopMoveMsg;
