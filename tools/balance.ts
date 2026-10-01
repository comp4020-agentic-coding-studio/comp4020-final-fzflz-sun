// Balance simulator: plays the real combat rules (src/combat.ts, src/cards.ts)
// through every camp in map order with a simple greedy player, many times,
// and reports damage taken per fight and how often a whole run survives.
//   node tools/balance.ts [runs] [healRule]
// healRule: none | camp (full heal when a camp is cleared) | win:N (heal N per victory)
import { drawHand, drawOne, discardHand, endEncounterPiles, newPiles, settlePlayed, takeFromHand, type Piles, type Rng } from "../src/cards.ts";
import {
  applyEnemyEvent, beginEnemyTurn, beginFight, endFight, hitUnit, isWon, makeUnit, planEnemyTurn, standing, startPlayerTurn,
  type CombatUnit, type Fight,
} from "../src/combat.ts";
import { ENEMY_SPAWNS, PLAYER_MAX_HP, UNITS } from "../src/world.ts";

const RUNS = Number(process.argv[2] ?? 2000);
const HEAL = process.argv[3] ?? "none";

function rng(seed: number): Rng {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The encounters a careful player takes, in map order: scouts split, then each pack whole.
const FIGHTS: { name: string; camp: string; ids: string[] }[] = [
  { name: "west scout 1", camp: "west", ids: ["west-1"] },
  { name: "west scout 2", camp: "west", ids: ["west-2"] },
  { name: "south stray", camp: "south", ids: ["south-1"] },
  { name: "swarm x3", camp: "hollow", ids: ["swarm-1", "swarm-2", "swarm-3"] },
  { name: "north sentry", camp: "north", ids: ["north-3"] },
  { name: "mage + 2 grunts", camp: "north", ids: ["north-1", "north-2", "north-mage"] },
  { name: "captain + grunt + swarm", camp: "ridge", ids: ["ridge-1", "ridge-captain", "ridge-2"] },
  { name: "warlord + guard", camp: "lair", ids: ["lair-guard", "lair-guard-2", "lair-boss"] },
];

const value = (u: CombatUnit) => {
  const it = u.intent;
  const dmg = it?.kind === "attack" ? it.value : it?.kind === "revive" ? 6 : 0;
  return dmg + (u.role === "mage" ? 2 : 0);
};

/** Greedy turn: Focus first; kill what dies to a Strike (most dangerous first); Cleave a crowd; Guard a big hit; else Strike the most dangerous. */
function playTurn(f: Fight, piles: Piles, r: Rng, energy: number) {
  for (let guardDone = false; ;) {
    const st = standing(f);
    if (!st.length) return;
    const hand = piles.hand;
    const idx = (name: string) => hand.findIndex((c) => c.name === name);
    const incoming = st.reduce((s, u) => s + (u.intent?.kind === "attack" ? u.intent.value : 0), 0) - f.player.block;
    const play = (i: number, fn: () => void) => {
      const card = takeFromHand(piles, i)!;
      energy -= card.cost;
      fn();
      settlePlayed(piles, card);
    };
    if (idx("Focus") >= 0) {
      play(idx("Focus"), () => {
        energy += 1;
        drawOne(piles, r);
      });
      continue;
    }
    const strikeable = st.filter((u) => u.hp + u.block <= 6).sort((a, b) => value(b) - value(a));
    const cleaveKills = st.filter((u) => u.hp + u.block <= 3).length;
    if (idx("Cleave") >= 0 && energy >= 2 && (cleaveKills >= 2 || (st.length >= 3 && cleaveKills >= 1))) {
      play(idx("Cleave"), () => st.forEach((u) => hitUnit(f, u.key, 3)));
      continue;
    }
    if (idx("Strike") >= 0 && energy >= 1 && strikeable.length) {
      play(idx("Strike"), () => hitUnit(f, strikeable[0].key, 6));
      continue;
    }
    if (!guardDone && idx("Guard") >= 0 && energy >= 1 && incoming >= 6) {
      guardDone = true;
      play(idx("Guard"), () => (f.player.block += 5));
      continue;
    }
    if (idx("Strike") >= 0 && energy >= 1) {
      const t = st.slice().sort((a, b) => value(b) - value(a) || a.hp - b.hp)[0];
      play(idx("Strike"), () => hitUnit(f, t.key, 6));
      continue;
    }
    if (idx("Cleave") >= 0 && energy >= 2 && st.length >= 2) {
      play(idx("Cleave"), () => st.forEach((u) => hitUnit(f, u.key, 3)));
      continue;
    }
    if (idx("Guard") >= 0 && energy >= 1 && incoming > 0) {
      play(idx("Guard"), () => (f.player.block += 5));
      continue;
    }
    return;
  }
}

function runOnce(seed: number) {
  const r = rng(seed);
  const piles = newPiles(r);
  const player = { hp: PLAYER_MAX_HP, block: 0 };
  const phases: Record<string, number> = {};
  const taken: number[] = [];
  const turns: number[] = [];
  const camps = new Map<string, number>();
  for (const fd of FIGHTS) camps.set(fd.camp, (camps.get(fd.camp) ?? 0) + 1);
  for (const fd of FIGHTS) {
    const units = fd.ids.map((id) => {
      const s = ENEMY_SPAWNS.find((sp) => sp.id === id)!;
      return makeUnit(id, s.role, s.group, undefined, phases[id] ?? 0);
    });
    const f = beginFight(units, player);
    const before = player.hp;
    let t = 0;
    while (!isWon(f) && player.hp > 0 && t < 40) {
      t++;
      startPlayerTurn(f);
      const reviving = f.units.filter((u) => u.intent?.kind === "revive");
      const heavy = f.units.filter((u) => u.intent?.kind === "attack" && u.intent.value >= 10);
      tally.reviveShown += reviving.length;
      tally.heavyShown += heavy.length;
      drawHand(piles, 4, r);
      playTurn(f, piles, r, 3);
      tally.reviveCancelled += reviving.filter((u) => u.downed).length;
      if (heavy.some((u) => !u.downed) && f.player.block > 0) tally.guardOnHeavy++;
      if (isWon(f)) break;
      discardHand(piles);
      beginEnemyTurn(f);
      const plan = planEnemyTurn(f);
      for (const ev of plan.events) {
        applyEnemyEvent(f, ev);
        if (ev.kind === "revive") tally.reviveDone++;
        if (ev.kind === "attack" && ev.value >= 10) tally.heavyLanded++;
      }
      player.block = 0;
    }
    endFight(f);
    endEncounterPiles(piles);
    for (const u of units) phases[u.key] = u.phase;
    taken.push(before - player.hp);
    turns.push(t);
    if (player.hp <= 0) return { won: false, diedAt: fd.name, taken, turns };
    camps.set(fd.camp, camps.get(fd.camp)! - 1);
    if (HEAL === "camp" && camps.get(fd.camp) === 0) player.hp = PLAYER_MAX_HP;
    if (HEAL.startsWith("win:")) player.hp = Math.min(PLAYER_MAX_HP, player.hp + Number(HEAL.slice(4)));
  }
  return { won: true, diedAt: null, taken, turns, hpLeft: player.hp };
}

const tally = { reviveShown: 0, reviveDone: 0, reviveCancelled: 0, heavyLanded: 0, heavyShown: 0, guardOnHeavy: 0 };
const results = Array.from({ length: RUNS }, (_, i) => runOnce(i + 1));
const pct = (n: number) => `${((100 * n) / RUNS).toFixed(1)}%`;
console.log(`runs ${RUNS}, heal rule "${HEAL}", player ${PLAYER_MAX_HP} HP, 3 energy, 14-card deck`);
console.log(`whole run survived: ${pct(results.filter((r) => r.won).length)}`);
const deaths = new Map<string, number>();
for (const r of results) if (r.diedAt) deaths.set(r.diedAt, (deaths.get(r.diedAt) ?? 0) + 1);
if (deaths.size) console.log("died at:", [...deaths].map(([k, v]) => `${k} ${pct(v)}`).join(", "));
console.log("\nfight                          avg dmg  p90 dmg  max   avg turns   (over runs that reached it)");
FIGHTS.forEach((fd, i) => {
  const xs = results.filter((r) => r.taken.length > i).map((r) => r.taken[i]).sort((a, b) => a - b);
  const ts = results.filter((r) => r.turns.length > i).map((r) => r.turns[i]);
  if (!xs.length) return;
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(
    `${fd.name.padEnd(30)} ${avg.toFixed(1).padStart(7)} ${String(xs[Math.floor(xs.length * 0.9)]).padStart(8)} ${String(xs.at(-1)).padStart(5)} ${(ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(1).padStart(10)}`,
  );
});
console.log(`\nper run: revive shown ${(tally.reviveShown / RUNS).toFixed(2)}, done ${(tally.reviveDone / RUNS).toFixed(2)}, cancelled by killing the mage ${(tally.reviveCancelled / RUNS).toFixed(2)}`);
console.log(`per run: heavy hits (10+) shown ${(tally.heavyShown / RUNS).toFixed(2)}, landed ${(tally.heavyLanded / RUNS).toFixed(2)}, turns the player guarded one ${(tally.guardOnHeavy / RUNS).toFixed(2)}`);
void UNITS;
