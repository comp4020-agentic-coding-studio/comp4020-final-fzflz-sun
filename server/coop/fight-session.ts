// One co-op fight's authoritative turn-based combat: per-player hands and
// energy, a common player phase (nobody's cards resolve until everyone
// still fighting has readied up), then one enemy turn, same rules as
// src/combat.ts runs for single-player. The server is the only thing that
// ever mutates this; main.ts/coop-main.ts only animate what it decides.
//
// Card instances: src/cards.ts has no per-card identity (two Strikes in a
// hand are literally the same object) because single-player never needs
// one — it plays by index, synchronously, with no network latency to
// reorder things. Over a network a card's index can go stale between a
// client's click and the server receiving it, so every dealt card gets a
// server-generated id here, kept in lockstep with Piles.hand by this file
// alone; src/cards.ts itself is untouched.
import {
  applyEnemyEvent,
  beginEnemyTurn,
  beginFight,
  endFight,
  hitUnit,
  isPartyWiped,
  isWon,
  makeUnit,
  markFled,
  planEnemyTurn,
  playerById,
  standing,
  startPlayerTurn,
  unitByKey,
  type CombatUnit,
  type Fight,
  type FightPlayer,
} from "../../src/combat.ts";
import type { CoopCardView, CoopFightEnemyView, CoopFightMsg, CoopFightPlayerView, CoopHandMsg, CoopIntentView } from "../../src/coop-protocol.ts";
import { drawHand, drawOne, discardHand, newPiles, settlePlayed, takeFromHand, type CardDef, type Piles, HAND_SIZE } from "../../src/cards.ts";
import { settleAfterFlee } from "../../src/roam.ts";
import { PLAYER_MAX_ENERGY, WORLD_HEIGHT, WORLD_WIDTH } from "../../src/world.ts";
import type { CoopRoom, RoomEnemy, RoomFight } from "./room.ts";

export type FightOutcome = "won" | "wiped" | "abandoned";

export type FightAction =
  | { type: "playCard"; cardInstanceId: string; targetKey?: string }
  | { type: "endTurn" }
  | { type: "flee" };

export interface ActionResult {
  ok: boolean;
  error?: string;
}

interface PlayerFightState {
  id: string;
  piles: Piles;
  /** parallel to piles.hand: handIds[i] is the stable id of piles.hand[i] */
  handIds: string[];
  energy: number;
  lastSeq: number;
}

let cardIdN = 1;
const newCardId = () => `card${cardIdN++}`;

/** A live view of one RoomPlayer, shaped like combat.ts's FightPlayer (no `id` collision risk here: this is a plain server object, not a Kaplay entity). */
function fightPlayerAdapter(rp: { id: string; hp: number; block: number }): FightPlayer {
  return {
    id: rp.id,
    get hp() {
      return rp.hp;
    },
    set hp(v: number) {
      rp.hp = v;
    },
    get block() {
      return rp.block;
    },
    set block(v: number) {
      rp.block = v;
    },
    downed: false,
    fled: false,
  };
}

function cardView(id: string, c: CardDef): CoopCardView {
  return { id, name: c.name, kind: c.kind, cost: c.cost, value: c.value, blurb: c.blurb };
}

function intentView(u: CombatUnit): CoopIntentView {
  return (u.intent as CoopIntentView) ?? null;
}

export class FightSession {
  readonly id: string;
  readonly room: CoopRoom;
  readonly fight: Fight;
  /** everyone who was ever in this fight, for notifying people after it ends (playerIds shrinks as they leave). */
  readonly initialPlayerIds: string[];
  private enemyByKey = new Map<string, RoomEnemy>();
  private playerStates = new Map<string, PlayerFightState>();
  private pendingFlee = new Set<string>();
  ended: FightOutcome | null = null;

  constructor(room: CoopRoom, roomFight: RoomFight, rng: () => number) {
    this.room = room;
    this.id = roomFight.id;
    this.initialPlayerIds = [...roomFight.playerIds];

    const units: CombatUnit[] = [];
    for (const key of roomFight.enemyKeys) {
      const e = room.enemies.find((x) => x.key === key)!;
      this.enemyByKey.set(key, e);
      units.push(makeUnit(e.key, e.role, e.group, e.hp, e.phase));
    }
    const players: FightPlayer[] = roomFight.playerIds.map((pid) => fightPlayerAdapter(room.players.get(pid)!));
    this.fight = beginFight(units, players);

    for (const pid of roomFight.playerIds) {
      this.playerStates.set(pid, { id: pid, piles: newPiles(rng), handIds: [], energy: PLAYER_MAX_ENERGY, lastSeq: 0 });
      const rp = room.players.get(pid)!;
      rp.block = 0;
      rp.ready = false;
    }
    this.startRound(rng);
  }

  /** Every player id this fight still has a seat for (present, however they're doing). */
  get playerIds(): string[] {
    return [...this.playerStates.keys()];
  }

  isMember(playerId: string): boolean {
    return this.playerStates.has(playerId);
  }

  private startRound(rng: () => number) {
    startPlayerTurn(this.fight);
    for (const [pid, ps] of this.playerStates) {
      const p = playerById(this.fight, pid)!;
      const rp = this.room.players.get(pid)!;
      rp.ready = false;
      if (p.downed || p.fled) continue;
      drawHand(ps.piles, HAND_SIZE, rng);
      ps.handIds = ps.piles.hand.map(() => newCardId());
      ps.energy = PLAYER_MAX_ENERGY;
    }
  }

  private allActiveReady(): boolean {
    for (const pid of this.playerStates.keys()) {
      const p = playerById(this.fight, pid)!;
      if (p.downed || p.fled) continue;
      if (!this.room.players.get(pid)!.ready) return false;
    }
    return true;
  }

  /**
   * Validates and applies one player's action. Every action carries a
   * per-player, strictly increasing `seq`: a replay, a duplicate send, or an
   * action that arrives after a later one has already been processed is
   * rejected here, before it can touch any state, so it can never double a
   * card's effect or double a readiness signal.
   */
  applyAction(playerId: string, seq: number, action: FightAction, now: number, rng: () => number): ActionResult {
    if (this.ended) return { ok: false, error: "this fight has already ended" };
    const ps = this.playerStates.get(playerId);
    const p = playerById(this.fight, playerId);
    if (!ps || !p) return { ok: false, error: "you're not in this fight" };
    if (p.downed) return { ok: false, error: "you're down: you can't act this fight" };
    if (p.fled) return { ok: false, error: "you already left this fight" };
    if (seq <= ps.lastSeq) return { ok: false, error: "stale or repeated action" };

    const rp = this.room.players.get(playerId)!;
    if (rp.ready && (action.type === "endTurn" || action.type === "flee")) {
      return { ok: false, error: "already readied up this round" };
    }
    if (rp.ready) return { ok: false, error: "already readied up: can't play more cards" };

    ps.lastSeq = seq;

    if (action.type === "playCard") {
      const idx = ps.handIds.indexOf(action.cardInstanceId);
      if (idx < 0) return { ok: false, error: "that card isn't in your hand (already played, or stale)" };
      const card = ps.piles.hand[idx];
      if (ps.energy < card.cost) return { ok: false, error: "not enough energy" };
      if (card.kind === "single") {
        if (!action.targetKey) return { ok: false, error: "this card needs a target" };
        const target = unitByKey(this.fight, action.targetKey);
        if (!target || target.downed) return { ok: false, error: "invalid or already-downed target" };
      }
      takeFromHand(ps.piles, idx);
      ps.handIds.splice(idx, 1);
      ps.energy -= card.cost;
      if (card.kind === "resource") {
        ps.energy += 1;
        if (drawOne(ps.piles, rng)) ps.handIds.push(newCardId());
      } else if (card.kind === "guard") {
        p.block += card.value;
      } else if (card.kind === "single") {
        hitUnit(this.fight, action.targetKey!, card.value);
      } else if (card.kind === "aoe") {
        for (const u of standing(this.fight)) hitUnit(this.fight, u.key, card.value);
      }
      settlePlayed(ps.piles, card);
      if (isWon(this.fight)) this.finish(now, "won");
      return { ok: true };
    }

    if (action.type === "endTurn" || action.type === "flee") {
      rp.ready = true;
      if (action.type === "flee") this.pendingFlee.add(playerId);
      if (this.allActiveReady()) this.resolveRound(now, rng);
      return { ok: true };
    }
    return { ok: false, error: "unknown action" };
  }

  /**
   * A reconnect window timing out: never a free exit. Exactly like the
   * player clicking Flee themselves — the shown enemy actions still land
   * this round, and they only actually leave once it resolves — but it
   * bypasses the normal per-player sequence check, since this is a
   * server-internal decision, not a replayable client message.
   */
  forceFlee(playerId: string, now: number, rng: () => number): ActionResult {
    if (this.ended) return { ok: false, error: "already ended" };
    const ps = this.playerStates.get(playerId);
    const p = playerById(this.fight, playerId);
    if (!ps || !p || p.downed || p.fled) return { ok: false, error: "not an active member" };
    const rp = this.room.players.get(playerId)!;
    this.pendingFlee.add(playerId);
    if (!rp.ready) {
      rp.ready = true;
      if (this.allActiveReady()) this.resolveRound(now, rng);
    }
    return { ok: true };
  }

  private resolveRound(now: number, rng: () => number) {
    for (const [pid, ps] of this.playerStates) {
      const p = playerById(this.fight, pid)!;
      if (!p.downed && !p.fled) discardHand(ps.piles);
    }
    beginEnemyTurn(this.fight);
    const plan = planEnemyTurn(this.fight);
    for (const ev of plan.events) applyEnemyEvent(this.fight, ev);

    // a flee requested this round resolves now, after the shown actions already landed
    for (const pid of this.pendingFlee) markFled(this.fight, pid);
    this.pendingFlee.clear();

    for (const pid of this.playerIds) {
      const p = playerById(this.fight, pid)!;
      if (p.fled) {
        const rp = this.room.players.get(pid)!;
        rp.fightId = null;
        rp.ready = false;
        rp.block = 0;
        this.playerStates.delete(pid);
      }
    }

    if (isWon(this.fight)) return this.finish(now, "won");
    if (isPartyWiped(this.fight)) return this.finish(now, this.fight.players.some((pl) => pl.fled) ? "abandoned" : "wiped");
    this.startRound(rng);
  }

  private finish(now: number, outcome: FightOutcome) {
    this.ended = outcome;
    const { dead } = endFight(this.fight);
    for (const key of dead) {
      const e = this.enemyByKey.get(key);
      if (e) e.alive = false;
    }
    const survivors: RoomEnemy[] = [];
    for (const u of this.fight.units) {
      const e = this.enemyByKey.get(u.key);
      if (e && !u.downed) {
        e.hp = u.hp;
        e.phase = u.phase;
        e.fightId = null;
        survivors.push(e);
      }
    }
    if (survivors.length) settleAfterFlee(survivors, now, { w: WORLD_WIDTH, h: WORLD_HEIGHT });
    for (const pid of this.playerIds) {
      const rp = this.room.players.get(pid);
      if (rp) {
        rp.fightId = null;
        rp.ready = false;
        rp.block = 0;
      }
    }
    this.playerStates.clear();
    this.room.fights.delete(this.id);
  }

  // ---------- views ----------

  fightView(): CoopFightMsg {
    const enemies: CoopFightEnemyView[] = this.fight.units.map((u) => ({
      key: u.key, role: this.enemyByKey.get(u.key)?.role ?? "brute", tier: this.enemyByKey.get(u.key)?.tier ?? "normal",
      hp: u.hp, maxHp: u.maxHp, downed: u.downed, intent: intentView(u),
    }));
    const players: CoopFightPlayerView[] = this.fight.players.map((p) => ({
      id: p.id, hp: p.hp, block: p.block, downed: p.downed, fled: p.fled, ready: this.room.players.get(p.id)?.ready ?? false,
    }));
    return { type: "fight", fightId: this.id, turn: this.fight.turn, phase: this.ended ? "ended" : "playerTurn", enemies, players };
  }

  handView(playerId: string): CoopHandMsg | null {
    const ps = this.playerStates.get(playerId);
    if (!ps) return null;
    return { type: "hand", fightId: this.id, cards: ps.piles.hand.map((c, i) => cardView(ps.handIds[i], c)), energy: ps.energy };
  }
}
