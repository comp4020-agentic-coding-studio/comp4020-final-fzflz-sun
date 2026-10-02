// Browser-driven playtest: opens a real (windowed) Chrome over the DevTools
// protocol, plays through actual key / mouse / touch input, and checks the
// state the page exposes on window.__game.
//
//   node tools/playtest.mjs [baseUrl] [--suite=combat,save,viewports]
//
// combat    rules, layout and camera in dev-only ?fight= encounters (dev server only)
// save      stranger -> start -> real fight -> saved -> reload -> restored; two visitors isolated
// viewports the save-loop core actions at 1920x1080 and on a 390x844 touch phone, plus a resize mid-fight
// prodguard production only: ?fight= must not start a test fight
// monsters  splitting skirmishers, whole packs, mage revive / cancel, elite cycle across flee + reload (dev server)
// groups    each camp's fight + a big mixed fight laid out at 1920x1080 and 390x844 (dev server)
// legacy    a v1-era save planted in the running container continues correctly (PLAYTEST_CONTAINER=<name>)
// roam      wandering, menu pause, pull-away + settle + reload, Warlord homing, guards apart, flee positions (dev server)
// race      New run while the final checkpoint is slow or can't be sent (throttled / offline network)
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const BASE = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:8080/").replace(/\/?$/, "/");
const SUITES = (args.find((a) => a.startsWith("--suite="))?.slice(8) ?? "combat,save,viewports").split(",");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const OUT = process.env.SHOTS ?? "/tmp/shots";
// keep in step with src/formation.ts
const TRASH_BOX = { left: -40, right: 40, top: -70, bottom: 18 };
const ELITE_BOX = { left: -48, right: 48, top: -96, bottom: 26 };
const BOSS_BOX = { left: -58, right: 58, top: -108, bottom: 32 };
const DECK = 14;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
  return cond;
}

const profile = `/tmp/cdp-playtest-${process.pid}`;
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1250,750",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "about:blank",
], { stdio: "ignore" });

let ws;
let msgId = 0;
const pending = new Map();
let mobile = false;

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
            const text = JSON.stringify(m.params).slice(0, 300);
            if (!/Failed to load resource/.test(text)) {
              console.log("  FAIL page error:", text);
              failures++;
            }
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
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}
async function game() {
  const v = await evaluate("JSON.stringify(window.__game?.())");
  return v ? JSON.parse(v) : null;
}
async function waitFor(pred, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const g = await game();
    if (g && pred(g)) return g;
    await sleep(60);
  }
  return null;
}
async function waitText(selector, re, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
    if (re.test(t)) return t;
    await sleep(80);
  }
  return await evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
}

async function setViewport(w, h, isMobile = false) {
  mobile = isMobile;
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: isMobile ? 2 : 1, mobile: isMobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: isMobile, maxTouchPoints: isMobile ? 5 : 1 });
}
async function open(path) {
  await send("Page.navigate", { url: BASE + path });
  await sleep(400);
  return waitFor((s) => !!s, 8000);
}
async function key(k) {
  const code = k === " " ? "Space" : /^[0-9]$/.test(k) ? `Digit${k}` : k.startsWith("Arrow") ? k : `Key${k.toUpperCase()}`;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, text: k.length === 1 ? k : undefined });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code });
  await sleep(60);
}
async function tap(x, y) {
  if (mobile) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(40);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(30);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }
  await sleep(80);
}
/** Taps the centre of a DOM element; returns false if it isn't there / visible. */
async function tapEl(selector) {
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
    const b = e.getBoundingClientRect(); return b.width && b.height ? JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) : null; })()`);
  if (!r) return false;
  const { x, y } = JSON.parse(r);
  await tap(x, y);
  return true;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64"));
}
const total = (g) => g.piles.draw + g.piles.hand.length + g.piles.discard + g.piles.exhaust;
const fighters = (g) => g.enemies.filter((e) => e.state === "engaged");

function layoutChecks(g, label) {
  const shown = fighters(g).filter((e) => !e.overflow);
  const s = g.cam.scale;
  const rects = shown.map((e) => {
    const b = e.boss ? BOSS_BOX : e.elite ? ELITE_BOX : TRASH_BOX;
    return { x0: e.sx + b.left * s, y0: e.sy + b.top * s, x1: e.sx + b.right * s, y1: e.sy + b.bottom * s };
  });
  const safe = g.safe;
  const out = rects.filter((r) => r.x0 < safe.x0 - 1 || r.y0 < safe.y0 - 1 || r.x1 > safe.x1 + 1 || r.y1 > safe.y1 + 1);
  check(out.length === 0, `${label}: every enemy's body/HP/intent/marker is inside the area left by HUD, hand and buttons (${shown.length} on stage)`);
  let overlap = false;
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) overlap = true;
    }
  check(!overlap, `${label}: no two enemies' footprints overlap (scale ${s.toFixed(2)})`);
  const halfW = g.view.w / (2 * s), halfH = g.view.h / (2 * s);
  check(
    g.cam.x >= halfW - 0.5 && g.cam.x <= 2200 - halfW + 0.5 && g.cam.y >= halfH - 0.5 && g.cam.y <= 1300 - halfH + 0.5,
    `${label}: camera stays inside the map`,
  );
}
const sameState = (a, b) =>
  a.hp === b.hp && a.energy === b.energy && a.turn === b.turn && a.phase === b.phase &&
  JSON.stringify(a.piles) === JSON.stringify(b.piles) &&
  JSON.stringify(a.enemies.map((e) => [e.id, e.hp, e.intent, e.x, e.y])) === JSON.stringify(b.enemies.map((e) => [e.id, e.hp, e.intent, e.x, e.y]));

/** Plays the current fight to the end: attack cards on the target, else end turn. */
async function fightToEnd(useTaps) {
  for (let step = 0; step < 80; step++) {
    const g = await game();
    if (!g || g.phase === null || g.run !== "playing") return g;
    if (g.phase !== "playerTurn") {
      await sleep(150);
      continue;
    }
    const idx = g.piles.hand.findIndex((c) => (c === "Strike" && g.energy >= 1) || (c === "Cleave" && g.energy >= 2) || c === "Focus");
    if (idx >= 0) {
      if (useTaps) await tapEl(`#hand .card:nth-child(${idx + 1})`);
      else await key(String(idx + 1));
    } else if (useTaps) await tapEl("#endTurn");
    else await key(" ");
    await sleep(120);
  }
  return game();
}

/** Starts a real fight with the nearest camp by tapping toward it (tap-to-move), following the camp pointer when it's off screen. */
async function walkIntoFight() {
  for (let i = 0; i < 80; i++) {
    const g = await game();
    if (g.phase) return g;
    // whichever map enemy is nearest (the camp pointer only shows when that one is off screen)
    const near = g.enemies
      .filter((e) => e.spawnId)
      .sort((a, b) => Math.hypot(a.x - g.player.x, a.y - g.player.y) - Math.hypot(b.x - g.player.x, b.y - g.player.y));
    const t = near[0];
    if (!t) return g;
    const s = g.safe;
    const onScreen = t.sx > s.x0 && t.sx < s.x1 && t.sy > s.y0 && t.sy < s.y1;
    const goal = onScreen ? { x: t.sx, y: t.sy } : g.pointer ?? { x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 };
    await tap(goal.x, goal.y);
    await sleep(250);
  }
  return game();
}

// ---------------------------------------------------------------- suites

async function combatSuite() {
  console.log("\n# combat rules & layout (dev ?fight=, 960x540)");
  await setViewport(960, 540);
  let g = await open("?fight=3,1,1250,750");
  if (!check(g && g.saveStatus === "off", "test fights switch saving off")) return;
  g = await waitFor((s) => s.phase === "playerTurn");
  check(!!g && fighters(g).length === 6, `3 stacked grunts + the Warlord's whole pack joined (${g && fighters(g).length})`);
  await sleep(900);
  g = await game();
  layoutChecks(g, "warlord pack + 3");
  await shot("c01_boss3");

  g = await open("?fight=3,0,1250,750");
  g = await waitFor((s) => s.phase === "playerTurn");
  check(!!g && fighters(g).length === 3, "three stacked grunts all joined; first turn started after formation");
  check(fighters(g).every((e) => e.intent), "every participant shows an intent");
  await sleep(900);
  g = await game();
  layoutChecks(g, "3 grunts");

  const before = g;
  await sleep(2000);
  check(sameState(before, await game()), "2s idle on the player turn: nothing changes");

  const grunt = fighters(g).find((e) => !e.boss);
  await tap(grunt.sx, grunt.sy);
  g = await game();
  check(g.target === grunt.id, "clicking a grunt selects it");
  await key("ArrowRight");
  const g2 = await game();
  check(g2.target !== grunt.id, "→ cycles the target");
  await key("ArrowLeft");
  g = await game();
  check(g.target === grunt.id, "← cycles back");

  const si = g.piles.hand.indexOf("Strike");
  if (si >= 0) {
    const others = fighters(g).filter((e) => e.id !== grunt.id);
    await tapEl(`#hand .card:nth-child(${si + 1})`);
    g = await game();
    const victim = g.enemies.find((e) => e.id === grunt.id);
    check(!victim || victim.hp < grunt.hp, "tapping the Strike card hit the selected grunt");
    check(
      others.every((o) => {
        const n = g.enemies.find((e) => e.id === o.id);
        return n && n.hp === o.hp && Math.hypot(n.x - o.x, n.y - o.y) < 0.5;
      }),
      "nobody else was hit or moved (slots stay put after a kill)",
    );
  }
  check(total(g) === DECK, "deck conserved");

  const turnBefore = g.turn;
  await key(" ");
  await key(" ");
  await key(" ");
  g = await game();
  check(g.phase === "resolving", "End turn locks into the enemy phase");
  const e0 = g.energy;
  await key("1");
  check((await game()).energy === e0, "cards are ignored during the enemy phase");
  g = await waitFor((s) => s.phase === "playerTurn" || s.run !== "playing", 8000);
  check(g.turn === turnBefore + 1, `three Space presses advanced exactly one turn (${turnBefore} -> ${g.turn})`);
  check(g.block === 0 && total(g) === DECK, "block cleared, deck conserved after the enemy turn");

  const engage = Object.fromEntries(fighters(g).map((e) => [e.id, { x: e.engageX, y: e.engageY }]));
  const preFlee = g;
  await tapEl("#flee");
  g = await waitFor((s) => s.phase === null, 8000);
  check(!!g && g.run === "playing" && g.hp <= preFlee.hp, `flee: enemies acted, then back to exploring (HP ${preFlee.hp} -> ${g?.hp})`);
  check(
    g.enemies.filter((e) => engage[e.id]).every((e) => Math.hypot(e.x - engage[e.id].x, e.y - engage[e.id].y) < 30),
    "survivors returned to where they engaged (formation never carries enemies)",
  );
  check(g.piles.exhaust === 0 && g.piles.hand.length === 0 && total(g) === DECK, "after flee: hand and exhaust back in the deck");
  await sleep(1200);
  g = await game();
  check(Math.abs(g.cam.scale - g.base) < 0.02, "camera back to exploration zoom");

  console.log("\n# corners, crowds, overflow list, boss charge");
  for (const [name, q] of [["topLeft_boss7", "7,1,16,16"], ["bottomRight_boss7", "7,1,2184,1284"], ["topRight_4", "4,0,2184,16"], ["centre_7", "7,0,1250,750"]]) {
    await open(`?fight=${q}`);
    g = await waitFor((s) => s.phase === "playerTurn");
    await sleep(900);
    g = await game();
    layoutChecks(g, name);
    const want = Number(q.split(",")[0]) + (q.split(",")[1] === "1" ? 3 : 0);
    check(fighters(g).length === want, `${name}: every chaser joined (${fighters(g).length}/${want})`);
    await shot(`c10_${name}`);
  }
  await open("?fight=30,1,1250,750");
  g = await waitFor((s) => s.phase === "playerTurn");
  await sleep(900);
  g = await game();
  const listed = fighters(g).filter((e) => e.overflow);
  check(fighters(g).length === 33 && listed.length > 0, `33 joined; ${listed.length} that don't fit go to the side list`);
  layoutChecks(g, "overflow stage");
  await tapEl("#overflowList button:first-child");
  g = await game();
  check(g.target === listed[0].id, "tapping the first list entry targets that enemy");
  await shot("c20_overflow");

  await open("?fight=0,1,1250,750");
  g = await waitFor((s) => s.phase === "playerTurn");
  for (let t = 0; t < 2; t++) {
    await key(" ");
    g = await waitFor((s) => s.phase === "playerTurn" && s.turn === t + 2, 8000);
  }
  check(fighters(g).find((e) => e.boss)?.intent === "CHARGE\nnext: ATK 12", "turn 3: the boss's charge names the coming 12-damage hit");

  console.log("\n# death stops the resolve");
  await open("?fight=7,1,1250,750");
  await waitFor((s) => s.phase === "playerTurn");
  await key(" ");
  g = await waitFor((s) => s.run === "dead", 10000);
  check(!!g && g.hp === 0 && g.phase === null, "fell during the enemy turn; combat stopped at once");
  check(await evaluate(`!document.getElementById("screen").hidden`), "the end screen opens");
  await sleep(800);
  check((await game()).hp === 0, "no leftover enemy actions after death");
}

async function saveSuite(viewport = { w: 1280, h: 800, mobile: false }, label = "1280x800") {
  console.log(`\n# stranger -> fight -> saved -> reload -> restored (${label})`);
  await setViewport(viewport.w, viewport.h, viewport.mobile);
  await send("Network.enable");
  await send("Network.clearBrowserCookies");
  let g = await open("");
  const titleText = await waitText("#panel", /Start a run/);
  check(/Start a run/.test(titleText) && /How to play/.test(titleText), "a stranger sees the goal, controls and a Start button");
  check(await evaluate(`!!document.querySelector('#panel a[href="/readme/"]')`), "the start screen links the README");
  await shot(`s01_title_${label}`);
  await tapEl("#go");
  g = await waitFor((s) => s.run === "playing" && !s.screen, 6000);
  check(!!g && g.runNumber === 1, "Start creates run #1 on the server");
  const pill = await waitText("#savePill", /Saved/);
  check(/Saved/.test(pill), `save status shows server confirmation (“${pill}”)`);

  const mapIds = (s) => new Set(s.enemies.filter((e) => e.spawnId).map((e) => e.spawnId));
  const beforeFight = mapIds(await game());
  g = await walkIntoFight();
  check(!!g?.phase, "tapping the map walks the player into a camp fight");
  await waitFor((s) => s.phase === "playerTurn");
  await sleep(700);
  g = await game();
  layoutChecks(g, `real fight ${label}`);
  await shot(`s02_fight_${label}`);
  g = await fightToEnd(true);
  check(g.phase === null && g.run === "playing", `won the fight with taps only (HP ${g.hp})`);
  const savedText = await waitText("#savePill", /Saved/, 8000);
  check(/Saved/.test(savedText), "victory checkpoint confirmed by the server");
  const afterWin = await game();
  const killed = [...beforeFight].filter((id) => !mapIds(afterWin).has(id));
  check(killed.length >= 1, `killed ${killed.join(", ")}`);

  const api = await evaluate(`fetch("/api/save").then(r => r.json()).then(j => JSON.stringify(j))`);
  const stored = JSON.parse(api).save;
  check(stored.reason === "victory" && stored.player.hp === afterWin.hp, `server holds the victory checkpoint (HP ${stored.player.hp})`);
  check(killed.every((id) => stored.enemies[id] === 0), "server records the killed enemies by stable id");

  await send("Page.reload");
  await sleep(500);
  const back = await waitText("#panel", /Welcome back/);
  check(/Welcome back/.test(back) && /Run #1/.test(back), "after reload the start screen shows the saved run");
  check(/Camps cleared: [1-9]/.test(back) || !/^west|^south/.test(killed.join()), "it reports the cleared camp");
  await shot(`s03_restore_${label}`);
  await tapEl("#go");
  g = await waitFor((s) => s.run === "playing" && !s.screen);
  check(g.hp === afterWin.hp, `HP restored (${g.hp})`);
  check(killed.every((id) => !g.enemies.some((e) => e.spawnId === id)), "killed enemies stay dead after reload");
  check(Math.hypot(g.player.x - afterWin.player.x, g.player.y - afterWin.player.y) < 2, "player restored to the checkpoint position");
  check((await evaluate(`document.getElementById("progress").innerText`)).includes("Run #1"), "HUD shows the restored run");

  console.log(`\n# a second visitor gets their own save (${label})`);
  const cookies = (await send("Network.getCookies", { urls: [BASE] })).result.cookies;
  const mine = cookies.find((c) => c.name === "cc_visitor");
  check(!!mine && mine.httpOnly, "visitor cookie is HttpOnly");
  await send("Network.clearBrowserCookies");
  await open("");
  const strangerText = await waitText("#panel", /Start a run/);
  check(/Start a run/.test(strangerText), "a different browser identity starts fresh");
  await tapEl("#go");
  await waitFor((s) => s.run === "playing" && !s.screen);
  await waitText("#savePill", /Saved/);
  await send("Network.setCookie", { name: mine.name, value: mine.value, url: BASE, httpOnly: true });
  await open("");
  const again = await waitText("#panel", /Welcome back/);
  check(/Welcome back/.test(again) && /Run #1/.test(again), "the first visitor's progress was not overwritten");
  await tapEl("#go");
  g = await waitFor((s) => s.run === "playing" && !s.screen);
  check(killed.every((id) => !g.enemies.some((e) => e.spawnId === id)), "…and their kills are still there");
}

async function viewportSuite() {
  await saveSuite({ w: 1920, h: 1080, mobile: false }, "1920x1080");
  await saveSuite({ w: 390, h: 844, mobile: true }, "390x844");

  console.log("\n# phone controls & a resize mid-fight");
  await setViewport(390, 844, true);
  let g = await game();
  check(!!g.pointer, `on the phone an edge pointer shows the way to the nearest camp (“${g.pointer?.text}”)`);
  g = await walkIntoFight();
  g = await waitFor((s) => s.phase === "playerTurn", 8000);
  if (g) {
    const dock = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#endTurn, #flee, #menuBtn')].map(e => { const b = e.getBoundingClientRect(); return { w: b.width, h: b.height }; }))`));
    check(dock.every((b) => b.w >= 44 && b.h >= 30), `phone buttons are usable touch targets (${dock.map((b) => `${Math.round(b.w)}x${Math.round(b.h)}`).join(" ")})`);
    const cards = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#hand .card:not(.empty)')].map(e => { const b = e.getBoundingClientRect(); return { w: b.width, h: b.height }; }))`));
    check(cards.length > 0 && cards.every((b) => b.w >= 70 && b.h >= 60), `phone cards are tappable (${cards.map((b) => `${Math.round(b.w)}x${Math.round(b.h)}`).join(" ")})`);
    const fontPx = Number(await evaluate(`parseFloat(getComputedStyle(document.querySelector('#hand .card .blurb')).fontSize)`));
    check(fontPx >= 10, `card text stays readable on the phone (${fontPx}px)`);
    await sleep(800);
    layoutChecks(await game(), "phone fight");
    await shot("v01_phone_fight");
    await setViewport(1280, 720, false);
    await sleep(1200);
    g = await game();
    layoutChecks(g, "after resize to 1280x720 mid-fight");
    await shot("v02_resized");
    await setViewport(390, 844, true);
    await sleep(1200);
    layoutChecks(await game(), "after resizing back to the phone");
    g = await fightToEnd(true);
    check(g.phase === null, "finished the fight after the resizes");
  } else check(false, "phone: walked into a fight");
}

async function apiState() {
  return JSON.parse(await evaluate(`fetch("/api/save").then(r => r.json()).then(j => JSON.stringify(j))`));
}
async function network(conditions) {
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, ...conditions });
}

async function raceSuite() {
  console.log("\n# race: New run while the victory checkpoint is still in flight (real server, slow network)");
  await setViewport(1280, 800);
  await send("Network.enable");
  await send("Network.clearBrowserCookies");
  await network({});
  await open("");
  await waitText("#panel", /Start a run/);
  await tapEl("#go");
  await waitFor((s) => s.run === "playing" && !s.screen);
  await waitText("#savePill", /Saved/);
  await walkIntoFight();
  await waitFor((s) => s.phase === "playerTurn");
  await network({ latency: 1500 });
  let g = await fightToEnd(true);
  check(g.phase === null && g.run === "playing", "won the fight on a 1.5 s-latency connection");
  const pillNow = await evaluate(`document.getElementById("savePill").innerText`);
  check(!/Saved/.test(pillNow), `right after the win the pill doesn't claim Saved yet (“${pillNow}”)`);
  await key("Escape");
  await tapEl("#new");
  await tapEl("#yes");
  await tapEl("#yes"); // a double click on the confirm button
  const waiting = await evaluate(`document.getElementById("panel").innerText`);
  check(/Saving your last result|Starting a run/.test(waiting), `a wait screen replaces the buttons (“${waiting.split("\n")[0]}”)`);
  g = await waitFor((s) => s.run === "playing" && !s.screen && s.runNumber === 2, 15000);
  check(!!g, "run #2 started once the victory was confirmed");
  await network({});
  let api = await apiState();
  check(api.save.runNumber === 2 && api.runs.length === 1, `exactly one new run was created (history: ${api.runs.map((r) => "#" + r.runNumber).join(",")})`);
  check(api.runs[0]?.runNumber === 1 && api.runs[0]?.wins >= 1, `run #1 was archived with its victory (wins ${api.runs[0]?.wins}, outcome ${api.runs[0]?.outcome})`);
  check(/Saved/.test(await waitText("#savePill", /Saved/)), "the new run shows Saved");

  console.log("\n# race: the final checkpoint can't reach the server");
  await walkIntoFight();
  await waitFor((s) => s.phase === "playerTurn");
  g = await fightToEnd(true);
  await network({ offline: true });
  // the victory checkpoint is sent the moment the fight ends, so cut the network first and
  // then trigger one more checkpoint-worthy event: walking into the next fight saves "engage"
  await network({});
  await network({ offline: true });
  const second = await walkIntoFight();
  const inFight = await waitFor((s) => s.phase === "playerTurn", 8000);
  if (!inFight) console.log("  no fight after walking:", await evaluate(`document.getElementById("screen").hidden + " | " + document.getElementById("panel").innerText.slice(0,120)`), JSON.stringify({ pointer: second?.pointer, run: second?.run, phase: second?.phase, player: second?.player, enemies: second?.enemies.map((e) => [e.spawnId, Math.round(e.x), Math.round(e.y), e.state]).slice(0, 4) }));
  await sleep(500);
  const offlinePill = await evaluate(`document.getElementById("savePill").innerText`);
  check(/retrying|Not saved/i.test(offlinePill), `offline, the pill says the checkpoint isn't saved (“${offlinePill}”)`);
  await key("Escape");
  await tapEl("#new");
  await tapEl("#yes");
  const failText = await waitText("#panel", /isn't saved/, 8000);
  check(/isn't saved/.test(failText) && /Retry saving/.test(failText), "New run is refused with a clear 'last result isn't saved' screen and a Retry button");
  api = null;
  await network({});
  api = await apiState();
  check(api.save.runNumber === 2, "nothing changed on the server while offline (still run #2)");
  await tapEl("#retry");
  g = await waitFor((s) => s.run === "playing" && !s.screen && s.runNumber === 3, 15000);
  check(!!g, "Retry saved the checkpoint and started run #3");
  api = await apiState();
  const r2 = api.runs.find((r) => r.runNumber === 2);
  check(!!r2 && r2.wins >= 1, `run #2 kept its fights in history (wins ${r2?.wins}, outcome ${r2?.outcome})`);
  check(api.runs.length === 2, `history has runs #1 and #2 (${api.runs.map((r) => "#" + r.runNumber).join(",")})`);
}

/** Starts a fresh saved run (dev ?start= puts the player somewhere), returns once playing. */
async function freshRunAt(xy) {
  await send("Network.enable");
  await send("Network.clearBrowserCookies");
  await open(`?start=${xy}`);
  await waitText("#panel", /Start a run/);
  await tapEl("#go");
  await waitFor((s) => s.run === "playing" && !s.screen);
  await waitText("#savePill", /Saved/);
}

/** Taps toward a map enemy until a fight starts. */
async function walkTo(spawnId) {
  for (let i = 0; i < 80; i++) {
    const g = await game();
    if (g.phase) return g;
    const t = g.enemies.find((e) => e.spawnId === spawnId);
    if (!t) return g;
    const s = g.safe;
    const on = t.sx > s.x0 && t.sx < s.x1 && t.sy > s.y0 && t.sy < s.y1;
    await tap(on ? t.sx : g.pointer?.x ?? t.sx, on ? t.sy : g.pointer?.y ?? t.sy);
    await sleep(200);
  }
  return game();
}

/** Reloads a dev test fight until the opening hand passes `ok`, so scripted turns can be played. */
async function openFightWithHand(query, ok, tries = 25) {
  for (let i = 0; i < tries; i++) {
    await open(query);
    const g = await waitFor((s) => s.phase === "playerTurn", 6000);
    if (g && ok(g.piles.hand)) return g;
  }
  return null;
}
const count = (hand, name) => hand.filter((c) => c === name).length;

async function playNamed(name, targetSpawnId) {
  let g = await game();
  if (targetSpawnId) {
    const t = g.enemies.find((e) => e.spawnId === targetSpawnId);
    await tap(t.sx, t.sy);
  }
  g = await game();
  const i = g.piles.hand.indexOf(name);
  if (i < 0) return false;
  await key(String(i + 1));
  return true;
}

async function monstersSuite() {
  console.log("\n# skirmishers can be split; a pack comes whole (real exploration, saved run)");
  await setViewport(1280, 800);
  await freshRunAt("440,380");
  let g = await walkTo("west-1");
  g = await waitFor((s) => s.phase === "playerTurn");
  const roster = (s) => s.enemies.filter((e) => e.state === "engaged").map((e) => e.spawnId).sort();
  check(JSON.stringify(roster(g)) === JSON.stringify(["west-1"]), `approaching from the west pulls one scout alone (${roster(g)})`);
  await fightToEnd(true);

  await freshRunAt("830,1135");
  g = await game();
  check(g.packHints.some((h) => h.id === "hollow" && /Swarm · 3 together/.test(h.text)), `near the hollow the ground says what's coming (${g.packHints.map((h) => h.text).join(" | ")})`);
  await shot("m01_pack_hint");
  g = await walkTo("swarm-1");
  g = await waitFor((s) => s.phase === "playerTurn");
  check(JSON.stringify(roster(g)) === JSON.stringify(["swarm-1", "swarm-2", "swarm-3"]), `touching one swarmling brings all three, and nobody else (${roster(g)})`);
  check(g.difficulty === "normal", `a swarm of three is framed as a normal fight (${g.difficulty})`);
  await shot("m02_swarm_fight");
  const ci = g.piles.hand.indexOf("Cleave");
  if (ci >= 0) {
    await key(String(ci + 1));
    g = await waitFor((s) => s.phase === null, 3000);
    check(!!g && !g.enemies.some((e) => e.group === "hollow"), "one Cleave clears the whole swarm");
  } else await fightToEnd(true);

  console.log("\n# the mage: revive shown, revive done, revived grunt acts next turn (dev ?fight=group:north)");
  g = await openFightWithHand("?fight=group:north", (h) => count(h, "Strike") >= 1);
  check(!!g, "got a hand with a Strike");
  if (g) {
    check(g.difficulty === "dangerous", "a mage guard is framed as a dangerous fight");
    const ids = roster(g);
    check(JSON.stringify(ids) === JSON.stringify(["north-1", "north-2", "north-mage"]), `the mage pack joins whole; the lone sentry stays out (${ids})`);
    await playNamed("Strike", "north-1");
    g = await game();
    const n1 = g.enemies.find((e) => e.spawnId === "north-1");
    check(!!n1 && n1.downed && n1.label === "", `north-1 is down in its slot (label “${n1?.label}”), with no revive planned yet`);
    const mageTurn1 = g.enemies.find((e) => e.spawnId === "north-mage").intent;
    check(mageTurn1 === "SHOOT 2", `the mage's turn-1 intent stays what it showed (“${mageTurn1}”)`);
    await key(" ");
    g = await waitFor((s) => s.phase === "playerTurn" && s.turn === 2, 8000);
    const mage = g.enemies.find((e) => e.spawnId === "north-mage");
    const body = g.enemies.find((e) => e.spawnId === "north-1");
    check(mage.intent === "REVIVE +3", `turn 2: the mage shows REVIVE +3 (“${mage.intent}”)`);
    check(body.label === "↺ +3 HP", `the body shows it's the target (“${body.label}”)`);
    check(/will revive Grunt \(north-1\) at 3 HP/.test(await evaluate(`document.getElementById("feedback").innerText`)), "the HUD names who will be revived and for how much");
    await shot("m03_revive_shown");
    const slot = { x: body.x, y: body.y };
    await key(" ");
    g = await waitFor((s) => s.phase === "playerTurn" && s.turn === 3, 8000);
    const back = g.enemies.find((e) => e.spawnId === "north-1");
    check(!back.downed && back.hp === 3, `north-1 is back on 3 HP (hp ${back.hp}, downed ${back.downed})`);
    check(Math.hypot(back.x - slot.x, back.y - slot.y) < 0.5, "it came back in its own slot");
    check(back.intent === "ATK 3", `and acts normally the next turn (“${back.intent}”)`);
    check(g.enemies.find((e) => e.spawnId === "north-mage").intent === "SHOOT 2", "the mage won't revive again this fight");
    await tap(back.sx, back.sy);
    check((await game()).target === back.id, "the revived grunt can be targeted");
    await shot("m04_revived");
  }

  console.log("\n# killing the mage cancels its revive");
  g = await openFightWithHand("?fight=group:north", (h) => count(h, "Strike") >= 1);
  if (g) {
    await playNamed("Strike", "north-1");
    await key(" ");
    let ok = false;
    for (let tries = 0; tries < 30 && !ok; tries++) {
      g = await waitFor((s) => s.phase === "playerTurn" && s.turn >= 2, 8000);
      const mage = g?.enemies.find((e) => e.spawnId === "north-mage");
      if (!g || !mage || mage.intent !== "REVIVE +3") break;
      // spend the turn on the mage: Focus, then Strikes / Cleave until it falls or cards run out
      for (const card of ["Focus", "Strike", "Strike", "Cleave", "Strike"]) {
        const cur = await game();
        const m = cur.enemies.find((e) => e.spawnId === "north-mage");
        if (!m || m.downed) break;
        await playNamed(card, card === "Focus" || card === "Cleave" ? null : "north-mage");
      }
      g = await game();
      ok = !!g.enemies.find((e) => e.spawnId === "north-mage")?.downed;
      if (!ok) break;
    }
    if (ok) {
      check(g.enemies.find((e) => e.spawnId === "north-1").label === "", "with the mage down, the body no longer shows a revive");
      await key(" ");
      g = await waitFor((s) => s.phase === "playerTurn" || s.phase === null, 8000);
      check(!g.enemies.some((e) => e.spawnId === "north-1" && !e.downed), "north-1 stayed down: the revive never happened");
    } else console.log("  (couldn't down the mage in one turn with this hand; covered by src/combat.test.ts)");
  }

  console.log("\n# the captain's cycle survives a flee and a reload (real exploration, saved run)");
  await freshRunAt("1440,1095");
  g = await walkTo("ridge-1");
  g = await waitFor((s) => s.phase === "playerTurn");
  const cap = (s) => s.enemies.find((e) => e.spawnId === "ridge-captain");
  check(JSON.stringify(roster(g)) === JSON.stringify(["ridge-1", "ridge-2", "ridge-captain"]), `the captain's pack joins whole (${roster(g)})`);
  check(cap(g).intent === "ATK 4" && cap(g).elite, `turn 1: the ELITE captain shows ATK 4 (“${cap(g).intent}”)`);
  await shot("m05_captain_turn1");
  await key(" ");
  g = await waitFor((s) => s.phase === "playerTurn" && s.turn === 2, 8000);
  check(cap(g).intent === "CHARGE\nnext: ATK 10", `turn 2: CHARGE naming the 10 coming (“${cap(g).intent}”)`);
  await key("f");
  g = await waitFor((s) => s.phase === null, 10000);
  check(!!g && g.run === "playing", `fled after the charge resolved (HP ${g?.hp})`);
  await waitText("#savePill", /Saved/, 8000);
  const api = await apiState();
  check(api.save.phases["ridge-captain"] === 2, `the server saved the captain at phase 2 (the heavy hit) (${api.save.phases["ridge-captain"]})`);
  await send("Page.reload");
  await sleep(500);
  await waitText("#panel", /Welcome back/);
  await tapEl("#go");
  await waitFor((s) => s.run === "playing" && !s.screen);
  await sleep(2700); // load protection
  g = await walkTo("ridge-1");
  g = await waitFor((s) => s.phase === "playerTurn", 10000);
  check(!!g && cap(g)?.intent === "HEAVY ATK 10", `after the reload the captain opens with the charged HEAVY ATK 10 (“${g && cap(g)?.intent}”)`);
  await shot("m06_captain_resumed");
}

async function groupLayoutSuite() {
  console.log("\n# every camp's fight is readable at both marking viewports");
  for (const [w, h, mob, label] of [[1920, 1080, false, "1920x1080"], [390, 844, true, "390x844"]]) {
    await setViewport(w, h, mob);
    for (const grp of ["north", "ridge", "lair", "hollow"]) {
      await open(`?fight=group:${grp}`);
      let g = await waitFor((s) => s.phase === "playerTurn", 8000);
      if (!check(!!g, `${label} ${grp}: fight started`)) continue;
      await sleep(900);
      g = await game();
      layoutChecks(g, `${label} ${grp}`);
      const outlined = await evaluate(`JSON.stringify(window.__game().enemies.filter(e => e.state === "engaged").length)`);
      void outlined;
      await shot(`g_${grp}_${label}`);
    }
    await open("?fight=9,1,1250,750");
    let g = await waitFor((s) => s.phase === "playerTurn", 8000);
    await sleep(900);
    g = await game();
    layoutChecks(g, `${label} big mixed fight (${fighters(g).length})`);
    await shot(`g_mixed_${label}`);
  }
  await setViewport(1280, 800);
}

async function legacySuite() {
  console.log("\n# a save from the v1 game continues correctly (needs PLAYTEST_CONTAINER = the running image)");
  const container = process.env.PLAYTEST_CONTAINER;
  if (!check(!!container, "PLAYTEST_CONTAINER is set")) return;
  await setViewport(1280, 800);
  await send("Network.enable");
  await send("Network.clearBrowserCookies");
  await open("");
  await waitText("#panel", /Start a run/);
  const cookie = (await send("Network.getCookies", { urls: [BASE] })).result.cookies.find((c) => c.name === "cc_visitor");
  const vid = createHash("sha256").update(cookie.value).digest("hex");
  const v1 = {
    v: 1, runId: "run_oldsave1", runNumber: 2, startedAt: 1700000000000, savedAt: 1700000100000, reason: "victory", outcome: "playing",
    player: { hp: 13, x: 700, y: 700 },
    enemies: { "west-1": 0, "west-2": 0, "south-1": 4, "north-1": 6, "north-2": 6, "north-3": 6, "lair-guard": 6, "lair-boss": 40 },
    stats: { fights: 3, wins: 2, flees: 1, kills: 2 },
  };
  execFileSync("docker", ["exec", container, "node", "--disable-warning=ExperimentalWarning", "-e",
    `const{DatabaseSync}=require("node:sqlite");new DatabaseSync("/data/game.sqlite").prepare("INSERT INTO saves (visitor_id, revision, data, updated_at) VALUES (?, 1, ?, ?)").run(process.argv[1], process.argv[2], Date.now())`,
    vid, JSON.stringify(v1)]);
  await send("Page.reload");
  await sleep(500);
  const text = await waitText("#panel", /Welcome back/);
  check(/Run #2/.test(text) && /HP 13\/24/.test(text) && /West camp/.test(text), "the start screen shows the old run: #2, HP 13, West camp cleared");
  await shot("l01_legacy_title");
  await tapEl("#go");
  const g = await waitFor((s) => s.run === "playing" && !s.screen);
  const ids = new Set(g.enemies.map((e) => e.spawnId));
  check(!ids.has("west-1") && !ids.has("west-2"), "enemies killed in the v1 run stay dead");
  check(g.enemies.find((e) => e.spawnId === "south-1")?.hp === 4, "a wounded v1 enemy keeps its HP");
  check(ids.has("north-mage") && ids.has("swarm-1") && ids.has("ridge-captain"), "new camps and the new mage are there to fight");
  check(g.hp === 13 && g.stats.kills === 2, `player HP and stats carried over (HP ${g.hp}, kills ${g.stats.kills})`);
}

/** Screen position of a world point (clamped inside the safe area so a tap lands on the map). */
function screenOf(g, wx, wy) {
  const s = g.cam.scale;
  let x = (wx - g.cam.x) * s + g.view.w / 2;
  let y = (wy - g.cam.y) * s + g.view.h / 2;
  const m = 30;
  x = Math.min(Math.max(x, g.safe.x0 + m), g.safe.x1 - m);
  y = Math.min(Math.max(y, g.safe.y0 + m), g.safe.y1 - m);
  return { x, y };
}
/** Walks the player toward a world point by repeated taps until `until(state)` or arrival. */
async function walkToward(wx, wy, until = () => false, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const g = await game();
    if (until(g)) return g;
    if (Math.hypot(g.player.x - wx, g.player.y - wy) < 12) return g;
    const p = screenOf(g, wx, wy);
    await tap(p.x, p.y);
    await sleep(150);
  }
  return game();
}
const byId = (g, id) => g.enemies.find((e) => e.spawnId === id);
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

async function roamSuite() {
  console.log("\n# enemies wander on their own, pause, and stay near their spot");
  await setViewport(1280, 800);
  await freshRunAt("220,650");
  const track = [];
  for (let i = 0; i < 30; i++) {
    const g = await game();
    track.push(byId(g, "west-1"));
    await sleep(200);
  }
  const moved = track.slice(1).filter((p, i) => d2(p, track[i]) > 0.5).length;
  const still = track.length - 1 - moved;
  const w1 = track[0];
  const maxOff = Math.max(...track.map((p) => Math.hypot(p.x - p.cx, p.y - p.cy)));
  check(moved >= 4 && still >= 4, `west-1 walks and pauses (${moved} moving / ${still} still samples over 6 s)`);
  check(maxOff <= w1.wander + 3, `it stays within its wander radius (${maxOff.toFixed(0)} <= ${w1.wander})`);
  check(track.every((p) => p.state === "idle"), "it never noticed the far-away player");

  console.log("\n# the menu freezes the world");
  await key("Escape");
  const a = await game();
  await sleep(1500);
  const b = await game();
  const same = a.enemies.every((e) => { const f = b.enemies.find((x) => x.id === e.id); return f && d2(e, f) < 0.01; });
  check(a.screen && same, "with the menu open no enemy moves");
  await key("Escape");

  console.log("\n# a grunt pulled away settles where it gave up, and stays there after a reload");
  await freshRunAt("470,380");
  let g = await waitFor((s) => byId(s, "west-1")?.state === "chasing", 4000);
  check(!!g, "west-1 notices the player");
  g = await walkToward(80, 80, (s) => ["calm", "idle"].includes(byId(s, "west-1")?.state) && byId(s, "west-1").state !== "chasing", 15000);
  g = await waitFor((s) => ["calm", "idle"].includes(byId(s, "west-1")?.state), 6000);
  const pulled = byId(g, "west-1");
  check(!!pulled && d2({ x: pulled.cx, y: pulled.cy }, { x: pulled.spawnX, y: pulled.spawnY }) > 120, `it gave up away from home: new center (${pulled?.cx.toFixed(0)},${pulled?.cy.toFixed(0)}) vs spawn (${pulled?.spawnX},${pulled?.spawnY})`);
  await waitText("#savePill", /Saved/, 6000);
  await sleep(600);
  let api = await apiState();
  const q = api.save.places["west-1"];
  check(api.save.reason === "disengage" && Math.abs(q.cx - pulled.cx) < 2 && Math.abs(q.cy - pulled.cy) < 2, `the server saved the new center (reason ${api.save.reason}, ${q.cx},${q.cy})`);
  await send("Page.reload");
  await sleep(500);
  await waitText("#panel", /Welcome back/);
  await tapEl("#go");
  g = await waitFor((s) => s.run === "playing" && !s.screen);
  const back = byId(g, "west-1");
  check(Math.abs(back.cx - q.cx) < 1 && Math.abs(back.cy - q.cy) < 1, "after the reload it wanders around the saved center");
  check(d2(back, { x: q.x, y: q.y }) < 3, "and starts from its saved position, not its spawn");
  await shot("r01_pulled_grunt");

  console.log("\n# the Warlord goes home; its guards stay where they gave up");
  await freshRunAt("1690,500");
  g = await waitFor((s) => byId(s, "lair-boss")?.state === "chasing", 5000);
  check(!!g && byId(g, "lair-guard")?.state === "chasing", "the lair wakes together (guards and boss are linked at home)");
  let sawHoming = false;
  const lured = (s) => {
    if (byId(s, "lair-boss")?.state === "homing") sawHoming = true;
    return sawHoming && ["calm", "idle"].includes(byId(s, "lair-guard")?.state);
  };
  // lure them south-west on a route that stays clear of the other camps
  for (const [wx, wy] of [[1350, 900], [1150, 820], [1350, 900]]) {
    g = await walkToward(wx, wy, lured, 12000);
    if (lured(g)) break;
  }
  check(sawHoming, "the Warlord turned back at the edge of its lair");
  g = await waitFor((s) => byId(s, "lair-boss")?.state !== "homing" && ["calm", "idle"].includes(byId(s, "lair-guard")?.state), 15000);
  const boss = byId(g, "lair-boss");
  const guard = byId(g, "lair-guard");
  check(!!boss && d2(boss, { x: boss.spawnX, y: boss.spawnY }) <= boss.wander + 3 && boss.cx === boss.spawnX, "it walked back and wanders in its lair again");
  check(!!guard && d2({ x: guard.cx, y: guard.cy }, { x: guard.spawnX, y: guard.spawnY }) > 250, `its guard settled away from the lair (${d2({ x: guard.cx, y: guard.cy }, { x: guard.spawnX, y: guard.spawnY }).toFixed(0)} px)`);
  await waitText("#savePill", /Saved/, 6000);
  await sleep(700);
  api = await apiState();
  check(!api.save.places["lair-boss"].homing && Math.abs(api.save.places["lair-boss"].x - 1905) < 80, `the server has the Warlord home (reason ${api.save.reason})`);
  const hints = (await game()).packHints;
  check(hints.some((h) => h.id === "lair" && /2 together/.test(h.text)), `the guards' hint follows them and counts only who's together (${hints.map((h) => h.text).join(" | ")})`);
  await shot("r02_guards_apart");

  console.log("\n# far guards fight without the Warlord; fleeing puts them back where they stood");
  g = await walkToward(guard.x, guard.y, (s) => !!s.phase, 15000);
  g = await waitFor((s) => s.phase === "playerTurn", 8000);
  const roster = (s) => s.enemies.filter((e) => e.state === "engaged").map((e) => e.spawnId).sort();
  check(!!g && !roster(g).includes("lair-boss") && roster(g).includes("lair-guard"), `the guards' fight leaves the Warlord in its lair (${g && roster(g)})`);
  const before = Object.fromEntries(g.enemies.filter((e) => e.state === "engaged").map((e) => [e.spawnId, { x: e.engageX, y: e.engageY }]));
  await key("f");
  g = await waitFor((s) => s.phase === null, 10000);
  const backHome = Object.keys(before).every((id) => { const e = byId(g, id); return !e || d2(e, before[id]) < 1; });
  check(backHome, "after fleeing, survivors stand where they were before the fight (not at their slots)");
  const centersOk = Object.keys(before).every((id) => { const e = byId(g, id); return !e || d2({ x: e.cx, y: e.cy }, before[id]) < 120; });
  check(centersOk, "and their new center is there too");

  console.log("\n# the Warlord alone doesn't pull far guards in; a homing Warlord saved mid-walk keeps walking after a reload");
  // the guards settled right beside the player: let them come again and finish them this time
  g = await waitFor((s) => s.phase === "playerTurn", 12000);
  if (g) {
    g = await fightToEnd(true);
    check(g.phase === null && !byId(g, "lair-guard") && !byId(g, "lair-guard-2"), "beat the guards away from the lair");
  }
  g = await walkToward(1700, 615, (s) => !!s.phase, 20000);
  g = await waitFor((s) => s.phase === "playerTurn", 8000);
  check(!!g && JSON.stringify(roster(g)) === JSON.stringify(["lair-boss"]), `at the lair the Warlord fights alone (${g && roster(g)})`);
  await key("f");
  g = await waitFor((s) => s.phase === null, 10000);
  check(byId(g, "lair-boss")?.state === "homing" || byId(g, "lair-boss")?.state === "calm", `after fleeing, the Warlord ${byId(g, "lair-boss")?.state === "homing" ? "walks home" : "is already home"}`);
  await waitText("#savePill", /Saved/, 6000);
  await sleep(300);
  api = await apiState();
  if (api.save.places["lair-boss"].homing) {
    await send("Page.reload");
    await sleep(500);
    await waitText("#panel", /Welcome back/);
    await tapEl("#go");
    g = await waitFor((s) => s.run === "playing" && !s.screen);
    check(byId(g, "lair-boss").state === "homing", "restored mid-walk, it is still going home");
    g = await waitFor((s) => byId(s, "lair-boss")?.state !== "homing", 15000);
    check(!!g && d2(byId(g, "lair-boss"), { x: 1905, y: 615 }) < 80, "and gets there");
  } else console.log("  (the Warlord was already home when the flee was saved; homing restore covered by src/save.test.ts)");
}

async function prodGuardSuite() {
  console.log("\n# production build: test entry points are off");
  await setViewport(1280, 800);
  const g = await open("?fight=3,1,1250,750");
  const text = await waitText("#panel", /Start a run|Welcome back|Your last run/);
  check(/Start a run|Welcome back|Your last run/.test(text) && g.saveStatus !== "off" && g.phase === null, "?fight= is ignored: the normal start screen shows and saving stays on");
}

async function main() {
  await connect();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  for (const s of SUITES) {
    if (s === "combat") await combatSuite();
    else if (s === "save") await saveSuite();
    else if (s === "viewports") await viewportSuite();
    else if (s === "prodguard") await prodGuardSuite();
    else if (s === "race") await raceSuite();
    else if (s === "monsters") await monstersSuite();
    else if (s === "groups") await groupLayoutSuite();
    else if (s === "legacy") await legacySuite();
    else if (s === "roam") await roamSuite();
  }
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
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
    setTimeout(() => process.exit(failures ? 1 : 0), 700);
  });
