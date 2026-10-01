import kaplay from "kaplay";
import {
  type CardDef,
  type Piles,
  drawHand,
  drawOne,
  discardHand,
  endEncounterPiles,
  newPiles,
  settlePlayed,
  takeFromHand,
  totalCards,
} from "./cards.ts";
import { VIEWPORT, VIEW_HEIGHT, VIEW_WIDTH, WORLD_HEIGHT, WORLD_WIDTH } from "./config.ts";
import { clampCam, formationBounds, layoutFormation, planCamera } from "./formation.ts";
import { separate } from "./separation.ts";
import {
  type Intent,
  type Phase,
  type PhaseEvent,
  type ResolvePlan,
  type RunState,
  canAct as canActRule,
  planResolve,
  transition,
} from "./turn.ts";

// Feel-test prototype, v5. Exploration is real-time (chase, leash, light
// separation); a fight locks the roster, eases enemies into readable slots,
// then runs strict turns: player turn -> enemy resolve (played one action at
// a time) -> next turn. Pure rules live in cards/formation/separation/turn.ts.


const k = kaplay({
  width: VIEW_WIDTH,
  height: VIEW_HEIGHT,
  letterbox: true,
  background: [17, 17, 17],
});

k.setGravity(0);

// ---------- tunables ----------

const PLAYER_SPEED = 220;
const PLAYER_MAX_HP = 24;
const PLAYER_MAX_ENERGY = 3;
const HAND_SIZE = 4;

const TRASH_AGGRO_RANGE = 210;
const TRASH_ENGAGE_RANGE = 40;
const TRASH_SPEED = 100;
const TRASH_HP = 6;
const TRASH_ATK_DAMAGE = 3;
const TRASH_RADIUS = 14;

const BOSS_AGGRO_RANGE = 260;
const BOSS_ENGAGE_RANGE = 46;
const BOSS_SPEED = 78;
const BOSS_HP = 40;
const BOSS_ATTACK_DMG = 5;
const BOSS_BIGATTACK_DMG = 12;
const BOSS_DEFEND_BLOCK = 8;
const BOSS_RADIUS = 28;
const BOSS_PATTERN: Intent[] = [
  { kind: "attack", value: BOSS_ATTACK_DMG },
  { kind: "defend", value: BOSS_DEFEND_BLOCK },
  { kind: "charge", value: 0 },
  { kind: "attack", value: BOSS_BIGATTACK_DMG },
];

const LEASH_FACTOR = 1.35;
const JOIN_RADIUS = 260;
const FLEE_IMMUNITY = 2.5;
const END_GRACE = 0.3;

// Enemy-enemy spacing only (the player is never pushed). Trash-trash minimum
// is 14+14+6 = 34, under the 40 engage range, so a crowd can still close in.
const SEPARATION_PADDING = 6;
const SEPARATION_SPEED = 160;
const BOSS_MASS = 2.2;
const TRASH_MASS = 1;

const FORM_DURATION = 0.3;
const ENEMY_ACTION_GAP = 0.45;
const OVERFLOW_PANEL_ROWS = 4;

const CAM_LERP_RATE = 4;
const CAM_MAX_ZOOM_SMALL = 1.5;
const CAM_MAX_ZOOM_LARGE = 1.2;
const BOSS_DANGER_BONUS = 3;
const DANGER_THRESHOLD = 3;

const FEEDBACK_DURATION = 1.4;
const HIT_FLASH_DURATION = 0.15;

// Label offsets match TRASH_BOX / BOSS_BOX in formation.ts.
const TRASH_LABELS = { hp: -24, intent: -42, marker: -60 };
const BOSS_LABELS = { hp: -40, intent: -68, marker: -98 };

const PLAYER_COLOR = k.rgb(80, 160, 255);
const TRASH_COLOR = k.rgb(220, 70, 70);
const BOSS_COLOR = k.rgb(160, 60, 200);

type Vec2 = ReturnType<typeof k.vec2>;
type Timer = ReturnType<typeof k.wait>;

// ---------- player / run state ----------

const player = k.add([
  k.pos(220, 650),
  k.circle(16),
  k.color(PLAYER_COLOR),
  k.area(),
  k.anchor("center"),
  k.z(10),
  "player",
  { hp: PLAYER_MAX_HP, energy: PLAYER_MAX_ENERGY, block: 0 },
]);

let piles: Piles = newPiles();
let selectedTarget: Enemy | null = null;
let runState: RunState = "playing";
let encounterCooldownUntil = 0;
let feedbackMessage = "";
let feedbackUntil = 0;
let overflowScroll = 0;

// Every delayed combat callback goes through here so an encounter ending,
// the player dying or a restart can cancel what's still queued.
let pendingTimers: Timer[] = [];
function schedule(seconds: number, fn: () => void) {
  const t = k.wait(seconds, fn);
  pendingTimers.push(t);
}
function cancelPending() {
  for (const t of pendingTimers) t.cancel();
  pendingTimers = [];
}

function showFeedback(msg: string) {
  feedbackMessage = msg;
  feedbackUntil = k.time() + FEEDBACK_DURATION;
}

function floatText(pos: Vec2, msg: string, color: ReturnType<typeof k.rgb>) {
  const t = k.add([
    k.text(msg, { size: 16 }),
    k.pos(pos.x, pos.y),
    k.anchor("center"),
    k.color(color),
    k.opacity(1),
    k.lifespan(0.7, { fade: 0.35 }),
    k.z(40),
  ]);
  t.onUpdate(() => {
    t.pos.y -= 36 * k.dt();
  });
}

// ---------- world dressing ----------

const GROUND_TILE = 130;
for (let gy = 0; gy < WORLD_HEIGHT; gy += GROUND_TILE) {
  for (let gx = 0; gx < WORLD_WIDTH; gx += GROUND_TILE) {
    const dark = ((gx / GROUND_TILE + gy / GROUND_TILE) | 0) % 2 === 0;
    k.add([
      k.rect(GROUND_TILE, GROUND_TILE),
      k.pos(gx, gy),
      k.color(dark ? 26 : 30, dark ? 26 : 30, dark ? 30 : 34),
      k.z(-100),
    ]);
  }
}
for (const p of [
  { x: 300, y: 300 }, { x: 1100, y: 200 }, { x: 400, y: 1100 },
  { x: 1600, y: 1050 }, { x: 2000, y: 350 }, { x: 900, y: 800 },
]) {
  k.add([k.circle(34), k.pos(p.x, p.y), k.color(45, 55, 45), k.z(-90)]);
}

// ---------- enemies ----------

type EnemyState = "idle" | "chasing" | "returning" | "engaged";
let nextEnemyId = 1;

function spawnEnemy(x: number, y: number, hp: number, isBoss: boolean) {
  const labels = isBoss ? BOSS_LABELS : TRASH_LABELS;
  const enemy = k.add([
    k.pos(x, y),
    isBoss ? k.rect(56, 56) : k.rect(28, 28),
    k.color(isBoss ? BOSS_COLOR : TRASH_COLOR),
    k.opacity(1),
    k.area(),
    k.anchor("center"),
    k.z(5),
    "enemy",
    {
      enemyId: nextEnemyId++,
      hp,
      maxHp: hp,
      block: 0,
      home: k.vec2(x, y),
      state: "idle" as EnemyState,
      isBoss,
      bodyRadius: isBoss ? BOSS_RADIUS : TRASH_RADIUS,
      mass: isBoss ? BOSS_MASS : TRASH_MASS,
      aggroRange: isBoss ? BOSS_AGGRO_RANGE : TRASH_AGGRO_RANGE,
      engageRange: isBoss ? BOSS_ENGAGE_RANGE : TRASH_ENGAGE_RANGE,
      speed: isBoss ? BOSS_SPEED : TRASH_SPEED,
      patternIndex: 0,
      intent: null as Intent | null,
      acted: false,
      engagePos: null as Vec2 | null,
      formFrom: null as Vec2 | null,
      formTo: null as Vec2 | null,
      overflow: false,
    },
  ]);
  enemy.add([
    k.text(String(hp), { size: isBoss ? 16 : 12 }),
    k.pos(0, labels.hp),
    k.anchor("center"),
    k.color(255, 255, 255),
    k.opacity(1),
    "enemyHpLabel",
  ]);
  enemy.add([
    k.text("", { size: 13, align: "center" }),
    k.pos(0, labels.intent),
    k.anchor("center"),
    k.color(255, 210, 80),
    k.opacity(1),
    "enemyStateLabel",
  ]);
  enemy.onClick(() => selectTarget(enemy));
  return enemy;
}
type Enemy = ReturnType<typeof spawnEnemy>;

const ENEMY_CONFIGS: { x: number; y: number; hp: number; boss?: boolean }[] = [
  { x: 700, y: 400, hp: TRASH_HP },
  { x: 760, y: 440, hp: TRASH_HP },
  { x: 650, y: 950, hp: TRASH_HP },
  { x: 1280, y: 280, hp: TRASH_HP },
  { x: 1330, y: 230, hp: TRASH_HP },
  { x: 1300, y: 360, hp: TRASH_HP },
  { x: 1750, y: 640, hp: TRASH_HP },
  { x: 1850, y: 700, hp: BOSS_HP, boss: true },
];

let enemies: Enemy[] = [];

function spawnAllEnemies() {
  enemies = ENEMY_CONFIGS.map((c) => spawnEnemy(c.x, c.y, c.hp, c.boss ?? false));
}

function hpLabelOf(e: Enemy) {
  return e.get("enemyHpLabel")[0];
}
function stateLabelOf(e: Enemy) {
  return e.get("enemyStateLabel")[0];
}
function enemyName(e: Enemy) {
  return e.isBoss ? "Boss" : `Grunt #${e.enemyId}`;
}
function refreshHpLabel(e: Enemy) {
  const label = hpLabelOf(e);
  if (label) label.text = e.block > 0 ? `${e.hp} (blk ${e.block})` : String(e.hp);
}
function intentText(e: Enemy): string {
  const intent = e.intent;
  if (!intent) return "";
  if (intent.kind === "attack") {
    return e.isBoss && intent.value >= BOSS_BIGATTACK_DMG ? `HEAVY ATK ${intent.value}` : `ATK ${intent.value}`;
  }
  if (intent.kind === "defend") return `DEF +${intent.value}`;
  // patternIndex already points at the move after this charge
  const next = BOSS_PATTERN[e.patternIndex % BOSS_PATTERN.length];
  return next.kind === "attack" ? `CHARGE\nnext: ATK ${next.value}` : "CHARGE";
}
function refreshIntentLabel(e: Enemy) {
  const label = stateLabelOf(e);
  if (!label) return;
  label.text = intentText(e);
  label.color = e.acted ? k.rgb(120, 120, 120) : k.rgb(255, 210, 80);
}

function flash(obj: { color: ReturnType<typeof k.rgb>; exists: () => boolean }, revert: ReturnType<typeof k.rgb>, c = k.rgb(255, 255, 255)) {
  obj.color = c;
  k.wait(HIT_FLASH_DURATION, () => {
    if (obj.exists()) obj.color = revert;
  });
}

// ---------- encounter state ----------

interface Encounter {
  id: number;
  roster: Enemy[];
  difficulty: "normal" | "dangerous";
  camPos: Vec2;
  camScale: number;
  phase: Phase;
  fleeing: boolean;
  turnNumber: number;
  phaseStartedAt: number;
}
let activeEncounter: Encounter | null = null;
let nextEncounterId = 1;

function canAct() {
  return canActRule(activeEncounter?.phase ?? null, runState);
}

function setPhase(enc: Encounter, ev: PhaseEvent): boolean {
  const next = transition(enc.phase, ev);
  if (!next) return false;
  enc.phase = next;
  enc.phaseStartedAt = k.time();
  return true;
}

function blockedReason(): string {
  if (runState !== "playing") return "run is over - press R";
  if (!activeEncounter) return "not in a fight";
  switch (activeEncounter.phase) {
    case "forming":
      return "enemies are forming up...";
    case "resolving":
      return "enemies are acting - wait";
    case "unforming":
      return "retreating...";
    default:
      return "";
  }
}

function aliveRoster(): Enemy[] {
  return activeEncounter ? activeEncounter.roster.filter((e) => e.exists()) : [];
}
function overflowList(): Enemy[] {
  return aliveRoster().filter((e) => e.overflow);
}

function selectTarget(e: Enemy) {
  if (!activeEncounter || !e.exists()) return;
  if (!activeEncounter.roster.includes(e)) {
    showFeedback("that enemy isn't in this fight");
    return;
  }
  selectedTarget = e;
}

function computeDifficulty(roster: Enemy[]): "normal" | "dangerous" {
  const weight = roster.length + roster.filter((e) => e.isBoss).length * BOSS_DANGER_BONUS;
  return weight >= DANGER_THRESHOLD ? "dangerous" : "normal";
}

function rollIntent(e: Enemy) {
  if (e.isBoss) {
    e.intent = BOSS_PATTERN[e.patternIndex % BOSS_PATTERN.length];
    e.patternIndex++;
  } else {
    e.intent = { kind: "attack", value: TRASH_ATK_DAMAGE };
  }
  e.acted = false;
  refreshIntentLabel(e);
}

// ---------- encounter flow ----------

function tryTriggerEncounter(now: number) {
  const instigator = enemies.find(
    (e) => e.exists() && e.state === "chasing" && e.pos.dist(player.pos) <= e.engageRange
  );
  if (!instigator) return;
  const roster = enemies.filter(
    (e) => e.exists() && e.state === "chasing" && e.pos.dist(player.pos) <= JOIN_RADIUS
  );

  // Slots are assigned once, here, and the camera is planned from those final
  // slots (not from where enemies happened to be standing when they caught you).
  const units = roster.map((e) => ({ id: e.enemyId, isBoss: e.isBoss, pos: { x: e.pos.x, y: e.pos.y } }));
  const anchor = { x: player.pos.x, y: player.pos.y };
  const formation = layoutFormation(units, anchor, VIEWPORT);
  const overflowIds = new Set(formation.overflow);
  for (const e of roster) {
    const slot = formation.slots.get(e.enemyId);
    e.state = "engaged";
    e.engagePos = e.pos.clone();
    e.formFrom = e.pos.clone();
    e.formTo = slot ? k.vec2(slot.x, slot.y) : e.pos.clone();
    e.overflow = overflowIds.has(e.enemyId);
    e.intent = null;
    e.block = 0;
    refreshIntentLabel(e);
    refreshHpLabel(e);
  }

  const difficulty = computeDifficulty(roster);
  const bounds = formationBounds(units, formation.slots, anchor);
  const zoom =
    difficulty === "dangerous"
      ? { min: 1, max: roster.length >= 3 ? CAM_MAX_ZOOM_LARGE : CAM_MAX_ZOOM_SMALL }
      : { min: 1, max: 1 };
  const cam = planCamera(bounds, VIEWPORT, zoom);

  activeEncounter = {
    id: nextEncounterId++,
    roster,
    difficulty,
    camPos: k.vec2(cam.center.x, cam.center.y),
    camScale: cam.scale,
    phase: "forming",
    fleeing: false,
    turnNumber: 1,
    phaseStartedAt: now,
  };
  player.block = 0;
  selectedTarget = roster.find((e) => e.isBoss && !e.overflow) ?? roster.find((e) => !e.overflow) ?? roster[0];
  renderHand();
}

function finishForming(enc: Encounter) {
  for (const e of enc.roster) {
    if (e.exists() && e.formTo) e.pos = e.formTo.clone();
  }
  if (setPhase(enc, "formed")) startPlayerTurn(enc);
}

function startPlayerTurn(enc: Encounter) {
  player.energy = PLAYER_MAX_ENERGY;
  drawHand(piles, HAND_SIZE);
  for (const e of enc.roster) {
    if (!e.exists()) continue;
    refreshHpLabel(e);
    rollIntent(e);
  }
  renderHand();
}

function endPlayerTurn(fleeing: boolean) {
  const enc = activeEncounter;
  if (!enc || !canAct()) {
    showFeedback(blockedReason());
    return;
  }
  if (!setPhase(enc, fleeing ? "flee" : "endTurn")) return;
  enc.fleeing = fleeing;
  discardHand(piles);
  renderHand();

  // An enemy's DEF block covered the player turn that just ended; it expires
  // now, before this round of actions (a fresh DEF re-applies below).
  for (const e of enc.roster) {
    if (!e.exists()) continue;
    e.block = 0;
    refreshHpLabel(e);
  }
  const plan = planResolve(
    { hp: player.hp, block: player.block },
    enc.roster.map((e) => ({ id: e.enemyId, alive: e.exists(), intent: e.intent }))
  );
  showFeedback(fleeing ? "Fleeing - enemies act first..." : "Enemy turn");
  playResolve(enc, plan, 0);
}

function playResolve(enc: Encounter, plan: ResolvePlan, i: number) {
  if (activeEncounter !== enc || runState !== "playing") return;
  if (i >= plan.events.length) {
    finishResolve(enc);
    return;
  }
  const ev = plan.events[i];
  const e = enc.roster.find((r) => r.enemyId === ev.id);
  player.hp = ev.hpAfter;
  player.block = ev.blockAfter;
  if (e && e.exists()) {
    e.acted = true;
    if (ev.intent.kind === "defend") {
      e.block += ev.intent.value;
      refreshHpLabel(e);
      floatText(e.pos.add(0, -20), `+${ev.intent.value} blk`, k.rgb(140, 200, 255));
      showFeedback(`${enemyName(e)} braces: +${ev.intent.value} block`);
    } else if (ev.intent.kind === "charge") {
      floatText(e.pos.add(0, -20), "charging!", k.rgb(255, 180, 60));
      showFeedback(`${enemyName(e)} charges up - heavy hit next turn`);
    } else {
      flash(e, e.isBoss ? BOSS_COLOR : TRASH_COLOR);
      flash(player, PLAYER_COLOR, k.rgb(255, 90, 90));
      const absorbed = ev.intent.value - ev.damageTaken;
      floatText(player.pos.add(0, -28), ev.damageTaken > 0 ? `-${ev.damageTaken}` : "blocked", k.rgb(255, 110, 110));
      k.shake(ev.intent.value >= BOSS_BIGATTACK_DMG ? 7 : 2);
      showFeedback(
        `${enemyName(e)} hits for ${ev.intent.value}` + (absorbed > 0 ? ` (${absorbed} blocked)` : "")
      );
    }
    refreshIntentLabel(e);
  }
  if (plan.died && i === plan.events.length - 1) {
    finishDeath();
    return;
  }
  schedule(ENEMY_ACTION_GAP, () => playResolve(enc, plan, i + 1));
}

function finishResolve(enc: Encounter) {
  if (enc.fleeing) {
    if (!setPhase(enc, "fleeEscaped")) return;
    for (const e of enc.roster) {
      if (!e.exists()) continue;
      e.formFrom = e.pos.clone();
      e.formTo = e.engagePos ? e.engagePos.clone() : e.pos.clone();
      e.block = 0;
      e.intent = null;
      refreshIntentLabel(e);
      refreshHpLabel(e);
    }
    showFeedback("Escaped!");
    return;
  }
  player.block = 0;
  if (!setPhase(enc, "nextTurn")) return;
  enc.turnNumber++;
  startPlayerTurn(enc);
}

function finishUnforming(enc: Encounter) {
  for (const e of enc.roster) {
    if (!e.exists()) continue;
    if (e.formTo) e.pos = e.formTo.clone();
    e.state = "returning";
  }
  encounterCooldownUntil = k.time() + FLEE_IMMUNITY;
  cleanupEncounter();
}

function finishVictory() {
  encounterCooldownUntil = k.time() + END_GRACE;
  showFeedback("Victory");
  cleanupEncounter();
}

function finishDeath() {
  cancelPending();
  endEncounterPiles(piles);
  runState = "dead";
  activeEncounter = null;
  renderHand();
}

function cleanupEncounter() {
  cancelPending();
  endEncounterPiles(piles);
  player.block = 0;
  selectedTarget = null;
  activeEncounter = null;
  overflowScroll = 0;
  for (const e of enemies) {
    if (!e.exists()) continue;
    e.overflow = false;
    e.engagePos = e.formFrom = e.formTo = null;
  }
  renderHand();
}

// ---------- exploration AI (frozen while any fight is active) ----------

function updateEnemyAI(e: Enemy) {
  const toPlayer = player.pos.sub(e.pos);
  const dist = toPlayer.len();
  if (e.state === "idle") {
    if (dist <= e.aggroRange) e.state = "chasing";
  } else if (e.state === "chasing") {
    if (dist > e.aggroRange * LEASH_FACTOR) e.state = "returning";
    else if (dist > e.engageRange) e.pos = e.pos.add(toPlayer.unit().scale(e.speed * k.dt()));
  } else if (e.state === "returning") {
    const toHome = e.home.sub(e.pos);
    if (toHome.len() < 4) {
      e.pos = e.home.clone();
      e.state = "idle";
    } else {
      e.pos = e.pos.add(toHome.unit().scale(e.speed * k.dt()));
    }
    if (dist <= e.aggroRange) e.state = "chasing";
  }
  const label = stateLabelOf(e);
  if (label) label.text = e.state === "chasing" ? "!" : e.state === "returning" ? "…" : "";
}

// ---------- cards ----------

function damageEnemy(enemy: Enemy, amount: number) {
  const absorbed = Math.min(enemy.block, amount);
  enemy.block -= absorbed;
  const dealt = amount - absorbed;
  enemy.hp -= dealt;
  flash(enemy, enemy.isBoss ? BOSS_COLOR : TRASH_COLOR);
  floatText(enemy.pos.add(0, -10), dealt > 0 ? `-${dealt}` : "blocked", k.rgb(255, 240, 160));
  if (enemy.hp <= 0) {
    k.destroy(enemy);
    return;
  }
  refreshHpLabel(enemy);
}

function playCardAt(idx: number) {
  if (!canAct()) {
    showFeedback(blockedReason());
    return;
  }
  const card = piles.hand[idx];
  if (!card) {
    showFeedback(`no card in slot ${idx + 1}`);
    return;
  }
  if (player.energy < card.cost) {
    showFeedback(`${card.name} needs ${card.cost} energy (you have ${player.energy})`);
    return;
  }
  const alive = aliveRoster();
  const target =
    selectedTarget && selectedTarget.exists() && alive.includes(selectedTarget) ? selectedTarget : alive[0];

  // Fully settle this card (out of hand, cost paid, effect applied, card sent
  // to discard/exhaust) before checking for victory, so a lethal play can't
  // cut cleanup in half and strand the rest of the hand.
  takeFromHand(piles, idx);
  player.energy -= card.cost;
  applyCard(card, target, alive);
  settlePlayed(piles, card);
  renderHand();

  if (aliveRoster().length === 0) finishVictory();
}

function applyCard(card: CardDef, target: Enemy | undefined, alive: Enemy[]) {
  if (card.kind === "single") {
    if (target) damageEnemy(target, card.value);
  } else if (card.kind === "aoe") {
    for (const e of alive) damageEnemy(e, card.value);
  } else if (card.kind === "guard") {
    player.block += card.value;
    floatText(player.pos.add(0, -28), `+${card.value} blk`, k.rgb(140, 200, 255));
  } else {
    // No cap: Focus exhausts after one use, so this can't loop within a fight.
    player.energy += card.value;
    drawOne(piles);
  }
}

function requestEndTurn() {
  endPlayerTurn(false);
}
function flee() {
  endPlayerTurn(true);
}

// ---------- HUD ----------
// Never put square brackets in displayed text: Kaplay parses [x] as a style
// tag and an unmatched one throws, halting the whole game loop.

const hud = {
  hp: k.add([k.text("", { size: 18 }), k.pos(16, 12), k.fixed(), k.z(100)]),
  energy: k.add([k.text("", { size: 18 }), k.pos(16, 34), k.fixed(), k.z(100)]),
  state: k.add([k.text("", { size: 16 }), k.pos(16, 56), k.fixed(), k.z(100), k.color(255, 210, 80)]),
  turn: k.add([k.text("", { size: 14 }), k.pos(16, 78), k.fixed(), k.z(100), k.color(160, 200, 255)]),
  piles: k.add([k.text("", { size: 13 }), k.pos(16, 98), k.fixed(), k.z(100), k.color(150, 150, 150)]),
  feedback: k.add([k.text("", { size: 14 }), k.pos(16, 118), k.fixed(), k.z(100), k.color(255, 160, 140)]),
  hint: k.add([
    k.text(
      "Click enemy (or side list) to target · 1-4 / click card to play · WASD move\n" +
        "Block lasts through the enemy turn, then clears. Flee = enemies act first.",
      { size: 12, width: 760 }
    ),
    k.pos(16, 404),
    k.fixed(),
    k.z(100),
    k.color(170, 170, 170),
  ]),
  status: k.add([k.text("", { size: 22 }), k.pos(VIEW_WIDTH / 2, 40), k.anchor("center"), k.fixed(), k.z(100)]),
};

function makeButton(label: string, y: number, onPress: () => void) {
  const btn = k.add([
    k.rect(140, 40, { radius: 6 }),
    k.pos(VIEW_WIDTH - 86, y),
    k.anchor("center"),
    k.fixed(),
    k.z(100),
    k.area(),
    k.color(50, 50, 50),
    k.opacity(1),
    k.outline(2, k.rgb(200, 200, 200)),
  ]);
  btn.add([k.text(label, { size: 12, align: "center" }), k.anchor("center"), k.color(230, 230, 230)]);
  btn.onClick(onPress);
  return btn;
}
const endTurnButton = makeButton("End Turn (Space)", VIEW_HEIGHT - 128, requestEndTurn);
const fleeButton = makeButton("Flee (F)\nenemies act first", VIEW_HEIGHT - 80, flee);

const targetMarker = k.add([
  k.text("▼", { size: 16 }),
  k.pos(0, 0),
  k.anchor("center"),
  k.color(255, 255, 80),
  k.opacity(0),
  k.z(20),
]);

// Fallback list for participants that don't fit the stage: still selectable,
// still damaged by Cleave, still act in the resolve.
const overflowPanel = k.add([
  k.rect(240, 24 + OVERFLOW_PANEL_ROWS * 24, { radius: 6 }),
  k.pos(VIEW_WIDTH - 16, 12),
  k.anchor("topright"),
  k.fixed(),
  k.z(100),
  k.color(30, 30, 30),
  k.outline(2, k.rgb(90, 90, 90)),
  k.opacity(0),
]);
const overflowTitle = k.add([
  k.text("", { size: 11 }),
  k.pos(VIEW_WIDTH - 248, 18),
  k.fixed(),
  k.z(101),
  k.color(200, 200, 200),
  k.opacity(0),
]);
function makeScrollButton(glyph: string, x: number, delta: number) {
  const b = k.add([
    k.text(glyph, { size: 14 }),
    k.pos(x, 16),
    k.fixed(),
    k.z(101),
    k.area(),
    k.color(220, 220, 220),
    k.opacity(0),
  ]);
  b.onClick(() => {
    overflowScroll += delta;
  });
  return b;
}
const overflowUp = makeScrollButton("▲", VIEW_WIDTH - 60, -1);
const overflowDown = makeScrollButton("▼", VIEW_WIDTH - 40, 1);
const overflowRows = Array.from({ length: OVERFLOW_PANEL_ROWS }, (_, r) => {
  const bg = k.add([
    k.rect(224, 20, { radius: 4 }),
    k.pos(VIEW_WIDTH - 24, 38 + r * 24),
    k.anchor("topright"),
    k.fixed(),
    k.z(100),
    k.area(),
    k.color(45, 45, 45),
    k.opacity(0),
  ]);
  const label = k.add([
    k.text("", { size: 11 }),
    k.pos(VIEW_WIDTH - 244, 42 + r * 24),
    k.fixed(),
    k.z(101),
    k.color(230, 230, 230),
    k.opacity(0),
  ]);
  bg.onClick(() => {
    const target = overflowList()[overflowScroll + r];
    if (target) selectTarget(target);
  });
  return { bg, label };
});

let cardSlots: ReturnType<typeof k.add>[] = [];
function renderHand() {
  for (const slot of cardSlots) k.destroy(slot);
  cardSlots = [];
  const slotW = 150;
  const startX = VIEW_WIDTH / 2 - (HAND_SIZE * slotW) / 2 - 60;
  const playable = canAct();
  for (let i = 0; i < HAND_SIZE; i++) {
    const card = piles.hand[i];
    const affordable = !!card && playable && player.energy >= card.cost;
    const box = k.add([
      k.rect(slotW - 12, 76, { radius: 6 }),
      k.pos(startX + i * slotW + slotW / 2, VIEW_HEIGHT - 46),
      k.anchor("center"),
      k.fixed(),
      k.z(100),
      k.area(),
      k.color(card ? (affordable ? 55 : 38) : 25, card ? (affordable ? 70 : 38) : 25, card ? (affordable ? 95 : 38) : 25),
      k.outline(2, card ? (affordable ? k.rgb(220, 220, 220) : k.rgb(110, 110, 110)) : k.rgb(60, 60, 60)),
    ]);
    if (card) {
      box.onClick(() => playCardAt(i));
      box.add([
        k.text(`${i + 1}. ${card.name}  (${card.cost}E)`, { size: 12 }),
        k.pos(0, -24),
        k.anchor("center"),
        k.color(240, 240, 240),
      ]);
      box.add([
        k.text(card.blurb, { size: 10, width: slotW - 24, align: "center" }),
        k.pos(0, 8),
        k.anchor("center"),
        k.color(affordable ? 200 : 130, affordable ? 200 : 130, affordable ? 200 : 130),
      ]);
    }
    cardSlots.push(box);
  }
}

// ---------- input ----------

for (let i = 0; i < HAND_SIZE; i++) {
  k.onKeyPress(String(i + 1), () => playCardAt(i));
}
k.onKeyPress("space", requestEndTurn);
k.onKeyPress("f", flee);
k.onKeyPress("escape", flee);
k.onKeyPress("r", () => {
  if (runState !== "playing") resetGame();
});

// ---------- reset ----------

function resetGame() {
  cancelPending();
  for (const e of k.get("enemy")) k.destroy(e);
  spawnAllEnemies();
  player.pos = k.vec2(220, 650);
  player.hp = PLAYER_MAX_HP;
  player.energy = PLAYER_MAX_ENERGY;
  player.block = 0;
  player.color = PLAYER_COLOR;
  piles = newPiles();
  selectedTarget = null;
  activeEncounter = null;
  encounterCooldownUntil = 0;
  feedbackMessage = "";
  overflowScroll = 0;
  runState = "playing";
  renderHand();
}

// Playtest shortcut: ?fight=GRUNTS,BOSS,X,Y puts the player at (X,Y) with that
// many grunts (plus the boss if BOSS=1) stacked on one point beside them.
function applyFightParam() {
  const raw = new URLSearchParams(location.search).get("fight");
  if (!raw) return;
  const [grunts = 3, withBoss = 0, x = 1100, y = 650] = raw.split(",").map(Number);
  player.pos = k.vec2(k.clamp(x, 16, WORLD_WIDTH - 16), k.clamp(y, 16, WORLD_HEIGHT - 16));
  const side = player.pos.x > WORLD_WIDTH / 2 ? -1 : 1;
  const spot = k.vec2(k.clamp(player.pos.x + side * 30, 30, WORLD_WIDTH - 30), player.pos.y);
  // Asking for more grunts than the map has spawns extras, to stress the
  // overflow list.
  for (let n = enemies.filter((e) => !e.isBoss).length; n < grunts; n++) {
    enemies.push(spawnEnemy(spot.x, spot.y, TRASH_HP, false));
  }
  const picked = [
    ...enemies.filter((e) => !e.isBoss).slice(0, grunts),
    ...(withBoss ? enemies.filter((e) => e.isBoss) : []),
  ];
  for (const e of picked) {
    e.pos = spot.clone();
    e.state = "chasing";
  }
}

resetGame();
applyFightParam();
// Read-only snapshot for the browser-driven playtest script (tools/playtest.mjs).
(window as unknown as { __game: () => unknown }).__game = () => ({
  run: runState,
  phase: activeEncounter?.phase ?? null,
  turn: activeEncounter?.turnNumber ?? 0,
  difficulty: activeEncounter?.difficulty ?? null,
  hp: player.hp,
  energy: player.energy,
  block: player.block,
  player: { x: player.pos.x, y: player.pos.y },
  piles: { draw: piles.draw.length, hand: piles.hand.map((c) => c.name), discard: piles.discard.length, exhaust: piles.exhaust.length },
  cam: { x: k.getCamPos().x, y: k.getCamPos().y, scale: k.getCamScale().x },
  target: selectedTarget?.exists() ? selectedTarget.enemyId : null,
  enemies: enemies
    .filter((e) => e.exists())
    .map((e) => {
      const s = k.toScreen(e.pos);
      return {
        id: e.enemyId, boss: e.isBoss, hp: e.hp, block: e.block, state: e.state, overflow: e.overflow,
        x: e.pos.x, y: e.pos.y, sx: s.x, sy: s.y, intent: e.intent ? intentText(e) : null,
        engageX: e.engagePos?.x ?? null, engageY: e.engagePos?.y ?? null,
      };
    }),
});
k.setCamPos(player.pos);
k.setCamScale(1, 1);

// Invariant: the 14-card deck is always fully accounted for across all piles.
const DECK_SIZE = totalCards(piles);

// ---------- main loop ----------

function incomingDamage(): number {
  return aliveRoster().reduce((sum, e) => sum + (e.intent?.kind === "attack" ? e.intent.value : 0), 0);
}

k.onUpdate(() => {
  const now = k.time();
  const playing = runState === "playing";
  const enc = activeEncounter;

  if (playing && !enc) {
    const move = k.vec2(0, 0);
    if (k.isKeyDown("left") || k.isKeyDown("a")) move.x -= 1;
    if (k.isKeyDown("right") || k.isKeyDown("d")) move.x += 1;
    if (k.isKeyDown("up") || k.isKeyDown("w")) move.y -= 1;
    if (k.isKeyDown("down") || k.isKeyDown("s")) move.y += 1;
    if (move.len() > 0) player.pos = player.pos.add(move.unit().scale(PLAYER_SPEED * k.dt()));
    player.pos.x = k.clamp(player.pos.x, 16, WORLD_WIDTH - 16);
    player.pos.y = k.clamp(player.pos.y, 16, WORLD_HEIGHT - 16);

    const explorers = enemies.filter((e) => e.exists());
    for (const e of explorers) updateEnemyAI(e);
    separate(explorers, k.dt(), {
      padding: SEPARATION_PADDING,
      speed: SEPARATION_SPEED,
      worldW: WORLD_WIDTH,
      worldH: WORLD_HEIGHT,
    });
    if (now >= encounterCooldownUntil) tryTriggerEncounter(now);
  }

  if (enc && (enc.phase === "forming" || enc.phase === "unforming")) {
    const t = Math.min(1, (now - enc.phaseStartedAt) / FORM_DURATION);
    const ease = t * t * (3 - 2 * t);
    for (const e of enc.roster) {
      if (e.exists() && e.formFrom && e.formTo) e.pos = e.formFrom.lerp(e.formTo, ease);
    }
    if (t >= 1) {
      if (enc.phase === "forming") finishForming(enc);
      else finishUnforming(enc);
    }
  }

  // Camera: fights (from formation onward) hold the framing planned from the
  // final slots; everything else follows the player at 1x. Position is
  // re-clamped at the *current* scale every frame so a zoom transition never
  // shows past the map edge.
  const cur = activeEncounter;
  const framed = !!cur && cur.phase !== "unforming";
  const targetPos = framed ? cur!.camPos : player.pos;
  const targetScale = framed ? cur!.camScale : 1;
  const lerpT = Math.min(1, CAM_LERP_RATE * k.dt());
  const scale = k.getCamScale().x + (targetScale - k.getCamScale().x) * lerpT;
  const rawPos = k.getCamPos().lerp(targetPos, lerpT);
  const clamped = clampCam({ x: rawPos.x, y: rawPos.y }, scale, VIEWPORT);
  k.setCamScale(scale, scale);
  k.setCamPos(clamped.x, clamped.y);

  // Visibility: participants on stage are full, overflow participants are
  // shown only in the side list, bystanders are dimmed while a fight runs.
  for (const e of enemies) {
    if (!e.exists()) continue;
    const inFight = !!cur && cur.roster.includes(e);
    const o = !cur ? 1 : inFight ? (e.overflow ? 0 : 1) : 0.3;
    e.opacity = o;
    const hpL = hpLabelOf(e);
    const stL = stateLabelOf(e);
    if (hpL) hpL.opacity = o;
    if (stL) stL.opacity = o;
  }

  if (cur && (!selectedTarget || !selectedTarget.exists() || !cur.roster.includes(selectedTarget))) {
    const alive = aliveRoster();
    selectedTarget = alive.find((e) => !e.overflow) ?? alive[0] ?? null;
  }
  const markerOn = !!cur && cur.phase !== "unforming" && !!selectedTarget && selectedTarget.exists() && !selectedTarget.overflow;
  targetMarker.opacity = markerOn ? 1 : 0;
  if (markerOn && selectedTarget) {
    const off = selectedTarget.isBoss ? BOSS_LABELS.marker : TRASH_LABELS.marker;
    targetMarker.pos = selectedTarget.pos.add(0, off);
  }

  const list = overflowList();
  const showList = list.length > 0 && !!cur && cur.phase !== "unforming" && cur.phase !== "forming";
  overflowScroll = k.clamp(overflowScroll, 0, Math.max(0, list.length - OVERFLOW_PANEL_ROWS));
  overflowPanel.opacity = showList ? 1 : 0;
  overflowTitle.opacity = showList ? 1 : 0;
  overflowTitle.text = `+${list.length} more in fight`;
  overflowUp.opacity = showList && overflowScroll > 0 ? 1 : 0.25 * Number(showList);
  overflowDown.opacity = showList && overflowScroll < list.length - OVERFLOW_PANEL_ROWS ? 1 : 0.25 * Number(showList);
  overflowRows.forEach((row, r) => {
    const e = list[overflowScroll + r];
    const on = showList && !!e;
    row.bg.opacity = on ? 1 : 0;
    row.label.opacity = on ? 1 : 0;
    if (e) {
      row.bg.color = e === selectedTarget ? k.rgb(110, 100, 30) : k.rgb(45, 45, 45);
      row.label.text = `${enemyName(e)} ${e.hp}hp${e.block > 0 ? ` (blk ${e.block})` : ""} · ${intentText(e).replace("\n", " ")}`;
    }
  });

  hud.hp.text = `HP ${player.hp}/${PLAYER_MAX_HP}${player.block > 0 ? `  (block ${player.block})` : ""}`;
  hud.energy.text = `Energy ${player.energy}/${PLAYER_MAX_ENERGY}`;
  hud.state.text = cur
    ? `${cur.difficulty === "dangerous" ? "DANGEROUS fight" : "Fight"}: ${aliveRoster().length} foe(s) alive`
    : "Exploring";
  if (cur) {
    const phaseLabel: Record<Phase, string> = {
      forming: "enemies forming up",
      playerTurn: "YOUR TURN",
      resolving: cur.fleeing ? "fleeing: enemies act first" : "ENEMY TURN",
      unforming: "escaped, enemies falling back",
    };
    const inc = incomingDamage();
    const after = Math.max(0, inc - player.block);
    hud.turn.text =
      `Turn ${cur.turnNumber} · ${phaseLabel[cur.phase]}` +
      (cur.phase === "playerTurn" ? ` · incoming ${inc} dmg (${after} after block)` : "");
    hud.piles.text = `draw ${piles.draw.length} · discard ${piles.discard.length} · exhausted ${piles.exhaust.length}`;
  } else {
    hud.turn.text = "";
    hud.piles.text = "";
  }
  hud.feedback.text = now < feedbackUntil ? feedbackMessage : "";

  const actable = canAct();
  endTurnButton.color = actable ? k.rgb(60, 110, 60) : k.rgb(45, 45, 45);
  fleeButton.color = actable ? k.rgb(120, 60, 60) : k.rgb(45, 45, 45);
  endTurnButton.opacity = fleeButton.opacity = cur ? 1 : 0.4;

  if (totalCards(piles) !== DECK_SIZE) {
    console.error("card count drifted", totalCards(piles), piles);
  }

  if (runState === "playing" && player.hp <= 0) finishDeath();
  if (runState === "playing" && !enemies.some((e) => e.exists())) runState = "won";

  hud.status.text =
    runState === "dead" ? "You fell - press R to restart" : runState === "won" ? "Area cleared - press R to restart" : "";
});
