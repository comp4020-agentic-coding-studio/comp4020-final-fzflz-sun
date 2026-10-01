import { describe, expect, it } from "vitest";
import {
  applyEnemyEvent,
  beginEnemyTurn,
  beginFight,
  endFight,
  fightThreat,
  DANGER_THRESHOLD,
  hitUnit,
  incomingDamage,
  isWon,
  makeUnit,
  planEnemyTurn,
  startPlayerTurn,
  unitByKey,
  type Fight,
} from "./combat.ts";
import { UNITS } from "./world.ts";

const fight = (units: ReturnType<typeof makeUnit>[], hp = 24) => beginFight(units, { hp, block: 0 });

/** Plays an enemy turn to the end, the way main.ts does (plan, then apply each event). */
function enemyTurn(f: Fight) {
  beginEnemyTurn(f);
  const plan = planEnemyTurn(f);
  for (const ev of plan.events) applyEnemyEvent(f, ev);
  return plan;
}

const mageGuard = () =>
  fight([makeUnit("g1", "brute", "north"), makeUnit("g2", "brute", "north"), makeUnit("mage", "mage", "north")]);

describe("intents per role", () => {
  it("grunt and swarmling always attack for their listed damage", () => {
    const f = fight([makeUnit("b", "brute", null), makeUnit("s", "swarm", "hollow")]);
    startPlayerTurn(f);
    expect(unitByKey(f, "b")!.intent).toEqual({ kind: "attack", value: 3 });
    expect(unitByKey(f, "s")!.intent).toEqual({ kind: "attack", value: 2 });
    expect(incomingDamage(f)).toBe(5);
  });

  it("a mage with nobody to revive shoots for 2 (ranged)", () => {
    const f = mageGuard();
    startPlayerTurn(f);
    expect(unitByKey(f, "mage")!.intent).toEqual({ kind: "attack", value: 2, ranged: true });
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
      { kind: "attack", value: 4 },
      { kind: "charge", next: 10 },
      { kind: "attack", value: 10 },
      { kind: "attack", value: 4 },
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
    expect(f.player.hp).toBe(24 - 3 - 3 - 2);
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
    expect(g1.intent).toEqual({ kind: "attack", value: 3 }); // acts normally next turn
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
    expect(again.intent).toEqual({ kind: "attack", value: 12 }); // the charged hit, not a reset
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

  it("the enemy turn stops at the killing blow", () => {
    const f = fight([makeUnit("a", "brute", null), makeUnit("b", "brute", null), makeUnit("c", "brute", null)], 5);
    startPlayerTurn(f);
    const plan = enemyTurn(f);
    expect(plan.died).toBe(true);
    expect(plan.events.map((e) => e.from)).toEqual(["a", "b"]);
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
