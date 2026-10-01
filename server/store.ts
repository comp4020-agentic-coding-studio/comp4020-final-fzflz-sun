import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { upgradeSave, type SaveData } from "../src/save.ts";

// One SQLite file on the /data volume (fly.toml), the only storage that
// survives a restart or redeploy. Three tables: who (an anonymous visitor),
// where their current run stands (one checkpoint), and the runs they ended.
export interface RunSummary {
  runId: string;
  runNumber: number;
  outcome: string;
  kills: number;
  wins: number;
  endedAt: number;
}

export interface Store {
  ensureVisitor(id: string): void;
  getSave(visitor: string): { revision: number; save: SaveData } | null;
  /** Writes only if the stored revision still equals `base`; returns the new revision or null on conflict. */
  putSave(visitor: string, base: number, save: SaveData): number | null;
  archiveAndReplace(visitor: string, base: number, next: SaveData, endedOutcome: string): number | null;
  runs(visitor: string, limit: number): RunSummary[];
  erase(visitor: string): void;
  close(): void;
}

export function openStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "game.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saves (
      visitor_id TEXT PRIMARY KEY REFERENCES visitors(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      run_number INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      data TEXT NOT NULL,
      ended_at INTEGER NOT NULL,
      PRIMARY KEY (visitor_id, run_id)
    );
  `);

  const insVisitor = db.prepare("INSERT OR IGNORE INTO visitors (id, created_at) VALUES (?, ?)");
  const selSave = db.prepare("SELECT revision, data FROM saves WHERE visitor_id = ?");
  const insSave = db.prepare("INSERT INTO saves (visitor_id, revision, data, updated_at) VALUES (?, ?, ?, ?)");
  const updSave = db.prepare(
    "UPDATE saves SET revision = ?, data = ?, updated_at = ? WHERE visitor_id = ? AND revision = ?",
  );
  const insRun = db.prepare(
    "INSERT OR REPLACE INTO runs (visitor_id, run_id, run_number, outcome, data, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selRuns = db.prepare(
    "SELECT run_id, run_number, outcome, data, ended_at FROM runs WHERE visitor_id = ? ORDER BY ended_at DESC LIMIT ?",
  );
  const delSaves = db.prepare("DELETE FROM saves WHERE visitor_id = ?");
  const delRuns = db.prepare("DELETE FROM runs WHERE visitor_id = ?");

  const getSave = (visitor: string) => {
    const row = selSave.get(visitor) as { revision: number; data: string } | undefined;
    // Saves written by an older version are migrated on read (src/save.ts upgradeSave).
    return row ? { revision: row.revision, save: upgradeSave(JSON.parse(row.data)) as SaveData } : null;
  };

  const write = (visitor: string, base: number, save: SaveData): number | null => {
    const now = Date.now();
    if (base === 0) {
      if (getSave(visitor)) return null;
      insSave.run(visitor, 1, JSON.stringify(save), now);
      return 1;
    }
    const res = updSave.run(base + 1, JSON.stringify(save), now, visitor, base);
    return Number(res.changes) === 1 ? base + 1 : null;
  };

  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  return {
    ensureVisitor: (id) => {
      insVisitor.run(id, Date.now());
    },
    getSave,
    putSave: (visitor, base, save) => tx(() => write(visitor, base, save)),
    archiveAndReplace: (visitor, base, next, endedOutcome) =>
      tx(() => {
        const cur = getSave(visitor);
        if ((cur?.revision ?? 0) !== base) return null;
        if (cur) {
          const s = cur.save;
          insRun.run(visitor, s.runId, s.runNumber, endedOutcome, JSON.stringify(s), Date.now());
        }
        return write(visitor, base, next);
      }),
    runs: (visitor, limit) =>
      (selRuns.all(visitor, limit) as { run_id: string; run_number: number; outcome: string; data: string; ended_at: number }[]).map(
        (r) => {
          const s = JSON.parse(r.data) as SaveData;
          return {
            runId: r.run_id,
            runNumber: r.run_number,
            outcome: r.outcome,
            kills: s.stats.kills,
            wins: s.stats.wins,
            endedAt: r.ended_at,
          };
        },
      ),
    erase: (visitor) =>
      tx(() => {
        delSaves.run(visitor);
        delRuns.run(visitor);
      }),
    close: () => db.close(),
  };
}
