import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCoopStore } from "./store.ts";

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("coop store", () => {
  it("creates a room and remembers it across a reopen (survives a restart)", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-store-"));
    let store = openCoopStore(dir);
    store.createRoom("ABC123", 1000);
    store.close();
    store = openCoopStore(dir);
    expect(store.roomExists("ABC123")).toBe(true);
    expect(store.roomExists("NOPE00")).toBe(false);
    store.close();
  });

  it("members join in order and re-joining updates their name, not a duplicate row", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-store-"));
    const store = openCoopStore(dir);
    store.createRoom("ABC123", 0);
    store.upsertMember("ABC123", "p1", "Ash", "#50a0ff", 10);
    store.upsertMember("ABC123", "p2", "Birch", "#ff8a65", 20);
    store.upsertMember("ABC123", "p1", "Ashley", "#50a0ff", 30); // same identity rejoins with a new name
    const members = store.members("ABC123");
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.playerId)).toEqual(["p1", "p2"]); // ordered by original join time
    expect(members[0].name).toBe("Ashley");
    store.close();
  });

  it("persists and reloads a room's world snapshot", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-store-"));
    let store = openCoopStore(dir);
    store.createRoom("ABC123", 0);
    expect(store.getState("ABC123")).toBeNull();
    const snap = JSON.stringify({ players: [{ id: "p1", x: 220, y: 650 }], enemies: [] });
    store.putState("ABC123", snap, 100);
    store.close();
    store = openCoopStore(dir);
    expect(store.getState("ABC123")).toBe(snap);
    store.close();
  });

  it("a different room's members and state stay isolated", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-store-"));
    const store = openCoopStore(dir);
    store.createRoom("ROOM1", 0);
    store.createRoom("ROOM2", 0);
    store.upsertMember("ROOM1", "p1", "Ash", "#fff", 0);
    store.putState("ROOM1", '{"a":1}', 0);
    expect(store.members("ROOM2")).toEqual([]);
    expect(store.getState("ROOM2")).toBeNull();
    store.close();
  });
});
