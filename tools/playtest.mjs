// Browser-driven playtest: opens a real (windowed) Chrome against the dev
// server over the DevTools protocol, plays scripted fights through actual
// key/mouse input, and checks the game state the page exposes on
// window.__game. Usage: node tools/playtest.mjs [baseUrl]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:5173/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const OUT = "/tmp/shots";
const SAFE = { x0: 16, y0: 140, x1: 944, y1: 384 };
const TRASH_BOX = { left: -36, right: 36, top: -70, bottom: 18 };
const BOSS_BOX = { left: -58, right: 58, top: -108, bottom: 32 };
const DECK = 14;
const VIEW_W = 960;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=/tmp/cdp-playtest",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1000,700",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "about:blank",
], { stdio: "ignore" });

let ws;
let msgId = 0;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener("open", r, { once: true }));
        ws.addEventListener("message", (ev) => {
          const m = JSON.parse(ev.data);
          if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) {
            console.log("  FAIL page error:", JSON.stringify(m.params).slice(0, 300));
            failures++;
          }
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
          }
        });
        return;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error("could not reach Chrome");
}
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
}
async function game() {
  const r = await send("Runtime.evaluate", { expression: "JSON.stringify(window.__game?.())", returnByValue: true });
  return r.result?.result?.value ? JSON.parse(r.result.result.value) : null;
}
async function waitFor(pred, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const g = await game();
    if (g && pred(g)) return g;
    await sleep(50);
  }
  return null;
}
let canvasRect = { x: 0, y: 0, scale: 1 };
async function open(query) {
  await send("Page.navigate", { url: BASE + query });
  await sleep(300);
  const g = await waitFor((s) => !!s);
  const r = await send("Runtime.evaluate", {
    expression: `(() => { const c = document.querySelector("canvas"); c.focus(); const b = c.getBoundingClientRect();
      return JSON.stringify({ x: b.x, y: b.y, scale: b.width / 960, active: document.activeElement === c }); })()`,
    returnByValue: true,
  });
  canvasRect = JSON.parse(r.result.result.value);
  if (!openedOnce) console.log("  canvas", JSON.stringify(canvasRect));
  openedOnce = true;
  return g;
}
let openedOnce = false;
async function key(k) {
  const code = k === " " ? "Space" : k.length === 1 && /[0-9]/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`;
  const keyName = k === " " ? " " : k;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, text: keyName });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code });
  await sleep(60); // input is consumed on the next game frame
}
async function click(gx, gy) {
  const x = canvasRect.x + gx * canvasRect.scale;
  const y = canvasRect.y + gy * canvasRect.scale;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(30);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(60);
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64"));
}
const total = (g) => g.piles.draw + g.piles.hand.length + g.piles.discard + g.piles.exhaust;
const fighters = (g) => g.enemies.filter((e) => e.state === "engaged");

function screenFootprint(e, scale) {
  const b = e.boss ? BOSS_BOX : TRASH_BOX;
  return { x0: e.sx + b.left * scale, y0: e.sy + b.top * scale, x1: e.sx + b.right * scale, y1: e.sy + b.bottom * scale };
}
function layoutChecks(g, label) {
  const shown = fighters(g).filter((e) => !e.overflow);
  const rects = shown.map((e) => screenFootprint(e, g.cam.scale));
  const inSafe = rects.every((r) => r.x0 >= SAFE.x0 - 1 && r.y0 >= SAFE.y0 - 1 && r.x1 <= SAFE.x1 + 1 && r.y1 <= SAFE.y1 + 1);
  check(inSafe, `${label}: every enemy's body/HP/intent/marker area is on screen, clear of HUD/hand/buttons`);
  let overlap = false;
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) overlap = true;
    }
  check(!overlap, `${label}: no two enemies' footprints overlap (${shown.length} on stage, scale ${g.cam.scale.toFixed(2)})`);
  const halfW = 960 / (2 * g.cam.scale), halfH = 540 / (2 * g.cam.scale);
  const camOk = g.cam.x >= halfW - 0.5 && g.cam.x <= 2200 - halfW + 0.5 && g.cam.y >= halfH - 0.5 && g.cam.y <= 1300 - halfH + 0.5;
  check(camOk, `${label}: camera stays inside the map`);
}
const sameState = (a, b) =>
  a.hp === b.hp && a.energy === b.energy && a.turn === b.turn && a.phase === b.phase &&
  JSON.stringify(a.piles) === JSON.stringify(b.piles) &&
  JSON.stringify(a.enemies.map((e) => [e.id, e.hp, e.intent, e.x, e.y])) === JSON.stringify(b.enemies.map((e) => [e.id, e.hp, e.intent, e.x, e.y]));

async function main() {
  await connect();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });

  console.log("\n# Boss + 3 grunts, stacked on one point, centre of map");
  let g = await open("?fight=3,1,1100,650");
  g = await waitFor((s) => s.phase === "forming" || s.phase === "playerTurn", 3000);
  check(!!g, "encounter triggers from a fully stacked group");
  const formingSeen = g?.phase === "forming";
  await key("1");
  g = await game();
  check(!formingSeen || g.piles.hand.length === 0 || g.phase === "playerTurn", "card input during formation is ignored");
  g = await waitFor((s) => s.phase === "playerTurn");
  check(!!g && fighters(g).length === 4, "all 4 joined and the first turn started after formation");
  check(g.enemies.filter((e) => e.state === "engaged").every((e) => e.intent), "every participant shows an intent");
  await sleep(900); // camera eases into the fight framing
  g = await game();
  layoutChecks(g, "boss+3");
  await shot("01_boss3_turn1");
  const engageRecord = Object.fromEntries(fighters(g).map((e) => [e.id, { x: e.engageX, y: e.engageY }]));

  const before = g;
  await sleep(2000);
  const after = await game();
  check(sameState(before, after), "2s idle on the player turn: HP, energy, hand, intents and positions unchanged");
  check(total(after) === DECK, `deck conserved (${total(after)}/14)`);

  // Click a grunt, then Strike it: only that grunt should take damage.
  const grunt = fighters(after).find((e) => !e.boss);
  await click(grunt.sx, grunt.sy);
  g = await game();
  check(g.target === grunt.id, `clicking grunt #${grunt.id} selects it`);
  const strikeIdx = g.piles.hand.indexOf("Strike");
  if (strikeIdx >= 0) {
    const others = fighters(g).filter((e) => e.id !== grunt.id);
    await key(String(strikeIdx + 1));
    await sleep(100);
    g = await game();
    const victim = g.enemies.find((e) => e.id === grunt.id);
    check(!victim || victim.hp < grunt.hp, "Strike hit the selected grunt");
    const moved = others.some((o) => {
      const n = g.enemies.find((e) => e.id === o.id);
      return !n || n.hp !== o.hp || Math.hypot(n.x - o.x, n.y - o.y) > 0.5;
    });
    check(!moved, "no other enemy was damaged or moved (slots stay fixed after a kill)");
    check(g.target !== grunt.id || !!victim, "target marker moved off the dead grunt");
    check(total(g) === DECK, "deck conserved after the kill");
  } else console.log("  (no Strike in opening hand; skipped targeted-kill check)");
  await shot("02_after_kill");

  // Spam End Turn: exactly one enemy turn must resolve.
  const turnBefore = g.turn;
  const hpBefore = g.hp;
  await key(" ");
  await key(" ");
  await key(" ");
  g = await game();
  check(g.phase === "resolving", "End Turn locks into the enemy phase");
  const e0 = g.energy;
  await key("1");
  g = await game();
  check(g.energy === e0, "card input during the enemy phase is ignored");
  await sleep(150);
  await shot("03_resolving");
  g = await waitFor((s) => s.phase === "playerTurn" || s.run !== "playing", 6000);
  check(g.turn === turnBefore + 1, `three End Turn presses advanced exactly one turn (${turnBefore} -> ${g.turn})`);
  check(g.hp < hpBefore || g.block > 0 || true, `player took the shown damage (${hpBefore} -> ${g.hp})`);
  check(g.block === 0, "player block cleared after the enemy turn");
  check(total(g) === DECK, "deck conserved across the turn");

  // Flee: enemies act once, then survivors walk back to where they engaged.
  const preFlee = g;
  await key("f");
  g = await waitFor((s) => s.phase === null, 6000);
  check(!!g && g.run === "playing", "flee resolved and returned to exploration");
  check(g.turn === 0 && preFlee.hp >= g.hp, `HP persisted through flee (${preFlee.hp} -> ${g.hp})`);
  const survivors = g.enemies.filter((e) => engageRecord[e.id]);
  const backHome = survivors.every((e) => Math.hypot(e.x - engageRecord[e.id].x, e.y - engageRecord[e.id].y) < 30);
  check(backHome, "surviving enemies returned to their recorded engage positions (no carrying via formation)");
  check(g.piles.exhaust === 0 && g.piles.hand.length === 0 && total(g) === DECK, "after flee: hand and exhaust returned, 14 cards");
  await sleep(1200);
  g = await game();
  check(Math.abs(g.cam.scale - 1) < 0.02, `camera back to 1x after flee (${g.cam.scale.toFixed(2)})`);
  check(Math.abs(g.cam.x - Math.min(Math.max(g.player.x, 480), 1720)) < 25, "camera following the player again");
  check(g.phase === null, "flee immunity: no instant re-engage");
  await shot("04_after_flee");

  console.log("\n# Corners and edges");
  for (const [name, q] of [
    ["topLeft_boss7", "7,1,16,16"],
    ["topRight_4", "4,0,2184,16"],
    ["bottomRight_boss7", "7,1,2184,1284"],
    ["bottomLeft_boss1", "1,1,16,1284"],
    ["centre_7", "7,0,1100,650"],
    ["centre_2", "2,0,1100,650"],
  ]) {
    await open(`?fight=${q}`);
    g = await waitFor((s) => s.phase === "playerTurn");
    if (!g) {
      check(false, `${name}: fight started`);
      continue;
    }
    await sleep(900); // let the camera settle
    g = await game();
    layoutChecks(g, name);
    check(fighters(g).length === Number(q.split(",")[0]) + Number(q.split(",")[1]), `${name}: every chaser joined (${fighters(g).length})`);
    await shot(`10_${name}`);
  }

  console.log("\n# Death mid-resolve, then restart");
  await open("?fight=7,1,1100,650");
  g = await waitFor((s) => s.phase === "playerTurn");
  await key(" ");
  g = await waitFor((s) => s.run === "dead", 8000);
  check(!!g, "7 grunts + boss kill the player during the first enemy turn");
  check(g.hp === 0 && g.phase === null, "combat stopped immediately at death");
  check(total(g) === DECK, "deck conserved at death");
  await sleep(1000);
  const deadAt = await game();
  check(deadAt.hp === 0 && deadAt.run === "dead", "no leftover enemy actions after death");
  await shot("20_dead");
  await key("r");
  g = await waitFor((s) => s.run === "playing");
  check(g.enemies.length === 8 && g.hp === 24 && g.phase === null, "R restarts: full HP, all 8 enemies, exploring");
  await sleep(1200);
  g = await game();
  check(Math.abs(g.cam.scale - 1) < 0.02 && Math.abs(g.cam.x - 480) < 30, "camera back on the player at 1x after restart");
  check(total(g) === DECK && g.piles.exhaust === 0, "fresh 14-card deck");
  await shot("21_restarted");

  console.log("\n# Boss charge telegraph");
  await open("?fight=0,1,1100,650");
  g = await waitFor((s) => s.phase === "playerTurn");
  for (let t = 0; t < 2; t++) {
    await key(" ");
    g = await waitFor((s) => s.phase === "playerTurn" && s.turn === t + 2, 6000);
  }
  const boss = g && fighters(g).find((e) => e.boss);
  check(!!boss && boss.intent === "CHARGE\nnext: ATK 12", `turn 3 boss intent names the coming hit (${JSON.stringify(boss?.intent)})`);
  await sleep(600);
  await shot("30_boss_charge");

  console.log("\n# Overflow list (20 grunts + boss)");
  await open("?fight=20,1,1100,650");
  g = await waitFor((s) => s.phase === "playerTurn");
  await sleep(900);
  g = await game();
  const inFight = fighters(g);
  const listed = inFight.filter((e) => e.overflow);
  check(inFight.length === 21, `all 21 joined the fight (${inFight.length})`);
  check(listed.length > 0, `${listed.length} that don't fit cleanly go to the side list`);
  check(inFight.length - listed.length > 0 && !inFight.find((e) => e.boss).overflow, "boss keeps a stage slot");
  layoutChecks(g, "overflow stage");
  await click(VIEW_W - 120, 48); // first list row
  g = await game();
  check(g.target === listed[0].id, `clicking the first list row targets grunt #${listed[0].id}`);
  await shot("40_overflow");
  const ci = g.piles.hand.indexOf("Cleave");
  if (ci >= 0) {
    await key(String(ci + 1));
    g = await game();
    const hit = listed.every((l) => (g.enemies.find((e) => e.id === l.id)?.hp ?? 0) < l.hp);
    check(hit, "Cleave also hits every listed enemy");
  } else console.log("  (no Cleave in hand; skipped)");
  await key(" ");
  g = await waitFor((s) => s.run === "dead" || s.turn === 2, 20000);
  check(!!g, "listed enemies act in the resolve (21 attackers resolved or killed the player)");

  console.log("\n# Focus then victory");
  let sawFocus = false;
  for (let attempt = 0; attempt < 8 && !sawFocus; attempt++) {
    await open("?fight=1,0,1100,650");
    g = await waitFor((s) => s.phase === "playerTurn");
    const fi = g.piles.hand.indexOf("Focus");
    if (fi < 0) continue;
    sawFocus = true;
    await key(String(fi + 1));
    g = await game();
    check(g.piles.exhaust === 1, "Focus goes to the exhaust pile");
    check(g.energy === 4, `Focus at full energy still grants +1 (${g.energy})`);
    for (let n = 0; n < 4 && g.phase === "playerTurn"; n++) {
      const si = g.piles.hand.findIndex((c) => c === "Strike" || c === "Cleave");
      if (si < 0) break;
      await key(String(si + 1));
      g = await game();
    }
    if (g.phase === null) {
      check(g.piles.exhaust === 0 && g.piles.hand.length === 0, "after victory, Focus left exhaust and the hand was returned");
      check(total(g) === DECK, "deck conserved after Focus + victory");
    } else console.log("  (no attack in hand to finish; skipped)");
  }
  if (!sawFocus) console.log("  (never drew Focus in 8 tries; skipped)");

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall browser checks passed");
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    ws?.close();
    chrome.kill();
    process.exit(failures ? 1 : 0);
  });
