import { describe, expect, it } from "vitest";
import { PLAYER_EDGE, PLAYER_START, WORLD_HEIGHT, WORLD_WIDTH } from "../../src/world.ts";
import { CoopRoom, makeRoomEnemies, PLAYER_SPEED } from "./room.ts";

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("CoopRoom: shared movement", () => {
  it("a new player starts at the map's start position", () => {
    const room = new CoopRoom("ABC123", 0);
    const p = room.addPlayer("p1", "Ash", "#50a0ff", 0);
    expect(p.pos).toEqual(PLAYER_START);
  });

  it("the same identity reconnecting re-attaches to its existing spot, not a new one", () => {
    const room = new CoopRoom("ABC123", 0);
    const p1 = room.addPlayer("p1", "Ash", "#50a0ff", 0);
    p1.pos.x = 777;
    const p1Again = room.addPlayer("p1", "Ash", "#50a0ff", 10);
    expect(room.players.size).toBe(1);
    expect(p1Again.pos.x).toBe(777);
  });

  it("moves a player at exactly PLAYER_SPEED, never faster, however the intent vector is sent", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#50a0ff", 0);
    room.setIntent("p1", 10, 0, 0); // an un-normalized but axis-aligned intent
    const before = { ...room.players.get("p1")!.pos };
    room.tick(0, 1, rng(1));
    const after = room.players.get("p1")!.pos;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeCloseTo(PLAYER_SPEED, 1);
  });

  it("diagonal movement isn't faster: a (1,1) intent still moves at PLAYER_SPEED", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#50a0ff", 0);
    room.setIntent("p1", 1, 1, 0);
    const before = { ...room.players.get("p1")!.pos };
    room.tick(0, 1, rng(1));
    const after = room.players.get("p1")!.pos;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeCloseTo(PLAYER_SPEED, 1);
  });

  it("never leaves the map", () => {
    const room = new CoopRoom("ABC123", 0);
    const p = room.addPlayer("p1", "Ash", "#50a0ff", 0);
    p.pos.x = PLAYER_EDGE + 2;
    p.pos.y = PLAYER_EDGE + 2;
    room.setIntent("p1", -1, -1, 0);
    for (let i = 0; i < 30; i++) room.tick(i, 1 / 30, rng(1));
    expect(p.pos.x).toBeGreaterThanOrEqual(PLAYER_EDGE);
    expect(p.pos.y).toBeGreaterThanOrEqual(PLAYER_EDGE);
    expect(p.pos.x).toBeLessThanOrEqual(WORLD_WIDTH - PLAYER_EDGE);
    expect(p.pos.y).toBeLessThanOrEqual(WORLD_HEIGHT - PLAYER_EDGE);
  });

  it("an offline player doesn't move and isn't chased, even with a stale intent", () => {
    const room = new CoopRoom("ABC123", 0);
    const p = room.addPlayer("p1", "Ash", "#50a0ff", 0);
    room.setIntent("p1", 1, 0, 0);
    room.setOnline("p1", false, 0);
    const before = { ...p.pos };
    room.tick(0, 1, rng(1));
    expect(p.pos).toEqual(before);
  });

  it("a disconnected player going back online keeps their last position", () => {
    const room = new CoopRoom("ABC123", 0);
    const p = room.addPlayer("p1", "Ash", "#50a0ff", 0);
    p.pos.x = 999;
    room.setOnline("p1", false, 0);
    room.setOnline("p1", true, 1);
    expect(p.pos.x).toBe(999);
  });
});

describe("CoopRoom: shared enemies", () => {
  it("starts with the real map layout, same count as single-player", () => {
    const room = new CoopRoom("ABC123", 0);
    expect(room.enemies.length).toBe(makeRoomEnemies().length);
    expect(room.enemies.every((e) => e.alive && e.hp === e.maxHp)).toBe(true);
  });

  it("an enemy notices and chases whichever nearby player it actually saw", () => {
    const room = new CoopRoom("ABC123", 0);
    const west1 = room.enemies.find((e) => e.key === "west-1")!;
    room.addPlayer("far", "Far", "#fff", 0).pos = { x: west1.spawn.x + 5000, y: west1.spawn.y };
    room.addPlayer("near", "Near", "#fff", 0).pos = { x: west1.spawn.x - 30, y: west1.spawn.y };
    room.tick(0, 1 / 30, rng(2));
    expect(west1.state).toBe("chasing");
    expect(west1.targetId).toBe("near");
  });

  it("snapshot only reports players and living enemies, with real coordinates", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#50a0ff", 0);
    const snap = room.snapshot(0);
    expect(snap.players).toHaveLength(1);
    expect(snap.players[0]).toMatchObject({ id: "p1", name: "Ash", x: PLAYER_START.x, y: PLAYER_START.y });
    expect(snap.enemies.length).toBe(room.enemies.length);
  });
});
