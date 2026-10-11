import kaplay from "kaplay";
import type { CoopClientMsg, CoopFightMsg, CoopHandMsg, CoopServerMsg } from "./coop-protocol.ts";
import { AREAS, ENEMY_SPAWNS, PLAYER_EDGE, WORLD_HEIGHT, WORLD_WIDTH } from "./world.ts";

// Keep in step with PLAYER_SPEED in server/coop/room.ts: the local-player
// prediction below must integrate movement exactly like the server does, or
// the reconciliation in applyState() would be fighting a mismatched guess
// every single snapshot instead of an occasional small correction.
const PLAYER_SPEED = 220;

// Co-op's own entry point: shared exploration (crit 9's base) plus the
// server-authoritative fight itself (phase 3). Reconnect handling and visual
// polish land in phase 4; this renders every connected player, the shared
// roaming enemies, and — once a fight forms — a plain functional card dock
// driven entirely by the server's `fight`/`hand` messages, so two tabs in one
// room see one world and one fight, not two separately-simulated copies kept
// in sync after the fact.

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  roster: $("roster"),
  status: $("status"),
  screen: $("screen"),
  nameInput: $<HTMLInputElement>("nameInput"),
  codeInput: $<HTMLInputElement>("codeInput"),
  createBtn: $<HTMLButtonElement>("createBtn"),
  joinBtn: $<HTMLButtonElement>("joinBtn"),
  formError: $("formError"),
  fightDock: $("fightDock"),
  fightTurn: $("fightTurn"),
  fightHint: $("fightHint"),
  enemyList: $("enemyList"),
  partyList: $("partyList"),
  hand: $("hand"),
  endTurnBtn: $<HTMLButtonElement>("endTurnBtn"),
  fleeBtn: $<HTMLButtonElement>("fleeBtn"),
  fightError: $("fightError"),
};

function setStatus(s: string) {
  ui.status.textContent = s;
}

// ---------- join flow ----------

async function api(path: string, body: unknown): Promise<{ code: string; name: string; color: string }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `request failed (${res.status})`);
  return data;
}

async function startJoinFlow() {
  const params = new URLSearchParams(location.search);
  const codeFromLink = (params.get("code") ?? "").toUpperCase();
  if (codeFromLink) ui.codeInput.value = codeFromLink;

  return new Promise<{ code: string; name: string; color: string }>((resolve) => {
    const go = async (fn: () => Promise<{ code: string; name: string; color: string }>) => {
      ui.formError.textContent = "";
      ui.createBtn.disabled = ui.joinBtn.disabled = true;
      try {
        resolve(await fn());
      } catch (e) {
        ui.formError.textContent = e instanceof Error ? e.message : "something went wrong";
        ui.createBtn.disabled = ui.joinBtn.disabled = false;
      }
    };
    ui.createBtn.onclick = () => go(() => api("/api/coop/rooms", { name: ui.nameInput.value }));
    ui.joinBtn.onclick = () => {
      const code = ui.codeInput.value.trim().toUpperCase();
      if (!code) {
        ui.formError.textContent = "enter a room code";
        return;
      }
      go(() => api(`/api/coop/rooms/${code}/join`, { name: ui.nameInput.value }));
    };
    if (codeFromLink) ui.joinBtn.focus();
    else ui.createBtn.focus();
  });
}

// ---------- engine ----------

const k = kaplay({ root: $("game"), background: [17, 17, 17], pixelDensity: Math.min(window.devicePixelRatio || 1, 2), global: false });
k.setGravity(0);

const ROLE_COLOR: Record<string, ReturnType<typeof k.rgb>> = {
  brute: k.rgb(220, 70, 70),
  swarm: k.rgb(240, 140, 60),
  mage: k.rgb(60, 190, 190),
  heavy: k.rgb(170, 40, 40),
  boss: k.rgb(160, 60, 200),
};
const ROLE_SIZE: Record<string, number> = { brute: 28, swarm: 20, mage: 24, heavy: 40, boss: 56 };

const GROUND_TILE = 130;
for (let gy = 0; gy < WORLD_HEIGHT; gy += GROUND_TILE) {
  for (let gx = 0; gx < WORLD_WIDTH; gx += GROUND_TILE) {
    const dark = ((gx / GROUND_TILE + gy / GROUND_TILE) | 0) % 2 === 0;
    k.add([k.rect(GROUND_TILE, GROUND_TILE), k.pos(gx, gy), k.color(dark ? 26 : 30, dark ? 26 : 30, dark ? 30 : 34), k.z(-100)]);
  }
}
for (const a of AREAS) {
  const members = ENEMY_SPAWNS.filter((s) => s.area === a.id);
  const x = members.reduce((s, m) => s + m.x, 0) / members.length;
  const y = Math.min(...members.map((m) => m.y)) - 70;
  k.add([k.text(a.name, { size: 14 }), k.pos(x, y), k.anchor("center"), k.color(110, 110, 120), k.z(-80)]);
}

function baseScale(): number {
  const w = k.width();
  const h = k.height();
  const fit = Math.min(Math.max(Math.min(w / 960, h / 540), 1), 2.2);
  return Math.max(fit, w / WORLD_WIDTH, h / WORLD_HEIGHT);
}

// ---------- entities, driven entirely by server snapshots ----------

function makePlayerBody(color: ReturnType<typeof k.rgb>) {
  return k.add([k.circle(16), k.pos(0, 0), k.color(color), k.opacity(1), k.anchor("center"), k.z(10)]);
}
function makeLabel(text: string, y: number) {
  return k.add([k.text(text, { size: 12 }), k.pos(0, y), k.anchor("center"), k.color(230, 230, 230), k.z(11)]);
}
function makeEnemyBody(role: string, tier: string) {
  const size = ROLE_SIZE[role] ?? 24;
  return k.add([
    k.rect(size, size),
    k.pos(0, 0),
    k.color(ROLE_COLOR[role] ?? k.rgb(200, 200, 200)),
    ...(tier === "elite" ? [k.outline(3, k.rgb(240, 200, 80))] : []),
    k.opacity(1),
    k.anchor("center"),
    k.z(5),
  ]);
}

// ---------- position smoothing: the server only broadcasts a `state`
// snapshot every ~150ms (server/coop/ws.ts's TICK_MS); rendering raw
// snapshot positions made motion visibly step once per snapshot instead of
// smoothly every frame (confirmed with tools/coop-perf-check.mjs: Chrome was
// a flawless 60fps throughout, but the displayed position only changed value
// roughly once every 9 rendered frames while walking — a rendering/sync
// problem, not a dropped-frame one). Remote players and enemies are rendered
// by interpolating between the two most recent snapshots, slightly in the
// past, so motion is continuous and never extrapolates beyond what the
// server has actually confirmed. The local player instead predicts its own
// movement immediately from input (so input feels instant) and is gently
// reconciled toward the server's authoritative position each snapshot,
// snapping instantly only on a real discontinuity (first spawn, a fight
// starting/ending, or a large correction) rather than sliding through a
// visibly wrong path. docs/adr/0006-coop-perf-and-reliability.md.
const INTERP_DELAY_MS = 180; // a bit over one server tick, absorbs normal jitter
const SNAP_DISTANCE = 80; // px: a correction this big means "teleport", not "smooth it"
const SELF_CORRECTION_BLEND = 0.3; // fraction of error nudged in per received snapshot

interface Snap {
  t: number;
  x: number;
  y: number;
}
function pushSnap(buf: Snap[], s: Snap) {
  buf.push(s);
  if (buf.length > 2) buf.shift();
}
/** Interpolates between the two most recent snapshots at `at`; never extrapolates past the newest one. */
function sampleBuffer(buf: Snap[], at: number): { x: number; y: number } | null {
  if (buf.length === 0) return null;
  if (buf.length === 1) return { x: buf[0].x, y: buf[0].y };
  const [a, b] = buf;
  if (at <= a.t) return { x: a.x, y: a.y };
  if (at >= b.t) return { x: b.x, y: b.y };
  const t = (at - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

interface PlayerView {
  body: ReturnType<typeof makePlayerBody>;
  label: ReturnType<typeof makeLabel>;
  buf: Snap[];
}
interface EnemyView {
  body: ReturnType<typeof makeEnemyBody>;
  hpLabel: ReturnType<typeof makeLabel>;
  labelOffset: number;
  buf: Snap[];
}

const players = new Map<string, PlayerView>();
const enemies = new Map<string, EnemyView>();
let selfId = "";
/** The local player's own displayed/predicted position; null until the first snapshot arrives. */
let selfPos: { x: number; y: number } | null = null;
let selfFightId: string | null = null;

function ensurePlayer(id: string, name: string, color: string, x: number, y: number): PlayerView {
  let v = players.get(id);
  if (v) return v;
  const body = makePlayerBody(parseColor(color));
  body.pos = k.vec2(x, y);
  const label = makeLabel(name, -28);
  label.pos = k.vec2(x, y - 28);
  v = { body, label, buf: [] };
  players.set(id, v);
  return v;
}

function ensureEnemy(id: string, role: string, tier: string, x: number, y: number): EnemyView {
  let v = enemies.get(id);
  if (v) return v;
  const size = ROLE_SIZE[role] ?? 24;
  const labelOffset = size / 2 + 10;
  const body = makeEnemyBody(role, tier);
  body.pos = k.vec2(x, y);
  const hpLabel = makeLabel("", -labelOffset);
  hpLabel.pos = k.vec2(x, y - labelOffset);
  v = { body, hpLabel, labelOffset, buf: [] };
  enemies.set(id, v);
  return v;
}

function parseColor(hex: string) {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return k.rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

const rosterNodes = new Map<string, HTMLSpanElement>();
/** Real display names by id, from `hello`'s member list and every `state` snapshot — never a truncated id. */
const memberNames = new Map<string, string>();
function roomMemberName(id: string): string {
  return memberNames.get(id) ?? id.slice(0, 6);
}

function applyState(msg: CoopServerMsg & { type: "state" }) {
  const now = performance.now();
  const seenP = new Set<string>();
  for (const p of msg.players) {
    seenP.add(p.id);
    const v = ensurePlayer(p.id, p.name, p.color, p.x, p.y);
    pushSnap(v.buf, { t: now, x: p.x, y: p.y });
    v.body.opacity = p.online ? (p.fightId ? 0.6 : 1) : 0.3;
    const tag = !p.online ? " (away)" : p.fightId ? " (in combat)" : "";
    const label = `${p.name}${tag}`;
    if (v.label.text !== label) v.label.text = label;

    if (p.id === selfId) {
      const fightChanged = selfFightId !== p.fightId;
      selfFightId = p.fightId;
      if (!selfPos || fightChanged || Math.hypot(selfPos.x - p.x, selfPos.y - p.y) > SNAP_DISTANCE) {
        selfPos = { x: p.x, y: p.y };
      } else {
        selfPos.x += (p.x - selfPos.x) * SELF_CORRECTION_BLEND;
        selfPos.y += (p.y - selfPos.y) * SELF_CORRECTION_BLEND;
      }
    }
  }
  for (const [id, v] of players) {
    if (!seenP.has(id)) {
      v.body.destroy();
      v.label.destroy();
      players.delete(id);
    }
  }

  const seenE = new Set<string>();
  for (const e of msg.enemies) {
    seenE.add(e.id);
    const v = ensureEnemy(e.id, e.role, e.tier, e.x, e.y);
    pushSnap(v.buf, { t: now, x: e.x, y: e.y });
    const hpText = e.fightId ? `${e.hp} ⚔` : `${e.hp}`;
    if (v.hpLabel.text !== hpText) v.hpLabel.text = hpText;
    v.body.opacity = e.fightId ? 0.5 : 1; // combat itself (phase 3) will replace this with the real fight screen
  }
  for (const [id, v] of enemies) {
    if (!seenE.has(id)) {
      v.body.destroy();
      v.hpLabel.destroy();
      enemies.delete(id);
    }
  }

  const me = msg.players.find((p) => p.id === selfId);
  const others = msg.players.filter((p) => p.id !== selfId);
  const seenRoster = new Set<string>();
  for (const p of [...(me ? [me] : []), ...others]) {
    seenRoster.add(p.id);
    let span = rosterNodes.get(p.id);
    if (!span) {
      span = document.createElement("span");
      rosterNodes.set(p.id, span);
    }
    const status = !p.online ? " (away)" : p.fightId ? " (in combat)" : "";
    const text = p.id === selfId ? `${p.name} (you)${status}` : `${p.name}${status}`;
    setText(span, text);
    const border = p.online ? p.color : "#4a4a52";
    if (span.style.borderColor !== border) span.style.borderColor = border;
    ui.roster.appendChild(span); // a no-op move if already in place; never recreated
  }
  for (const [id, span] of rosterNodes) {
    if (!seenRoster.has(id)) {
      span.remove();
      rosterNodes.delete(id);
    }
  }
}

// ---------- per-frame render: local prediction, remote interpolation, camera ----------

function advanceSelfPrediction(dt: number) {
  if (!selfPos || selfFightId) return; // fighting: the server owns position, nothing to predict
  const d = currentDir();
  const len = Math.hypot(d.x, d.y);
  if (len === 0) return;
  selfPos.x += (d.x / len) * PLAYER_SPEED * dt;
  selfPos.y += (d.y / len) * PLAYER_SPEED * dt;
  selfPos.x = Math.min(Math.max(selfPos.x, PLAYER_EDGE), WORLD_WIDTH - PLAYER_EDGE);
  selfPos.y = Math.min(Math.max(selfPos.y, PLAYER_EDGE), WORLD_HEIGHT - PLAYER_EDGE);
}

function renderFrame() {
  const dt = k.dt();
  advanceSelfPrediction(dt);
  const renderAt = performance.now() - INTERP_DELAY_MS;

  for (const [id, v] of players) {
    const p = id === selfId ? selfPos : sampleBuffer(v.buf, renderAt);
    if (!p) continue;
    v.body.pos = k.vec2(p.x, p.y);
    v.label.pos = k.vec2(p.x, p.y - 28);
  }
  for (const [, v] of enemies) {
    const p = sampleBuffer(v.buf, renderAt);
    if (!p) continue;
    v.body.pos = k.vec2(p.x, p.y);
    v.hpLabel.pos = k.vec2(p.x, p.y - v.labelOffset);
  }

  const me = selfPos;
  if (me) {
    const scale = baseScale();
    k.setCamScale(scale);
    const half = { x: k.width() / 2 / scale, y: k.height() / 2 / scale };
    const cx = Math.min(Math.max(me.x, half.x), WORLD_WIDTH - half.x);
    const cy = Math.min(Math.max(me.y, half.y), WORLD_HEIGHT - half.y);
    k.setCamPos(k.vec2(cx, cy));
  }
}
k.onUpdate(renderFrame);

// ---------- input: direction intent sent to the server, which owns position ----------

const held = new Set<string>();
const KEYS: Record<string, [number, number]> = {
  arrowup: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], arrowright: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
};

let socket: WebSocket | null = null;
let lastSentDir = { x: 2, y: 2 }; // force the first send

function currentDir(): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const key of held) {
    const v = KEYS[key];
    if (v) {
      x += v[0];
      y += v[1];
    }
  }
  return { x, y };
}

function sendIntent(force = false) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const d = currentDir();
  if (!force && d.x === lastSentDir.x && d.y === lastSentDir.y) return;
  lastSentDir = d;
  const msg: CoopClientMsg = { type: "move", dx: d.x, dy: d.y };
  socket.send(JSON.stringify(msg));
}

window.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (key in KEYS) {
    held.add(key);
    sendIntent();
  }
});
window.addEventListener("keyup", (e) => {
  const key = e.key.toLowerCase();
  if (held.delete(key)) sendIntent();
});
window.addEventListener("blur", () => {
  held.clear();
  sendIntent(true);
});
// a safety-net resend: WebSocket doesn't drop messages in order on its own, but
// this guards against a missed keyup event (alt-tab mid-press, etc.)
setInterval(() => sendIntent(true), 1500);

// ---------- fight dock: plain HTML, driven entirely by the server's fight/hand messages ----------

let currentFight: CoopFightMsg | null = null;
let currentHand: CoopHandMsg | null = null;
let selectedTargetKey: string | null = null;
let actionSeq = 0;

function sendAction(msg: CoopClientMsg) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(msg));
}
function nextSeq() {
  return ++actionSeq;
}

function intentLabel(intent: CoopFightMsg["enemies"][number]["intent"]): string {
  if (!intent) return "";
  if (intent.kind === "attack") return `${intent.ranged ? "shoot" : "atk"} ${intent.value}`;
  if (intent.kind === "defend") return `def ${intent.value}`;
  if (intent.kind === "charge") return `charge → ${intent.next}`;
  return `revive ${intent.target}`;
}

/**
 * Keyed node reuse: existing elements are updated and moved into place
 * (a no-op if already there), never torn down and rebuilt, so repeated
 * renders (every `fight`/`hand` message) don't thrash click/focus state or
 * do needless DOM work. `nodes` is the per-list reuse cache the caller keeps
 * across calls.
 */
function syncList<T>(
  container: HTMLElement,
  items: T[],
  keyOf: (t: T) => string,
  nodes: Map<string, HTMLElement>,
  build: () => HTMLElement,
  update: (el: HTMLElement, t: T) => void,
) {
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    seen.add(key);
    let el = nodes.get(key);
    if (!el) {
      el = build();
      nodes.set(key, el);
    }
    update(el, item);
    container.appendChild(el);
  }
  for (const [key, el] of nodes) {
    if (!seen.has(key)) {
      el.remove();
      nodes.delete(key);
    }
  }
}

const enemyNodes = new Map<string, HTMLElement>();
const partyNodes = new Map<string, HTMLElement>();
const handNodes = new Map<string, HTMLElement>();

function setHtml(el: HTMLElement, html: string) {
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderFight() {
  const f = currentFight;
  if (!f) {
    ui.fightDock.hidden = true;
    return;
  }
  ui.fightDock.hidden = false;
  const me = f.players.find((p) => p.id === selfId);
  setText(ui.fightTurn, `Turn ${f.turn}${me?.ready ? " · waiting on your party…" : ""}`);

  syncList(
    ui.enemyList, f.enemies, (e) => e.key, enemyNodes,
    () => {
      const btn = document.createElement("button");
      btn.type = "button";
      return btn;
    },
    (el, e) => {
      const btn = el as HTMLButtonElement;
      btn.disabled = e.downed;
      btn.setAttribute("aria-pressed", String(selectedTargetKey === e.key));
      const targetName = e.intent?.kind === "attack" ? roomMemberName(e.intent.targetId) : null;
      setHtml(
        btn,
        `<span class="name">${e.role}${e.downed ? " (down)" : ""}</span><br>HP ${e.hp}/${e.maxHp}<br>${intentLabel(e.intent)}${targetName ? ` → ${targetName}` : ""}`,
      );
      btn.onclick = () => {
        selectedTargetKey = selectedTargetKey === e.key ? null : e.key;
        renderFight();
      };
    },
  );

  syncList(
    ui.partyList, f.players, (p) => p.id, partyNodes,
    () => document.createElement("span"),
    (el, p) => {
      el.className = p.ready ? "ready" : "";
      const who = p.id === selfId ? "you" : roomMemberName(p.id);
      setText(
        el,
        `${who}: ${p.downed ? "down" : p.fled ? "fled" : `${p.hp} HP${p.block ? ` +${p.block} blk` : ""}`}${p.ready ? " ✓" : ""}`,
      );
    },
  );

  const myHandEnabled = !!me && !me.downed && !me.fled && !me.ready;
  syncList(
    ui.hand, currentHand?.cards ?? [], (c) => c.id, handNodes,
    () => {
      const btn = document.createElement("button");
      btn.type = "button";
      return btn;
    },
    (el, c) => {
      const btn = el as HTMLButtonElement;
      btn.disabled = !myHandEnabled || (currentHand?.energy ?? 0) < c.cost;
      btn.title = c.blurb;
      setHtml(btn, `<span class="name">${c.name}</span><span class="cost">${c.cost} energy</span>`);
      btn.onclick = () => {
        if (c.kind === "single" && !selectedTargetKey) {
          setText(ui.fightError, "select an enemy first");
          return;
        }
        setText(ui.fightError, "");
        sendAction({ type: "playCard", seq: nextSeq(), cardInstanceId: c.id, targetKey: c.kind === "single" ? selectedTargetKey! : undefined });
        selectedTargetKey = null;
      };
    },
  );
  ui.endTurnBtn.disabled = !myHandEnabled;
  ui.fleeBtn.disabled = !myHandEnabled;
}

let fightRenderScheduled = false;
/**
 * The server sends a `fight` view and a `hand` view back-to-back for a
 * single action (server/coop/ws.ts's afterFightChange/tickAll); coalescing
 * both into one rAF-scheduled render avoids doing the work (and the DOM
 * diffing above) twice for one logical update.
 */
function scheduleRenderFight() {
  if (fightRenderScheduled) return;
  fightRenderScheduled = true;
  requestAnimationFrame(() => {
    fightRenderScheduled = false;
    renderFight();
  });
}

function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

ui.endTurnBtn.onclick = () => sendAction({ type: "endTurn", seq: nextSeq() });
ui.fleeBtn.onclick = () => sendAction({ type: "flee", seq: nextSeq() });

// ---------- connect ----------

async function main() {
  const joined = await startJoinFlow();
  history.replaceState(null, "", `${location.pathname}?code=${joined.code}`);
  ui.screen.hidden = true;
  setStatus("connecting…");

  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/coop/ws?code=${joined.code}`;
  socket = new WebSocket(wsUrl);
  socket.addEventListener("open", () => setStatus(`room ${joined.code}`));
  socket.addEventListener("close", () => setStatus("disconnected — reload to try again"));
  socket.addEventListener("error", () => setStatus("connection error"));
  socket.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data) as CoopServerMsg;
    if (msg.type === "hello") {
      selfId = msg.selfId;
      for (const m of msg.room.members) memberNames.set(m.id, m.name);
    } else if (msg.type === "state") {
      applyState(msg);
      for (const p of msg.players) memberNames.set(p.id, p.name);
    } else if (msg.type === "fight") {
      currentFight = msg;
      scheduleRenderFight();
    } else if (msg.type === "hand") {
      currentHand = msg;
      // a refreshed page always starts actionSeq back at 0; adopt the server's
      // real count (never backwards) so the next action isn't mistaken for a
      // stale replay of one that was actually never sent this session.
      actionSeq = Math.max(actionSeq, msg.lastSeq);
      scheduleRenderFight();
    } else if (msg.type === "fightEnded") {
      currentFight = null;
      currentHand = null;
      selectedTargetKey = null;
      renderFight();
      showFightEndFeedback(msg.outcome);
    } else if (msg.type === "leftFight") {
      // the fight itself continues for the rest of the party: only this
      // client's own dock closes, distinct from a whole-fight fightEnded.
      currentFight = null;
      currentHand = null;
      selectedTargetKey = null;
      renderFight();
      setStatus(`room ${new URLSearchParams(location.search).get("code") ?? ""} — you fled; your party keeps fighting`);
    } else if (msg.type === "actionError") {
      setText(ui.fightError, msg.error);
    }
  });

  // debug/test hook, mirroring src/main.ts's window.__game
  (window as unknown as { __coop: () => unknown }).__coop = () => ({
    selfId,
    status: ui.status.textContent,
    players: [...players.keys()],
    enemies: [...enemies.keys()],
    fight: currentFight,
    hand: currentHand,
    // exposed for perf measurement only (tools/coop-perf-check.mjs): where the
    // local player is actually rendered right now, not a behavior change.
    selfPos: players.get(selfId) ? { x: players.get(selfId)!.body.pos.x, y: players.get(selfId)!.body.pos.y } : null,
  });
}

function showFightEndFeedback(outcome: "won" | "wiped" | "abandoned") {
  const msg = outcome === "won" ? "Victory!" : outcome === "wiped" ? "You fell." : "Retreated.";
  setStatus(`room ${new URLSearchParams(location.search).get("code") ?? ""} — ${msg}`);
}

main();
