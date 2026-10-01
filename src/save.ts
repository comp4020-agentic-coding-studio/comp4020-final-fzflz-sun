// The checkpoint a visitor's run is restored from. Saved only at stable
// moments (run start, the instant a fight triggers, victory, flee, death), so
// it never holds formation slots, half an enemy turn or an animation: enemies
// are stored by stable id with their HP (0 = confirmed dead) and always
// restore at their home spot; elites and the boss also keep the position in
// their action cycle, so a charge you fled from is still coming.
import {
  AREAS,
  ENEMY_SPAWNS,
  PHASED_IDS,
  UNITS,
  V1_ENEMIES,
  type EnemySpawn,
  PLAYER_EDGE,
  PLAYER_MAX_HP,
  PLAYER_START,
  SPAWN_BY_ID,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./world.ts";

export const SAVE_VERSION = 2;
export const MAX_SAVE_BYTES = 8 * 1024;

export type Outcome = "playing" | "dead" | "won";
export type CheckpointReason = "start" | "engage" | "victory" | "flee" | "death";
const OUTCOMES: Outcome[] = ["playing", "dead", "won"];
const REASONS: CheckpointReason[] = ["start", "engage", "victory", "flee", "death"];

export interface RunStats {
  fights: number;
  wins: number;
  flees: number;
  kills: number;
}

export interface SaveData {
  v: typeof SAVE_VERSION;
  runId: string;
  runNumber: number;
  startedAt: number;
  savedAt: number;
  reason: CheckpointReason;
  outcome: Outcome;
  player: { hp: number; x: number; y: number };
  /** Current HP of every map enemy by stable id; 0 means confirmed dead this run. */
  enemies: Record<string, number>;
  /** Next action-cycle index for each elite / boss (PHASED_IDS). */
  phases: Record<string, number>;
  stats: RunStats;
}

export function newRun(runId: string, runNumber: number, now: number): SaveData {
  return {
    v: SAVE_VERSION,
    runId,
    runNumber,
    startedAt: now,
    savedAt: now,
    reason: "start",
    outcome: "playing",
    player: { hp: PLAYER_MAX_HP, x: PLAYER_START.x, y: PLAYER_START.y },
    enemies: Object.fromEntries(ENEMY_SPAWNS.map((s) => [s.id, s.maxHp])),
    phases: Object.fromEntries(PHASED_IDS.map((id) => [id, 0])),
    stats: { fights: 0, wins: 0, flees: 0, kills: 0 },
  };
}

export function clearedAreas(save: SaveData): string[] {
  return AREAS.filter((a) => ENEMY_SPAWNS.every((s) => s.area !== a.id || save.enemies[s.id] === 0)).map(
    (a) => a.id,
  );
}

export function killedCount(save: SaveData): number {
  return ENEMY_SPAWNS.filter((s) => save.enemies[s.id] === 0).length;
}

type Result = { ok: true; save: SaveData } | { ok: false; error: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown, lo: number, hi: number): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
const isNum = (x: unknown, lo: number, hi: number): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;

/** Structural check: exact keys, known enemy ids, values in range. Unknown keys are rejected. */
export function validateSave(x: unknown): Result {
  if (!isObj(x)) return { ok: false, error: "save must be an object" };
  const keys = ["v", "runId", "runNumber", "startedAt", "savedAt", "reason", "outcome", "player", "enemies", "phases", "stats"];
  const extra = Object.keys(x).filter((k) => !keys.includes(k));
  if (extra.length) return { ok: false, error: `unknown field(s): ${extra.join(", ")}` };
  if (x.v !== SAVE_VERSION) return { ok: false, error: "unsupported save version" };
  if (typeof x.runId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(x.runId)) return { ok: false, error: "bad runId" };
  if (!isInt(x.runNumber, 1, 1_000_000)) return { ok: false, error: "bad runNumber" };
  if (!isInt(x.startedAt, 0, 8.64e15) || !isInt(x.savedAt, 0, 8.64e15)) return { ok: false, error: "bad timestamp" };
  if (!REASONS.includes(x.reason as CheckpointReason)) return { ok: false, error: "bad reason" };
  if (!OUTCOMES.includes(x.outcome as Outcome)) return { ok: false, error: "bad outcome" };

  const p = x.player;
  if (!isObj(p) || Object.keys(p).length !== 3) return { ok: false, error: "bad player" };
  if (!isInt(p.hp, 0, PLAYER_MAX_HP)) return { ok: false, error: "bad player hp" };
  if (!isNum(p.x, PLAYER_EDGE, WORLD_WIDTH - PLAYER_EDGE) || !isNum(p.y, PLAYER_EDGE, WORLD_HEIGHT - PLAYER_EDGE))
    return { ok: false, error: "player outside the map" };

  const e = x.enemies;
  if (!isObj(e)) return { ok: false, error: "bad enemies" };
  const ids = Object.keys(e);
  if (ids.length !== ENEMY_SPAWNS.length || !ids.every((id) => SPAWN_BY_ID.has(id)))
    return { ok: false, error: "enemies must list every map enemy by id" };
  for (const id of ids) {
    if (!isInt(e[id], 0, SPAWN_BY_ID.get(id)!.maxHp)) return { ok: false, error: `bad hp for ${id}` };
  }

  const ph = x.phases;
  if (!isObj(ph)) return { ok: false, error: "bad phases" };
  const phIds = Object.keys(ph);
  if (phIds.length !== PHASED_IDS.length || !phIds.every((id) => PHASED_IDS.includes(id)))
    return { ok: false, error: "phases must list every elite and boss by id" };
  for (const id of phIds) {
    const len = UNITS[SPAWN_BY_ID.get(id)!.role].pattern.length;
    if (!isInt(ph[id], 0, len - 1)) return { ok: false, error: `bad phase for ${id}` };
  }

  const s = x.stats;
  if (!isObj(s) || Object.keys(s).length !== 4) return { ok: false, error: "bad stats" };
  for (const k of ["fights", "wins", "flees", "kills"]) {
    if (!isInt(s[k], 0, 1_000_000)) return { ok: false, error: `bad stats.${k}` };
  }

  const save = x as unknown as SaveData;
  if (save.outcome === "dead" && save.player.hp !== 0) return { ok: false, error: "dead run with HP left" };
  if (save.outcome !== "dead" && save.player.hp === 0) return { ok: false, error: "0 HP but not dead" };
  if (save.outcome === "won" && killedCount(save) !== ENEMY_SPAWNS.length)
    return { ok: false, error: "won with enemies alive" };
  return { ok: true, save };
}

/** Rules for overwriting a checkpoint within the same run. Returns an error or null. */
export function checkProgression(prev: SaveData, next: SaveData): string | null {
  if (prev.runId !== next.runId) return "a different run: start new runs through /api/runs";
  if (prev.runNumber !== next.runNumber || prev.startedAt !== next.startedAt) return "run identity changed";
  if (prev.outcome !== "playing") return "this run has ended";
  for (const s of ENEMY_SPAWNS) {
    if (prev.enemies[s.id] === 0 && next.enemies[s.id] !== 0) return `${s.id} was killed and can't come back`;
  }
  for (const k of ["fights", "wins", "flees", "kills"] as const) {
    if (next.stats[k] < prev.stats[k]) return `stats.${k} went backwards`;
  }
  if (next.savedAt < prev.savedAt) return "older than the stored checkpoint";
  return null;
}

/**
 * Brings an older stored save up to the current version; anything else is
 * returned untouched (validateSave then judges it). v1 -> v2:
 *
 * 1. an enemy at 0 HP (confirmed dead) stays dead;
 * 2. a living v1 enemy keeps its HP, scaled by newMax / oldMax if its max HP
 *    changed (rounded up, at least 1), so a wounded enemy stays wounded;
 * 3. an enemy new in v2 starts dead if the run had already ended (a finished
 *    run keeps its result) or if its camp was fully cleared in the v1 save (a
 *    cleared camp stays cleared); otherwise it starts at full HP;
 * 4. elites and the boss start their action cycle at 0 (v1 didn't save it).
 *
 * Player, stats, run identity and outcome are unchanged.
 */
export function upgradeSave(raw: unknown, spawns: EnemySpawn[] = ENEMY_SPAWNS): unknown {
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.enemies)) return raw;
  const old = raw.enemies as Record<string, number>;
  const ended = raw.outcome !== "playing";
  const clearedV1 = new Set(
    [...new Set(V1_ENEMIES.map((e) => e.area))].filter((area) => V1_ENEMIES.every((e) => e.area !== area || old[e.id] === 0)),
  );
  const enemies: Record<string, number> = {};
  for (const sp of spawns) {
    const v1 = V1_ENEMIES.find((e) => e.id === sp.id);
    if (v1 && typeof old[sp.id] === "number") {
      const hp = old[sp.id];
      enemies[sp.id] = hp === 0 ? 0 : Math.min(sp.maxHp, Math.max(1, Math.ceil((hp * sp.maxHp) / v1.maxHp)));
    } else {
      enemies[sp.id] = ended || clearedV1.has(sp.area) ? 0 : sp.maxHp;
    }
  }
  return {
    ...raw,
    v: 2,
    enemies,
    phases: Object.fromEntries(PHASED_IDS.map((id) => [id, 0])),
  };
}
