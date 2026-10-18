// Real headless-Chrome check that a room member's display name (which the
// server only trims/truncates — see server/coop/ws.ts's cleanName — never
// strips HTML) can never execute as markup when shown back to another
// player, including inside the fight dock's innerHTML-built "→ <name>"
// attack-intent line (src/coop-main.ts's renderFight()). Real-browser-level:
// a WebSocket-only check (like tools/coop-live-check.mjs) could confirm the
// server sends the raw name unescaped, but only an actual DOM proves nothing
// executes and no injected element is created from it.
//
// All identities/rooms here are created locally for this run only and
// discarded; the payload is harmless (it only flips a page-local flag,
// never makes an external call) and nothing is sent to any shared/online
// room.
//
// Usage: node tools/coop-xss-check.mjs [baseUrl]   (default http://127.0.0.1:8080)
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

async function openTab(label) {
  const profile = mkdtempSync(join(tmpdir(), `cc-xss-${label}-`));
  const chrome = spawn(
    CHROME,
    ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=900,700", "--no-sandbox", "--headless", "about:blank"],
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
  /** set by the injected payload if it ever actually executes — the one thing that must never become true */
  let xssFired = false;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails?.exception?.description ?? "page error");
    if (m.method === "Runtime.consoleAPICalled" && m.params.args?.[0]?.value === "__XSS_FIRED__") xssFired = true;
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
    get xssFired() {
      return xssFired;
    },
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

/**
 * Keyboard input only offers 8 directions, unlike a WS-level check's
 * arbitrary unit vectors — a fixed diagonal heading can geometrically miss
 * an enemy's actual spawn point by design, not as a flake (the same issue
 * round 3's own correction record documented for coop-formation-2p-check.mjs,
 * and which tools/coop-identity-demo-check.mjs's steerToward() already fixed
 * for this file's own earlier, since-removed fixed w+d heading). So this
 * steers live: each step, recompute which of the 8 directions most closely
 * points from the tab's own last known position toward `target`.
 */
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

async function walkTogether(tabs, target, maxIters = 60) {
  const heldSets = tabs.map(() => new Set());
  const results = await Promise.all(tabs.map((t, i) => steerToward(t, target, heldSets[i], maxIters)));
  await Promise.all(tabs.map((t, i) => releaseAll(t, heldSets[i])));
  return results.some(Boolean);
}

// A payload that, if ever actually parsed as an element and executed, logs a
// page-console marker this script watches for — harmless (no external call,
// never leaves the page), but unambiguous proof of real execution.
const XSS_NAME = `<img src=x onerror="console.log('__XSS_FIRED__')">`;

async function main() {
  const attacker = await openTab("attacker");
  await attacker.navigate("/coop.html");
  await sleep(500);
  await attacker.setValue("#nameInput", XSS_NAME);
  await attacker.click("#createBtn");
  await sleep(800);
  const hostState = JSON.parse(await attacker.evaluate("JSON.stringify(window.__coop?.())"));
  const code = hostState.status.replace("room ", "");

  const victim = await openTab("victim");
  await victim.navigate(`/coop.html?code=${code}`);
  await sleep(300);
  await victim.setValue("#nameInput", "Victim");
  await victim.click("#joinBtn");
  await sleep(800);

  // walk both toward west-1's real spawn (src/world.ts) together, so the attacker's crafted
  // name ends up as the victim's attack-intent target string (the real sink this fix closes),
  // not just the roster. Live-steered rather than a fixed diagonal, which can geometrically
  // miss this spawn and walk toward a farther camp instead (see tools/coop-identity-demo-check.mjs's
  // steerToward(), the same fix applied here).
  const started = await walkTogether([attacker, victim], { x: 640, y: 380 });
  check(started, "both players enter a shared fight");

  await sleep(500);
  // wait up to a few rounds for the enemy's shown intent to actually target the attacker
  // (the account whose crafted name is the real test subject), triggering a client render
  // of "→ <name>" with that name — the real sink.
  let intentTargetsAttacker = false;
  for (let i = 0; i < 6 && !intentTargetsAttacker; i++) {
    const g = JSON.parse(await victim.evaluate("JSON.stringify(window.__coop?.())"));
    const fight = g.fight;
    const attackerId = fight?.players.find((p) => p.id !== g.selfId)?.id;
    const intent = fight?.enemies.find((e) => e.intent?.kind === "attack" && e.intent.targetId === attackerId);
    if (intent) {
      intentTargetsAttacker = true;
      break;
    }
    // end the victim's own turn to advance the round and get a fresh intent next cycle
    const endBtn = await victim.evaluate("document.getElementById('endTurnBtn')?.disabled");
    if (endBtn === false) await victim.click("#endTurnBtn");
    await sleep(600);
  }
  if (!intentTargetsAttacker) {
    console.log("  (the enemy's intent never happened to target the attacker within the round budget — re-run to retry; the escaping fix itself doesn't depend on this, but this specific scenario does)");
  }

  await sleep(300);
  const enemyButtonHtml = await victim.evaluate("document.querySelector('#enemyList button')?.innerHTML ?? ''");
  check(!enemyButtonHtml.includes("<img"), "the crafted name's <img> tag is NOT present as real markup in the enemy button's innerHTML");
  check(enemyButtonHtml.includes("&lt;img") || !enemyButtonHtml.toLowerCase().includes("img"), "if the name text appears at all, it's as escaped text (&lt;img), not a live tag");
  check(!victim.xssFired, "the crafted name's onerror handler never actually executed");
  check(!attacker.xssFired, "the crafted name's onerror handler never executed on the attacker's own client either");

  // a normal Chinese/space/punctuation name must still display exactly as typed
  const normalName = "小明 2号";
  const observer = await openTab("observer");
  await observer.navigate("/coop.html");
  await sleep(500);
  await observer.setValue("#nameInput", normalName);
  await observer.click("#createBtn");
  await sleep(800);
  const rosterText = await observer.evaluate("document.getElementById('roster')?.textContent ?? ''");
  check(rosterText.includes(normalName), `a normal name with spaces/Chinese characters still displays exactly as typed (got roster text: ${JSON.stringify(rosterText)})`);

  check(attacker.pageErrors.length === 0, `no page errors on the attacker's client (${attacker.pageErrors.slice(0, 2).join(" | ")})`);
  check(victim.pageErrors.length === 0, `no page errors on the victim's client (${victim.pageErrors.slice(0, 2).join(" | ")})`);

  attacker.close();
  victim.close();
  observer.close();

  // Bracketed/backslash names: Kaplay's own text() treats unescaped [ ] as
  // style-tag syntax and a trailing unescaped \ as an escape error — a name
  // like "[Sun]" reaching src/coop-main.ts's makeLabel()/applyState()
  // unescaped throws "Styled text error: unclosed tags ...", confirmed in a
  // real two-profile reproduction. escapeHtml (proven above) does nothing
  // for this different sink; this exercises src/coop-protocol.ts's
  // escapeKaplayText() through the real create/join flow, in two
  // independent local profiles, joining by invite link.
  for (const bracketName of ["[Sun]", "]", "[", "mismatched]tag[", "a\\", "反\\斜[杠]"]) {
    const a = await openTab("bracket-a");
    await a.navigate("/coop.html");
    await sleep(500);
    await a.setValue("#nameInput", bracketName);
    await a.click("#createBtn");
    await sleep(800);
    const aState = await a.state();
    check(!!aState?.selfId, `[${bracketName}] the room creator gets a resolved identity (no canvas-text crash)`);
    check(!!aState?.selfPos, `[${bracketName}] the room creator's own position is not null after applyState`);
    const codeMatch = /^room ([A-Z0-9]{6})/.exec(aState?.status ?? "");
    const code = codeMatch?.[1];

    const b = await openTab("bracket-b");
    if (code) {
      await b.navigate(`/coop.html?code=${code}`);
      await sleep(300);
      await b.setValue("#nameInput", "Observer");
      await b.click("#joinBtn");
      await sleep(800);
    }
    const bState = await b.state();
    check(!!bState?.selfId, `[${bracketName}] a second profile joining via invite link also gets a resolved identity`);
    check((bState?.players?.length ?? 0) >= 2, `[${bracketName}] the joiner's own player list is populated, not empty from an aborted state-apply`);

    const aRoster = await a.evaluate("document.getElementById('roster')?.textContent ?? ''");
    check(aRoster.includes(bracketName), `[${bracketName}] the name displays in the DOM roster exactly as typed (got ${JSON.stringify(aRoster)})`);
    check(a.pageErrors.length === 0, `[${bracketName}] no page errors on the name-owner's client (${a.pageErrors.slice(0, 2).join(" | ")})`);
    check(b.pageErrors.length === 0, `[${bracketName}] no page errors on the joining client (${b.pageErrors.slice(0, 2).join(" | ")})`);

    a.close();
    b.close();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
