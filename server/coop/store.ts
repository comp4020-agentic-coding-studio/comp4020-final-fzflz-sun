import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Co-op's own SQLite file, next to the single-player one on the same /data
// volume, but a separate database: joining or creating a room must never
// touch a visitor's single-player save. Three tables: the room itself, who's
// in it, and the last persisted world snapshot (so a restart resumes instead
// of resetting the expedition).
export interface CoopMember {
  playerId: string;
  name: string;
  color: string;
  joinedAt: number;
}

export interface PersistedFightRow {
  fightId: string;
  data: string;
}

export interface CoopStore {
  createRoom(code: string, now: number): void;
  roomExists(code: string): boolean;
  upsertMember(code: string, playerId: string, name: string, color: string, now: number): void;
  members(code: string): CoopMember[];
  getState(code: string): string | null;
  putState(code: string, json: string, now: number): void;
  /** One active fight's full, resolved state (hands, round, energy, card instance ids): see server/coop/fight-session.ts's serialize()/restore. */
  putFight(code: string, fightId: string, json: string, now: number): void;
  deleteFight(code: string, fightId: string): void;
  fights(code: string): PersistedFightRow[];
  close(): void;
}

export function openCoopStore(dataDir: string): CoopStore {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "coop.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (room_code, player_id)
    );
    CREATE TABLE IF NOT EXISTS room_state (
      room_code TEXT PRIMARY KEY REFERENCES rooms(code) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fights (
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      fight_id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (room_code, fight_id)
    );
  `);

  const insRoom = db.prepare("INSERT OR IGNORE INTO rooms (code, created_at) VALUES (?, ?)");
  const selRoom = db.prepare("SELECT code FROM rooms WHERE code = ?");
  const insMember = db.prepare(
    "INSERT INTO members (room_code, player_id, name, color, joined_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(room_code, player_id) DO UPDATE SET name = excluded.name",
  );
  const selMembers = db.prepare("SELECT player_id, name, color, joined_at FROM members WHERE room_code = ? ORDER BY joined_at ASC");
  const selState = db.prepare("SELECT data FROM room_state WHERE room_code = ?");
  const putState = db.prepare(
    "INSERT INTO room_state (room_code, data, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(room_code) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  );
  const putFight = db.prepare(
    "INSERT INTO fights (room_code, fight_id, data, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(room_code, fight_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  );
  const delFight = db.prepare("DELETE FROM fights WHERE room_code = ? AND fight_id = ?");
  const selFights = db.prepare("SELECT fight_id, data FROM fights WHERE room_code = ?");

  return {
    createRoom: (code, now) => insRoom.run(code, now),
    roomExists: (code) => !!selRoom.get(code),
    upsertMember: (code, playerId, name, color, now) => insMember.run(code, playerId, name, color, now),
    members: (code) =>
      (selMembers.all(code) as { player_id: string; name: string; color: string; joined_at: number }[]).map((r) => ({
        playerId: r.player_id,
        name: r.name,
        color: r.color,
        joinedAt: r.joined_at,
      })),
    getState: (code) => (selState.get(code) as { data: string } | undefined)?.data ?? null,
    putState: (code, json, now) => void putState.run(code, json, now),
    putFight: (code, fightId, json, now) => void putFight.run(code, fightId, json, now),
    deleteFight: (code, fightId) => void delFight.run(code, fightId),
    fights: (code) => (selFights.all(code) as { fight_id: string; data: string }[]).map((r) => ({ fightId: r.fight_id, data: r.data })),
    close: () => db.close(),
  };
}
