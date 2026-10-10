// A co-op room's shared, authoritative world: every connected player's real
// position, and the same enemy roam state src/roam.ts runs for single-player
// (built from the same src/world.ts spawn data), ticked once per room on the
// server. Pure logic, no WebSocket and no SQLite here, so it's unit-testable
// on its own; server/coop/ws.ts drives it from real connections and
// server/coop/store.ts persists its snapshots.
import type { CoopEnemyView, CoopPlayerView } from "../../src/coop-protocol.ts";
import { type Pt, type RoamEvent, type RoamPlayer, type RoamUnit, roamTick } from "../../src/roam.ts";
import {
  ENEMY_SPAWNS,
  GROUP_BY_ID,
  PLAYER_EDGE,
  PLAYER_MAX_HP,
  PLAYER_START,
  UNITS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  memberOffset,
  wanderRadiusOf,
  type Role,
} from "../../src/world.ts";

// Keep in step with PLAYER_SPEED in src/main.ts: the same world, the same pace.
export const PLAYER_SPEED = 220;

export interface RoomEnemy extends RoamUnit {
  role: Role;
  hp: number;
  maxHp: number;
}

export interface RoomPlayer {
  id: string;
  name: string;
  color: string;
  pos: Pt;
  hp: number;
  /** current movement intent as sent by the client; not normalized */
  dir: Pt;
  online: boolean;
  lastSeen: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** The map's enemies, exactly as main.ts builds them for single-player, minus Kaplay. */
export function makeRoomEnemies(): RoomEnemy[] {
  return ENEMY_SPAWNS.map((spawn) => {
    const def = UNITS[spawn.role];
    const group = spawn.group ? GROUP_BY_ID.get(spawn.group) : undefined;
    return {
      key: spawn.id,
      alive: true,
      tier: def.tier,
      role: spawn.role,
      group: spawn.group,
      groupKind: (group?.kind ?? "skirmish") as "skirmish" | "pack",
      pos: { x: spawn.x, y: spawn.y },
      spawn: { x: spawn.x, y: spawn.y },
      center: def.tier === "boss" ? { x: spawn.x, y: spawn.y } : { x: spawn.x, y: spawn.y },
      offset: memberOffset(spawn.id),
      aggroRange: def.aggroRange,
      engageRange: def.engageRange,
      speed: def.speed,
      bodyRadius: def.radius,
      wanderRadius: wanderRadiusOf(spawn.id),
      wanderPace: 0.32 + Math.random() * 0.14,
      state: "idle",
      stateUntil: 0,
      wanderTarget: null,
      pauseUntil: Math.random() * 1.5,
      moveSince: 0,
      outSince: null,
      targetId: null,
      hp: spawn.maxHp,
      maxHp: spawn.maxHp,
    };
  });
}

let colorN = 0;
export const MEMBER_COLORS = ["#50a0ff", "#ff8a65", "#7fd97f", "#e0a8ff", "#ffd250", "#80e0e0"];
export const nextColor = () => MEMBER_COLORS[colorN++ % MEMBER_COLORS.length];

export interface RoomSnapshot {
  t: number;
  players: CoopPlayerView[];
  enemies: CoopEnemyView[];
}

/** One shared expedition: every player's live position plus the roaming enemy state. */
export class CoopRoom {
  readonly code: string;
  readonly createdAt: number;
  enemies: RoomEnemy[];
  players = new Map<string, RoomPlayer>();

  constructor(code: string, now: number, enemies: RoomEnemy[] = makeRoomEnemies()) {
    this.code = code;
    this.createdAt = now;
    this.enemies = enemies;
  }

  /** A returning player (same id) re-attaches to their existing spot instead of spawning a new one. */
  addPlayer(id: string, name: string, color: string, now: number): RoomPlayer {
    const existing = this.players.get(id);
    if (existing) {
      existing.online = true;
      existing.lastSeen = now;
      existing.name = name || existing.name;
      return existing;
    }
    const p: RoomPlayer = { id, name, color, pos: { ...PLAYER_START }, hp: PLAYER_MAX_HP, dir: { x: 0, y: 0 }, online: true, lastSeen: now };
    this.players.set(id, p);
    return p;
  }

  setOnline(id: string, online: boolean, now: number) {
    const p = this.players.get(id);
    if (!p) return;
    p.online = online;
    p.lastSeen = now;
    if (!online) p.dir = { x: 0, y: 0 };
  }

  /** Movement intent, not a position: the server is the one that integrates it. */
  setIntent(id: string, dx: number, dy: number, now: number) {
    const p = this.players.get(id);
    if (!p || !p.online) return;
    const len = Math.hypot(dx, dy);
    p.dir = len > 1 ? { x: dx / len, y: dy / len } : { x: dx, y: dy };
    p.lastSeen = now;
  }

  /** Advances every online player by at most PLAYER_SPEED * dt, clamped to the map, then ticks enemy roam. */
  tick(now: number, dt: number, rnd: () => number): RoamEvent[] {
    for (const p of this.players.values()) {
      if (!p.online) continue;
      const len = Math.hypot(p.dir.x, p.dir.y);
      if (len > 0) {
        p.pos.x = clamp(p.pos.x + (p.dir.x / len) * PLAYER_SPEED * dt, PLAYER_EDGE, WORLD_WIDTH - PLAYER_EDGE);
        p.pos.y = clamp(p.pos.y + (p.dir.y / len) * PLAYER_SPEED * dt, PLAYER_EDGE, WORLD_HEIGHT - PLAYER_EDGE);
      }
    }
    const roamPlayers: RoamPlayer[] = [...this.players.values()].filter((p) => p.online).map((p) => ({ id: p.id, pos: p.pos }));
    return roamTick(this.enemies, { now, dt, players: roamPlayers, rnd, world: { w: WORLD_WIDTH, h: WORLD_HEIGHT } });
  }

  snapshot(now: number): RoomSnapshot {
    return {
      t: now,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, x: p.pos.x, y: p.pos.y, hp: p.hp, online: p.online })),
      enemies: this.enemies.filter((e) => e.alive).map((e) => ({ id: e.key, role: e.role, tier: e.tier, x: e.pos.x, y: e.pos.y, hp: e.hp, maxHp: e.maxHp, state: e.state })),
    };
  }
}
