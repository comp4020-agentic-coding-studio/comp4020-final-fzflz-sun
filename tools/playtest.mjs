// Browser-driven playtest: opens a real (windowed) Chrome over the DevTools
// protocol, plays through actual key / mouse / touch input, and checks the
// state the page exposes on window.__game.
//
//   node tools/playtest.mjs [baseUrl] [--suite=combat,save,viewports]
//
// combat    rules, layout and camera in dev-only ?fight= encounters (dev server only)
// save      stranger -> start -> real fight -> saved -> reload -> restored; two visitors isolated
// viewports the save-loop core actions at 1920x1080 and on a 390x844 touch phone, plus a resize mid-fight
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const BASE = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:8080/").replace(/\/?$/, "/");
const SUITES = (args.find((a) => a.startsWith("--suite="))?.slice(8) ?? "combat,save,viewports").split(",");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const OUT = process.env.SHOTS ?? "/tmp/shots";
const TRASH_BOX = { left: -36, right: 36, top: -70, bottom: 18 };
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
  "--window-size=1100,800",
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
    const b = e.boss ? BOSS_BOX : TRASH_BOX;
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

/** Starts a real fight with the West camp by tapping toward it (tap-to-move), following the camp pointer when it's off screen. */
async function walkIntoFight() {
  for (let i = 0; i < 80; i++) {
    const g = await game();
    if (g.phase) return g;
    const west = g.enemies.filter((e) => e.spawnId?.startsWith("west"));
    const t = west[0] ?? g.enemies[0];
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
  let g = await open("?fight=3,1,1100,650");
  if (!check(g && g.saveStatus === "off", "test fights switch saving off")) return;
  g = await waitFor((s) => s.phase === "playerTurn");
  check(!!g && fighters(g).length === 4, "stacked boss + 3 all joined; first turn started after formation");
  check(fighters(g).every((e) => e.intent), "every participant shows an intent");
  await sleep(900);
  g = await game();
  layoutChecks(g, "boss+3");
  await shot("c01_boss3");

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
  for (const [name, q] of [["topLeft_boss7", "7,1,16,16"], ["bottomRight_boss7", "7,1,2184,1284"], ["topRight_4", "4,0,2184,16"], ["centre_7", "7,0,1100,650"]]) {
    await open(`?fight=${q}`);
    g = await waitFor((s) => s.phase === "playerTurn");
    await sleep(900);
    g = await game();
    layoutChecks(g, name);
    check(fighters(g).length === Number(q.split(",")[0]) + Number(q.split(",")[1]), `${name}: every chaser joined`);
    await shot(`c10_${name}`);
  }
  await open("?fight=30,1,1100,650");
  g = await waitFor((s) => s.phase === "playerTurn");
  await sleep(900);
  g = await game();
  const listed = fighters(g).filter((e) => e.overflow);
  check(fighters(g).length === 31 && listed.length > 0, `31 joined; ${listed.length} that don't fit go to the side list`);
  layoutChecks(g, "overflow stage");
  await tapEl("#overflowList button:first-child");
  g = await game();
  check(g.target === listed[0].id, "tapping the first list entry targets that enemy");
  await shot("c20_overflow");

  await open("?fight=0,1,1100,650");
  g = await waitFor((s) => s.phase === "playerTurn");
  for (let t = 0; t < 2; t++) {
    await key(" ");
    g = await waitFor((s) => s.phase === "playerTurn" && s.turn === t + 2, 8000);
  }
  check(fighters(g).find((e) => e.boss)?.intent === "CHARGE\nnext: ATK 12", "turn 3: the boss's charge names the coming 12-damage hit");

  console.log("\n# death stops the resolve");
  await open("?fight=7,1,1100,650");
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

async function main() {
  await connect();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  for (const s of SUITES) {
    if (s === "combat") await combatSuite();
    else if (s === "save") await saveSuite();
    else if (s === "viewports") await viewportSuite();
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
