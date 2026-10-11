// A co-op room's shared, authoritative world: every connected player's real
// position, and the same enemy roam state src/roam.ts runs for single-player
// (built from the same src/world.ts spawn data), ticked once per room on the
// server. Pure logic, no WebSocket and no SQLite here, so it's unit-testable
// on its own; server/coop/ws.ts drives it from real connections and
// server/coop/store.ts persists its snapshots.
import type { CoopEnemyView, CoopPlayerView } from "../../src/coop-protocol.ts";
import { type EncounterPlayer, type Explorer, selectRoster } from "../../src/encounter.ts";
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
  /** position in this unit's action cycle; persists across fights, like single-player's save v2+ */
  phase: number;
  fightId: string | null;
}

export interface RoomPlayer {
  id: string;
  name: string;
  color: string;
  pos: Pt;
  hp: number;
  /** only meaningful while fightId is set: cleared whenever a fight ends */
  block: number;
  ready: boolean;
  /** current movement intent as sent by the client; not normalized */
  dir: Pt;
  online: boolean;
  lastSeen: number;
  /** the fight this player is in, fixed for its duration; null while free exploring */
  fightId: string | null;
}

/**
 * A formed fight's fixed membership: set once when it triggers (src/encounter.ts's
 * selectRoster), never changed by later movement, zoom or window size. Combat
 * itself (phase 3) resolves and clears it; for now a room can form fights but
 * has no engine yet to end them.
 */
export interface RoomFight {
  id: string;
  anchorId: string;
  playerIds: string[];
  enemyKeys: string[];
  startedAt: number;
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
      phase: 0,
      fightId: null,
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
  fights = new Map<string, RoomFight>();
  private nextFightN = 1;

  constructor(code: string, now: number, enemies: RoomEnemy[] = makeRoomEnemies()) {
    this.code = code;
    this.createdAt = now;
    this.enemies = enemies;
  }

  /**
   * A fresh `CoopRoom` instance always starts `nextFightN` back at 1 (every
   * cold `getOrLoadRoom` after a restart constructs a new instance) — a
   * restored fight reusing its old id (e.g. "f1") would otherwise collide
   * with the very next genuinely new encounter, which would also generate
   * "f1". Call this once per fight actually re-registered on restore so
   * new ids never repeat one already in use.
   */
  reserveFightId(id: string): void {
    const m = /^f(\d+)$/.exec(id);
    if (!m) return;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= this.nextFightN) this.nextFightN = n + 1;
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
    const p: RoomPlayer = {
      id, name, color, pos: { ...PLAYER_START }, hp: PLAYER_MAX_HP, block: 0, ready: false,
      dir: { x: 0, y: 0 }, online: true, lastSeen: now, fightId: null,
    };
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

  /** Movement intent, not a position: the server is the one that integrates it. A fighting player can't move the map. */
  setIntent(id: string, dx: number, dy: number, now: number) {
    const p = this.players.get(id);
    if (!p || !p.online || p.fightId) return;
    const len = Math.hypot(dx, dy);
    p.dir = len > 1 ? { x: dx / len, y: dy / len } : { x: dx, y: dy };
    p.lastSeen = now;
  }

  /** Advances every free, online player by at most PLAYER_SPEED * dt, clamped to the map, then ticks enemy roam. */
  tick(now: number, dt: number, rnd: () => number): { roamEvents: RoamEvent[]; newFights: RoomFight[] } {
    for (const p of this.players.values()) {
      if (!p.online || p.fightId) continue;
      const len = Math.hypot(p.dir.x, p.dir.y);
      if (len > 0) {
        p.pos.x = clamp(p.pos.x + (p.dir.x / len) * PLAYER_SPEED * dt, PLAYER_EDGE, WORLD_WIDTH - PLAYER_EDGE);
        p.pos.y = clamp(p.pos.y + (p.dir.y / len) * PLAYER_SPEED * dt, PLAYER_EDGE, WORLD_HEIGHT - PLAYER_EDGE);
      }
    }
    // a fighting player isn't part of the shared explorable world: other
    // enemies can't notice or chase them until their fight ends
    const roamPlayers: RoamPlayer[] = [...this.players.values()].filter((p) => p.online && !p.fightId).map((p) => ({ id: p.id, pos: p.pos }));
    const roamEvents = roamTick(this.enemies, { now, dt, players: roamPlayers, rnd, world: { w: WORLD_WIDTH, h: WORLD_HEIGHT } });
    const newFights = this.formFights(now);
    return { roamEvents, newFights };
  }

  /**
   * Checks every free, online player and every not-already-engaged enemy for
   * a trigger (src/encounter.ts's selectRoster), forming as many fights as
   * actually trigger this tick. A fight's roster is fixed the instant it
   * forms: those enemies become "engaged" (roamTick already leaves engaged
   * units alone) and those players stop moving and stop being eligible for
   * another fight, so the loop below can never form two fights over the same
   * enemy or player.
   */
  formFights(now: number): RoomFight[] {
    const formed: RoomFight[] = [];
    for (;;) {
      const explorers: Explorer<RoomEnemy>[] = this.enemies
        .filter((e) => e.alive && e.state !== "engaged")
        .map((e) => ({
          ref: e, key: e.key, alive: e.alive, state: e.state, x: e.pos.x, y: e.pos.y,
          group: e.group, groupKind: e.groupKind, aggroRange: e.aggroRange, engageRange: e.engageRange, targetId: e.targetId,
        }));
      const candidates: EncounterPlayer[] = [...this.players.values()]
        .filter((p) => p.online)
        .map((p) => ({ id: p.id, x: p.pos.x, y: p.pos.y, alive: p.hp > 0, busy: !!p.fightId }));
      const result = selectRoster(explorers, candidates);
      if (!result) break;
      const id = `f${this.nextFightN++}`;
      const fight: RoomFight = { id, anchorId: result.anchorId, playerIds: result.playerIds, enemyKeys: result.enemies.map((e) => e.key), startedAt: now };
      this.fights.set(id, fight);
      for (const e of result.enemies) {
        e.state = "engaged";
        e.fightId = id;
      }
      for (const pid of result.playerIds) {
        const p = this.players.get(pid)!;
        p.fightId = id;
        p.dir = { x: 0, y: 0 };
      }
      formed.push(fight);
    }
    return formed;
  }

  snapshot(now: number): RoomSnapshot {
    return {
      t: now,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, x: p.pos.x, y: p.pos.y, hp: p.hp, block: p.block, ready: p.ready, online: p.online, fightId: p.fightId,
      })),
      enemies: this.enemies
        .filter((e) => e.alive)
        .map((e) => ({ id: e.key, role: e.role, tier: e.tier, x: e.pos.x, y: e.pos.y, hp: e.hp, maxHp: e.maxHp, state: e.state, fightId: e.fightId })),
    };
  }
}
