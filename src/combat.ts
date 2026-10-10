// The rules of one fight, free of Kaplay and the DOM so tests and the balance
// simulator run exactly what the game runs. main.ts (solo) and
// server/coop/fight-session.ts (co-op) own animation/input/turn-readiness;
// every state change in a fight goes through these functions.
//
// Turn shape: startPlayerTurn (intents, including each attack's target, are
// decided and shown) -> players play cards (hitUnit) -> beginEnemyTurn +
// planEnemyTurn, whose events are played back one at a time with
// applyEnemyEvent -> next startPlayerTurn. Nothing here runs on a timer.
//
// One fight can hold several players (co-op) or one (solo, under a single
// conventional id). An attack's target is picked once, at startPlayerTurn,
// and shown before it resolves; if that target is already downed by an
// earlier event in the same enemy turn, the attack void's rather than
// retargeting (src/combat.test.ts; the brief: "an action already shown never
// retargets"). A downed or fled player stops acting and is never targeted
// again, but never blocks the rest of the party from continuing.
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
  intent: UnitIntent | null;
  /** at 0 HP during this fight; confirmed dead only when the fight ends */
  downed: boolean;
  downedOnTurn: number | null;
  revivedThisFight: boolean;
  /** a mage's one successful revive per fight has been spent */
  reviveUsed: boolean;
}

/** Same shape as world.ts's Intent, but an attack now names the player it's shown against. */
export type UnitIntent =
  | { kind: "attack"; value: number; ranged?: boolean; targetId: string }
  | { kind: "defend"; value: number }
  | { kind: "charge"; next: number }
  | { kind: "revive"; target: string; value: number };

export interface FightPlayer {
  id: string;
  hp: number;
  block: number;
  /** at 0 HP: stops acting and stops being targeted, but never blocks the rest of the party */
  downed: boolean;
  /** left after a round it was still present for (flee resolves the shown actions first) */
  fled: boolean;
}

export interface Fight {
  turn: number;
  units: CombatUnit[];
  players: FightPlayer[];
}

export function makeUnit(key: string, role: Role, group: string | null, hp?: number, phase = 0): CombatUnit {
  const maxHp = UNITS[role].maxHp;
  return {
    key, role, group, maxHp, hp: hp ?? maxHp, block: 0, phase, intent: null,
    downed: false, downedOnTurn: null, revivedThisFight: false, reviveUsed: false,
  };
}

/**
 * Clears per-fight state. Units come in alive (confirmed-dead enemies are
 * never in a fight); players come in at their persistent hp, block always
 * reset to 0 (a card's block never carries in from before the fight started).
 */
export function beginFight(units: CombatUnit[], players: FightPlayer[]): Fight {
  for (const u of units) {
    u.block = 0;
    u.intent = null;
    u.downed = false;
    u.downedOnTurn = null;
    u.revivedThisFight = false;
    u.reviveUsed = false;
  }
  for (const p of players) {
    p.block = 0;
    p.downed = p.hp <= 0;
    p.fled = false;
  }
  return { turn: 0, units, players };
}

export const standing = (f: Fight) => f.units.filter((u) => !u.downed);
export const isWon = (f: Fight) => standing(f).length === 0;
export const unitByKey = (f: Fight, key: string) => f.units.find((u) => u.key === key);
export const playerById = (f: Fight, id: string) => f.players.find((p) => p.id === id);
/** Still here and able to act or be targeted: not downed, hasn't left. */
export const activePlayers = (f: Fight) => f.players.filter((p) => !p.downed && !p.fled);
/** The whole party is down: nobody left to act. A fled player isn't a survivor either. */
export const isPartyWiped = (f: Fight) => activePlayers(f).length === 0;

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

/**
 * The player an un-aimed attack intent shows against: whoever is still
 * active with the least HP, ties broken by join order (f.players is fixed
 * for the fight, so this is deterministic and stable turn to turn). Drafted
 * for author confirmation in docs/adr/0005-coop-multiplayer.md.
 */
function pickAttackTarget(f: Fight): string | undefined {
  const alive = activePlayers(f);
  if (!alive.length) return undefined;
  return alive.reduce((lowest, p) => (p.hp < lowest.hp ? p : lowest)).id;
}

function resolveIntent(f: Fight, intent: Intent): UnitIntent {
  return intent.kind === "attack" ? { ...intent, targetId: pickAttackTarget(f) ?? f.players[0]?.id ?? "" } : intent;
}

/** Starts a player turn: decides and fixes every standing unit's intent (and each attack's target) for the coming enemy turn. */
export function startPlayerTurn(f: Fight) {
  f.turn++;
  for (const p of f.players) if (!p.downed && !p.fled) p.block = 0;
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
        u.intent = resolveIntent(f, def.pattern[0]);
      }
      continue;
    }
    u.intent = resolveIntent(f, def.pattern[u.phase % def.pattern.length]);
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

/** Marks a player downed, the way an enemy attack does. Exposed so a session layer never sets this field directly. */
export function downPlayer(f: Fight, id: string) {
  const p = playerById(f, id);
  if (p) {
    p.hp = 0;
    p.downed = true;
  }
}

/** A player leaves after the current round resolves (flee or a reconnect timeout), if they survived it. */
export function markFled(f: Fight, id: string) {
  const p = playerById(f, id);
  if (p && !p.downed) p.fled = true;
}

export type EnemyEvent =
  | { kind: "attack"; from: string; targetId: string; value: number; ranged: boolean; damageTaken: number; absorbed: number; hpAfter: number; blockAfter: number }
  | { kind: "attackVoid"; from: string; targetId: string } // the shown target already fell earlier this same resolve
  | { kind: "defend"; from: string; value: number }
  | { kind: "charge"; from: string; next: number }
  | { kind: "revive"; from: string; target: string; value: number }
  | { kind: "fizzle"; from: string; target: string };

/** A DEF block covered the player turn that just ended; it expires as the enemy turn begins. */
export function beginEnemyTurn(f: Fight) {
  for (const u of f.units) u.block = 0;
}

function clone(f: Fight): Fight {
  return { turn: f.turn, players: f.players.map((p) => ({ ...p })), units: f.units.map((u) => ({ ...u })) };
}

/**
 * The enemy turn, in roster order, as a list of events. Standing units act on
 * the intent shown during the player turn; downed ones do nothing. An attack
 * whose shown target already fell earlier this same resolve voids rather
 * than retargeting. A revive whose target is no longer down fizzles (it
 * never turns into something else). Stops only once the whole party is
 * down — one player falling never cuts the resolve short for the others.
 */
export function planEnemyTurn(f: Fight): { events: EnemyEvent[]; wiped: boolean } {
  const sim = clone(f);
  const events: EnemyEvent[] = [];
  for (const u of sim.units) {
    if (u.downed || !u.intent) continue;
    const it = u.intent;
    let ev: EnemyEvent;
    if (it.kind === "attack") {
      const target = playerById(sim, it.targetId);
      if (!target || target.downed) {
        ev = { kind: "attackVoid", from: u.key, targetId: it.targetId };
      } else {
        const absorbed = Math.min(target.block, it.value);
        const damageTaken = it.value - absorbed;
        ev = {
          kind: "attack", from: u.key, targetId: it.targetId, value: it.value, ranged: !!it.ranged, damageTaken, absorbed,
          hpAfter: Math.max(0, target.hp - damageTaken), blockAfter: target.block - absorbed,
        };
      }
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
    if (isPartyWiped(sim)) return { events, wiped: true };
  }
  return { events, wiped: false };
}

export function applyEnemyEvent(f: Fight, ev: EnemyEvent) {
  if (ev.kind === "attack") {
    const target = playerById(f, ev.targetId);
    if (target) {
      target.hp = ev.hpAfter;
      target.block = ev.blockAfter;
      if (target.hp <= 0) target.downed = true;
    }
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
  // charge, fizzle and attackVoid need no state change beyond having been planned/shown
}

/** Damage the standing units' shown attacks would deal to `playerId` before block. */
export function incomingDamage(f: Fight, playerId: string): number {
  return standing(f).reduce((s, u) => s + (u.intent?.kind === "attack" && u.intent.targetId === playerId ? u.intent.value : 0), 0);
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
