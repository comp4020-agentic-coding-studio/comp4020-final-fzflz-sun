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
    close: () => {
      try {
        chrome.kill();
      } catch {}
    },
  };
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

  // walk both toward the camp together, so the attacker's crafted name ends up as the
  // victim's attack-intent target string (the real sink this fix closes), not just the roster
  await Promise.all([attacker.keyDown("w", "KeyW"), attacker.keyDown("d", "KeyD"), victim.keyDown("w", "KeyW"), victim.keyDown("d", "KeyD")]);
  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    await sleep(250);
    const g = await victim.evaluate("JSON.stringify(window.__coop?.())").then((s) => (s ? JSON.parse(s) : null));
    if (g?.fight) started = true;
  }
  await Promise.all([attacker.keyUp("w", "KeyW"), attacker.keyUp("d", "KeyD"), victim.keyUp("w", "KeyW"), victim.keyUp("d", "KeyD")]);
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
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
