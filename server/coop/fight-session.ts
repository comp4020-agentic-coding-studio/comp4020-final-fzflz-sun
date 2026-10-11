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

/**
 * A fight's full, resolved state: enough to resume it exactly where it was
 * (same hands, round, energy, card instance ids, downed/fled flags) without
 * re-dealing, re-resolving, or re-confirming anything. Written after every
 * completed action (server/coop/ws.ts); read back only at room load, when
 * server/coop/store.ts's `fights` table still has a row for a fight whose
 * room never saw it end.
 */
export interface PersistedFightPlayer {
  id: string;
  /**
   * Captured here too, not left to the room-level snapshot alone: that
   * snapshot is only written on its own debounce (server/coop/ws.ts), so a
   * crash between a damaging action and the next debounced write would
   * otherwise roll a player's HP back to a stale, higher value on restore.
   */
  hp: number;
  block: number;
  downed: boolean;
  fled: boolean;
  /** whether this player had already ended their turn or committed to flee this round — must survive a restart exactly, or a player who'd already committed could regain the ability to act. */
  ready: boolean;
  piles: Piles;
  handIds: string[];
  energy: number;
  lastSeq: number;
}
export interface PersistedFight {
  roomFight: RoomFight;
  turn: number;
  units: CombatUnit[];
  players: PersistedFightPlayer[];
  pendingFlee: string[];
}

const EMPTY_PILES: Piles = { draw: [], hand: [], discard: [], exhaust: [] };

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
  /** Players who personally left this round while the fight continues for others: ws.ts owes each of these one
   * explicit message (there's no `fightEnded` for them, since the fight itself didn't end) so their own client
   * actually closes its fight dock instead of it sitting on the last view it had. Cleared by takeJustLeft(). */
  private justLeft: string[] = [];
  ended: FightOutcome | null = null;

  /**
   * `restore`, when given, reconstructs exactly the persisted state (a server
   * restart recovering a fight in progress) instead of dealing a fresh
   * round — no re-shuffling, no re-dealing, no re-resolving anything that
   * already happened.
   */
  constructor(room: CoopRoom, roomFight: RoomFight, rng: () => number, restore?: PersistedFight) {
    this.room = room;
    this.id = roomFight.id;
    this.initialPlayerIds = [...roomFight.playerIds];
    for (const key of roomFight.enemyKeys) this.enemyByKey.set(key, room.enemies.find((x) => x.key === key)!);

    if (restore) {
      const units: CombatUnit[] = restore.units.map((u) => ({ ...u }));
      const players: FightPlayer[] = roomFight.playerIds.map((pid) => {
        const adapter = fightPlayerAdapter(room.players.get(pid)!);
        const saved = restore.players.find((p) => p.id === pid);
        adapter.downed = saved?.downed ?? false;
        adapter.fled = saved?.fled ?? false;
        return adapter;
      });
      this.fight = { turn: restore.turn, units, players };
      for (const saved of restore.players) {
        const rp = room.players.get(saved.id);
        if (!rp) continue; // a member who's since left the room entirely: nothing to resume them into
        // the fight's own record of hp/block is the freshest one (captured at the same
        // moment as everything else here), not the room-level snapshot's separately
        // debounced copy — restoring from that instead would risk rolling HP back to a
        // stale, higher value if the crash landed between the two writes.
        rp.hp = saved.hp;
        rp.block = saved.block;
        // exactly as it was at the moment of the last completed action: a player who'd
        // already ended their turn or committed to flee this round must stay unable to
        // act after a restart, not regain it by being reset to "not ready".
        rp.ready = saved.ready;
        // a fled player has already left (no seat to resume); a downed one stays a member
        // (structurally present, shown as fallen) exactly like live play, just like the rest.
        if (!saved.fled) {
          this.playerStates.set(saved.id, { id: saved.id, piles: saved.piles, handIds: saved.handIds, energy: saved.energy, lastSeq: saved.lastSeq });
        }
      }
      for (const pid of restore.pendingFlee) this.pendingFlee.add(pid);
      return;
    }

    const units: CombatUnit[] = roomFight.enemyKeys.map((key) => {
      const e = this.enemyByKey.get(key)!;
      return makeUnit(e.key, e.role, e.group, e.hp, e.phase);
    });
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

  /** Everything needed to resume this fight exactly where it is, with no re-dealing or re-resolving. */
  serialize(): PersistedFight {
    const roomFight = this.room.fights.get(this.id)!;
    const players: PersistedFightPlayer[] = this.fight.players.map((p) => {
      const ps = this.playerStates.get(p.id);
      const rp = this.room.players.get(p.id);
      return {
        id: p.id, hp: p.hp, block: p.block, downed: p.downed, fled: p.fled, ready: rp?.ready ?? false,
        piles: ps?.piles ?? EMPTY_PILES, handIds: ps?.handIds ?? [], energy: ps?.energy ?? 0, lastSeq: ps?.lastSeq ?? 0,
      };
    });
    return {
      roomFight,
      turn: this.fight.turn,
      units: this.fight.units.map((u) => ({ ...u })),
      players,
      pendingFlee: [...this.pendingFlee],
    };
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

    this.justLeft = [];
    for (const pid of this.playerIds) {
      const p = playerById(this.fight, pid)!;
      if (p.fled) {
        const rp = this.room.players.get(pid)!;
        rp.fightId = null;
        rp.ready = false;
        rp.block = 0;
        this.playerStates.delete(pid);
        this.justLeft.push(pid);
      }
    }

    if (isWon(this.fight)) return this.finish(now, "won");
    if (isPartyWiped(this.fight)) return this.finish(now, this.fight.players.some((pl) => pl.fled) ? "abandoned" : "wiped");
    this.startRound(rng);
  }

  /** The players who personally left this round (fled, fight continues for others), once, for ws.ts to notify. */
  takeJustLeft(): string[] {
    const out = this.justLeft;
    this.justLeft = [];
    return out;
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
    return { type: "hand", fightId: this.id, cards: ps.piles.hand.map((c, i) => cardView(ps.handIds[i], c)), energy: ps.energy, lastSeq: ps.lastSeq };
  }
}
