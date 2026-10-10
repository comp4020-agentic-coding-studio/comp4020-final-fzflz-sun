import kaplay from "kaplay";
import type { CoopClientMsg, CoopServerMsg } from "./coop-protocol.ts";
import { AREAS, ENEMY_SPAWNS, WORLD_HEIGHT, WORLD_WIDTH } from "./world.ts";

// Co-op's own entry point: shared exploration only (crit 9's base). Combat,
// auto-join and reconnect windows land in later phases; this renders every
// connected player and the same roaming enemies the server simulates, from
// server-pushed snapshots, so two tabs looking at one room see one world, not
// two separately-simulated ones kept in sync after the fact.

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

interface PlayerView {
  body: ReturnType<typeof makePlayerBody>;
  label: ReturnType<typeof makeLabel>;
}
interface EnemyView {
  body: ReturnType<typeof makeEnemyBody>;
  hpLabel: ReturnType<typeof makeLabel>;
}

const players = new Map<string, PlayerView>();
const enemies = new Map<string, EnemyView>();
let selfId = "";

function ensurePlayer(id: string, name: string, color: string): PlayerView {
  let v = players.get(id);
  if (v) return v;
  const body = makePlayerBody(parseColor(color));
  const label = makeLabel(name, -28);
  v = { body, label };
  players.set(id, v);
  return v;
}

function ensureEnemy(id: string, role: string, tier: string): EnemyView {
  let v = enemies.get(id);
  if (v) return v;
  const size = ROLE_SIZE[role] ?? 24;
  const body = makeEnemyBody(role, tier);
  const hpLabel = makeLabel("", -size / 2 - 10);
  v = { body, hpLabel };
  enemies.set(id, v);
  return v;
}

function parseColor(hex: string) {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return k.rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function applyState(msg: CoopServerMsg & { type: "state" }) {
  const seenP = new Set<string>();
  for (const p of msg.players) {
    seenP.add(p.id);
    const v = ensurePlayer(p.id, p.name, p.color);
    v.body.pos = k.vec2(p.x, p.y);
    v.label.pos = k.vec2(p.x, p.y - 28);
    v.body.opacity = p.online ? (p.fightId ? 0.6 : 1) : 0.3;
    const tag = !p.online ? " (away)" : p.fightId ? " (in combat)" : "";
    v.label.text = `${p.name}${tag}`;
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
    const v = ensureEnemy(e.id, e.role, e.tier);
    v.body.pos = k.vec2(e.x, e.y);
    v.hpLabel.pos = k.vec2(e.x, e.y - (ROLE_SIZE[e.role] ?? 24) / 2 - 10);
    v.hpLabel.text = e.fightId ? `${e.hp} ⚔` : `${e.hp}`;
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
  ui.roster.textContent = "";
  for (const p of [...(me ? [me] : []), ...others]) {
    const span = document.createElement("span");
    const status = !p.online ? " (away)" : p.fightId ? " (in combat)" : "";
    span.textContent = p.id === selfId ? `${p.name} (you)${status}` : `${p.name}${status}`;
    span.style.borderColor = p.online ? p.color : "#4a4a52";
    ui.roster.appendChild(span);
  }
}

// ---------- camera: follow self, same fit rule as solo exploration ----------

function updateCamera() {
  const me = players.get(selfId);
  if (!me) return;
  const scale = baseScale();
  k.setCamScale(scale);
  const half = { x: k.width() / 2 / scale, y: k.height() / 2 / scale };
  const cx = Math.min(Math.max(me.body.pos.x, half.x), WORLD_WIDTH - half.x);
  const cy = Math.min(Math.max(me.body.pos.y, half.y), WORLD_HEIGHT - half.y);
  k.setCamPos(k.vec2(cx, cy));
}
k.onUpdate(updateCamera);

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
    } else if (msg.type === "state") {
      applyState(msg);
    }
  });

  // debug/test hook, mirroring src/main.ts's window.__game
  (window as unknown as { __coop: () => unknown }).__coop = () => ({
    selfId,
    status: ui.status.textContent,
    players: [...players.keys()],
    enemies: [...enemies.keys()],
  });
}

main();
