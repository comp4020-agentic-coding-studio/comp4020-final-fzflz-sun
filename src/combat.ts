// The rules of one fight, free of Kaplay and the DOM so tests and the balance
// simulator run exactly what the game runs. main.ts owns animation and input;
// every state change in a fight goes through these functions.
//
// Turn shape: startPlayerTurn (intents are decided and shown) -> the player
// plays cards (hitUnit) -> beginEnemyTurn + planEnemyTurn, whose events main
// plays back one at a time with applyEnemyEvent -> next startPlayerTurn.
// Nothing here runs on a timer.
import { REVIVABLE, UNITS, type Intent, type Role } from "./world.ts";

export interface CombatUnit {
  /** stable spawn id for map enemies, a runtime key for dev-only extras */
  key: string;
  role: Role;
  /** pack/skirmish group; a mage only revives members of its own group */
  group: string | null;
  maxHp: number;
  hp: number;
  block: number;
  /** position in the unit's action cycle; persists across fights and saves */
  phase: number;
  intent: Intent | null;
  /** at 0 HP during this fight; confirmed dead only when the fight ends */
  downed: boolean;
  downedOnTurn: number | null;
  revivedThisFight: boolean;
  /** a mage's one successful revive per fight has been spent */
  reviveUsed: boolean;
}

export interface Fight {
  turn: number;
  units: CombatUnit[];
  player: { hp: number; block: number };
}

export function makeUnit(key: string, role: Role, group: string | null, hp?: number, phase = 0): CombatUnit {
  const maxHp = UNITS[role].maxHp;
  return {
    key, role, group, maxHp, hp: hp ?? maxHp, block: 0, phase, intent: null,
    downed: false, downedOnTurn: null, revivedThisFight: false, reviveUsed: false,
  };
}

/** Clears per-fight state. Units come in alive (confirmed-dead enemies are never in a fight). */
export function beginFight(units: CombatUnit[], player: { hp: number; block: number }): Fight {
  for (const u of units) {
    u.block = 0;
    u.intent = null;
    u.downed = false;
    u.downedOnTurn = null;
    u.revivedThisFight = false;
    u.reviveUsed = false;
  }
  return { turn: 0, units, player };
}

export const standing = (f: Fight) => f.units.filter((u) => !u.downed);
export const isWon = (f: Fight) => standing(f).length === 0;
export const unitByKey = (f: Fight, key: string) => f.units.find((u) => u.key === key);

/** Members a mage could bring back right now (fallen before this player turn began). */
export function reviveCandidates(f: Fight, mage: CombatUnit): CombatUnit[] {
  return f.units.filter(
    (t) =>
      t.downed &&
      t.group !== null &&
      t.group === mage.group &&
      REVIVABLE.includes(t.role) &&
      !t.revivedThisFight &&
      t.downedOnTurn !== null &&
      t.downedOnTurn < f.turn,
  );
}

/** Starts a player turn: decides and fixes every standing unit's intent for the coming enemy turn. */
export function startPlayerTurn(f: Fight) {
  f.turn++;
  const claimed = new Set<string>();
  for (const u of f.units) {
    if (u.downed) {
      u.intent = null;
      continue;
    }
    const def = UNITS[u.role];
    if (u.role === "mage") {
      const target = u.reviveUsed ? undefined : reviveCandidates(f, u).find((t) => !claimed.has(t.key));
      if (target) {
        claimed.add(target.key);
        u.intent = { kind: "revive", target: target.key, value: Math.ceil(target.maxHp / 2) };
      } else {
        u.intent = def.pattern[0];
      }
      continue;
    }
    u.intent = def.pattern[u.phase % def.pattern.length];
    u.phase = (u.phase + 1) % def.pattern.length;
  }
}

export interface HitResult {
  dealt: number;
  absorbed: number;
  downed: boolean;
}

/** Player damage to one unit. A unit at 0 HP is downed (keeps its slot), not removed. */
export function hitUnit(f: Fight, key: string, amount: number): HitResult {
  const u = unitByKey(f, key);
  if (!u || u.downed) return { dealt: 0, absorbed: 0, downed: false };
  const absorbed = Math.min(u.block, amount);
  u.block -= absorbed;
  const dealt = Math.min(u.hp, amount - absorbed);
  u.hp -= dealt;
  if (u.hp <= 0) {
    u.hp = 0;
    u.downed = true;
    u.downedOnTurn = f.turn;
    u.intent = null; // a downed unit does nothing, including a revive it had planned
  }
  return { dealt, absorbed, downed: u.downed };
}

export type EnemyEvent =
  | { kind: "attack"; from: string; value: number; ranged: boolean; damageTaken: number; absorbed: number; hpAfter: number; blockAfter: number }
  | { kind: "defend"; from: string; value: number }
  | { kind: "charge"; from: string; next: number }
  | { kind: "revive"; from: string; target: string; value: number }
  | { kind: "fizzle"; from: string; target: string };

/** A DEF block covered the player turn that just ended; it expires as the enemy turn begins. */
export function beginEnemyTurn(f: Fight) {
  for (const u of f.units) u.block = 0;
}

function clone(f: Fight): Fight {
  return { turn: f.turn, player: { ...f.player }, units: f.units.map((u) => ({ ...u })) };
}

/**
 * The enemy turn, in roster order, as a list of events. Standing units act on
 * the intent shown during the player's turn; downed ones do nothing. A revive
 * whose target is no longer down fizzles (it never turns into something
 * else), and a unit revived this turn has no intent, so it waits until the
 * next one. Stops at the action that kills the player.
 */
export function planEnemyTurn(f: Fight): { events: EnemyEvent[]; died: boolean } {
  const sim = clone(f);
  const events: EnemyEvent[] = [];
  for (const u of sim.units) {
    if (u.downed || !u.intent) continue;
    const it = u.intent;
    let ev: EnemyEvent;
    if (it.kind === "attack") {
      const absorbed = Math.min(sim.player.block, it.value);
      const damageTaken = it.value - absorbed;
      ev = {
        kind: "attack", from: u.key, value: it.value, ranged: !!it.ranged, damageTaken, absorbed,
        hpAfter: Math.max(0, sim.player.hp - damageTaken), blockAfter: sim.player.block - absorbed,
      };
    } else if (it.kind === "defend") {
      ev = { kind: "defend", from: u.key, value: it.value };
    } else if (it.kind === "charge") {
      ev = { kind: "charge", from: u.key, next: it.next };
    } else {
      const t = unitByKey(sim, it.target);
      ev = t && t.downed ? { kind: "revive", from: u.key, target: it.target, value: it.value } : { kind: "fizzle", from: u.key, target: it.target };
    }
    applyEnemyEvent(sim, ev);
    events.push(ev);
    if (sim.player.hp <= 0) return { events, died: true };
  }
  return { events, died: false };
}

export function applyEnemyEvent(f: Fight, ev: EnemyEvent) {
  if (ev.kind === "attack") {
    f.player.hp = ev.hpAfter;
    f.player.block = ev.blockAfter;
  } else if (ev.kind === "defend") {
    const u = unitByKey(f, ev.from);
    if (u) u.block += ev.value;
  } else if (ev.kind === "revive") {
    const t = unitByKey(f, ev.target);
    const mage = unitByKey(f, ev.from);
    if (t && t.downed) {
      t.hp = ev.value;
      t.downed = false;
      t.downedOnTurn = null;
      t.revivedThisFight = true;
      t.intent = null;
    }
    if (mage) mage.reviveUsed = true;
  }
}

/** Damage the standing units' shown attacks would deal before block. */
export function incomingDamage(f: Fight): number {
  return standing(f).reduce((s, u) => s + (u.intent?.kind === "attack" ? u.intent.value : 0), 0);
}

/** Ends the fight: whoever is still down is confirmed dead (once, by key). */
export function endFight(f: Fight): { dead: string[] } {
  return { dead: f.units.filter((u) => u.downed).map((u) => u.key) };
}

/** Fight weight for camera framing: count, tier and support all push towards "dangerous". */
export function fightThreat(roles: Role[]): number {
  return roles.reduce((s, r) => s + UNITS[r].threat, 0);
}
export const DANGER_THRESHOLD = 3;
