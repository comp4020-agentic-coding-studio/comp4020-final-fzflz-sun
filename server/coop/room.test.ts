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

  it("a wiped (0 HP) player cannot move: setIntent is a no-op and their position is unchanged across ticks", () => {
    const room = new CoopRoom("ABC123", 0);
    const p = room.addPlayer("p1", "Ash", "#50a0ff", 0);
    p.hp = 0; // the state a real party wipe leaves a player in (fight-session.ts's finish() never restores hp)
    room.setIntent("p1", 1, 0, 0);
    expect(p.dir).toEqual({ x: 0, y: 0 }); // the intent itself was never applied
    const before = { ...p.pos };
    room.tick(0, 1, rng(1));
    expect(p.pos).toEqual(before);
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
    // inside aggroRange (210) so it notices, outside engageRange (40) so it
    // chases without also instantly triggering a fight this same tick
    room.addPlayer("near", "Near", "#fff", 0).pos = { x: west1.spawn.x - 100, y: west1.spawn.y };
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

describe("CoopRoom: fights form and freeze membership", () => {
  /** Force an enemy already chasing `playerId`, right at its own doorstep. */
  function putInEngageRange(room: CoopRoom, key: string, playerId: string) {
    const e = room.enemies.find((x) => x.key === key)!;
    const p = room.players.get(playerId)!;
    e.state = "chasing";
    e.targetId = playerId;
    e.pos = { x: p.pos.x + e.engageRange - 1, y: p.pos.y };
    return e;
  }

  it("a trigger forms a fight that freezes the enemy and the player", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#50a0ff", 0);
    const e = putInEngageRange(room, "west-1", "p1");
    const formed = room.formFights(0);
    expect(formed).toHaveLength(1);
    expect(e.state).toBe("engaged");
    expect(e.fightId).toBe(formed[0].id);
    const p = room.players.get("p1")!;
    expect(p.fightId).toBe(formed[0].id);
    // a fighting player can't move the shared map anymore
    room.setIntent("p1", 1, 0, 1);
    room.tick(1, 1, rng(1));
    expect(p.pos).toEqual(PLAYER_START);
  });

  it("a free teammate within PLAYER_JOIN_RADIUS joins; a far one stays free to keep exploring", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#50a0ff", 0);
    const near = room.addPlayer("near", "Birch", "#ff8a65", 0);
    near.pos = { x: PLAYER_START.x + 50, y: PLAYER_START.y };
    const far = room.addPlayer("far", "Cove", "#7fd97f", 0);
    far.pos = { x: PLAYER_START.x + 5000, y: PLAYER_START.y };
    putInEngageRange(room, "west-1", "p1");
    const [fight] = room.formFights(0);
    expect(fight.playerIds.sort()).toEqual(["near", "p1"].sort());
    expect(near.fightId).toBe(fight.id);
    expect(far.fightId).toBeNull();
    // the far player is still free to move
    room.setIntent("far", 1, 0, 1);
    room.tick(1, 1, rng(1));
    expect(far.pos.x).not.toBe(PLAYER_START.x + 5000);
  });

  it("two players triggering two unrelated, far-apart enemies form two separate fights in one tick", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#50a0ff", 0).pos = { x: 300, y: 300 };
    room.addPlayer("p2", "Birch", "#ff8a65", 0).pos = { x: 2000, y: 1000 };
    putInEngageRange(room, "west-1", "p1");
    putInEngageRange(room, "lair-boss", "p2");
    const formed = room.formFights(0);
    expect(formed).toHaveLength(2);
    const byAnchor = new Map(formed.map((f) => [f.anchorId, f]));
    expect(byAnchor.get("p1")!.enemyKeys).toContain("west-1");
    expect(byAnchor.get("p2")!.enemyKeys).toContain("lair-boss");
  });

  it("an enemy already engaged in one fight is never pulled into another", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#50a0ff", 0).pos = { x: 300, y: 300 };
    const e = putInEngageRange(room, "west-1", "p1");
    const [first] = room.formFights(0);
    expect(e.fightId).toBe(first.id);
    // nothing new triggers: a second pass forms no further fights
    expect(room.formFights(1)).toHaveLength(0);
  });

  it("a busy player's fight never changes once formed, even as others move nearby later", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#50a0ff", 0);
    putInEngageRange(room, "west-1", "p1");
    const [fight] = room.formFights(0);
    const late = room.addPlayer("late", "Cove", "#7fd97f", 10);
    late.pos = { x: PLAYER_START.x + 10, y: PLAYER_START.y }; // arrives right next to the fight, after it formed
    room.formFights(10);
    expect(late.fightId).toBeNull();
    expect(room.fights.get(fight.id)!.playerIds).toEqual(fight.playerIds);
  });
});

describe("CoopRoom: reserveFightId (avoiding a collision after a restart)", () => {
  it("a restored fight's id is never reused by the next genuinely new one", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#50a0ff", 0);
    room.addPlayer("p2", "Birch", "#ff8a65", 0).pos = { x: 2000, y: 1000 };
    // simulate restoring a fight "f1" without ever calling formFights for it
    room.reserveFightId("f1");
    putInEngageRange(room, "lair-boss", "p2");
    const [fight] = room.formFights(0);
    expect(fight.id).not.toBe("f1");
  });

  it("reserving a lower or malformed id never moves the counter backwards or crashes", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#50a0ff", 0);
    putInEngageRange(room, "west-1", "p1");
    const [first] = room.formFights(0); // "f1"
    room.reserveFightId("f1"); // already used, lower than or equal to current counter
    room.reserveFightId("not-a-fight-id"); // malformed: ignored, not thrown
    const room2 = new CoopRoom("ABC123", 1);
    room2.addPlayer("p2", "Birch", "#ff8a65", 1);
    putInEngageRange(room2, "west-1", "p2");
    const [second] = room2.formFights(0);
    expect(first.id).toBe("f1");
    expect(second.id).toBe("f1"); // a separate room instance: unaffected by the first room's reservations
  });

  function putInEngageRange(room: CoopRoom, key: string, playerId: string) {
    const e = room.enemies.find((x) => x.key === key)!;
    const p = room.players.get(playerId)!;
    e.state = "chasing";
    e.targetId = playerId;
    e.pos = { x: p.pos.x + e.engageRange - 1, y: p.pos.y };
    return e;
  }
});
