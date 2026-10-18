// Real headless-Chrome check that a co-op party wipe leaves a clear,
// persistent "expedition ended" state with a working way to start a new
// one — not just a transient status-line message that a 0-HP player could
// otherwise mistake for still being able to explore or fight. Reuses
// tools/coop-xss-check.mjs's exact CDP/temp-profile mechanism.
//
// A solo player (no teammate to Guard/revive them) walks into west-1's
// 6-HP brute (src/world.ts), which deterministically attacks for exactly 3
// unblocked damage per round (no RNG in attack value — see
// src/combat.ts's planEnemyTurn) against the player's 24 max HP — a lethal
// Strike would end the fight too fast to observe the wipe path, so this
// repeatedly ends turn WITHOUT playing Guard, taking the full 3 damage each
// round until hp reaches 0 (8 rounds), then asserts the panel and its
// button, at both a desktop and a phone viewport.
//
// All identities/rooms here are created locally for this run only; nothing
// touches any shared/online room.
//
// Usage: node tools/coop-wipe-check.mjs [baseUrl]   (default http://127.0.0.1:8080)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:8080";
const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
].find(existsSync);
if (!CHROME) throw new Error("Chrome not found");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
}

async function openTab(label, viewport) {
  const profile = mkdtempSync(join(tmpdir(), `cc-wipe-${label}-`));
  const [w, h] = viewport ?? [900, 700];
  const chrome = spawn(
    CHROME,
    ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--window-size=${w},${h}`, "--no-sandbox", "--headless", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const deadline = Date.now() + 15000;
  let ws;
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener("open", res, { once: true });
          ws.addEventListener("error", rej, { once: true });
        });
        break;
      }
    } catch {}
    await sleep(150);
  }
  if (!ws) throw new Error(`[${label}] could not connect to chrome`);
  let msgId = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails?.exception?.description ?? "page error");
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  return {
    label, chrome, pageErrors, evaluate,
    navigate: async (path) => {
      await send("Page.navigate", { url: BASE + path });
      await sleep(500);
    },
    setValue: async (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; })()`),
    click: async (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`),
    keyDown: async (key, code) => send("Input.dispatchKeyEvent", { type: "keyDown", key, code }),
    keyUp: async (key, code) => send("Input.dispatchKeyEvent", { type: "keyUp", key, code }),
    state: async () => {
      const s = await evaluate("JSON.stringify(window.__coop?.())");
      return s ? JSON.parse(s) : null;
    },
    close: () => {
      try {
        chrome.kill();
      } catch {}
    },
  };
}

const KEY_CODES = { w: "KeyW", a: "KeyA", s: "KeyS", d: "KeyD" };

/** Same live-steering approach as tools/coop-xss-check.mjs and tools/coop-identity-demo-check.mjs: recompute heading toward `target` each step from the tab's own reported position, rather than a fixed diagonal that can geometrically miss the spawn. */
async function steerToward(tab, target, heldKeys, maxIters = 60) {
  for (let i = 0; i < maxIters; i++) {
    const g = await tab.state();
    if (g?.fight) return true;
    const pos = g?.selfPos;
    if (pos) {
      const dx = target.x - pos.x;
      const dy = target.y - pos.y;
      const want = new Set();
      if (Math.abs(dx) > 10) want.add(dx > 0 ? "d" : "a");
      if (Math.abs(dy) > 10) want.add(dy > 0 ? "s" : "w");
      for (const k of Object.keys(KEY_CODES)) {
        const should = want.has(k);
        const is = heldKeys.has(k);
        if (should && !is) {
          await tab.keyDown(k, KEY_CODES[k]);
          heldKeys.add(k);
        } else if (!should && is) {
          await tab.keyUp(k, KEY_CODES[k]);
          heldKeys.delete(k);
        }
      }
    }
    await sleep(200);
  }
  return false;
}

async function releaseAll(tab, heldKeys) {
  for (const k of [...heldKeys]) {
    await tab.keyUp(k, KEY_CODES[k]);
    heldKeys.delete(k);
  }
}

async function runWipeScenario(viewport, label) {
  const tab = await openTab(label, viewport);
  await tab.navigate("/coop.html");
  await sleep(500);
  await tab.setValue("#nameInput", `Wipe-${label}`);
  await tab.click("#createBtn");
  await sleep(800);

  const held = new Set();
  const started = await steerToward(tab, { x: 640, y: 380 }, held, 60); // west-1's real spawn, src/world.ts
  await releaseAll(tab, held);
  check(started, `[${label}] enters a solo fight with west-1`);
  if (!started) {
    tab.close();
    return;
  }

  // Repeatedly end turn WITHOUT playing Guard: west-1 deals exactly 3
  // unblocked damage per round against 24 max HP, so this is a deterministic
  // 8-round wipe, not a race against a random hand.
  let wiped = false;
  for (let round = 0; round < 12 && !wiped; round++) {
    const endBtn = await tab.evaluate("document.getElementById('endTurnBtn')?.disabled");
    if (endBtn === false) await tab.click("#endTurnBtn");
    await sleep(500);
    const panelVisible = await tab.evaluate("document.getElementById('screen')?.hidden === false");
    if (panelVisible) wiped = true;
  }
  check(wiped, `[${label}] the expedition-ended panel appears after the party is wiped`);

  const panelHtml = await tab.evaluate("document.getElementById('panel')?.innerHTML ?? ''");
  check(panelHtml.includes("expedition has ended") || panelHtml.toLowerCase().includes("wiped"), `[${label}] the panel's own text says the expedition is over (got ${JSON.stringify(panelHtml.slice(0, 120))})`);
  const hasButton = await tab.evaluate("!!document.getElementById('newExpeditionBtn')");
  check(hasButton, `[${label}] a working "start a new expedition" button is present`);

  // The button must actually navigate away from this ended session (to a
  // fresh /coop.html, the existing create-room entry point) — not just be
  // present and inert.
  await tab.click("#newExpeditionBtn");
  await sleep(1000);
  const urlAfter = await tab.evaluate("location.pathname + location.search");
  check(urlAfter === "/coop.html", `[${label}] clicking the button navigates to a fresh /coop.html (got ${JSON.stringify(urlAfter)})`);

  check(tab.pageErrors.length === 0, `[${label}] no page errors (${tab.pageErrors.slice(0, 2).join(" | ")})`);
  tab.close();
}

async function main() {
  await runWipeScenario([1280, 800], "desktop");
  await runWipeScenario([390, 844], "phone");
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
