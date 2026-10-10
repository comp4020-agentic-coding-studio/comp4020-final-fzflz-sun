// Real-browser performance measurement for co-op: two independent Chrome
// tabs, two independent identities, one room. Measures what actually matters
// for the user's "feels like very low framerate" report:
//   - real rAF frame deltas (is the browser actually dropping frames), via an
//     independent rAF loop injected before any page script runs;
//   - how often the locally-rendered player position actually changes value
//     (distinguishes "steppy position updates" from "low render rate" —
//     see docs/adr/0006-coop-perf-and-reliability.md);
//   - the arrival interval of the server's `state` broadcast, via a
//     WebSocket wrapper injected the same way.
// Not part of `pnpm check`: this is a manual before/after measurement tool,
// run against a real `pnpm dev` (optionally with COOP_PERF_LOG=1 so the
// server also prints its own tick/persist/loop-lag summary to compare).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:8080";
const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
].find(existsSync);
if (!CHROME) throw new Error("Chrome not found");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Installed via Page.addScriptToEvaluateOnNewDocument, so it runs before any
// module script on the page — it does not depend on, or modify, coop-main.ts.
const PERF_INIT = `(function () {
  const perf = { frames: [], posSamples: [], stateTimes: [] };
  window.__perf = perf;
  let last = performance.now();
  function loop(t) {
    perf.frames.push(t - last);
    last = t;
    if (perf.frames.length > 20000) perf.frames.shift();
    try {
      const d = window.__coop && window.__coop();
      if (d && d.selfPos) {
        perf.posSamples.push({ t, x: d.selfPos.x, y: d.selfPos.y });
        if (perf.posSamples.length > 20000) perf.posSamples.shift();
      }
    } catch {}
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  const OrigWS = window.WebSocket;
  function WrappedWS(...args) {
    const ws = new OrigWS(...args);
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "state") {
          perf.stateTimes.push(performance.now());
          if (perf.stateTimes.length > 20000) perf.stateTimes.shift();
        }
      } catch {}
    });
    return ws;
  }
  WrappedWS.prototype = OrigWS.prototype;
  WrappedWS.OPEN = OrigWS.OPEN;
  WrappedWS.CONNECTING = OrigWS.CONNECTING;
  WrappedWS.CLOSING = OrigWS.CLOSING;
  WrappedWS.CLOSED = OrigWS.CLOSED;
  window.WebSocket = WrappedWS;
})();`;

async function openTab(label) {
  const profile = mkdtempSync(join(tmpdir(), `cc-coop-perf-${label}-`));
  const chrome = spawn(
    CHROME,
    [
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--window-size=1280,800", "--no-sandbox", "--headless", "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let errOut = "";
  chrome.stderr.on("data", (d) => (errOut += d.toString()));
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
  if (!ws) throw new Error(`[${label}] could not connect to chrome: ${errOut.slice(-500)}`);
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
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PERF_INIT });
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
    click: async (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`),
    clickFirst: async (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`),
    setValue: async (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; })()`),
    keyDown: async (code, key) => send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) }),
    keyUp: async (code, key) => send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) }),
    holdKey: async (code, key, ms) => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
      await sleep(ms);
      await send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
    },
    close: () => {
      try {
        chrome.kill();
      } catch {}
    },
  };
}

function stats(arr) {
  if (!arr.length) return { n: 0, avg: 0, p95: 0, max: 0, over50: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    n: sorted.length,
    avg: +avg.toFixed(2),
    p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
    over50: sorted.filter((v) => v > 50).length,
  };
}

function intervalStats(times) {
  const deltas = [];
  for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
  return stats(deltas);
}

/** How many rAF ticks pass, on average, between two *different* position values — the direct "is motion steppy" signal. */
function stepSizeStats(samples) {
  const steps = [];
  let lastChangeIdx = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].x !== samples[i - 1].x || samples[i].y !== samples[i - 1].y) {
      steps.push(i - lastChangeIdx);
      lastChangeIdx = i;
    }
  }
  return stats(steps);
}

async function collect(tab, label) {
  const raw = await tab.evaluate("JSON.stringify(window.__perf)");
  const p = JSON.parse(raw);
  return {
    label,
    frameDeltaMs: stats(p.frames),
    stateIntervalMs: intervalStats(p.stateTimes),
    rafTicksBetweenPosChanges: stepSizeStats(p.posSamples),
    posSampleCount: p.posSamples.length,
  };
}

function resetPerf(tab) {
  return tab.evaluate("window.__perf.frames = []; window.__perf.posSamples = []; window.__perf.stateTimes = []; true");
}

async function main() {
  const label = process.argv[2] ?? "run";
  console.log(`=== coop perf check: ${label} ===`);

  const host = await openTab("host");
  await host.navigate("/coop.html");
  await sleep(500);
  await host.setValue("#nameInput", "Ash");
  await host.click("#createBtn");
  await sleep(1200);
  const hostState = JSON.parse(await host.evaluate("JSON.stringify(window.__coop?.())"));
  const code = hostState.status.replace("room ", "");

  const guest = await openTab("guest");
  await guest.navigate(`/coop.html?code=${code}`);
  await sleep(300);
  await guest.setValue("#nameInput", "Birch");
  await guest.click("#joinBtn");
  await sleep(1000);

  const results = {};

  // --- scenario 1: both idle ---
  await resetPerf(host);
  await resetPerf(guest);
  await sleep(3000);
  results.idle = { host: await collect(host, "idle"), guest: await collect(guest, "idle") };

  // --- scenario 2: both moving continuously ---
  await resetPerf(host);
  await resetPerf(guest);
  const movePromise = Promise.all([host.holdKey("KeyD", "d", 3500), guest.holdKey("KeyD", "d", 3500)]);
  await sleep(3500);
  await movePromise;
  await sleep(200);
  results.moving = { host: await collect(host, "moving"), guest: await collect(guest, "moving") };

  // --- scenario 3: pull both into a shared fight (hold W+D: up-right, same
  // idea as .local/coop-reconnect-check.mjs's {dx:1,dy:-0.65} heading) ---
  await resetPerf(host);
  await resetPerf(guest);
  await Promise.all([host.keyDown("KeyW", "w"), host.keyDown("KeyD", "d"), guest.keyDown("KeyW", "w"), guest.keyDown("KeyD", "d")]);
  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    await sleep(250);
    const f = JSON.parse(await host.evaluate("JSON.stringify(window.__coop?.().fight ?? null)"));
    if (f) started = true;
  }
  await Promise.all([host.keyUp("KeyW", "w"), host.keyUp("KeyD", "d"), guest.keyUp("KeyW", "w"), guest.keyUp("KeyD", "d")]);
  await sleep(200);
  results.enterFight = { host: await collect(host, "enterFight"), guest: await collect(guest, "enterFight"), started };

  // --- scenario 4: a burst of card plays / end turns while in a fight ---
  await resetPerf(host);
  await resetPerf(guest);
  for (let i = 0; i < 6; i++) {
    await host.click("#hand button:not(:disabled)");
    await sleep(120);
    await guest.click("#hand button:not(:disabled)");
    await sleep(120);
  }
  await host.click("#endTurnBtn");
  await guest.click("#endTurnBtn");
  await sleep(1500);
  results.combatBurst = { host: await collect(host, "combatBurst"), guest: await collect(guest, "combatBurst") };

  console.log(JSON.stringify(results, null, 2));
  console.log("page errors (host):", host.pageErrors.slice(0, 5));
  console.log("page errors (guest):", guest.pageErrors.slice(0, 5));

  mkdirSync(".local/checks", { recursive: true });
  const outPath = `.local/checks/coop-perf-${label}.json`;
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${outPath}`);

  host.close();
  guest.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
