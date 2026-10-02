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
import {
  applyEnemyEvent,
  beginEnemyTurn,
  beginFight,
  DANGER_THRESHOLD,
  endFight,
  fightThreat,
  hitUnit,
  incomingDamage,
  isWon,
  makeUnit,
  planEnemyTurn,
  startPlayerTurn as rollTurn,
  unitByKey,
  type CombatUnit,
  type EnemyEvent,
  type Fight,
} from "./combat.ts";
import { boxAt, boxFor, clampCam, formationBounds, layoutFormation, planCamera, type Rect, type Viewport } from "./formation.ts";
import { SaveClient, SaveFlowError, type SavePayload, type SaveStatus } from "./net.ts";
import { clearedAreas, killedCount, newRun, type CheckpointReason, type SaveData } from "./save.ts";
import { selectRoster, type Explorer } from "./encounter.ts";
import { CALM_TIME, linkClusters, roamTick, settleAfterFlee, type Pt, type RoamEvent, type RoamState } from "./roam.ts";
import { separate } from "./separation.ts";
import { type Phase, type PhaseEvent, canAct as canActRule, transition } from "./turn.ts";
import {
  AREAS,
  ENEMY_SPAWNS,
  GROUPS,
  GROUP_BY_ID,
  PHASED_IDS,
  PLAYER_EDGE,
  PLAYER_MAX_HP,
  PLAYER_START,
  UNITS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  memberOffset,
  wanderRadiusOf,
  type Role,
} from "./world.ts";

// Exploration is real-time (chase, leash, light separation; packs alert and
// give up together); a fight locks the roster, eases enemies into readable
// slots, then runs strict turns through src/combat.ts: player turn -> enemy
// turn (one action at a time) -> next turn. Fallen enemies stay in their slot
// until the fight ends, because a mage may bring them back. The run is saved
// on the server at stable checkpoints. HUD, hand and menus are HTML over the
// canvas so they stay readable and tappable at any viewport size.

const DEV = import.meta.env.DEV;
const params = new URLSearchParams(location.search);
// ?fight= and ?start= are development-only shortcuts; neither exists in production.
const FIGHT_PARAM = DEV ? params.get("fight") : null;
const START_PARAM = DEV ? params.get("start") : null;

// ---------- tunables ----------

const PLAYER_SPEED = 220;
const PLAYER_MAX_ENERGY = 3;
const HAND_SIZE = 4;

const FLEE_IMMUNITY = 2.5;
const LOAD_IMMUNITY = 2.5; // after restoring a checkpoint, a moment to get your bearings
const END_GRACE = 0.3;
/** pack name + makeup shows on the ground when you're this close to its camp */
const PACK_HINT_RANGE = 560;

// Enemy-enemy spacing only (the player is never pushed). Grunt-grunt minimum
// is 14+14+6 = 34, under the 40 engage range, so a crowd can still close in.
const SEPARATION_PADDING = 6;
const SEPARATION_SPEED = 160;

const FORM_DURATION = 0.3;
const ENEMY_ACTION_GAP = 0.45;

const CAM_LERP_RATE = 4;
const CAM_MAX_ZOOM_SMALL = 1.5;
const CAM_MAX_ZOOM_LARGE = 1.2;

const FEEDBACK_MS = 1800;
const HIT_FLASH_DURATION = 0.15;

// Label offsets match TRASH_BOX / ELITE_BOX / BOSS_BOX in formation.ts.
const LABELS = {
  unit: { hp: -24, intent: -42, tag: -42, marker: -60 },
  elite: { hp: -32, intent: -52, tag: -74, marker: -88 },
  boss: { hp: -40, intent: -68, tag: -68, marker: -98 },
};

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

type Color = ReturnType<typeof k.rgb>;
const PLAYER_COLOR = k.rgb(80, 160, 255);
const DOWN_COLOR = k.rgb(90, 90, 96);
const GOLD = k.rgb(240, 200, 80);
const ROLE_COLOR: Record<Role, Color> = {
  brute: k.rgb(220, 70, 70),
  swarm: k.rgb(240, 140, 60),
  mage: k.rgb(60, 190, 190),
  heavy: k.rgb(170, 40, 40),
  boss: k.rgb(160, 60, 200),
};
const ROLE_SIZE: Record<Role, number> = { brute: 28, swarm: 20, mage: 24, heavy: 40, boss: 56 };

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

function floatText(pos: Vec2, msg: string, color: Color) {
  const t = k.add([
    k.text(msg, { size: 16 }),
    k.pos(pos.x, pos.y),
    k.anchor("center"),
    k.color(color),
    k.opacity(1),
    k.lifespan(0.8, { fade: 0.35 }),
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
    k.add([k.rect(GROUND_TILE, GROUND_TILE), k.pos(gx, gy), k.color(dark ? 26 : 30, dark ? 26 : 30, dark ? 30 : 34), k.z(-100)]);
  }
}
for (const p of [
  { x: 300, y: 300 }, { x: 1100, y: 200 }, { x: 400, y: 1100 },
  { x: 1500, y: 800 }, { x: 2050, y: 330 }, { x: 860, y: 780 },
]) {
  k.add([k.circle(34), k.pos(p.x, p.y), k.color(45, 55, 45), k.z(-90)]);
}

// Camp names on the ground, so "camps cleared" points at somewhere real.
const areaLabels = new Map<string, { text: string; pos: Vec2 }>();
for (const a of AREAS) {
  const members = ENEMY_SPAWNS.filter((s) => s.area === a.id);
  const x = members.reduce((s, m) => s + m.x, 0) / members.length;
  const y = Math.min(...members.map((m) => m.y)) - 70;
  areaLabels.set(a.id, k.add([k.text(a.name, { size: 14 }), k.pos(x, y), k.anchor("center"), k.color(110, 110, 120), k.z(-80)]));
}

// ---------- enemies ----------

let nextEnemyId = 1;

interface SpawnSpec {
  role: Role;
  /** real position (where it was last saved, or its spawn) */
  x: number;
  y: number;
  /** activity center; a boss's is always its spawn */
  center: Pt;
  /** fixed spawn point: layout, migration, boss home */
  spawn: Pt;
  homing: boolean;
  hp: number;
  phase: number;
  spawnId: string | null;
  group: string | null;
}

function spawnEnemy(spec: SpawnSpec) {
  const def = UNITS[spec.role];
  const size = ROLE_SIZE[spec.role];
  const g = spec.group ? GROUP_BY_ID.get(spec.group) : undefined;
  const lab = def.tier === "boss" ? LABELS.boss : def.tier === "elite" ? LABELS.elite : LABELS.unit;
  const enemyId = nextEnemyId++; // runtime only; saves use spawnId
  const enemy = k.add([
    k.pos(spec.x, spec.y),
    k.rect(size, size),
    k.color(ROLE_COLOR[spec.role]),
    // Elites always wear a gold outline. Others get one only while their pack's
    // hint shows: Kaplay draws an outline of width 0 (or opacity 0) anyway, so
    // the component is added and removed rather than hidden.
    ...(def.tier === "elite" ? [k.outline(3, GOLD)] : []),
    k.opacity(1),
    k.area(),
    k.anchor("center"),
    k.z(5),
    "enemy",
    {
      enemyId,
      spawnId: spec.spawnId,
      role: spec.role,
      tier: def.tier,
      group: spec.group,
      groupKind: (g?.kind ?? "skirmish") as "skirmish" | "pack",
      unit: makeUnit(spec.spawnId ?? `extra-${enemyId}`, spec.role, spec.group, spec.hp, spec.phase) as CombatUnit,
      key: spec.spawnId ?? `extra-${enemyId}`,
      alive: true,
      spawn: { ...spec.spawn },
      center: def.tier === "boss" ? { ...spec.spawn } : { ...spec.center },
      offset: spec.spawnId ? memberOffset(spec.spawnId) : { x: 0, y: 0 },
      wanderRadius: spec.spawnId ? wanderRadiusOf(spec.spawnId) : def.wander,
      wanderPace: 0.32 + Math.random() * 0.14, // a little different for everyone
      state: (spec.homing ? "homing" : "idle") as RoamState,
      stateUntil: 0,
      wanderTarget: null as Pt | null,
      pauseUntil: k.time() + Math.random() * 1.5,
      moveSince: 0,
      outSince: null as number | null,
      bodyRadius: def.radius, // not "radius": rect() owns that name
      mass: def.tier === "normal" ? 1 : def.tier === "elite" ? 1.6 : 2.2,
      aggroRange: def.aggroRange,
      engageRange: def.engageRange,
      speed: def.speed,
      acted: false,
      engagePos: null as Vec2 | null,
      formFrom: null as Vec2 | null,
      formTo: null as Vec2 | null,
      overflow: false,
      labels: lab,
    },
  ]);
  enemy.add([k.text(String(spec.hp), { size: def.tier === "boss" ? 16 : 13 }), k.pos(0, lab.hp), k.anchor("center"), k.color(255, 255, 255), k.opacity(1), "enemyHpLabel"]);
  enemy.add([k.text("", { size: 14, align: "center" }), k.pos(0, lab.intent), k.anchor("center"), k.color(255, 210, 80), k.opacity(1), "enemyStateLabel"]);
  if (def.tier === "elite") enemy.add([k.text("ELITE", { size: 12 }), k.pos(0, lab.tag), k.anchor("center"), k.color(GOLD), k.opacity(1), "enemyTagLabel"]);
  if (spec.role === "mage") enemy.add([k.text("+", { size: 18 }), k.pos(0, 1), k.anchor("center"), k.color(10, 40, 40), k.opacity(1), "enemyGlyph"]);
  enemy.onClick(() => selectTarget(enemy));
  return enemy;
}
type Enemy = ReturnType<typeof spawnEnemy>;

let enemies: Enemy[] = [];

const labelOf = (e: Enemy, tag: string) => e.get(tag)[0] as unknown as { text: string; color: Color; opacity: number } | undefined;
const hpLabelOf = (e: Enemy) => labelOf(e, "enemyHpLabel");
const stateLabelOf = (e: Enemy) => labelOf(e, "enemyStateLabel");

function enemyName(e: Enemy) {
  const base = UNITS[e.role].name;
  return e.spawnId ? `${base} (${e.spawnId})` : base;
}

// Never put square brackets in Kaplay text: [x] is a style tag and an
// unmatched one throws, halting the game loop.
function refreshHpLabel(e: Enemy) {
  const label = hpLabelOf(e);
  if (!label) return;
  const u = e.unit;
  label.text = u.downed ? "down" : u.block > 0 ? `${u.hp} (blk ${u.block})` : String(u.hp);
}

/** What a standing unit will do, with the real numbers; for a body, whether a mage is about to raise it. */
function intentText(e: Enemy): string {
  const u = e.unit;
  if (u.downed) {
    const raiser = activeEncounter?.fight.units.find((m) => !m.downed && m.intent?.kind === "revive" && m.intent.target === u.key);
    return raiser && raiser.intent?.kind === "revive" ? `↺ +${raiser.intent.value} HP` : "";
  }
  const it = u.intent;
  if (!it) return "";
  if (it.kind === "attack") {
    if (it.ranged) return `SHOOT ${it.value}`;
    return it.value >= 10 ? `HEAVY ATK ${it.value}` : `ATK ${it.value}`;
  }
  if (it.kind === "defend") return `DEF +${it.value}`;
  if (it.kind === "charge") return `CHARGE\nnext: ATK ${it.next}`;
  return `REVIVE +${it.value}`;
}

function intentLong(e: Enemy): string {
  const it = e.unit.intent;
  if (it?.kind === "revive") {
    const t = enemies.find((x) => x.unit.key === it.target);
    return `will revive ${t ? enemyName(t) : it.target} at ${it.value} HP`;
  }
  return intentText(e).replace("\n", " ");
}

/** Exploration label: alert state plus what's special about this unit. */
function scoutText(e: Enemy): string {
  const tag = e.role === "mage" ? "MAGE" : "";
  const st = e.state === "chasing" ? "!" : e.state === "homing" ? "going home" : e.state === "calm" ? "…" : "";
  return [st, tag].filter(Boolean).join(" ");
}

function refreshIntentLabel(e: Enemy) {
  const label = stateLabelOf(e);
  if (!label) return;
  label.text = activeEncounter && activeEncounter.roster.includes(e) ? intentText(e) : scoutText(e);
  label.color = e.unit.downed ? k.rgb(150, 230, 150) : e.acted ? k.rgb(120, 120, 120) : k.rgb(255, 210, 80);
}

function showDowned(e: Enemy, down: boolean) {
  e.color = down ? DOWN_COLOR : ROLE_COLOR[e.role];
  refreshHpLabel(e);
  refreshIntentLabel(e);
}

function flash(e: Enemy) {
  e.color = k.rgb(255, 255, 255);
  k.wait(HIT_FLASH_DURATION, () => {
    if (e.exists()) e.color = e.unit.downed ? DOWN_COLOR : ROLE_COLOR[e.role];
  });
}
function flashPlayer() {
  player.color = k.rgb(255, 90, 90);
  k.wait(HIT_FLASH_DURATION, () => {
    player.color = PLAYER_COLOR;
  });
}

// ---------- pack hints (before contact) ----------

// One hint per *cluster* of linked pack-mates, wherever they are now: a pack
// pulled across the map takes its name with it, and a guard left far from its
// boss shows as its own group. Fixed camp names stay on the ground separately.
const hintPool: { text: string; pos: Vec2; opacity: number }[] = [];
let shownHints: { group: string; text: string; size: number }[] = [];

function clusterMakeup(group: string, members: Enemy[]): string {
  const notes: string[] = [];
  if (members.some((e) => e.tier === "boss")) notes.push("BOSS");
  if (members.some((e) => e.tier === "elite")) notes.push("ELITE");
  if (members.some((e) => e.role === "mage")) notes.push("mage");
  const name = GROUP_BY_ID.get(group)!.label;
  const size = members.length === 1 ? (members[0].tier === "boss" ? "alone in its lair" : "alone") : `${members.length} together`;
  return `${name} · ${size}${notes.length ? ` · ${notes.join(", ")}` : ""}`;
}

/** While exploring near a pack: its name and real makeup above it, and a shared outline on members that would come together. */
function updatePackHints() {
  const packed = enemies.filter((e) => e.exists() && e.groupKind === "pack" && e.state !== "engaged");
  const clusters = linkClusters(packed);
  const wantOutline = new Set<Enemy>();
  shownHints = [];
  let used = 0;
  for (const c of clusters) {
    const cx = c.reduce((a, e) => a + e.pos.x, 0) / c.length;
    const top = Math.min(...c.map((e) => e.pos.y));
    const near = playing() && !activeEncounter && Math.hypot(player.pos.x - cx, player.pos.y - top) < PACK_HINT_RANGE;
    if (!near) continue;
    if (c.length > 1) for (const e of c) wantOutline.add(e);
    if (!hintPool[used]) hintPool[used] = k.add([k.text("", { size: 13, align: "center" }), k.pos(0, 0), k.anchor("center"), k.color(200, 200, 215), k.opacity(0), k.z(-70)]);
    const label = hintPool[used++];
    const text = clusterMakeup(c[0].group!, c);
    if (label.text !== text) label.text = text;
    // above the group, unless that would put it under the HUD: then below it
    const above = k.vec2(cx, top - 92);
    const bottom = Math.max(...c.map((e) => e.pos.y));
    label.pos = k.toScreen(above).y < measureSafe().y0 + 8 ? k.vec2(cx, bottom + 40) : above;
    label.opacity = 1;
    shownHints.push({ group: c[0].group!, text, size: c.length });
  }
  for (let i = used; i < hintPool.length; i++) hintPool[i].opacity = 0;
  for (const e of enemies) {
    if (!e.exists() || e.tier === "elite") continue; // elites keep their gold outline
    const want = wantOutline.has(e);
    const has = e.has("outline");
    if (want && !has) e.use(k.outline(2, k.rgb(235, 235, 235)));
    else if (!want && has) e.unuse("outline");
  }
}

// ---------- encounter state ----------

interface Encounter {
  id: number;
  roster: Enemy[];
  fight: Fight;
  difficulty: "normal" | "dangerous";
  camPos: Vec2;
  camScale: number;
  phase: Phase;
  fleeing: boolean;
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

/** Fight members still on their feet. */
function standingRoster(): Enemy[] {
  return activeEncounter ? activeEncounter.roster.filter((e) => e.exists() && !e.unit.downed) : [];
}
function overflowList(): Enemy[] {
  return activeEncounter ? activeEncounter.roster.filter((e) => e.exists() && e.overflow) : [];
}

function selectTarget(e: Enemy) {
  if (!activeEncounter || !e.exists()) return;
  if (!activeEncounter.roster.includes(e)) {
    showFeedback("that enemy isn't in this fight");
    return;
  }
  if (e.unit.downed) {
    showFeedback(`${enemyName(e)} is down`);
    return;
  }
  selectedTarget = e;
}

function cycleTarget(dir: number) {
  const st = standingRoster();
  if (!st.length) return;
  // left-to-right on screen for on-stage enemies, then the side list
  const order = [...st.filter((e) => !e.overflow).sort((a, b) => a.pos.x - b.pos.x), ...st.filter((e) => e.overflow)];
  const i = selectedTarget ? order.indexOf(selectedTarget) : -1;
  selectedTarget = order[(i + dir + order.length) % order.length];
}

// ---------- checkpoints ----------

function aliveMapEnemy(spawnId: string) {
  return enemies.find((e) => e.spawnId === spawnId && e.exists());
}

/**
 * The world state at a stable moment: player HP and position, every map
 * enemy's HP by stable id (0 = confirmed dead), where each elite / boss is in
 * its action cycle, and every living enemy's real position, activity center
 * and (boss) homing flag. Wander targets and animations aren't saved: on
 * restore each enemy picks a new target around its center.
 */
function checkpoint(reason: CheckpointReason): SaveData | null {
  if (!run) return null;
  const enemiesHp = Object.fromEntries(ENEMY_SPAWNS.map((s) => [s.id, Math.max(0, aliveMapEnemy(s.id)?.unit.hp ?? 0)]));
  const phases = Object.fromEntries(PHASED_IDS.map((id) => [id, aliveMapEnemy(id)?.unit.phase ?? run!.phases[id] ?? 0]));
  // Real world positions only: an enemy in a fight is saved where it stood
  // before the formation (engagePos), never at its fight slot.
  const places = Object.fromEntries(
    ENEMY_SPAWNS.filter((s) => enemiesHp[s.id] > 0).map((s) => {
      const e = aliveMapEnemy(s.id)!;
      const p = e.engagePos ?? e.pos;
      const r = (n: number, max: number) => Math.min(Math.max(Math.round(n), 0), max);
      return [s.id, {
        x: r(p.x, WORLD_WIDTH), y: r(p.y, WORLD_HEIGHT),
        cx: e.tier === "boss" ? s.x : r(e.center.x, WORLD_WIDTH), cy: e.tier === "boss" ? s.y : r(e.center.y, WORLD_HEIGHT),
        homing: e.tier === "boss" && e.state === "homing",
      }];
    }),
  );
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
    phases,
    places,
    stats: { ...run.stats },
  };
  return run;
}

function saveCheckpoint(reason: CheckpointReason) {
  const cp = checkpoint(reason);
  if (cp) saveClient.save(cp);
}

// ---------- exploration AI (frozen while any fight is active) ----------

let devNoDisengage = false; // dev test fights: nobody gives up

function explorers(): Explorer<Enemy>[] {
  return enemies
    .filter((e) => e.exists())
    .map((e) => ({
      ref: e, key: String(e.enemyId), alive: true, state: e.state, x: e.pos.x, y: e.pos.y,
      group: e.group, groupKind: e.groupKind, aggroRange: e.aggroRange, engageRange: e.engageRange,
    }));
}

// A settled pack or a boss arriving home is a stable moment worth keeping;
// several in quick succession are saved once.
let roamSaveTimer: ReturnType<typeof setTimeout> | null = null;
function saveAfterRoam(events: RoamEvent[]) {
  const reason: CheckpointReason | null = events.some((e) => e.kind === "settled")
    ? "disengage"
    : events.some((e) => e.kind === "homed")
      ? "homed"
      : null;
  if (!reason || !run || runState !== "playing") return;
  if (roamSaveTimer) clearTimeout(roamSaveTimer);
  roamSaveTimer = setTimeout(() => {
    roamSaveTimer = null;
    if (runState === "playing" && !activeEncounter) saveCheckpoint(reason);
  }, 400);
}

function updateExploration() {
  const live = enemies.filter((e) => e.exists());
  const events = roamTick(live, {
    now: k.time(),
    dt: k.dt(),
    player: { x: player.pos.x, y: player.pos.y },
    rnd: Math.random,
    world: { w: WORLD_WIDTH, h: WORLD_HEIGHT },
    noDisengage: devNoDisengage,
  });
  saveAfterRoam(events);
  for (const e of live) refreshIntentLabel(e);
}

// ---------- encounter flow ----------

function tryTriggerEncounter(now: number) {
  const roster = selectRoster(explorers(), player.pos);
  if (!roster) return;

  // The pre-fight checkpoint: closing the tab mid-fight comes back to here.
  if (run) run.stats.fights++;
  saveCheckpoint("engage");

  moveTarget = null;
  const anchor = { x: player.pos.x, y: player.pos.y };
  player.block = 0;
  const fight = beginFight(roster.map((e) => e.unit), player);
  activeEncounter = {
    id: nextEncounterId++,
    roster,
    fight,
    difficulty: fightThreat(roster.map((e) => e.role)) >= DANGER_THRESHOLD ? "dangerous" : "normal",
    camPos: k.vec2(player.pos.x, player.pos.y),
    camScale: baseScale(),
    phase: "forming",
    fleeing: false,
    phaseStartedAt: now,
    anchor,
  };
  // Show the fight HUD and dock first, so the space measured below is the space the fight really has.
  document.body.classList.add("fighting");
  renderHud();
  const units = roster.map((e) => ({ id: e.enemyId, isBoss: e.tier === "boss", elite: e.tier === "elite", pos: { x: e.pos.x, y: e.pos.y } }));
  // Slots are assigned once, from the real space left between HUD and hand.
  // If some don't fit, the side list appears and the stage is re-measured.
  ui.overflow.hidden = true;
  let formation = layoutFormation(units, anchor, viewport());
  if (DEV) (window as unknown as { __formationVp: unknown }).__formationVp = { vp: viewport(), stage: formation.stage };
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
    e.acted = false;
  }

  for (const e of roster) {
    refreshIntentLabel(e);
    refreshHpLabel(e);
  }
  replanCamera(activeEncounter, true);
  selectedTarget =
    roster.find((e) => e.tier === "boss" && !e.overflow) ?? roster.find((e) => e.tier === "elite" && !e.overflow) ?? roster.find((e) => !e.overflow) ?? roster[0];
  renderHand();
}

function enemyBounds(units: { id: number; isBoss: boolean; elite?: boolean }[], slots: Map<number, { x: number; y: number }>): Rect {
  const rects = units.map((u) => boxAt(slots.get(u.id)!, boxFor(u)));
  return {
    x0: Math.min(...rects.map((r) => r.x0)),
    y0: Math.min(...rects.map((r) => r.y0)),
    x1: Math.max(...rects.map((r) => r.x1)),
    y1: Math.max(...rects.map((r) => r.y1)),
  };
}

/** Frames the fight inside the current safe area; re-run on resize. Uses final slots, not pre-fight positions. */
function replanCamera(enc: Encounter, useSlots: boolean) {
  const base = baseScale();
  const shown = enc.roster.filter((e) => e.exists() && !e.overflow);
  const units = shown.map((e) => {
    const p = useSlots && e.formTo ? e.formTo : e.pos;
    return { id: e.enemyId, isBoss: e.tier === "boss", elite: e.tier === "elite", pos: { x: p.x, y: p.y } };
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

function finishForming(enc: Encounter) {
  for (const e of enc.roster) {
    if (e.exists() && e.formTo) e.pos = e.formTo.clone();
  }
  if (setPhase(enc, "formed")) startPlayerTurn(enc);
}

function startPlayerTurn(enc: Encounter) {
  player.energy = PLAYER_MAX_ENERGY;
  drawHand(piles, HAND_SIZE);
  rollTurn(enc.fight);
  for (const e of enc.roster) {
    e.acted = false;
    refreshHpLabel(e);
  }
  for (const e of enc.roster) refreshIntentLabel(e); // after all intents exist, so bodies show who raises them
  const raising = enc.roster.filter((e) => e.unit.intent?.kind === "revive");
  if (raising.length) showFeedback(raising.map((e) => `${enemyName(e)} ${intentLong(e)}`).join("; "));
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
  beginEnemyTurn(enc.fight); // an enemy's DEF block covered the player turn that just ended
  for (const e of enc.roster) refreshHpLabel(e);
  const plan = planEnemyTurn(enc.fight);
  showFeedback(fleeing ? "Fleeing - enemies act first..." : "Enemy turn");
  playResolve(enc, plan.events, plan.died, 0);
}

const byKey = (enc: Encounter, key: string) => enc.roster.find((r) => r.unit.key === key);

function showEnemyEvent(enc: Encounter, ev: EnemyEvent) {
  const e = byKey(enc, ev.from);
  if (!e || !e.exists()) return;
  e.acted = true;
  if (ev.kind === "attack") {
    flash(e);
    flashPlayer();
    floatText(player.pos.add(0, -28), ev.damageTaken > 0 ? `-${ev.damageTaken}` : "blocked", k.rgb(255, 110, 110));
    k.shake(ev.value >= 10 ? 7 : 2);
    showFeedback(`${enemyName(e)} ${ev.ranged ? "shoots" : "hits"} for ${ev.value}${ev.absorbed > 0 ? ` (${ev.absorbed} blocked)` : ""}`);
  } else if (ev.kind === "defend") {
    floatText(e.pos.add(0, -20), `+${ev.value} blk`, k.rgb(140, 200, 255));
    showFeedback(`${enemyName(e)} braces: +${ev.value} block`);
  } else if (ev.kind === "charge") {
    floatText(e.pos.add(0, -20), "charging!", k.rgb(255, 180, 60));
    showFeedback(`${enemyName(e)} charges up - ${ev.next} damage next turn`);
  } else if (ev.kind === "revive") {
    const t = byKey(enc, ev.target);
    if (t) {
      showDowned(t, false);
      floatText(t.pos.add(0, -20), `revived +${ev.value}`, k.rgb(150, 230, 150));
    }
    showFeedback(`${enemyName(e)} revives ${t ? enemyName(t) : ev.target} at ${ev.value} HP`);
  } else {
    floatText(e.pos.add(0, -20), "fizzled", k.rgb(170, 170, 170));
    showFeedback(`${enemyName(e)}'s revive fizzles`);
  }
  for (const r of enc.roster) {
    refreshHpLabel(r);
    refreshIntentLabel(r);
  }
}

function playResolve(enc: Encounter, events: EnemyEvent[], died: boolean, i: number) {
  if (activeEncounter !== enc || runState !== "playing") return;
  if (i >= events.length) {
    finishResolve(enc);
    return;
  }
  applyEnemyEvent(enc.fight, events[i]);
  showEnemyEvent(enc, events[i]);
  if (died && i === events.length - 1) {
    finishDeath();
    return;
  }
  schedule(ENEMY_ACTION_GAP, () => playResolve(enc, events, died, i + 1));
}

/** Whoever is still down when a fight ends is confirmed dead: removed, and counted once by stable id. */
function confirmDeaths(enc: Encounter) {
  const { dead } = endFight(enc.fight);
  for (const key of dead) {
    const e = byKey(enc, key);
    if (!e || !e.exists()) continue;
    if (run && e.spawnId) run.stats.kills++;
    k.destroy(e);
  }
}

function finishResolve(enc: Encounter) {
  if (enc.fleeing) {
    if (!setPhase(enc, "fleeEscaped")) return;
    confirmDeaths(enc);
    for (const e of enc.roster) {
      if (!e.exists()) continue;
      e.formFrom = e.pos.clone();
      e.formTo = e.engagePos ? e.engagePos.clone() : e.pos.clone();
      e.unit.block = 0;
      e.unit.intent = null; // the next intent is generated fresh, from the saved phase
      refreshIntentLabel(e);
      refreshHpLabel(e);
    }
    showFeedback("Escaped!");
    return;
  }
  player.block = 0;
  if (!setPhase(enc, "nextTurn")) return;
  startPlayerTurn(enc);
}

function finishUnforming(enc: Encounter) {
  // back at their pre-fight positions (formTo was set to engagePos), never
  // their fight slots; grunts and elites settle there, a boss heads home
  const survivors = enc.roster.filter((e) => e.exists());
  for (const e of survivors) if (e.formTo) e.pos = e.formTo.clone();
  settleAfterFlee(survivors, k.time(), { w: WORLD_WIDTH, h: WORLD_HEIGHT });
  encounterCooldownUntil = k.time() + Math.max(FLEE_IMMUNITY, CALM_TIME);
  cleanupEncounter();
  if (run) run.stats.flees++;
  saveCheckpoint("flee");
}

function finishVictory() {
  const enc = activeEncounter;
  if (!enc) return;
  confirmDeaths(enc);
  encounterCooldownUntil = k.time() + END_GRACE;
  cleanupEncounter();
  if (run) run.stats.wins++;
  const cleared = !enemies.some((e) => e.exists() && e.spawnId);
  if (cleared) runState = "won";
  saveCheckpoint("victory");
  if (cleared) showEndScreen();
  else showFeedback("Victory");
}

function finishDeath() {
  const enc = activeEncounter;
  cancelPending();
  if (enc) confirmDeaths(enc);
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
    e.unit.intent = null;
    e.unit.block = 0;
    refreshIntentLabel(e);
    refreshHpLabel(e);
  }
  renderHand();
}

// ---------- cards ----------

function damageEnemy(enc: Encounter, e: Enemy, amount: number) {
  const r = hitUnit(enc.fight, e.unit.key, amount);
  flash(e);
  floatText(e.pos.add(0, -10), r.dealt > 0 ? `-${r.dealt}` : "blocked", k.rgb(255, 240, 160));
  if (r.downed) {
    showDowned(e, true);
    showFeedback(e.group && enc.roster.some((m) => m.role === "mage" && !m.unit.downed && m.group === e.group && m.unit.reviveUsed === false)
      ? `${enemyName(e)} is down - a mage could raise it next turn`
      : `${enemyName(e)} is down`);
  }
  refreshHpLabel(e);
  for (const r2 of enc.roster) refreshIntentLabel(r2); // a body's "↺" or a downed mage's cancelled revive
}

function playCardAt(idx: number) {
  const enc = activeEncounter;
  if (!enc || !canAct()) {
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
  const st = standingRoster();
  const target = selectedTarget && selectedTarget.exists() && st.includes(selectedTarget) ? selectedTarget : st[0];

  // Fully settle this card (out of hand, cost paid, effect applied, card sent
  // to discard/exhaust) before checking for victory, so a lethal play can't
  // cut cleanup in half and strand the rest of the hand.
  takeFromHand(piles, idx);
  player.energy -= card.cost;
  applyCard(enc, card, target, st);
  settlePlayed(piles, card);
  renderHand();

  if (isWon(enc.fight)) finishVictory();
}

function applyCard(enc: Encounter, card: CardDef, target: Enemy | undefined, st: Enemy[]) {
  if (card.kind === "single") {
    if (target) damageEnemy(enc, target, card.value);
  } else if (card.kind === "aoe") {
    for (const e of st) damageEnemy(enc, e, card.value);
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
  const sig = JSON.stringify(list.map((e) => [e.enemyId, e.unit.hp, e.unit.block, e.unit.downed, intentText(e), e === selectedTarget]));
  if (sig === overflowSignature) return;
  overflowSignature = sig;
  const up = list.filter((e) => !e.unit.downed).length;
  setText(ui.overflowTitle, `+${list.length} more in this fight (not on screen, ${up} standing)`);
  ui.overflowList.replaceChildren(
    ...list.map((e) => {
      const b = document.createElement("button");
      b.type = "button";
      const u = e.unit;
      const note = u.downed ? intentText(e) || "down" : intentLong(e);
      b.textContent = `${enemyName(e)} · ${u.downed ? "down" : `${u.hp} HP${u.block ? ` (blk ${u.block})` : ""}`} · ${note}`;
      b.setAttribute("aria-pressed", String(e === selectedTarget));
      if (u.downed) b.disabled = true;
      b.addEventListener("click", () => selectTarget(e));
      return b;
    }),
  );
}

/** Live view of what the next checkpoint would hold (for HUD counts), without saving. */
function checkpointPreview(): SaveData {
  const base = run ?? newRun("run_preview00", 1, 0);
  return { ...base, enemies: Object.fromEntries(ENEMY_SPAWNS.map((s) => [s.id, Math.max(0, aliveMapEnemy(s.id)?.unit.hp ?? 0)])) };
}

function renderHud() {
  setText(ui.hp, `HP ${player.hp}/${PLAYER_MAX_HP}${player.block > 0 ? ` (block ${player.block})` : ""}`);
  setText(ui.energy, `Energy ${player.energy}/${PLAYER_MAX_ENERGY}`);
  const cur = activeEncounter;
  setText(
    ui.state,
    cur
      ? `${cur.difficulty === "dangerous" ? "DANGEROUS fight" : "Fight"}: ${standingRoster().length} standing of ${cur.roster.length}`
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
    const inc = incomingDamage(cur.fight);
    setText(
      ui.turn,
      `Turn ${cur.fight.turn} · ${phaseLabel[cur.phase]}` +
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
      ? "Move: WASD / arrow keys, or tap and hold on the map. Outlined enemies are a pack: pull one and the whole pack comes."
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
  <li><b>Goal:</b> clear the six camps; the Warlord waits in the last one. Walk near enemies to draw them out.</li>
  <li><b>Who joins a fight:</b> lone enemies notice and give up on their own, so you can pull them one at a time. <b>Packs</b> (outlined, with their name above them) move together: pull one and the pack-mates near it chase you, give up together, and join the fight together. Nearby enemies already chasing you join too.</li>
  <li><b>Pulling enemies away:</b> enemies wander near their spot until they notice you. Grunts, swarmlings, mages and the elite captain follow you as far as you lead them; when they give up they stay and wander <b>where they stopped</b>. The <b>Warlord</b> only chases a short way from its lair, then walks back home and won't turn around until it gets there. Its guards can be pulled away from it; once apart, they no longer come together.</li>
  <li><b>Move:</b> WASD or arrow keys, or tap and hold on the map.</li>
  <li><b>Fight:</b> each turn you get 3 energy and 4 cards. Tap an enemy (or ←/→) to target, tap a card (or 1-4) to play it. Each enemy shows exactly what it will do; nothing happens until you <b>End turn</b> (Space).</li>
  <li><b>Enemies:</b> grunts hit for 3; swarmlings have 3 HP (one Cleave); a <b>mage</b> shoots for 2, and at the start of your turn may say it will <b>revive</b> a pack-mate who fell on an earlier turn (at half HP, once per fight). Kill the mage first and the revive never happens. The gold-outlined <b>ELITE</b> captain and the Warlord <b>charge</b> before a heavy hit; the charge names the damage coming.</li>
  <li><b>Fallen enemies</b> stay where they fell until the fight ends; then they're gone for good.</li>
  <li><b>Block</b> soaks damage during the enemy turn, then clears. <b>Flee</b> (F): enemies still take their shown actions, then you escape if you survive. Elites and the Warlord remember where they were in their attack cycle, so a charged hit is still coming next time.</li>
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
  disengage: "after enemies gave up a chase",
  homed: "when the Warlord got back to its lair",
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
        const btn = ui.panel.querySelector<HTMLButtonElement>("#yes");
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Erasing…";
        }
        try {
          const fresh = await saveClient.erase();
          resetToMenu();
          showStartScreen(fresh);
        } catch (e) {
          if (btn) {
            btn.disabled = false;
            btn.textContent = "Erase everything";
          }
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

// Every way of starting a run (end-screen button, R, the menu's confirm, a
// retry) comes through here. The save client does the ordering: it sends any
// unconfirmed checkpoint first, so the run being left is archived with its
// real result. This guard just stops a second trigger stacking up screens.
let startingRun = false;
async function beginNewRun(opts: { discardUnsaved?: boolean } = {}) {
  if (startingRun) return;
  if (!saveClient.enabled) {
    startFromSave(newRun(`run_offline${Date.now()}`, (run?.runNumber ?? 0) + 1, Date.now()), false);
    return;
  }
  startingRun = true;
  showScreen(
    saveClient.unsaved && !opts.discardUnsaved
      ? `<h1 id="panelTitle">Saving your last result…</h1><p>Your run's final checkpoint is still on its way to the server. The new run starts as soon as it's confirmed.</p>`
      : `<h1 id="panelTitle">Starting a run…</h1><p>Asking the server for a fresh run.</p>`,
  );
  try {
    const p = await saveClient.startRun(opts);
    lastPayload = p;
    if (p.save) startFromSave(p.save, false);
  } catch (e) {
    if (e instanceof SaveFlowError && e.reason === "conflict") return showConflictScreen(e.message);
    if (e instanceof SaveFlowError) {
      const back = () => (runState === "dead" || runState === "won" ? showEndScreen() : hideScreen());
      return showScreen(
        `<h1 id="panelTitle">Your last result isn't saved</h1>
         <p>${escapeHtml(e.message)}. Nothing has changed on the server yet, and your current run is still there.</p>
         <div class="buttons">
           ${e.reason === "unsaved" ? `<button class="primary" id="retry">Retry saving, then start</button>` : ""}
           <button class="danger" id="discard">Start anyway (lose the unsaved result)</button>
           <button id="back">Back</button>
         </div>`,
        { retry: () => void beginNewRun(), discard: () => void beginNewRun({ discardUnsaved: true }), back },
      );
    }
    showScreen(
      `<h1 id="panelTitle">Couldn't start a run</h1><p>${escapeHtml((e as Error).message)}. Your last result is saved; no new run was created.</p>
       <div class="buttons"><button class="primary" id="retry">Try again</button></div>`,
      { retry: () => void beginNewRun() },
    );
  } finally {
    startingRun = false;
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

/**
 * Rebuilds the world from a checkpoint: enemies at home with their saved HP
 * and action phase; confirmed-dead ones stay gone. Intents are generated
 * fresh, from the saved phase, when the next fight starts.
 */
function startFromSave(save: SaveData, restored: boolean) {
  clearWorld();
  run = JSON.parse(JSON.stringify(save)) as SaveData;
  lastSavedAt = save.savedAt;
  for (const s of ENEMY_SPAWNS) {
    const hp = save.enemies[s.id] ?? s.maxHp;
    if (hp <= 0) continue;
    // where it was last saved (never a fight slot), wandering around its saved center
    const q = save.places?.[s.id] ?? { x: s.x, y: s.y, cx: s.x, cy: s.y, homing: false };
    enemies.push(
      spawnEnemy({
        role: s.role, x: q.x, y: q.y, center: { x: q.cx, y: q.cy }, spawn: { x: s.x, y: s.y }, homing: q.homing,
        hp, phase: save.phases?.[s.id] ?? 0, spawnId: s.id, group: s.group,
      }),
    );
  }
  player.pos = k.vec2(save.player.x, save.player.y);
  if (!restored && START_PARAM) {
    const [x, y] = START_PARAM.split(",").map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) player.pos = k.vec2(k.clamp(x, PLAYER_EDGE, WORLD_WIDTH - PLAYER_EDGE), k.clamp(y, PLAYER_EDGE, WORLD_HEIGHT - PLAYER_EDGE));
  }
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
    // the end screen advertises R; it goes through the same guarded entry as the button
    else if (key === "r" && !e.repeat && (runState === "dead" || runState === "won") && !(e.target instanceof HTMLInputElement)) {
      void beginNewRun();
    }
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

// ?fight=N,BOSS,X,Y puts the player at (X,Y) with N lone grunts (plus the
// Warlord and its pack if BOSS=1) stacked on one point beside them, extra
// grunts spawned if N is larger than the map has. ?fight=group:north,ridge
// alerts those camps and puts the player next to the first one. Development
// builds only; saving is switched off, and pack leashes are disabled.
function applyFightParam(raw: string) {
  devNoDisengage = true;
  if (raw.startsWith("group:")) {
    const ids = raw.slice(6).split(",");
    const first = enemies.filter((e) => e.group === ids[0]);
    if (!first.length) return;
    const lead = first.reduce((a, b) => (a.role === "mage" ? b : a));
    player.pos = k.vec2(k.clamp(lead.pos.x - 34, PLAYER_EDGE, WORLD_WIDTH - PLAYER_EDGE), lead.pos.y);
    for (const e of enemies) if (e.group && ids.includes(e.group)) e.state = "chasing";
  } else {
    const [n = 3, withBoss = 0, x = 1100, y = 650] = raw.split(",").map(Number);
    player.pos = k.vec2(k.clamp(x, PLAYER_EDGE, WORLD_WIDTH - PLAYER_EDGE), k.clamp(y, PLAYER_EDGE, WORLD_HEIGHT - PLAYER_EDGE));
    const side = player.pos.x > WORLD_WIDTH / 2 ? -1 : 1;
    const spot = k.vec2(k.clamp(player.pos.x + side * 30, 30, WORLD_WIDTH - 30), player.pos.y);
    const loners = () => enemies.filter((e) => e.groupKind === "skirmish" && e.tier === "normal");
    for (let i = loners().length; i < n; i++) {
      enemies.push(spawnEnemy({
        role: "brute", x: spot.x, y: spot.y, center: { x: spot.x, y: spot.y }, spawn: { x: spot.x, y: spot.y }, homing: false,
        hp: UNITS.brute.maxHp, phase: 0, spawnId: null, group: null,
      }));
    }
    // N lone grunts; the boss brings its whole pack, as packs do
    const picked = [...loners().slice(0, n), ...(withBoss ? enemies.filter((e) => e.group === "lair") : [])];
    for (const e of picked) {
      e.pos = spot.clone();
      e.state = "chasing";
    }
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

    updateExploration();
    const bodies = enemies.filter((e) => e.exists());
    separate(bodies, k.dt(), { padding: SEPARATION_PADDING, speed: SEPARATION_SPEED, worldW: WORLD_WIDTH, worldH: WORLD_HEIGHT });
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

  // Participants on stage are full (bodies faded), side-list participants are
  // hidden from the map, bystanders are dimmed while a fight runs.
  for (const e of enemies) {
    if (!e.exists()) continue;
    const inFight = !!cur && cur.roster.includes(e);
    const o = !cur ? 1 : inFight ? (e.overflow ? 0 : e.unit.downed ? 0.45 : 1) : 0.3;
    e.opacity = o;
    for (const tag of ["enemyHpLabel", "enemyStateLabel", "enemyTagLabel", "enemyGlyph"]) {
      const l = labelOf(e, tag);
      if (l) l.opacity = inFight && e.unit.downed && tag === "enemyStateLabel" ? 1 : o;
    }
  }
  // Camp names name the camps while exploring and get out of the way of
  // HP / intent text during fights.
  const clearedNow = clearedAreas(checkpointPreview());
  for (const a of AREAS) {
    const label = areaLabels.get(a.id);
    const text = cur ? "" : clearedNow.includes(a.id) ? `${a.name} (cleared)` : a.name;
    if (label && label.text !== text) label.text = text;
  }
  updatePackHints();

  if (cur && (!selectedTarget || !selectedTarget.exists() || selectedTarget.unit.downed || !cur.roster.includes(selectedTarget))) {
    const st = standingRoster();
    selectedTarget = st.find((e) => !e.overflow) ?? st[0] ?? null;
  }
  const markerOn = !!cur && cur.phase !== "unforming" && !!selectedTarget && selectedTarget.exists() && !selectedTarget.overflow;
  targetMarker.opacity = markerOn ? 1 : 0;
  if (markerOn && selectedTarget) targetMarker.pos = selectedTarget.pos.add(0, selectedTarget.labels.marker);

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
  turn: activeEncounter?.fight.turn ?? 0,
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
  packHints: shownHints.map((h) => ({ id: h.group, text: h.text, size: h.size })),
  enemies: enemies
    .filter((e) => e.exists())
    .map((e) => {
      const s = k.toScreen(e.pos);
      return {
        id: e.enemyId, spawnId: e.spawnId, role: e.role, tier: e.tier, group: e.group, boss: e.tier === "boss", elite: e.tier === "elite",
        hp: e.unit.hp, block: e.unit.block, downed: e.unit.downed, phase: e.unit.phase, reviveUsed: e.unit.reviveUsed,
        state: e.state, overflow: e.overflow, x: e.pos.x, y: e.pos.y, sx: s.x, sy: s.y,
        cx: e.center.x, cy: e.center.y, spawnX: e.spawn.x, spawnY: e.spawn.y, wander: e.wanderRadius,
        intent: e.unit.intent ? intentText(e) : null, label: stateLabelOf(e)?.text ?? "",
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
