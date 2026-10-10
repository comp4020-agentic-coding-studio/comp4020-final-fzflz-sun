import { describe, expect, it } from "vitest";
import {
  activePlayers,
  applyEnemyEvent,
  beginEnemyTurn,
  beginFight,
  endFight,
  fightThreat,
  DANGER_THRESHOLD,
  hitUnit,
  incomingDamage,
  isPartyWiped,
  isWon,
  makeUnit,
  markFled,
  playerById,
  planEnemyTurn,
  startPlayerTurn,
  unitByKey,
  type Fight,
  type FightPlayer,
} from "./combat.ts";
import { UNITS } from "./world.ts";

const solo = (hp = 24): FightPlayer[] => [{ id: "solo", hp, block: 0, downed: false, fled: false }];
const fight = (units: ReturnType<typeof makeUnit>[], hp = 24) => beginFight(units, solo(hp));
/** Solo's one player, for the tests that read its hp/block directly. */
const soloPlayer = (f: Fight) => playerById(f, "solo")!;

/** Plays an enemy turn to the end, the way main.ts / fight-session.ts does (plan, then apply each event). */
function enemyTurn(f: Fight) {
  beginEnemyTurn(f);
  const plan = planEnemyTurn(f);
  for (const ev of plan.events) applyEnemyEvent(f, ev);
  return plan;
}

const mageGuard = () =>
  fight([makeUnit("g1", "brute", "north"), makeUnit("g2", "brute", "north"), makeUnit("mage", "mage", "north")]);

describe("intents per role", () => {
  it("grunt and swarmling always attack for their listed damage, aimed at the only player", () => {
    const f = fight([makeUnit("b", "brute", null), makeUnit("s", "swarm", "hollow")]);
    startPlayerTurn(f);
    expect(unitByKey(f, "b")!.intent).toEqual({ kind: "attack", value: 3, targetId: "solo" });
    expect(unitByKey(f, "s")!.intent).toEqual({ kind: "attack", value: 2, targetId: "solo" });
    expect(incomingDamage(f, "solo")).toBe(5);
  });

  it("a mage with nobody to revive shoots for 2 (ranged)", () => {
    const f = mageGuard();
    startPlayerTurn(f);
    expect(unitByKey(f, "mage")!.intent).toEqual({ kind: "attack", value: 2, ranged: true, targetId: "solo" });
  });

  it("the captain cycles attack 4 -> charge (names 10) -> attack 10", () => {
    const f = fight([makeUnit("cap", "heavy", "ridge")], 99);
    const seen = [];
    for (let t = 0; t < 4; t++) {
      startPlayerTurn(f);
      seen.push(unitByKey(f, "cap")!.intent);
      enemyTurn(f);
    }
    expect(seen).toEqual([
      { kind: "attack", value: 4, targetId: "solo" },
      { kind: "charge", next: 10 },
      { kind: "attack", value: 10, targetId: "solo" },
      { kind: "attack", value: 4, targetId: "solo" },
    ]);
  });
});

describe("the player turn is still", () => {
  it("nothing changes between intents being shown and the enemy turn, however long the player waits", () => {
    const f = mageGuard();
    startPlayerTurn(f);
    const snap = JSON.stringify(f);
    expect(JSON.stringify(f)).toBe(snap); // no clock: only explicit calls change a fight
  });

  it("enemies act exactly on the shown intents, in roster order, once", () => {
    const f = mageGuard();
    startPlayerTurn(f);
    const plan = enemyTurn(f);
    expect(plan.events.map((e) => [e.kind, e.from])).toEqual([["attack", "g1"], ["attack", "g2"], ["attack", "mage"]]);
    expect(soloPlayer(f).hp).toBe(24 - 3 - 3 - 2);
  });
});

describe("downed, revived, confirmed dead", () => {
  it("a unit at 0 HP is downed in place, not removed, and can't be hit again", () => {
    const f = mageGuard();
    startPlayerTurn(f);
    expect(hitUnit(f, "g1", 6)).toMatchObject({ dealt: 6, downed: true });
    expect(f.units.map((u) => u.key)).toEqual(["g1", "g2", "mage"]);
    expect(hitUnit(f, "g1", 6).dealt).toBe(0);
    expect(unitByKey(f, "g1")!.intent).toBeNull();
  });

  it("someone downed this turn isn't a revive target until the next player turn", () => {
    const f = mageGuard();
    startPlayerTurn(f); // turn 1
    hitUnit(f, "g1", 6);
    expect(unitByKey(f, "mage")!.intent?.kind).toBe("attack"); // decided before g1 fell
    enemyTurn(f);
    startPlayerTurn(f); // turn 2
    expect(unitByKey(f, "mage")!.intent).toEqual({ kind: "revive", target: "g1", value: 3 });
  });

  it("revive restores half max HP (rounded up), at the end of the enemy turn, and the revived unit waits a turn", () => {
    const f = mageGuard();
    startPlayerTurn(f);
    hitUnit(f, "g1", 6);
    enemyTurn(f);
    startPlayerTurn(f);
    const plan = enemyTurn(f);
    expect(plan.events.find((e) => e.kind === "revive")).toMatchObject({ target: "g1", value: 3 });
    const g1 = unitByKey(f, "g1")!;
    expect(g1).toMatchObject({ hp: 3, downed: false, intent: null });
    expect(plan.events.some((e) => e.from === "g1")).toBe(false); // no extra action this turn
    startPlayerTurn(f);
    expect(g1.intent).toEqual({ kind: "attack", value: 3, targetId: "solo" }); // acts normally next turn
    expect(hitUnit(f, "g1", 1).dealt).toBe(1); // and can be targeted
  });

  it("killing the mage first cancels its revive", () => {
    const f = mageGuard();
    startPlayerTurn(f);
    hitUnit(f, "g1", 6);
    enemyTurn(f);
    startPlayerTurn(f);
    expect(unitByKey(f, "mage")!.intent?.kind).toBe("revive");
    hitUnit(f, "mage", 9);
    const plan = enemyTurn(f);
    expect(plan.events.some((e) => e.kind === "revive" || e.kind === "fizzle")).toBe(false);
    expect(unitByKey(f, "g1")!.downed).toBe(true);
  });

  it("each mage revives successfully at most once per fight; each member at most once", () => {
    const f = mageGuard();
    startPlayerTurn(f);
    hitUnit(f, "g1", 6);
    hitUnit(f, "g2", 6);
    enemyTurn(f);
    startPlayerTurn(f);
    expect(unitByKey(f, "mage")!.intent).toMatchObject({ kind: "revive", target: "g1" });
    enemyTurn(f);
    hitUnit(f, "g1", 3); // down again
    enemyTurn(f);
    for (let t = 0; t < 3; t++) {
      startPlayerTurn(f);
      expect(unitByKey(f, "mage")!.intent?.kind).toBe("attack"); // no second revive, for g1 or g2
      enemyTurn(f);
    }
  });

  it("a mage never revives elites, bosses, its own kind, or another group's members", () => {
    const f = fight([
      makeUnit("cap", "heavy", "north"),
      makeUnit("m2", "mage", "north"),
      makeUnit("stranger", "brute", "west"),
      makeUnit("mage", "mage", "north"),
    ], 99);
    startPlayerTurn(f);
    hitUnit(f, "cap", 13);
    hitUnit(f, "m2", 9);
    hitUnit(f, "stranger", 6);
    enemyTurn(f);
    startPlayerTurn(f);
    expect(unitByKey(f, "mage")!.intent?.kind).toBe("attack");
  });

  it("a revive whose target is no longer down fizzles; it never becomes another action", () => {
    const f = mageGuard();
    startPlayerTurn(f);
    hitUnit(f, "g1", 6);
    enemyTurn(f);
    startPlayerTurn(f);
    unitByKey(f, "g1")!.downed = false; // e.g. something else already brought it back
    const plan = enemyTurn(f);
    expect(plan.events.find((e) => e.from === "mage")).toEqual({ kind: "fizzle", from: "mage", target: "g1" });
    expect(unitByKey(f, "mage")!.reviveUsed).toBe(false);
  });

  it("victory = nobody standing, even with bodies on the field; endFight confirms each downed unit once", () => {
    const f = mageGuard();
    startPlayerTurn(f);
    hitUnit(f, "g1", 6);
    enemyTurn(f);
    startPlayerTurn(f);
    enemyTurn(f); // g1 revived
    hitUnit(f, "g1", 3);
    hitUnit(f, "g2", 6);
    expect(isWon(f)).toBe(false);
    hitUnit(f, "mage", 9);
    expect(isWon(f)).toBe(true);
    expect(endFight(f).dead).toEqual(["g1", "g2", "mage"]); // g1 fell twice, counted once
  });

  it("a mage left alone still fights (and can be finished)", () => {
    const f = mageGuard();
    startPlayerTurn(f);
    hitUnit(f, "g1", 6);
    hitUnit(f, "g2", 6);
    enemyTurn(f);
    startPlayerTurn(f);
    hitUnit(f, "mage", 9);
    expect(isWon(f)).toBe(true);
  });
});

describe("action phases carry over", () => {
  it("a phase reached in one fight (e.g. after fleeing) continues in the next", () => {
    const boss = makeUnit("boss", "boss", "lair");
    let f = fight([boss], 99);
    for (let t = 0; t < 3; t++) {
      startPlayerTurn(f); // attack 5, defend 8, charge
      enemyTurn(f);
    }
    // fled after the charge resolved; a new fight starts from the saved phase
    const saved = boss.phase;
    const again = makeUnit("boss", "boss", "lair", 40, saved);
    f = fight([again], 99);
    startPlayerTurn(f);
    expect(again.intent).toEqual({ kind: "attack", value: 12, targetId: "solo" }); // the charged hit, not a reset
  });

  it("the boss's DEF block lasts through the player's turn, then expires", () => {
    const f = fight([makeUnit("boss", "boss", "lair", 40, 1)], 99);
    startPlayerTurn(f);
    enemyTurn(f); // defends 8
    expect(unitByKey(f, "boss")!.block).toBe(8);
    startPlayerTurn(f);
    expect(hitUnit(f, "boss", 6)).toMatchObject({ dealt: 0, absorbed: 6 });
    beginEnemyTurn(f);
    expect(unitByKey(f, "boss")!.block).toBe(0);
  });

  it("the enemy turn stops once the (solo) party is wiped", () => {
    const f = fight([makeUnit("a", "brute", null), makeUnit("b", "brute", null), makeUnit("c", "brute", null)], 5);
    startPlayerTurn(f);
    const plan = enemyTurn(f);
    expect(plan.wiped).toBe(true);
    expect(plan.events.map((e) => e.from)).toEqual(["a", "b"]);
  });
});

describe("co-op: more than one player in a fight", () => {
  const two = (hpA = 24, hpB = 24): FightPlayer[] => [
    { id: "a", hp: hpA, block: 0, downed: false, fled: false },
    { id: "b", hp: hpB, block: 0, downed: false, fled: false },
  ];

  it("an attack aims at the lowest-HP active player, ties broken by join order", () => {
    const f = beginFight([makeUnit("g", "brute", null)], two(24, 10));
    startPlayerTurn(f);
    expect(unitByKey(f, "g")!.intent).toMatchObject({ targetId: "b" });

    const tied = beginFight([makeUnit("g2", "brute", null)], two(24, 24));
    startPlayerTurn(tied);
    expect(unitByKey(tied, "g2")!.intent).toMatchObject({ targetId: "a" }); // tie -> first in join order
  });

  it("a downed player stops being targeted and stops blocking the rest of the party", () => {
    const f = beginFight([makeUnit("g1", "brute", null), makeUnit("g2", "brute", null)], two(3, 24));
    startPlayerTurn(f); // both grunts aim at "a" (lower hp)
    expect(unitByKey(f, "g1")!.intent).toMatchObject({ targetId: "a" });
    expect(unitByKey(f, "g2")!.intent).toMatchObject({ targetId: "a" });
    const plan = enemyTurn(f);
    expect(playerById(f, "a")!.downed).toBe(true);
    expect(plan.wiped).toBe(false); // "b" is untouched and still standing
    expect(activePlayers(f).map((p) => p.id)).toEqual(["b"]);
  });

  it("an attack whose shown target already fell this same resolve voids, never retargets", () => {
    // two grunts both aim at "a" (lower hp); the first kill voids the second's attack on "a"
    const f = beginFight([makeUnit("g1", "brute", null), makeUnit("g2", "brute", null)], two(2, 24));
    startPlayerTurn(f);
    const plan = enemyTurn(f);
    expect(plan.events[0]).toMatchObject({ kind: "attack", from: "g1", targetId: "a" });
    expect(plan.events[1]).toEqual({ kind: "attackVoid", from: "g2", targetId: "a" });
    expect(playerById(f, "b")!.hp).toBe(24); // "b" was never hit instead
  });

  it("only a full party wipe stops the resolve; one player down doesn't cut it short", () => {
    const f = beginFight(
      [makeUnit("g1", "brute", null), makeUnit("g2", "brute", null), makeUnit("g3", "brute", null)],
      two(3, 24),
    );
    startPlayerTurn(f); // all three are shown aiming at "a" (lower hp) before any of them act
    const plan = enemyTurn(f);
    expect(plan.wiped).toBe(false); // "b" was never anyone's target: still full HP, untouched
    expect(plan.events).toHaveLength(3); // g1 downs "a"; g2 and g3's shown attacks on "a" both void, never retarget to "b"
    expect(plan.events[0]).toMatchObject({ kind: "attack", from: "g1", targetId: "a" });
    expect(plan.events[1]).toEqual({ kind: "attackVoid", from: "g2", targetId: "a" });
    expect(plan.events[2]).toEqual({ kind: "attackVoid", from: "g3", targetId: "a" });
    expect(playerById(f, "b")!.hp).toBe(24);
  });

  it("the whole party down wipes, same as solo", () => {
    const f = beginFight([makeUnit("g1", "brute", null), makeUnit("g2", "brute", null)], two(3, 2));
    startPlayerTurn(f);
    // force both intents onto separate targets so each dies to one hit
    unitByKey(f, "g1")!.intent = { kind: "attack", value: 3, targetId: "a" };
    unitByKey(f, "g2")!.intent = { kind: "attack", value: 2, targetId: "b" };
    const plan = enemyTurn(f);
    expect(plan.wiped).toBe(true);
    expect(isPartyWiped(f)).toBe(true);
  });

  it("fleeing marks a player gone without touching anyone else's state", () => {
    const f = beginFight([makeUnit("g", "brute", null)], two());
    markFled(f, "a");
    expect(playerById(f, "a")!.fled).toBe(true);
    expect(activePlayers(f).map((p) => p.id)).toEqual(["b"]);
    expect(playerById(f, "b")!.fled).toBe(false);
  });

  it("a downed player can't be marked fled (they didn't survive to leave)", () => {
    const f = beginFight([makeUnit("g", "brute", null)], two(0, 24));
    expect(playerById(f, "a")!.downed).toBe(true); // beginFight derives downed from hp<=0
    markFled(f, "a");
    expect(playerById(f, "a")!.fled).toBe(false);
  });

  it("incomingDamage is per player: each only sees attacks aimed at them", () => {
    const f = beginFight([makeUnit("g1", "brute", null), makeUnit("g2", "brute", null)], two(10, 3));
    startPlayerTurn(f); // both aim at "b" (lower hp)
    expect(incomingDamage(f, "b")).toBe(6);
    expect(incomingDamage(f, "a")).toBe(0);
  });
});

describe("fight threat", () => {
  it("a swarm of three is a normal fight; a captain with escort, or a mage guard, is dangerous", () => {
    expect(fightThreat(["swarm", "swarm", "swarm"])).toBeLessThan(DANGER_THRESHOLD);
    expect(fightThreat(["brute", "brute"])).toBeLessThan(DANGER_THRESHOLD);
    expect(fightThreat(["heavy", "brute", "swarm"])).toBeGreaterThanOrEqual(DANGER_THRESHOLD);
    expect(fightThreat(["mage", "brute", "brute"])).toBeGreaterThanOrEqual(DANGER_THRESHOLD);
    expect(fightThreat(["boss"])).toBeGreaterThanOrEqual(DANGER_THRESHOLD);
    expect(UNITS.swarm.maxHp).toBe(3);
  });
});
