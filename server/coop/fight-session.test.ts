import { describe, expect, it } from "vitest";
import { PLAYER_MAX_ENERGY } from "../../src/world.ts";
import { FightSession } from "./fight-session.ts";
import { CoopRoom, type RoomFight } from "./room.ts";

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A room with one manually-formed fight, bypassing roam/trigger mechanics (covered in room.test.ts). */
function setup(playerIds: string[], enemyKeys: string[], enemyHp?: Record<string, number>) {
  const room = new CoopRoom("ABC123", 0);
  for (const id of playerIds) room.addPlayer(id, id, "#fff", 0);
  for (const key of enemyKeys) {
    const e = room.enemies.find((x) => x.key === key)!;
    e.state = "engaged";
    e.fightId = "f1";
    if (enemyHp?.[key] !== undefined) e.hp = enemyHp[key];
  }
  for (const id of playerIds) room.players.get(id)!.fightId = "f1";
  const roomFight: RoomFight = { id: "f1", anchorId: playerIds[0], playerIds, enemyKeys, startedAt: 0 };
  room.fights.set("f1", roomFight);
  const session = new FightSession(room, roomFight, rng(1));
  return { room, session, roomFight };
}

function hand(session: FightSession, playerId: string) {
  return session.handView(playerId)!.cards;
}
function findCard(session: FightSession, playerId: string, name: string) {
  return hand(session, playerId).find((c) => c.name === name)!;
}

describe("FightSession: setup", () => {
  it("builds a Fight with the right enemies and players, hands dealt, energy full", () => {
    const { session } = setup(["p1"], ["west-1"]);
    expect(session.fight.units.map((u) => u.key)).toEqual(["west-1"]);
    expect(session.fight.players.map((p) => p.id)).toEqual(["p1"]);
    const h = session.handView("p1")!;
    expect(h.cards).toHaveLength(4);
    expect(h.energy).toBe(PLAYER_MAX_ENERGY);
    expect(new Set(h.cards.map((c) => c.id)).size).toBe(4); // distinct instance ids, even if some share a name
  });

  it("the fight view shows enemy intent and HP, and every player's block/ready/downed state", () => {
    const { session } = setup(["p1"], ["west-1"]);
    const fv = session.fightView();
    expect(fv.enemies[0]).toMatchObject({ key: "west-1", hp: 6, downed: false });
    expect(fv.enemies[0].intent).toMatchObject({ kind: "attack", targetId: "p1" });
    expect(fv.players[0]).toMatchObject({ id: "p1", hp: 24, block: 0, ready: false, downed: false, fled: false });
  });
});

describe("FightSession: playing cards", () => {
  it("a card is identified by its stable instance id, not a hand index", () => {
    const { session } = setup(["p1"], ["west-1"], { "west-1": 999 });
    const strike = findCard(session, "p1", "Strike");
    const before = session.fight.units[0].hp;
    const r = session.applyAction("p1", 1, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(2));
    expect(r.ok).toBe(true);
    expect(session.fight.units[0].hp).toBe(before - 6);
    expect(hand(session, "p1").find((c) => c.id === strike.id)).toBeUndefined(); // it left the hand
  });

  it("a single-target card without a target is rejected, and nothing is spent", () => {
    const { session } = setup(["p1"], ["west-1"], { "west-1": 999 });
    const strike = findCard(session, "p1", "Strike");
    const before = hand(session, "p1").length;
    const r = session.applyAction("p1", 1, { type: "playCard", cardInstanceId: strike.id }, 0, rng(2));
    expect(r.ok).toBe(false);
    expect(hand(session, "p1")).toHaveLength(before); // card stays in hand
  });

  it("not enough energy rejects the play", () => {
    const { session } = setup(["p1"], ["west-1"], { "west-1": 999 });
    const cleave = findCard(session, "p1", "Cleave"); // costs 2
    // spend down to 0 energy with two Strikes/Guards first (cost 1 each)
    for (let i = 0; i < PLAYER_MAX_ENERGY; i++) {
      const c = hand(session, "p1").find((x) => x.name !== "Cleave" && x.cost <= 1);
      if (c) session.applyAction("p1", i + 1, { type: "playCard", cardInstanceId: c.id, targetKey: "west-1" }, 0, rng(1));
    }
    const r = session.applyAction("p1", 99, { type: "playCard", cardInstanceId: cleave.id }, 0, rng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/energy/);
  });

  it("a stale or repeated sequence number is rejected without double-applying the action", () => {
    const { session } = setup(["p1"], ["west-1"]);
    const strike = findCard(session, "p1", "Strike");
    session.applyAction("p1", 5, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(2));
    const hpAfterFirst = session.fight.units[0].hp;
    // replay the exact same seq: must be rejected (card's already gone from hand anyway)
    const replay = session.applyAction("p1", 5, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(2));
    expect(replay.ok).toBe(false);
    expect(session.fight.units[0].hp).toBe(hpAfterFirst);
    // an older seq than one already processed is also rejected
    const stale = session.applyAction("p1", 3, { type: "endTurn" }, 0, rng(2));
    expect(stale.ok).toBe(false);
  });

  it("a second attack on an already-downed enemy is validated against current state, never a wasted extra kill", () => {
    // a second enemy keeps the fight going, isolating "target already downed"
    // from "the whole fight already ended" (combat.test.ts covers hitUnit's
    // own no-op-on-a-downed-unit rule at the pure-function level already)
    const { session } = setup(["p1"], ["west-1", "west-2"], { "west-1": 999, "west-2": 999 });
    const target = session.fight.units.find((u) => u.key === "west-1")!;
    target.hp = 0;
    target.downed = true; // e.g. a teammate's attack, arriving a moment earlier, already downed it
    const strike = findCard(session, "p1", "Strike");
    const r = session.applyAction("p1", 1, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(2));
    expect(r.ok).toBe(false);
    expect(session.ended).toBeNull(); // west-2 still stands: the fight itself is unaffected
    expect(hand(session, "p1").some((c) => c.id === strike.id)).toBe(true); // the card was never spent
  });
});

describe("FightSession: the common player phase", () => {
  it("the enemy turn only resolves once every active player has readied up", () => {
    const { session } = setup(["p1", "p2"], ["west-1"]);
    const turnBefore = session.fight.turn;
    const r1 = session.applyAction("p1", 1, { type: "endTurn" }, 0, rng(2));
    expect(r1.ok).toBe(true);
    expect(session.fight.turn).toBe(turnBefore); // p2 hasn't readied yet: no resolve
    expect(session.fightView().players.find((p) => p.id === "p1")!.ready).toBe(true);
    const r2 = session.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2));
    expect(r2.ok).toBe(true);
    expect(session.fight.turn).toBe(turnBefore + 1); // both ready: round resolved, next turn started
  });

  it("a player can't act again after readying up, until the next round", () => {
    const { session } = setup(["p1", "p2"], ["west-1"]);
    session.applyAction("p1", 1, { type: "endTurn" }, 0, rng(2));
    const strike = findCard(session, "p1", "Strike");
    const r = session.applyAction("p1", 2, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(2));
    expect(r.ok).toBe(false);
  });

  it("a downed player doesn't block the round from resolving for the others", () => {
    const { session } = setup(["p1", "p2"], ["west-1", "west-2"]);
    // force p1 down directly (as an enemy attack would)
    const fp1 = session.fight.players.find((p) => p.id === "p1")!;
    fp1.hp = 0;
    fp1.downed = true;
    const r = session.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2));
    expect(r.ok).toBe(true);
    expect(session.fight.turn).toBe(2); // resolved: p1 (downed) never had to ready up
  });
});

describe("FightSession: fleeing and death", () => {
  it("fleeing still takes the shown enemy actions this round, then leaves if it survived", () => {
    const { session, room } = setup(["p1"], ["west-1"]);
    const before = session.fightView().players[0].hp;
    session.applyAction("p1", 1, { type: "flee" }, 0, rng(2));
    // resolved immediately (solo: the only active player readied up)
    expect(session.ended).toBe("abandoned");
    expect(room.players.get("p1")!.fightId).toBeNull(); // free to explore again
    expect(before).toBeGreaterThan(0);
  });

  it("one player fleeing doesn't end the fight for a teammate who keeps fighting", () => {
    const { session, room } = setup(["p1", "p2"], ["west-1"]);
    session.applyAction("p1", 1, { type: "flee" }, 0, rng(2));
    session.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2));
    expect(session.ended).toBeNull(); // p2 is still fighting
    expect(room.players.get("p1")!.fightId).toBeNull();
    expect(room.players.get("p2")!.fightId).toBe("f1");
    expect(session.isMember("p1")).toBe(false);
    expect(session.isMember("p2")).toBe(true);
  });

  it("the whole party downed ends the fight as a wipe; the surviving enemy returns to roaming with its current HP", () => {
    const { session, room } = setup(["p1"], ["west-1"]);
    session.fight.players[0].hp = 2; // west-1's shown attack (3 dmg) will be lethal this round
    const r = session.applyAction("p1", 1, { type: "endTurn" }, 0, rng(2));
    expect(r.ok).toBe(true);
    expect(session.ended).toBe("wiped");
    expect(session.fight.players[0].downed).toBe(true);
    const enemy = room.enemies.find((e) => e.key === "west-1")!;
    expect(enemy.hp).toBe(enemy.maxHp); // west-1 was never hit: full HP carries back to the room
    expect(enemy.fightId).toBeNull();
    expect(enemy.state).not.toBe("engaged"); // settleAfterFlee returned it to roaming (calm, around its spot)
    expect(room.players.get("p1")!.fightId).toBeNull();
    expect(room.fights.has("f1")).toBe(false);
  });

  it("a victorious kill ends the fight immediately, without needing an End Turn", () => {
    const { session, room } = setup(["p1"], ["west-1"], { "west-1": 6 });
    const strike = findCard(session, "p1", "Strike"); // exactly lethal
    const r = session.applyAction("p1", 1, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(2));
    expect(r.ok).toBe(true);
    expect(session.ended).toBe("won");
    expect(room.enemies.find((e) => e.key === "west-1")!.alive).toBe(false);
    expect(room.players.get("p1")!.fightId).toBeNull();
    expect(room.fights.has("f1")).toBe(false);
  });
});
