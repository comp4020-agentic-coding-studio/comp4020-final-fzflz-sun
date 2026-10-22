import { describe, expect, it } from "vitest";
import { PLAYER_MAX_ENERGY, PLAYER_MAX_HP } from "../../src/world.ts";
import { FIGHT_PERSIST_VERSION, FightSession, migratePersistedFight } from "./fight-session.ts";
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
    expect(h.lastSeq).toBe(0);
  });

  it("handView's lastSeq tracks accepted actions, so a refreshed client can resume its counter from it", () => {
    const { session } = setup(["p1"], ["west-1"], { "west-1": 999 });
    const strike = findCard(session, "p1", "Strike");
    session.applyAction("p1", 1, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(2));
    expect(session.handView("p1")!.lastSeq).toBe(1);
    session.applyAction("p1", 1, { type: "endTurn" }, 0, rng(2)); // a stale/duplicate seq: rejected, doesn't advance
    expect(session.handView("p1")!.lastSeq).toBe(1);
    session.applyAction("p1", 2, { type: "endTurn" }, 0, rng(2));
    expect(session.handView("p1")!.lastSeq).toBe(2);
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

  it("a successful playCard's result carries the server-confirmed card name/kind, and the real target only for a single-target card", () => {
    const { session } = setup(["p1"], ["west-1"], { "west-1": 999 });
    const strike = findCard(session, "p1", "Strike");
    const r = session.applyAction("p1", 1, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(2));
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ cardName: "Strike", cardKind: "single", validTargetKey: "west-1" });
  });

  it("a non-single card's result never carries a targetKey, even if one was attached to the request", () => {
    const { session } = setup(["p1"], ["west-1"], { "west-1": 999 });
    const guard = findCard(session, "p1", "Guard");
    // a client attaching a targetKey to a card that doesn't use one at all — the server must
    // never echo it back as though it were a real, validated target.
    const r = session.applyAction("p1", 1, { type: "playCard", cardInstanceId: guard.id, targetKey: "x".repeat(2048) }, 0, rng(2));
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ cardName: "Guard", cardKind: "guard", validTargetKey: undefined });
    expect(JSON.stringify(r.summary)).not.toContain("x".repeat(2048));
  });
});

describe("FightSession: the action-sequence contract (lastSeq only advances on real success)", () => {
  it("a rejected card-not-in-hand action at seq N does not advance lastSeq; a legitimate action still at seq N then succeeds", () => {
    const { session } = setup(["p1"], ["west-1"]);
    const before = session.handView("p1")!.lastSeq;
    const bad = session.applyAction("p1", 2, { type: "playCard", cardInstanceId: "not-a-real-card" }, 0, rng(2));
    expect(bad.ok).toBe(false);
    expect(session.handView("p1")!.lastSeq).toBe(before); // unchanged by the rejection
    // the exact same seq, now a legitimate action: must succeed, not be rejected as stale
    const good = session.applyAction("p1", 2, { type: "endTurn" }, 0, rng(2));
    expect(good.ok).toBe(true);
    expect(session.handView("p1")!.lastSeq).toBe(2);
  });

  it("a rejected not-enough-energy action does not advance lastSeq, and the same seq can be retried with an affordable card", () => {
    const { session } = setup(["p1"], ["west-1"], { "west-1": 999 });
    // spend down to 0 energy first
    for (let i = 0; i < PLAYER_MAX_ENERGY; i++) {
      const c = hand(session, "p1").find((x) => x.cost <= 1);
      if (c) session.applyAction("p1", i + 1, { type: "playCard", cardInstanceId: c.id, targetKey: "west-1" }, 0, rng(1));
    }
    const lastSeqBefore = session.handView("p1")!.lastSeq;
    const cleave = hand(session, "p1").find((c) => c.name === "Cleave");
    if (cleave) {
      const rejected = session.applyAction("p1", lastSeqBefore + 1, { type: "playCard", cardInstanceId: cleave.id }, 0, rng(1));
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toMatch(/energy/);
      expect(session.handView("p1")!.lastSeq).toBe(lastSeqBefore); // unchanged
      // the same seq, now ending the turn instead: must succeed
      const good = session.applyAction("p1", lastSeqBefore + 1, { type: "endTurn" }, 0, rng(1));
      expect(good.ok).toBe(true);
    }
  });

  it("a rejected invalid-target action does not advance lastSeq", () => {
    const { session } = setup(["p1"], ["west-1"], { "west-1": 999 });
    const strike = findCard(session, "p1", "Strike");
    const before = session.handView("p1")!.lastSeq;
    const rejected = session.applyAction("p1", 5, { type: "playCard", cardInstanceId: strike.id, targetKey: "no-such-enemy" }, 0, rng(2));
    expect(rejected.ok).toBe(false);
    expect(session.handView("p1")!.lastSeq).toBe(before);
    const good = session.applyAction("p1", 5, { type: "endTurn" }, 0, rng(2));
    expect(good.ok).toBe(true);
    expect(session.handView("p1")!.lastSeq).toBe(5);
  });

  it("a real successful action still advances lastSeq normally (regression guard)", () => {
    const { session } = setup(["p1"], ["west-1"], { "west-1": 999 });
    const strike = findCard(session, "p1", "Strike");
    const r = session.applyAction("p1", 1, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(2));
    expect(r.ok).toBe(true);
    expect(session.handView("p1")!.lastSeq).toBe(1);
  });

  it("deterministic all-single-card hand: every card in hand is a Strike, the exact scenario a shuffled 4-card hand can legitimately produce", () => {
    // bypasses the shuffle entirely rather than relying on a seed that happens
    // to deal all-Strike — this is the deterministic regression for the
    // flake documented in docs/process/2026-10-18-c10-review.md (finding 4):
    // a real 14-card deck (5 Strike/3 Cleave/3 Guard/3 Focus) CAN deal a
    // 4-card hand that is entirely single-target cards.
    const { session } = setup(["p1"], ["west-1"], { "west-1": 999 });
    const ps = (session as unknown as { playerStates: Map<string, { piles: { hand: { name: string; kind: string }[] }; handIds: string[] }> }).playerStates.get("p1")!;
    const strikeDef = { name: "Strike", kind: "single", cost: 1, value: 6, blurb: "6 dmg to target" };
    ps.piles.hand = [strikeDef, strikeDef, strikeDef, strikeDef];
    ps.handIds = ps.handIds.map((_, i) => `forced-${i}`);
    const h = session.handView("p1")!;
    expect(h.cards.every((c) => c.kind === "single")).toBe(true);
    // a legitimate action against this all-single hand must still succeed with a real target
    const r = session.applyAction("p1", 1, { type: "playCard", cardInstanceId: h.cards[0].id, targetKey: "west-1" }, 0, rng(2));
    expect(r.ok).toBe(true);
    expect(r.summary?.cardName).toBe("Strike");
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

  it("takeJustLeft() reports exactly the player who personally left this round, once (ws.ts's leftFight message)", () => {
    const { session } = setup(["p1", "p2"], ["west-1"]);
    session.applyAction("p1", 1, { type: "flee" }, 0, rng(2));
    session.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2));
    expect(session.takeJustLeft()).toEqual(["p1"]);
    expect(session.takeJustLeft()).toEqual([]); // consumed: not reported twice
  });

  it("a downed player is not reported by takeJustLeft(): they stay structurally present, shown as fallen", () => {
    const { session } = setup(["p1", "p2"], ["west-1"]);
    session.fight.players[0].hp = 2; // west-1's shown attack (3 dmg) will down p1, not kill the whole party
    session.applyAction("p1", 1, { type: "endTurn" }, 0, rng(2));
    session.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2));
    expect(session.fight.players[0].downed).toBe(true);
    expect(session.takeJustLeft()).toEqual([]);
    expect(session.isMember("p1")).toBe(true); // still a member: fightView/handView keep covering them
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

  it("finalPlayerIds captures exactly who was still here when the fight ended, excluding anyone who'd already personally left — the correct notification list, unlike the original fixed roster", () => {
    const { session } = setup(["p1", "p2"], ["west-1"], { "west-1": 999 });
    expect(session.finalPlayerIds).toBeNull(); // not yet ended
    session.applyAction("p1", 1, { type: "flee" }, 0, rng(2)); // p1 ready+pendingFlee, p2 hasn't acted
    session.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2)); // round resolves: p1 actually leaves
    expect(session.isMember("p1")).toBe(false);
    expect(session.isMember("p2")).toBe(true);
    // the fight hasn't ended yet (p2 is still fighting alone) — finalPlayerIds stays null
    expect(session.ended).toBeNull();
    expect(session.finalPlayerIds).toBeNull();

    // now p2 finishes the fight (kills the enemy): finalPlayerIds must be exactly [p2], not
    // [p1, p2] (the original roster, which would wrongly notify p1 about THIS fight ending)
    const strike = findCard(session, "p2", "Strike");
    const west1 = session.fight.units.find((u) => u.key === "west-1")!;
    west1.hp = strike.value; // make it exactly lethal regardless of its default max HP
    session.applyAction("p2", 2, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(3));
    expect(session.ended).toBe("won");
    expect(session.finalPlayerIds).toEqual(["p2"]);
    expect(session.initialPlayerIds).toEqual(["p1", "p2"]); // unchanged: still the original fixed roster, for contrast
  });
});

describe("FightSession: a reconnect window timing out (forceFlee)", () => {
  it("is exactly like the player clicking Flee themselves: shown actions land, then they leave if they survived", () => {
    const { session, room } = setup(["p1"], ["west-1"]);
    const r = session.forceFlee("p1", 0, rng(2));
    expect(r.ok).toBe(true);
    expect(r.left).toBe(true); // solo: resolved immediately within this exact call
    expect(session.ended).toBe("abandoned"); // solo: resolved immediately, nobody left fighting
    expect(room.players.get("p1")!.fightId).toBeNull();
  });

  it("never a free exit: it still takes a full round to resolve, same as a real flee — and this call's own result honestly reports they have NOT left yet", () => {
    const { session } = setup(["p1", "p2"], ["west-1"]);
    const r = session.forceFlee("p1", 0, rng(2));
    expect(r.ok).toBe(true);
    expect(r.left).toBe(false); // queued only: p2 hasn't readied yet, this call did not resolve anything
    expect(session.ended).toBeNull(); // p2 hasn't readied yet: the round (and p1's departure) hasn't resolved
    expect(session.isMember("p1")).toBe(true); // still structurally present until the round actually resolves
  });

  it("resolves alongside a teammate's own action, and doesn't disturb that teammate's own sequence checking", () => {
    const { session } = setup(["p1", "p2"], ["west-1"]);
    const forced = session.forceFlee("p1", 0, rng(2));
    expect(forced.left).toBe(false); // this call itself only queued it — p2 hadn't acted yet
    const r = session.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2));
    expect(r.ok).toBe(true); // both now ready: the round resolves
    expect(session.isMember("p1")).toBe(false); // p1 left (forced flee, survived the round)
    expect(session.isMember("p2")).toBe(true); // p2 fought on alone
    expect(session.ended).toBeNull();
    const replay = session.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2)); // p2's own seq tracking is unaffected
    expect(replay.ok).toBe(false);
  });

  it("when the forced player is the LAST unready one, this same call resolves the round and reports left:true", () => {
    const { session } = setup(["p1", "p2"], ["west-1"]);
    session.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2)); // p2 already ready
    const r = session.forceFlee("p1", 0, rng(2)); // p1 is now the last unready active player
    expect(r.ok).toBe(true);
    expect(r.left).toBe(true); // resolved within this exact call
    expect(session.isMember("p1")).toBe(false);
  });

  it("a downed or already-fled player can't be force-fled again", () => {
    const { session } = setup(["p1", "p2"], ["west-1"]);
    const fp1 = session.fight.players.find((p) => p.id === "p1")!;
    fp1.hp = 0;
    fp1.downed = true;
    const r = session.forceFlee("p1", 0, rng(2));
    expect(r.ok).toBe(false);
    expect(r.left).toBeUndefined(); // rejected outright: no departure to report either way
  });
});

describe("FightSession: serialize/restore (a server restart mid-fight)", () => {
  it("round-trips turn, enemy state, hands, energy, lastSeq and card instance ids exactly", () => {
    const { session, room, roomFight } = setup(["p1", "p2"], ["west-1"], { "west-1": 999 });
    const strike = findCard(session, "p1", "Strike");
    session.applyAction("p1", 1, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(2));
    const data = session.serialize();

    const restored = new FightSession(room, roomFight, rng(9), data);
    expect(restored.fight.turn).toBe(session.fight.turn);
    expect(restored.fight.units.map((u) => u.hp)).toEqual(session.fight.units.map((u) => u.hp));
    expect(hand(restored, "p1").map((c) => c.id)).toEqual(hand(session, "p1").map((c) => c.id));
    expect(restored.handView("p1")!.energy).toBe(session.handView("p1")!.energy);
    expect(restored.handView("p1")!.lastSeq).toBe(session.handView("p1")!.lastSeq);
    expect(restored.handView("p2")!.cards.length).toBe(4); // p2 never acted: still their original fresh hand
  });

  it("restores a player's HP from the fight's own record, not a stale value already sitting on the room", () => {
    const { session, room, roomFight } = setup(["p1", "p2"], ["west-1"]);
    session.fight.players.find((p) => p.id === "p1")!.hp = 11; // simulate damage taken this fight
    const data = session.serialize();
    // simulate a crash landing before the room-level debounced snapshot caught up:
    // the room still thinks p1 is at full HP.
    room.players.get("p1")!.hp = 24;

    new FightSession(room, roomFight, rng(9), data);
    expect(room.players.get("p1")!.hp).toBe(11); // not rolled back to the stale 24
  });

  it("restores exactly who had already readied up (ended turn or committed to flee), not resetting everyone to not-ready", () => {
    const { session, room, roomFight } = setup(["p1", "p2"], ["west-1"], { "west-1": 999 });
    session.applyAction("p1", 1, { type: "endTurn" }, 0, rng(2)); // p1 ready; p2 hasn't acted, round doesn't resolve
    expect(session.ended).toBeNull();
    const data = session.serialize();

    const restored = new FightSession(room, roomFight, rng(9), data);
    expect(room.players.get("p1")!.ready).toBe(true);
    expect(room.players.get("p2")!.ready).toBe(false);
    // p1 already committed this round: must still be rejected, not able to sneak in another card
    const card = hand(restored, "p1")[0];
    const r = restored.applyAction("p1", 2, { type: "playCard", cardInstanceId: card.id }, 0, rng(2));
    expect(r.ok).toBe(false);
    // p2 can still act normally
    const r2 = restored.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2));
    expect(r2.ok).toBe(true);
  });

  it("a fled player is not resumed as a member, and isn't given a seat in the restored fight", () => {
    const { session, room, roomFight } = setup(["p1", "p2"], ["west-1"]);
    session.applyAction("p1", 1, { type: "flee" }, 0, rng(2)); // p1 ready+pendingFlee, p2 hasn't acted yet
    session.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2)); // round resolves: p1 actually leaves
    expect(session.isMember("p1")).toBe(false);
    const data = session.serialize();

    const restored = new FightSession(room, roomFight, rng(9), data);
    expect(restored.isMember("p1")).toBe(false);
    expect(restored.isMember("p2")).toBe(true);
  });

  it("restoring a hand with a far-advanced card id reserves it: a subsequently generated card id never collides, even across a second, separately-restored room", () => {
    const { session, room, roomFight } = setup(["p1", "p2"], ["west-1"], { "west-1": 999 });
    const data = session.serialize();
    // simulate a persisted hand whose ids are far ahead of this process's own counter
    // (e.g. a process that had already dealt tens of thousands of cards before this restart)
    data.players[0].handIds = ["card99001", "card99002", "card99003", "card99004"];

    const restored = new FightSession(room, roomFight, rng(9), data);
    // force a brand-new card id: play the resource card (Focus) to draw one, if present;
    // otherwise directly exercise the same path via a second restore in a different room.
    const focus = hand(restored, "p1").find((c) => c.kind === "resource");
    if (focus) {
      restored.applyAction("p1", 1, { type: "playCard", cardInstanceId: focus.id }, 0, rng(3));
      const newIds = hand(restored, "p1").map((c) => Number(/^card(\d+)$/.exec(c.id)?.[1] ?? 0));
      for (const n of newIds) expect(n).toBeGreaterThanOrEqual(99001); // never a low, colliding id like "card1"
    }

    // a second, independently-restored room's fresh deal must also never collide with
    // the first room's reserved ids — the counter is process-wide, so this proves the
    // reservation isn't accidentally scoped to only the first room checked.
    const second = setup(["p3"], ["west-2"], { "west-2": 999 });
    const secondIds = hand(second.session, "p3").map((c) => Number(/^card(\d+)$/.exec(c.id)?.[1] ?? 0));
    for (const n of secondIds) expect(n).toBeGreaterThan(99004);
  });

  it("a downed (not fled) player IS resumed as a member — server/coop/ws.ts's restore loop relies on playerIds to still include them, shown as fallen, unable to act, but not freed", () => {
    const { session, room, roomFight } = setup(["p1", "p2"], ["west-1"], { "west-1": 999 });
    session.fight.players.find((p) => p.id === "p1")!.hp = 3; // west-1's shown 3-dmg attack will down, not kill the party
    session.applyAction("p1", 1, { type: "endTurn" }, 0, rng(2));
    session.applyAction("p2", 1, { type: "endTurn" }, 0, rng(2));
    expect(session.fight.players.find((p) => p.id === "p1")!.downed).toBe(true);
    expect(session.isMember("p1")).toBe(true); // still a member, just downed
    const data = session.serialize();

    const restored = new FightSession(room, roomFight, rng(9), data);
    // this is exactly the set server/coop/ws.ts's getOrLoadRoom uses to decide who
    // gets re-locked (fightId set, reconnect timer armed) after a restart — p1 must
    // still be included (downed, structurally present) even though they can't act.
    expect(restored.playerIds.sort()).toEqual(["p1", "p2"]);
    expect(restored.isMember("p1")).toBe(true);
    const r = restored.applyAction("p1", 2, { type: "endTurn" }, 0, rng(2));
    expect(r.ok).toBe(false); // downed: can't act
  });
});

describe("migratePersistedFight: legacy rows (written between 3c658ca and b2896df, no version/hp/ready)", () => {
  function legacyRow(overrides: Partial<{ pendingFlee: string[]; players: Record<string, unknown>[] }> = {}) {
    return {
      // no `version` field at all: the real compat signal
      roomFight: { id: "f1", anchorId: "p1", playerIds: ["p1", "p2"], enemyKeys: ["west-1"], startedAt: 0 },
      turn: 2,
      units: [{ key: "west-1", role: "brute", group: "west", maxHp: 6, hp: 6, block: 0, phase: 0, intent: null, downed: false, downedOnTurn: null, revivedThisFight: false, reviveUsed: false }],
      players: overrides.players ?? [
        { id: "p1", block: 0, downed: false, fled: false, piles: { draw: [], hand: [], discard: [], exhaust: [] }, handIds: [], energy: 2, lastSeq: 3 }, // no hp, no ready
        { id: "p2", block: 0, downed: false, fled: false, piles: { draw: [], hand: [], discard: [], exhaust: [] }, handIds: [], energy: 3, lastSeq: 1 },
      ],
      pendingFlee: overrides.pendingFlee ?? [],
    };
  }

  it("migrates a structurally-valid legacy row to a fully-valid shape: no undefined/NaN anywhere", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "p1", "#fff", 0);
    room.addPlayer("p2", "p2", "#fff", 0);
    room.players.get("p1")!.hp = 17; // the room-level snapshot's own value: the documented fallback source
    const migrated = migratePersistedFight(legacyRow(), room);
    expect(migrated).not.toBeNull();
    expect(migrated!.version).toBe(FIGHT_PERSIST_VERSION);
    for (const p of migrated!.players) {
      expect(Number.isFinite(p.hp)).toBe(true);
      expect(typeof p.ready).toBe("boolean");
    }
    expect(migrated!.players.find((p) => p.id === "p1")!.hp).toBe(17); // pulled from the room snapshot, not invented
  });

  it("a legacy player with no room-level HP either falls back to PLAYER_MAX_HP, never undefined/NaN", () => {
    const room = new CoopRoom("ABC123", 0); // p1/p2 never added: no room-level fallback available
    const migrated = migratePersistedFight(legacyRow(), room)!;
    for (const p of migrated.players) expect(p.hp).toBe(PLAYER_MAX_HP);
  });

  it("a legacy player who had committed to flee (pendingFlee) is restored ready, and can't play another card", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "p1", "#fff", 0);
    room.addPlayer("p2", "p2", "#fff", 0);
    const roomFight: RoomFight = { id: "f1", anchorId: "p1", playerIds: ["p1", "p2"], enemyKeys: ["west-1"], startedAt: 0 };
    room.fights.set("f1", roomFight);
    for (const e of room.enemies) if (e.key === "west-1") e.state = "engaged";

    const migrated = migratePersistedFight(legacyRow({ pendingFlee: ["p1"] }), room)!;
    expect(migrated.players.find((p) => p.id === "p1")!.ready).toBe(true);

    const restored = new FightSession(room, roomFight, rng(9), migrated);
    const r = restored.applyAction("p1", 10, { type: "endTurn" }, 0, rng(2));
    expect(r.ok).toBe(false); // already readied up per the migrated data
  });

  it("a legacy player with no flee recorded defaults to not-ready and can still act — the documented limit (a real historical End Turn can't be reconstructed)", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "p1", "#fff", 0);
    room.addPlayer("p2", "p2", "#fff", 0);
    const roomFight: RoomFight = { id: "f1", anchorId: "p1", playerIds: ["p1", "p2"], enemyKeys: ["west-1"], startedAt: 0 };
    room.fights.set("f1", roomFight);

    const migrated = migratePersistedFight(legacyRow(), room)!;
    expect(migrated.players.find((p) => p.id === "p1")!.ready).toBe(false);
    const restored = new FightSession(room, roomFight, rng(9), migrated);
    const r = restored.applyAction("p1", 10, { type: "endTurn" }, 0, rng(2));
    expect(r.ok).toBe(true);
  });

  it("a new-format row (has version/hp/ready already) passes through unaffected by the legacy fallbacks", () => {
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "p1", "#fff", 0);
    const row = { ...legacyRow({ players: [{ id: "p1", hp: 9, block: 2, downed: false, fled: false, ready: true, piles: { draw: [], hand: [], discard: [], exhaust: [] }, handIds: [], energy: 1, lastSeq: 5 }] }), version: FIGHT_PERSIST_VERSION };
    const migrated = migratePersistedFight(row, room)!;
    expect(migrated.players[0]).toMatchObject({ hp: 9, block: 2, ready: true, energy: 1, lastSeq: 5 });
  });

  it("returns null (not a throw) for structurally broken data, so the caller can fall back to freeing the enemy instead of crashing or wiping the room", () => {
    const room = new CoopRoom("ABC123", 0);
    expect(migratePersistedFight(null, room)).toBeNull();
    expect(migratePersistedFight({}, room)).toBeNull();
    expect(migratePersistedFight({ roomFight: {}, turn: 1, units: [], players: [], pendingFlee: [] }, room)).toBeNull();
    expect(migratePersistedFight({ roomFight: { id: "f1", playerIds: [], enemyKeys: [] }, turn: "not a number", units: [], players: [], pendingFlee: [] }, room)).toBeNull();
  });
});
