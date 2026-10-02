import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../server/store.ts";
import { validateSave } from "./save.ts";

// The real SQLite store, on a throwaway directory: a row written by the v1
// game comes back as a valid current save, and saving over it works.
let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("stored v1 saves", () => {
  it("are migrated to the current version on read and can be saved over", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-store-"));
    const store = openStore(dir);
    store.ensureVisitor("v1visitor");
    store.close();
    const raw = new DatabaseSync(join(dir, "game.sqlite"));
    const v1 = {
      v: 1, runId: "run_oldsave1", runNumber: 2, startedAt: 1_700_000_000_000, savedAt: 1_700_000_100_000,
      reason: "victory", outcome: "playing", player: { hp: 13, x: 900, y: 500 },
      enemies: { "west-1": 0, "west-2": 0, "south-1": 4, "north-1": 6, "north-2": 6, "north-3": 6, "lair-guard": 6, "lair-boss": 40 },
      stats: { fights: 3, wins: 2, flees: 1, kills: 2 },
    };
    raw.prepare("INSERT INTO saves (visitor_id, revision, data, updated_at) VALUES (?, ?, ?, ?)").run("v1visitor", 7, JSON.stringify(v1), Date.now());
    raw.close();

    const again = openStore(dir);
    const got = again.getSave("v1visitor")!;
    expect(got.revision).toBe(7);
    expect(got.save.v).toBe(3);
    expect(got.save.places["north-mage"]).toEqual({ x: 1395, y: 195, cx: 1395, cy: 195, homing: false });
    expect(validateSave(got.save).ok).toBe(true);
    expect(got.save.enemies["west-1"]).toBe(0);
    expect(got.save.enemies["south-1"]).toBe(4);
    expect(got.save.enemies["north-mage"]).toBe(9); // north wasn't cleared: its new mage starts at full HP
    expect(got.save.phases).toEqual({ "ridge-captain": 0, "lair-boss": 0 });
    expect(got.save.player).toEqual({ hp: 13, x: 900, y: 500 });

    const next = { ...got.save, savedAt: got.save.savedAt + 1, reason: "engage" as const, stats: { ...got.save.stats, fights: 4 } };
    expect(again.putSave("v1visitor", 7, next)).toBe(8);
    expect(again.getSave("v1visitor")!.save.reason).toBe("engage");
    again.close();
  });
});
