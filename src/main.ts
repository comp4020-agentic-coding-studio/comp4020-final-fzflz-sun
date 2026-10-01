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
import { BOSS_BOX, boxAt, clampCam, formationBounds, layoutFormation, planCamera, TRASH_BOX, type Rect, type Viewport } from "./formation.ts";
import { SaveClient, type SavePayload, type SaveStatus } from "./net.ts";
import { clearedAreas, killedCount, newRun, type CheckpointReason, type SaveData } from "./save.ts";
import { separate } from "./separation.ts";
import {
  type Intent,
  type Phase,
  type PhaseEvent,
  type ResolvePlan,
  canAct as canActRule,
  planResolve,
  transition,
} from "./turn.ts";
import {
  AREAS,
  ENEMY_SPAWNS,
  PLAYER_EDGE,
  PLAYER_MAX_HP,
  PLAYER_START,
  TRASH_HP,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./world.ts";

// Exploration is real-time (chase, leash, light separation); a fight locks the
// roster, eases enemies into readable slots, then runs strict turns: player
// turn -> enemy resolve (one action at a time) -> next turn. The run is saved
// on the server at stable checkpoints. HUD, hand and menus are HTML over the
// canvas so they stay readable and tappable at any viewport size.

const DEV = import.meta.env.DEV;
const params = new URLSearchParams(location.search);
// ?fight= is a development-only shortcut; it never runs (or saves) in production.
const FIGHT_PARAM = DEV ? params.get("fight") : null;

// ---------- tunables ----------

const PLAYER_SPEED = 220;
const PLAYER_MAX_ENERGY = 3;
const HAND_SIZE = 4;

const TRASH_AGGRO_RANGE = 210;
const TRASH_ENGAGE_RANGE = 40;
const TRASH_SPEED = 100;
const TRASH_ATK_DAMAGE = 3;
const TRASH_RADIUS = 14;

const BOSS_AGGRO_RANGE = 260;
const BOSS_ENGAGE_RANGE = 46;
const BOSS_SPEED = 78;
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
const LOAD_IMMUNITY = 2.5; // after restoring a checkpoint, a moment to get your bearings
const END_GRACE = 0.3;

// Enemy-enemy spacing only (the player is never pushed). Trash-trash minimum
// is 14+14+6 = 34, under the 40 engage range, so a crowd can still close in.
const SEPARATION_PADDING = 6;
const SEPARATION_SPEED = 160;
const BOSS_MASS = 2.2;
const TRASH_MASS = 1;

const FORM_DURATION = 0.3;
const ENEMY_ACTION_GAP = 0.45;

const CAM_LERP_RATE = 4;
const CAM_MAX_ZOOM_SMALL = 1.5;
const CAM_MAX_ZOOM_LARGE = 1.2;
const BOSS_DANGER_BONUS = 3;
const DANGER_THRESHOLD = 3;

const FEEDBACK_MS = 1600;
const HIT_FLASH_DURATION = 0.15;

// Label offsets match TRASH_BOX / BOSS_BOX in formation.ts.
const TRASH_LABELS = { hp: -24, intent: -42, marker: -60 };
const BOSS_LABELS = { hp: -40, intent: -68, marker: -98 };

// ---------- DOM ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  hp: $("hp"),
  energy: $("energy"),
  state: $("state"),
  turn: $("turn"),
  piles: $("piles"),
  progress: $("progress"),
  feedback: $("feedback"),
  savePill: $<HTMLButtonElement>("savePill"),
  menuBtn: $<HTMLButtonElement>("menuBtn"),
  topbar: $("topbar"),
  overflow: $("overflow"),
  overflowTitle: $("overflowTitle"),
  overflowList: $("overflowList"),
  dock: $("dock"),
  hint: $("hint"),
  hand: $("hand"),
  endTurn: $<HTMLButtonElement>("endTurn"),
  flee: $<HTMLButtonElement>("flee"),
  screen: $("screen"),
  panel: $("panel"),
};

function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
function showFeedback(msg: string) {
  setText(ui.feedback, msg);
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => setText(ui.feedback, ""), FEEDBACK_MS);
}

// ---------- engine ----------

const k = kaplay({
  root: $("game"),
  background: [17, 17, 17],
  pixelDensity: Math.min(window.devicePixelRatio || 1, 2),
  global: false,
  debug: DEV,
});
k.setGravity(0);

const PLAYER_COLOR = k.rgb(80, 160, 255);
const TRASH_COLOR = k.rgb(220, 70, 70);
const BOSS_COLOR = k.rgb(160, 60, 200);

type Vec2 = ReturnType<typeof k.vec2>;
type Timer = ReturnType<typeof k.wait>;

// ---------- layout (viewport-driven) ----------

/** Screen px per world unit while exploring: about a 960x540 world view, never wider than the map. */
function baseScale(): number {
  const w = k.width();
  const h = k.height();
  const fit = Math.min(Math.max(Math.min(w / 960, h / 540), 1), 2.2);
  return Math.max(fit, w / WORLD_WIDTH, h / WORLD_HEIGHT);
}

/** Part of the canvas not covered by the HTML HUD, dock or side list, measured from the real DOM. */
function measureSafe(): Rect {
  const w = k.width();
  const h = k.height();
  let top = ui.topbar.getBoundingClientRect().bottom + 6;
  let right = w - 8;
  let bottom = h - 6;
  if (document.body.classList.contains("fighting")) bottom = ui.dock.getBoundingClientRect().top - 6;
  if (!ui.overflow.hidden) {
    const o = ui.overflow.getBoundingClientRect();
    if (w <= 640) top = Math.max(top, o.bottom + 6);
    else right = Math.min(right, o.left - 6);
  }
  return { x0: 8, y0: top, x1: right, y1: Math.max(bottom, top + 60) };
}

function viewport(): Viewport {
  return { viewW: k.width(), viewH: k.height(), worldW: WORLD_WIDTH, worldH: WORLD_HEIGHT, safe: measureSafe(), baseScale: baseScale() };
}

function placeOverflowPanel() {
  ui.overflow.style.top = `${ui.topbar.getBoundingClientRect().bottom + 6}px`;
}

// ---------- player / run state ----------

const player = k.add([
  k.pos(PLAYER_START.x, PLAYER_START.y),
  k.circle(16),
  k.color(PLAYER_COLOR),
  k.area(),
  k.anchor("center"),
  k.z(10),
  "player",
  { hp: PLAYER_MAX_HP, energy: PLAYER_MAX_ENERGY, block: 0 },
]);

type RunState = "menu" | "playing" | "dead" | "won";
let piles: Piles = newPiles();
let selectedTarget: Enemy | null = null;
let runState: RunState = "menu";
let encounterCooldownUntil = 0;
let run: SaveData | null = null; // the run being played: identity + stats; enemies/player live in the world
let lastSavedAt = 0;
let moveTarget: Vec2 | null = null;
const held = new Set<string>();

const saveClient = new SaveClient();

let pendingTimers: Timer[] = [];
function schedule(seconds: number, fn: () => void) {
  pendingTimers.push(k.wait(seconds, fn));
}
function cancelPending() {
  for (const t of pendingTimers) t.cancel();
  pendingTimers = [];
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
// Area names on the ground, so "camps cleared" points at somewhere real.
const AREA_LABEL_POS: Record<string, { x: number; y: number }> = {
  west: { x: 730, y: 330 }, south: { x: 650, y: 880 }, north: { x: 1305, y: 160 }, lair: { x: 1800, y: 560 },
};
const areaLabels = new Map<string, { text: string }>();
for (const a of AREAS) {
  const p = AREA_LABEL_POS[a.id];
  areaLabels.set(a.id, k.add([k.text(a.name, { size: 14 }), k.pos(p.x, p.y), k.anchor("center"), k.color(110, 110, 120), k.z(-80)]));
}

// ---------- enemies ----------

type EnemyState = "idle" | "chasing" | "returning" | "engaged";
let nextEnemyId = 1;

function spawnEnemy(x: number, y: number, hp: number, maxHp: number, isBoss: boolean, spawnId: string | null) {
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
      enemyId: nextEnemyId++, // runtime only; saves use spawnId
      spawnId,
      hp,
      maxHp,
      block: 0,
      home: k.vec2(x, y),
      state: "idle" as EnemyState,
      isBoss,
      bodyRadius: isBoss ? BOSS_RADIUS : TRASH_RADIUS, // not "radius": rect() owns that name
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
    k.text(String(hp), { size: isBoss ? 16 : 13 }),
    k.pos(0, labels.hp),
    k.anchor("center"),
    k.color(255, 255, 255),
    k.opacity(1),
    "enemyHpLabel",
  ]);
  enemy.add([
    k.text("", { size: 14, align: "center" }),
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

let enemies: Enemy[] = [];

function hpLabelOf(e: Enemy) {
  return e.get("enemyHpLabel")[0];
}
function stateLabelOf(e: Enemy) {
  return e.get("enemyStateLabel")[0];
}
function enemyName(e: Enemy) {
  return e.isBoss ? "Boss" : `Grunt ${e.spawnId ?? e.enemyId}`;
}
// Never put square brackets in Kaplay text: [x] is a style tag and an
// unmatched one throws, halting the game loop.
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
  anchor: { x: number; y: number };
}
let activeEncounter: Encounter | null = null;
let nextEncounterId = 1;

const playing = () => runState === "playing";
function canAct() {
  return runState === "playing" && !screenOpen() && canActRule(activeEncounter?.phase ?? null, "playing");
}

function setPhase(enc: Encounter, ev: PhaseEvent): boolean {
  const next = transition(enc.phase, ev);
  if (!next) return false;
  enc.phase = next;
  enc.phaseStartedAt = k.time();
  return true;
}

function blockedReason(): string {
  if (runState !== "playing") return "the run is over";
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

function cycleTarget(dir: number) {
  const alive = aliveRoster();
  if (!alive.length) return;
  // left-to-right on screen for on-stage enemies, then the side list
  const order = [...alive.filter((e) => !e.overflow).sort((a, b) => a.pos.x - b.pos.x), ...alive.filter((e) => e.overflow)];
  const i = selectedTarget ? order.indexOf(selectedTarget) : -1;
  selectedTarget = order[(i + dir + order.length) % order.length];
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

// ---------- checkpoints ----------

function aliveMapEnemy(spawnId: string) {
  return enemies.find((e) => e.spawnId === spawnId && e.exists());
}

/**
 * The logical world state at a stable moment: player HP and position, every
 * map enemy's HP by stable id (0 = killed). Enemy positions are not saved; on
 * restore they stand at their home spot, so formation slots never leak into a save.
 */
function checkpoint(reason: CheckpointReason): SaveData | null {
  if (!run) return null;
  const enemiesHp = Object.fromEntries(ENEMY_SPAWNS.map((s) => [s.id, Math.max(0, aliveMapEnemy(s.id)?.hp ?? 0)]));
  const allDead = ENEMY_SPAWNS.every((s) => enemiesHp[s.id] === 0);
  const dead = runState === "dead";
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1);
  run = {
    ...run,
    savedAt: lastSavedAt,
    reason,
    outcome: dead ? "dead" : allDead ? "won" : "playing",
    player: {
      hp: dead ? 0 : Math.max(1, player.hp),
      x: k.clamp(Math.round(player.pos.x), PLAYER_EDGE, WORLD_WIDTH - PLAYER_EDGE),
      y: k.clamp(Math.round(player.pos.y), PLAYER_EDGE, WORLD_HEIGHT - PLAYER_EDGE),
    },
    enemies: enemiesHp,
    stats: { ...run.stats },
  };
  return run;
}

function saveCheckpoint(reason: CheckpointReason) {
  const cp = checkpoint(reason);
  if (cp) saveClient.save(cp);
}

// ---------- encounter flow ----------

function tryTriggerEncounter(now: number) {
  const instigator = enemies.find(
    (e) => e.exists() && e.state === "chasing" && e.pos.dist(player.pos) <= e.engageRange,
  );
  if (!instigator) return;
  const roster = enemies.filter(
    (e) => e.exists() && e.state === "chasing" && e.pos.dist(player.pos) <= JOIN_RADIUS,
  );

  // The pre-fight checkpoint: closing the tab mid-fight comes back to here.
  if (run) run.stats.fights++;
  saveCheckpoint("engage");

  moveTarget = null;
  document.body.classList.add("fighting");
  const anchor = { x: player.pos.x, y: player.pos.y };
  const units = roster.map((e) => ({ id: e.enemyId, isBoss: e.isBoss, pos: { x: e.pos.x, y: e.pos.y } }));
  // Slots are assigned once, from the real space left between HUD and hand.
  // If some don't fit, the side list appears and the stage is re-measured.
  ui.overflow.hidden = true;
  let formation = layoutFormation(units, anchor, viewport());
  if (formation.overflow.length) {
    ui.overflow.hidden = false;
    placeOverflowPanel();
    formation = layoutFormation(units, anchor, viewport());
  }
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

  activeEncounter = {
    id: nextEncounterId++,
    roster,
    difficulty: computeDifficulty(roster),
    camPos: k.vec2(player.pos.x, player.pos.y),
    camScale: baseScale(),
    phase: "forming",
    fleeing: false,
    turnNumber: 1,
    phaseStartedAt: now,
    anchor,
  };
  replanCamera(activeEncounter, true);
  player.block = 0;
  selectedTarget = roster.find((e) => e.isBoss && !e.overflow) ?? roster.find((e) => !e.overflow) ?? roster[0];
  renderHand();
}

/** Frames the fight inside the current safe area; re-run on resize. Uses final slots, not pre-fight positions. */
function replanCamera(enc: Encounter, useSlots: boolean) {
  const base = baseScale();
  const shown = enc.roster.filter((e) => e.exists() && !e.overflow);
  const units = shown.map((e) => {
    const p = useSlots && e.formTo ? e.formTo : e.pos;
    return { id: e.enemyId, isBoss: e.isBoss, pos: { x: p.x, y: p.y } };
  });
  const slots = new Map(units.map((u) => [u.id, u.pos]));
  const bounds = formationBounds(units, slots, enc.anchor);
  const core = units.length ? enemyBounds(units, slots) : bounds;
  const max = enc.difficulty === "dangerous" ? base * (enc.roster.length >= 3 ? CAM_MAX_ZOOM_LARGE : CAM_MAX_ZOOM_SMALL) : base;
  // min below base: only used if the window got too small to show the fight at exploration zoom
  const cam = planCamera(bounds, viewport(), { min: base * 0.5, max }, core);
  enc.camPos = k.vec2(cam.center.x, cam.center.y);
  enc.camScale = cam.scale;
}

function enemyBounds(units: { id: number; isBoss: boolean }[], slots: Map<number, { x: number; y: number }>): Rect {
  const rects = units.map((u) => boxAt(slots.get(u.id)!, u.isBoss ? BOSS_BOX : TRASH_BOX));
  return {
    x0: Math.min(...rects.map((r) => r.x0)),
    y0: Math.min(...rects.map((r) => r.y0)),
    x1: Math.max(...rects.map((r) => r.x1)),
    y1: Math.max(...rects.map((r) => r.y1)),
  };
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
  // An enemy's DEF block covered the player turn that just ended; it expires now.
  for (const e of enc.roster) {
    if (!e.exists()) continue;
    e.block = 0;
    refreshHpLabel(e);
  }
  const plan = planResolve(
    { hp: player.hp, block: player.block },
    enc.roster.map((e) => ({ id: e.enemyId, alive: e.exists(), intent: e.intent })),
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
      showFeedback(`${enemyName(e)} hits for ${ev.intent.value}` + (absorbed > 0 ? ` (${absorbed} blocked)` : ""));
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
  if (run) run.stats.flees++;
  saveCheckpoint("flee");
}

function finishVictory() {
  encounterCooldownUntil = k.time() + END_GRACE;
  cleanupEncounter();
  if (run) run.stats.wins++;
  const cleared = !enemies.some((e) => e.exists());
  if (cleared) runState = "won";
  saveCheckpoint("victory");
  if (cleared) showEndScreen();
  else showFeedback("Victory");
}

function finishDeath() {
  cancelPending();
  endEncounterPiles(piles);
  runState = "dead";
  activeEncounter = null;
  document.body.classList.remove("fighting");
  ui.overflow.hidden = true;
  renderHand();
  saveCheckpoint("death");
  showEndScreen();
}

function cleanupEncounter() {
  cancelPending();
  endEncounterPiles(piles);
  player.block = 0;
  selectedTarget = null;
  activeEncounter = null;
  document.body.classList.remove("fighting");
  ui.overflow.hidden = true;
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
    enemy.hp = 0;
    k.destroy(enemy);
    if (run && enemy.spawnId) run.stats.kills++;
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

const requestEndTurn = () => endPlayerTurn(false);
const flee = () => endPlayerTurn(true);

// ---------- HUD (HTML) ----------

let handSignature = "";
function renderHand() {
  const playable = canAct();
  const sig = JSON.stringify([piles.hand.map((c) => c.name), player.energy, playable]);
  if (sig === handSignature) return;
  handSignature = sig;
  ui.hand.replaceChildren(
    ...Array.from({ length: HAND_SIZE }, (_, i) => {
      const card = piles.hand[i];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "card";
      if (!card) {
        b.classList.add("empty");
        b.tabIndex = -1;
        return b;
      }
      const affordable = playable && player.energy >= card.cost;
      if (!affordable) {
        b.classList.add("cant");
        b.setAttribute("aria-disabled", "true");
      }
      b.innerHTML = `<span class="name"></span><span class="cost"></span><span class="blurb"></span>`;
      (b.children[0] as HTMLElement).textContent = `${i + 1}. ${card.name}`;
      (b.children[1] as HTMLElement).textContent = `${card.cost} energy`;
      (b.children[2] as HTMLElement).textContent = card.blurb;
      b.setAttribute("aria-label", `${card.name}, costs ${card.cost} energy: ${card.blurb}. Key ${i + 1}`);
      b.addEventListener("click", () => playCardAt(i));
      return b;
    }),
  );
}

let overflowSignature = "";
function renderOverflow() {
  const list = overflowList();
  const show = list.length > 0 && !!activeEncounter && activeEncounter.phase !== "unforming";
  if (ui.overflow.hidden === show) ui.overflow.hidden = !show;
  if (!show) return;
  const sig = JSON.stringify(list.map((e) => [e.enemyId, e.hp, e.block, intentText(e), e === selectedTarget]));
  if (sig === overflowSignature) return;
  overflowSignature = sig;
  setText(ui.overflowTitle, `+${list.length} more in this fight (not on screen)`);
  ui.overflowList.replaceChildren(
    ...list.map((e) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `${enemyName(e)} · ${e.hp} HP${e.block ? ` (blk ${e.block})` : ""} · ${intentText(e).replace("\n", " ")}`;
      b.setAttribute("aria-pressed", String(e === selectedTarget));
      b.addEventListener("click", () => selectTarget(e));
      return b;
    }),
  );
}

/** Live view of what the next checkpoint would hold (for HUD counts), without saving. */
function checkpointPreview(): SaveData {
  const base = run ?? newRun("run_preview00", 1, 0);
  return { ...base, enemies: Object.fromEntries(ENEMY_SPAWNS.map((s) => [s.id, Math.max(0, aliveMapEnemy(s.id)?.hp ?? 0)])) };
}

function renderHud() {
  setText(ui.hp, `HP ${player.hp}/${PLAYER_MAX_HP}${player.block > 0 ? ` (block ${player.block})` : ""}`);
  setText(ui.energy, `Energy ${player.energy}/${PLAYER_MAX_ENERGY}`);
  const cur = activeEncounter;
  setText(
    ui.state,
    cur
      ? `${cur.difficulty === "dangerous" ? "DANGEROUS fight" : "Fight"}: ${aliveRoster().length} foe(s) alive`
      : runState === "playing"
        ? "Exploring"
        : runState === "dead"
          ? "Fallen"
          : runState === "won"
            ? "All camps cleared"
            : "",
  );
  if (cur) {
    const phaseLabel: Record<Phase, string> = {
      forming: "enemies forming up",
      playerTurn: "YOUR TURN",
      resolving: cur.fleeing ? "fleeing: enemies act first" : "ENEMY TURN",
      unforming: "escaped, enemies falling back",
    };
    const inc = aliveRoster().reduce((s, e) => s + (e.intent?.kind === "attack" ? e.intent.value : 0), 0);
    setText(
      ui.turn,
      `Turn ${cur.turnNumber} · ${phaseLabel[cur.phase]}` +
        (cur.phase === "playerTurn" ? ` · incoming ${inc} (${Math.max(0, inc - player.block)} after block)` : ""),
    );
    setText(ui.piles, `draw ${piles.draw.length} · discard ${piles.discard.length} · exhausted ${piles.exhaust.length}`);
  } else {
    setText(ui.turn, "");
    setText(ui.piles, "");
  }
  if (run) {
    const cleared = clearedAreas(checkpointPreview()).length;
    setText(ui.progress, `Run #${run.runNumber} · camps cleared ${cleared}/${AREAS.length} · kills ${run.stats.kills}`);
  } else setText(ui.progress, "");
  const actable = canAct();
  ui.endTurn.disabled = !actable;
  ui.flee.disabled = !actable;
  setText(
    ui.hint,
    runState === "playing" && !cur
      ? "Move: WASD / arrow keys, or tap and hold on the map. Lure enemies; everyone chasing you joins the fight."
      : "",
  );
}

function renderSaveStatus(s: SaveStatus) {
  const pill = ui.savePill;
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const set = (text: string, cls: string, title: string) => {
    setText(pill, text);
    pill.className = cls;
    pill.title = title;
  };
  switch (s.kind) {
    case "idle":
      return set("Not saved yet", "", "Your run saves on the server when a fight starts, and after you win, flee or fall.");
    case "saving":
      return set("Saving…", "busy", "Sending this checkpoint to the server");
    case "saved":
      return set(`Saved ✓ ${time(s.at)}`, "ok", "The server confirmed this checkpoint");
    case "retrying":
      return set(`Save failed - retrying (${s.attempt}/5)…`, "busy bad", s.error);
    case "failed":
      return set(s.retryable ? "Not saved - tap to retry" : "Save rejected", "bad", s.error);
    case "conflict":
      return set("Out of date - reload", "bad", s.error);
    case "off":
      return set(s.why, "bad", s.why);
  }
}

// ---------- screens (HTML modal) ----------

let screenCloseable = false;
const screenOpen = () => !ui.screen.hidden;

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function showScreen(html: string, handlers: Record<string, () => void> = {}, closeable = false) {
  ui.panel.innerHTML = html;
  for (const [id, fn] of Object.entries(handlers)) {
    ui.panel.querySelector<HTMLElement>(`#${id}`)?.addEventListener("click", fn);
  }
  ui.screen.hidden = false;
  screenCloseable = closeable;
  held.clear();
  moveTarget = null;
  (ui.panel.querySelector<HTMLElement>(".primary") ?? ui.panel.querySelector<HTMLElement>("button"))?.focus();
}

function hideScreen() {
  ui.screen.hidden = true;
  screenCloseable = false;
  renderHand();
}

const HOW_TO = `
<h2>How to play</h2>
<ul>
  <li><b>Goal:</b> clear the four enemy camps. Walk near enemies to draw them out; everyone chasing you when one reaches you joins that fight, so you choose how many you take on.</li>
  <li><b>Move:</b> WASD or arrow keys, or tap and hold on the map.</li>
  <li><b>Fight:</b> each turn you get 3 energy and 4 cards. Tap an enemy (or ←/→) to target, tap a card (or 1-4) to play it. Each enemy shows what it will do; nothing happens until you <b>End turn</b> (Space).</li>
  <li><b>Block</b> soaks damage during the enemy turn, then clears. <b>Flee</b> (F): enemies still take their shown actions, then you escape if you survive.</li>
  <li><b>Saving:</b> your run is saved on the server when a fight starts and after you win, flee or fall. Closing mid-fight brings you back to the moment that fight started.</li>
</ul>`;

function relTime(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

const REASON_TEXT: Record<CheckpointReason, string> = {
  start: "at the start of the run",
  engage: "as a fight began",
  victory: "after a victory",
  flee: "after escaping a fight",
  death: "when you fell",
};

function summaryHtml(s: SaveData) {
  const cleared = clearedAreas(s);
  const names = AREAS.filter((a) => cleared.includes(a.id)).map((a) => a.name);
  return `<div class="summary">
    <b>Run #${s.runNumber}</b> · ${s.outcome === "playing" ? `HP ${s.player.hp}/${PLAYER_MAX_HP}` : s.outcome === "dead" ? "fallen" : "all camps cleared"}<br>
    Camps cleared: ${cleared.length}/${AREAS.length}${names.length ? ` (${escapeHtml(names.join(", "))})` : ""} · kills ${killedCount(s)} · fights won ${s.stats.wins} · fled ${s.stats.flees}<br>
    <span class="note">Saved ${relTime(s.savedAt)}, ${REASON_TEXT[s.reason]}.</span>
  </div>`;
}

function historyHtml(p: SavePayload) {
  if (!p.runs.length) return "";
  const rows = p.runs
    .map((r) => `<tr><td>#${r.runNumber}</td><td>${escapeHtml(r.outcome)}</td><td>${r.kills} kills</td><td>${new Date(r.endedAt).toLocaleDateString()}</td></tr>`)
    .join("");
  return `<h2>Earlier runs</h2><table><tbody>${rows}</tbody></table>`;
}

let lastPayload: SavePayload | null = null;

function showStartScreen(p: SavePayload) {
  lastPayload = p;
  const s = p.save;
  if (!s) {
    return showScreen(
      `<h1 id="panelTitle">Camp Clearer</h1>
       <p>A short card-battle trek. Choose which enemies to pull into each fight, read what they're about to do, and play your hand. Your progress is kept on the server for this browser, no account needed.</p>
       ${HOW_TO}
       <div class="buttons"><button class="primary" id="go">Start a run</button><a href="/readme/" target="_blank" rel="noopener">What makes this good? (README)</a></div>`,
      { go: () => void beginNewRun() },
    );
  }
  if (s.outcome === "playing") {
    return showScreen(
      `<h1 id="panelTitle">Welcome back</h1>
       <p>Your saved progress was found on the server:</p>
       ${summaryHtml(s)}
       <div class="buttons"><button class="primary" id="go">Continue run #${s.runNumber}</button><button id="new">New run…</button></div>
       ${HOW_TO}${historyHtml(p)}
       <p class="note"><button id="erase" class="danger">Erase my saved data…</button></p>`,
      { go: () => startFromSave(s, true), new: () => confirmNewRun(p), erase: () => confirmErase(p) },
    );
  }
  showScreen(
    `<h1 id="panelTitle">${s.outcome === "won" ? "Run complete" : "Your last run ended"}</h1>
     ${summaryHtml(s)}
     <p>That run is kept in your history. Starting a new one doesn't delete anything.</p>
     <div class="buttons"><button class="primary" id="go">Start run #${s.runNumber + 1}</button></div>
     ${HOW_TO}${historyHtml(p)}
     <p class="note"><button id="erase" class="danger">Erase my saved data…</button></p>`,
    { go: () => void beginNewRun(), erase: () => confirmErase(p) },
  );
}

function confirmNewRun(p: SavePayload) {
  const s = run ?? p.save;
  showScreen(
    `<h1 id="panelTitle">Start a new run?</h1>
     ${s && s.outcome === "playing" ? `<p>Run #${s.runNumber} will be recorded in your history as <b>abandoned</b>. Its last saved checkpoint is kept; nothing is deleted.</p>` : ""}
     <div class="buttons"><button class="primary" id="yes">Start new run</button><button id="no">Cancel</button></div>`,
    { yes: () => void beginNewRun(), no: () => (runState === "menu" ? showStartScreen(p) : hideScreen()) },
  );
}

function confirmErase(p: SavePayload) {
  showScreen(
    `<h1 id="panelTitle">Erase saved data</h1>
     <p>This deletes your current run <b>and</b> your run history from the server for this browser. It can't be undone.</p>
     <p><label>Type <b>ERASE</b> to confirm: <input id="eraseWord" autocomplete="off"></label></p>
     <div class="buttons"><button class="danger" id="yes">Erase everything</button><button class="primary" id="no">Keep my data</button></div>`,
    {
      yes: async () => {
        const word = ui.panel.querySelector<HTMLInputElement>("#eraseWord")?.value.trim();
        if (word !== "ERASE") return showFeedbackInPanel("Type ERASE exactly to confirm.");
        try {
          const fresh = await saveClient.erase();
          resetToMenu();
          showStartScreen(fresh);
        } catch (e) {
          showFeedbackInPanel(`Couldn't erase: ${(e as Error).message}`);
        }
      },
      no: () => (runState === "menu" ? showStartScreen(p) : hideScreen()),
    },
  );
}

function showFeedbackInPanel(msg: string) {
  let el = ui.panel.querySelector<HTMLElement>(".panelMsg");
  if (!el) {
    el = document.createElement("p");
    el.className = "panelMsg";
    el.setAttribute("role", "alert");
    el.style.color = "var(--bad)";
    ui.panel.append(el);
  }
  el.textContent = msg;
}

function showLoadError(err: unknown) {
  showScreen(
    `<h1 id="panelTitle">Can't reach the server</h1>
     <p>Your saved progress couldn't be loaded (${escapeHtml(err instanceof Error ? err.message : "network error")}). Starting now would not use your save.</p>
     <div class="buttons"><button class="primary" id="retry">Try again</button><button id="offline">Play without saving</button></div>`,
    {
      retry: () => void boot(),
      offline: () => {
        saveClient.disable("Not saving (offline)");
        startFromSave(newRun("run_offline00", 1, Date.now()), false);
      },
    },
  );
}

function showConflictScreen(msg: string) {
  showScreen(
    `<h1 id="panelTitle">Progress changed elsewhere</h1>
     <p>${escapeHtml(msg)}. To avoid overwriting it, this tab stopped saving.</p>
     <div class="buttons"><button class="primary" id="reload">Reload with the latest save</button></div>`,
    { reload: () => location.reload() },
  );
}

function openMenu() {
  if (runState === "menu" || screenOpen()) return;
  const status = saveClient.status;
  const saveLine =
    status.kind === "saved"
      ? "Your last checkpoint is saved on the server."
      : status.kind === "off"
        ? "Progress is not being saved in this session."
        : "Saving: see the status at the top right.";
  const p = lastPayload ?? { revision: 0, save: null, runs: [] };
  showScreen(
    `<h1 id="panelTitle">Menu</h1>
     ${run ? summaryHtml(checkpointPreview()) : ""}
     <p class="note">${saveLine} ${activeEncounter ? "This fight isn't saved until it ends; closing now returns you to when it started." : ""}</p>
     <div class="buttons"><button class="primary" id="resume">Resume</button><button id="new">New run…</button><a href="/readme/" target="_blank" rel="noopener">README</a></div>
     ${HOW_TO}
     <p class="note"><button id="erase" class="danger">Erase my saved data…</button></p>`,
    { resume: hideScreen, new: () => confirmNewRun(p), erase: () => confirmErase(p) },
    true,
  );
}

function showEndScreen() {
  const s = run;
  if (!s) return;
  const won = runState === "won";
  showScreen(
    `<h1 id="panelTitle">${won ? "All camps cleared!" : "You fell"}</h1>
     ${summaryHtml(checkpointPreview())}
     <p id="endSave" class="note">Saving this result…</p>
     <div class="buttons"><button class="primary" id="go">Start run #${s.runNumber + 1}</button><a href="/readme/" target="_blank" rel="noopener">README</a></div>
     <p class="note">Key: R starts a new run. Your finished run stays in your history.</p>`,
    { go: () => void beginNewRun() },
  );
  updateEndSaveLine();
}

function updateEndSaveLine() {
  const el = ui.panel.querySelector<HTMLElement>("#endSave");
  if (!el) return;
  const s = saveClient.status;
  el.textContent =
    s.kind === "saved"
      ? "Result saved on the server."
      : s.kind === "off"
        ? "Not saved (saving is off in this session)."
        : s.kind === "failed" || s.kind === "conflict"
          ? `Result NOT saved: ${s.error}`
          : "Saving this result…";
}

saveClient.onStatus((s) => {
  renderSaveStatus(s);
  updateEndSaveLine();
  if (s.kind === "conflict") showConflictScreen(s.error);
});
renderSaveStatus(saveClient.status);
ui.savePill.addEventListener("click", () => {
  if (saveClient.status.kind === "failed" && saveClient.status.retryable) saveClient.retryNow();
  else if (saveClient.status.kind === "conflict") location.reload();
});
ui.endTurn.addEventListener("click", requestEndTurn);
ui.flee.addEventListener("click", flee);
ui.menuBtn.addEventListener("click", () => openMenu());

// ---------- run lifecycle ----------

async function beginNewRun() {
  if (!saveClient.enabled) {
    startFromSave(newRun(`run_offline${Date.now()}`, (run?.runNumber ?? 0) + 1, Date.now()), false);
    return;
  }
  showScreen(`<h1 id="panelTitle">Starting a run…</h1><p>Asking the server for a fresh run.</p>`);
  try {
    const p = await saveClient.startRun();
    lastPayload = p;
    if (p.save) startFromSave(p.save, false);
  } catch (e) {
    if ((e as { status?: number }).status === 409) return showConflictScreen((e as Error).message);
    showScreen(
      `<h1 id="panelTitle">Couldn't start a run</h1><p>${escapeHtml((e as Error).message)}. Nothing was changed.</p>
       <div class="buttons"><button class="primary" id="retry">Try again</button></div>`,
      { retry: () => void beginNewRun() },
    );
  }
}

function clearWorld() {
  cancelPending();
  for (const e of k.get("enemy")) k.destroy(e);
  enemies = [];
  activeEncounter = null;
  selectedTarget = null;
  moveTarget = null;
  document.body.classList.remove("fighting");
  ui.overflow.hidden = true;
}

function resetToMenu() {
  clearWorld();
  run = null;
  runState = "menu";
}

/** Rebuilds the world from a checkpoint: enemies at home with their saved HP; killed ones stay gone. */
function startFromSave(save: SaveData, restored: boolean) {
  clearWorld();
  run = JSON.parse(JSON.stringify(save)) as SaveData;
  lastSavedAt = save.savedAt;
  for (const s of ENEMY_SPAWNS) {
    const hp = save.enemies[s.id] ?? s.maxHp;
    if (hp > 0) enemies.push(spawnEnemy(s.x, s.y, hp, s.maxHp, s.boss, s.id));
  }
  player.pos = k.vec2(save.player.x, save.player.y);
  player.hp = save.player.hp;
  player.energy = PLAYER_MAX_ENERGY;
  player.block = 0;
  player.color = PLAYER_COLOR;
  piles = newPiles();
  encounterCooldownUntil = k.time() + LOAD_IMMUNITY;
  runState = save.outcome === "playing" ? "playing" : save.outcome;
  k.setCamScale(baseScale(), baseScale());
  k.setCamPos(player.pos);
  hideScreen();
  if (restored) showFeedback(`Restored run #${save.runNumber} from ${relTime(save.savedAt)} (${REASON_TEXT[save.reason]})`);
}

// ---------- input ----------

const MOVE_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"]);
document.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (screenOpen()) {
    if (key === "escape" && screenCloseable) hideScreen();
    return;
  }
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  const fighting = !!activeEncounter;
  if (MOVE_KEYS.has(key)) {
    e.preventDefault();
    if (fighting && (key === "arrowleft" || key === "arrowright")) {
      if (!e.repeat) cycleTarget(key === "arrowleft" ? -1 : 1);
      return;
    }
    held.add(key);
    moveTarget = null;
    return;
  }
  if (e.repeat) return;
  if (/^[1-9]$/.test(key)) playCardAt(Number(key) - 1);
  else if (key === " ") {
    e.preventDefault(); // Space ends the turn, never "clicks" whichever button has focus
    requestEndTurn();
  } else if (key === "f") flee();
  else if (key === "q" || key === "e") cycleTarget(key === "q" ? -1 : 1);
  else if (key === "escape") openMenu();
  else if (key === "r" && (runState === "dead" || runState === "won")) void beginNewRun();
});
document.addEventListener("keyup", (e) => held.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => held.clear());

// Tap / click and hold on the map to walk there (the HTML HUD sits above the
// canvas, so taps on buttons never reach this).
k.onMousePress(() => {
  if (!playing() || activeEncounter || screenOpen()) return;
  moveTarget = k.toWorld(k.mousePos());
});

window.addEventListener("beforeunload", (e) => {
  if (saveClient.unsaved) e.preventDefault();
});

// Re-frame a fight whenever the space it was framed for changes: a window
// resize, or the HTML HUD / dock / side list changing size.
function onLayoutChange() {
  placeOverflowPanel();
  if (activeEncounter && activeEncounter.phase !== "unforming") replanCamera(activeEncounter, activeEncounter.phase === "forming");
}
k.onResize(onLayoutChange);
const layoutObserver = new ResizeObserver(onLayoutChange);
for (const el of [ui.topbar, ui.dock, ui.overflow]) layoutObserver.observe(el);

// ---------- dev-only test fights ----------

// ?fight=GRUNTS,BOSS,X,Y puts the player at (X,Y) with that many grunts (plus
// the boss if BOSS=1) stacked on one point beside them. Development builds
// only, and saving is switched off so a test never writes a real save.
function applyFightParam(raw: string) {
  const [grunts = 3, withBoss = 0, x = 1100, y = 650] = raw.split(",").map(Number);
  player.pos = k.vec2(k.clamp(x, PLAYER_EDGE, WORLD_WIDTH - PLAYER_EDGE), k.clamp(y, PLAYER_EDGE, WORLD_HEIGHT - PLAYER_EDGE));
  const side = player.pos.x > WORLD_WIDTH / 2 ? -1 : 1;
  const spot = k.vec2(k.clamp(player.pos.x + side * 30, 30, WORLD_WIDTH - 30), player.pos.y);
  for (let n = enemies.filter((e) => !e.isBoss).length; n < grunts; n++) {
    enemies.push(spawnEnemy(spot.x, spot.y, TRASH_HP, TRASH_HP, false, null));
  }
  const picked = [...enemies.filter((e) => !e.isBoss).slice(0, grunts), ...(withBoss ? enemies.filter((e) => e.isBoss) : [])];
  for (const e of picked) {
    e.pos = spot.clone();
    e.state = "chasing";
  }
  encounterCooldownUntil = 0;
  k.setCamPos(player.pos);
}

// ---------- main loop ----------

const targetMarker = k.add([k.text("▼", { size: 16 }), k.pos(0, 0), k.anchor("center"), k.color(255, 255, 80), k.opacity(0), k.z(20)]);
// While exploring, points at the nearest camp that's still standing when it's
// off screen (on a phone the start view shows no enemies at all).
const campPointer = k.add([k.text("", { size: 15 }), k.pos(0, 0), k.anchor("center"), k.color(255, 210, 80), k.opacity(0), k.fixed(), k.z(30)]);

function updateCampPointer() {
  const alive = enemies.filter((e) => e.exists() && e.spawnId);
  if (!playing() || activeEncounter || screenOpen() || !alive.length) return void (campPointer.opacity = 0);
  const nearest = alive.reduce((a, b) => (a.pos.dist(player.pos) <= b.pos.dist(player.pos) ? a : b));
  const p = k.toScreen(nearest.pos);
  const safe = measureSafe();
  const pad = 70;
  if (p.x > safe.x0 && p.x < safe.x1 && p.y > safe.y0 && p.y < safe.y1) return void (campPointer.opacity = 0);
  const c = k.vec2((safe.x0 + safe.x1) / 2, (safe.y0 + safe.y1) / 2);
  const d = p.sub(c);
  const t = Math.min(
    Math.abs(d.x) > 0 ? ((safe.x1 - safe.x0) / 2 - pad) / Math.abs(d.x) : Infinity,
    Math.abs(d.y) > 0 ? ((safe.y1 - safe.y0) / 2 - 24) / Math.abs(d.y) : Infinity,
  );
  const arrows = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
  const arrow = arrows[Math.round(((Math.atan2(d.y, d.x) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
  const area = AREAS.find((a) => ENEMY_SPAWNS.find((s) => s.id === nearest.spawnId)?.area === a.id);
  campPointer.text = `${arrow} ${area?.name ?? "enemies"}`;
  campPointer.pos = c.add(d.scale(t));
  campPointer.opacity = 1;
}

// Invariant: the 14-card deck is always fully accounted for across all piles.
const DECK_SIZE = totalCards(piles);

k.onUpdate(() => {
  const now = k.time();
  const enc = activeEncounter;
  const base = baseScale();

  if (playing() && !enc && !screenOpen()) {
    const move = k.vec2(0, 0);
    if (held.has("arrowleft") || held.has("a")) move.x -= 1;
    if (held.has("arrowright") || held.has("d")) move.x += 1;
    if (held.has("arrowup") || held.has("w")) move.y -= 1;
    if (held.has("arrowdown") || held.has("s")) move.y += 1;
    if (move.len() === 0 && moveTarget) {
      if (k.isMouseDown("left")) moveTarget = k.toWorld(k.mousePos());
      const to = moveTarget.sub(player.pos);
      if (to.len() < 6) moveTarget = null;
      else {
        move.x = to.x;
        move.y = to.y;
      }
    }
    if (move.len() > 0) {
      const step = Math.min(PLAYER_SPEED * k.dt(), moveTarget ? moveTarget.dist(player.pos) : Infinity);
      player.pos = player.pos.add(move.unit().scale(step));
    }
    player.pos.x = k.clamp(player.pos.x, PLAYER_EDGE, WORLD_WIDTH - PLAYER_EDGE);
    player.pos.y = k.clamp(player.pos.y, PLAYER_EDGE, WORLD_HEIGHT - PLAYER_EDGE);

    const explorers = enemies.filter((e) => e.exists());
    for (const e of explorers) updateEnemyAI(e);
    separate(explorers, k.dt(), { padding: SEPARATION_PADDING, speed: SEPARATION_SPEED, worldW: WORLD_WIDTH, worldH: WORLD_HEIGHT });
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

  // Camera: fights (from formation on) hold the framing planned from the final
  // slots; everything else follows the player at exploration zoom. Position is
  // re-clamped at the *current* scale every frame, so a zoom transition never
  // shows past the map edge.
  const cur = activeEncounter;
  const framed = !!cur && cur.phase !== "unforming";
  const targetPos = framed ? cur!.camPos : player.pos;
  const targetScale = framed ? cur!.camScale : base;
  const lerpT = Math.min(1, CAM_LERP_RATE * k.dt());
  const scale = k.getCamScale().x + (targetScale - k.getCamScale().x) * lerpT;
  const rawPos = k.getCamPos().lerp(targetPos, lerpT);
  const clamped = clampCam({ x: rawPos.x, y: rawPos.y }, scale, {
    viewW: k.width(), viewH: k.height(), worldW: WORLD_WIDTH, worldH: WORLD_HEIGHT, safe: { x0: 0, y0: 0, x1: 0, y1: 0 },
  });
  k.setCamScale(scale, scale);
  k.setCamPos(clamped.x, clamped.y);

  // Participants on stage are full, side-list participants are hidden from the
  // map, bystanders are dimmed while a fight runs.
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
  // Ground labels name the camps while exploring and get out of the way of
  // HP / intent text during fights.
  const clearedNow = clearedAreas(checkpointPreview());
  for (const a of AREAS) {
    const label = areaLabels.get(a.id);
    const text = cur ? "" : clearedNow.includes(a.id) ? `${a.name} (cleared)` : a.name;
    if (label && label.text !== text) label.text = text;
  }

  if (cur && (!selectedTarget || !selectedTarget.exists() || !cur.roster.includes(selectedTarget))) {
    const alive = aliveRoster();
    selectedTarget = alive.find((e) => !e.overflow) ?? alive[0] ?? null;
  }
  const markerOn = !!cur && cur.phase !== "unforming" && !!selectedTarget && selectedTarget.exists() && !selectedTarget.overflow;
  targetMarker.opacity = markerOn ? 1 : 0;
  if (markerOn && selectedTarget) {
    targetMarker.pos = selectedTarget.pos.add(0, selectedTarget.isBoss ? BOSS_LABELS.marker : TRASH_LABELS.marker);
  }

  updateCampPointer();
  renderHud();
  renderHand();
  renderOverflow();

  if (totalCards(piles) !== DECK_SIZE) console.error("card count drifted", totalCards(piles), piles);
  if (runState === "playing" && player.hp <= 0) finishDeath();
});

// Read-only snapshot for the browser-driven checks (tools/playtest.mjs).
(window as unknown as { __game: () => unknown }).__game = () => ({
  run: runState,
  screen: screenOpen(),
  saveStatus: saveClient.status.kind,
  runNumber: run?.runNumber ?? null,
  stats: run?.stats ?? null,
  phase: activeEncounter?.phase ?? null,
  turn: activeEncounter?.turnNumber ?? 0,
  difficulty: activeEncounter?.difficulty ?? null,
  hp: player.hp,
  energy: player.energy,
  block: player.block,
  player: { x: player.pos.x, y: player.pos.y },
  piles: { draw: piles.draw.length, hand: piles.hand.map((c) => c.name), discard: piles.discard.length, exhaust: piles.exhaust.length },
  cam: { x: k.getCamPos().x, y: k.getCamPos().y, scale: k.getCamScale().x },
  base: baseScale(),
  view: { w: k.width(), h: k.height() },
  safe: measureSafe(),
  target: selectedTarget?.exists() ? selectedTarget.enemyId : null,
  pointer: campPointer.opacity > 0 ? { x: campPointer.pos.x, y: campPointer.pos.y, text: campPointer.text } : null,
  enemies: enemies
    .filter((e) => e.exists())
    .map((e) => {
      const s = k.toScreen(e.pos);
      return {
        id: e.enemyId, spawnId: e.spawnId, boss: e.isBoss, hp: e.hp, block: e.block, state: e.state, overflow: e.overflow,
        x: e.pos.x, y: e.pos.y, sx: s.x, sy: s.y, intent: e.intent ? intentText(e) : null,
        engageX: e.engagePos?.x ?? null, engageY: e.engagePos?.y ?? null,
      };
    }),
});

// ---------- boot ----------

async function boot() {
  if (FIGHT_PARAM) {
    saveClient.disable("Test fight - not saved");
    startFromSave(newRun("run_testfight", 1, Date.now()), false);
    applyFightParam(FIGHT_PARAM);
    return;
  }
  showScreen(`<h1 id="panelTitle">Camp Clearer</h1><p>Loading your save…</p>`);
  try {
    // Load before anything starts, so a default new game can never overwrite a save.
    showStartScreen(await saveClient.load());
  } catch (err) {
    showLoadError(err);
  }
}

placeOverflowPanel();
k.setCamScale(baseScale(), baseScale());
k.setCamPos(player.pos);
void boot();
