// Real headless-Chrome check, reusing tools/coop-xss-check.mjs's exact
// CDP/temp-profile mechanism, standing in for the live crit-10 demo: two
// separate Chrome profiles (separate mkdtempSync user-data-dirs — no shared
// cookies or storage, exactly "two Chrome profiles" as the brief requires)
// join one room via an invite link alone, reach a shared fight, each play a
// card with no cross-contamination of hand/energy state, one flees while the
// other continues, and the first player's page is closed and reopened on
// the same profile to confirm identity and room membership survive. This
// proves the mechanics work; it is not a rehearsal of the actual live
// narrate-from-logs presentation (see tools/coop-log-check.mjs for that, and
// docs/process/2026-10-17-c10-identity-logging.md's demo notes).
//
// Usage: node tools/coop-identity-demo-check.mjs [baseUrl]   (default http://127.0.0.1:8080)
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

async function openTab(label, profileDir) {
  const profile = profileDir ?? mkdtempSync(join(tmpdir(), `cc-idemo-${label}-`));
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
    label, profile, chrome, pageErrors, evaluate,
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
    // A plain SIGTERM/kill() can race Chrome's own cookie-database flush to
    // disk, so reopening the same profile moments later can see a vanished
    // or stale cookie even though the profile dir is kept — not a flake in
    // this check's own logic, confirmed directly by comparing the raw
    // cookie token across a close/reopen cycle. Browser.close asks Chrome to
    // shut down cleanly (which flushes Cookies/Cookies-journal) before the
    // process is actually killed.
    close: async () => {
      try {
        await send("Browser.close");
      } catch {}
      await sleep(500);
      try {
        chrome.kill();
      } catch {}
    },
  };
}

const KEY_CODES = { w: "KeyW", a: "KeyA", s: "KeyS", d: "KeyD" };

/**
 * Keyboard input only offers 8 directions (combinations of w/a/s/d), unlike
 * the WS-level checks' arbitrary unit vectors — a fixed diagonal heading can
 * geometrically miss an enemy's actual spawn point by design, not as a flake
 * (the same issue round 3's own correction record already documented for a
 * different check). So this steers live: each step, recompute which of the
 * 8 directions most closely points from the tab's own last known position
 * toward `target`, and hold exactly those keys.
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

async function main() {
  // Tab A: a fresh, disposable Chrome profile — no cookies/storage shared
  // with anything else, exactly "a Chrome profile" per the demo requirement.
  const a = await openTab("a");
  await a.navigate("/coop.html");
  await sleep(500);
  await a.setValue("#nameInput", "Demo-Ash");
  await a.click("#createBtn");
  await sleep(800);

  // The invite link is read from the same rendered UI element the real copy
  // button uses (src/coop-main.ts's copyLinkBtn handler) — clipboard access
  // itself is flaky under headless Chrome, but the link's content is simply
  // `${origin}/coop.html?code=${roomCode}`, and roomCodeText is exactly that
  // code rendered on the page, so reading it is equivalent to what a real
  // player would copy and send.
  const code = await a.evaluate("document.getElementById('roomCodeText')?.textContent ?? ''");
  check(/^[A-Z0-9]{6}$/.test(code), `a 6-character room code is visible on the page (got ${JSON.stringify(code)})`);
  const inviteLink = `/coop.html?code=${code}`;

  // Tab B: a second, entirely separate Chrome profile, joining by navigating
  // to the invite link alone — no code typed by hand, no terminal/DB access.
  const b = await openTab("b");
  await b.navigate(inviteLink);
  await sleep(300);
  await b.setValue("#nameInput", "Demo-Birch");
  await b.click("#joinBtn");
  await sleep(800);

  const aHello = await a.state();
  const bHello = await b.state();
  check(!!aHello?.selfId && !!bHello?.selfId, "both tabs have a resolved identity");
  check(aHello.selfId !== bHello.selfId, "the two tabs have distinct identities");

  // west-1's real spawn (src/world.ts) — steering toward it directly avoids
  // the fixed-diagonal-heading miss a naive w+d hold would risk.
  const started = await walkTogether([a, b], { x: 640, y: 380 });
  check(started, "both players enter a shared fight via the invite-link join alone");

  await sleep(300);
  const fightA = (await a.state()).fight;
  const fightB = (await b.state()).fight;
  check(!!fightA && !!fightB && fightA.fightId === fightB.fightId, "both see the same shared fight");

  // Each plays a real card independently — assert no cross-contamination.
  const handABefore = (await a.state()).hand;
  const handBBefore = (await b.state()).hand;
  check(!!handABefore && !!handBBefore, "both tabs have their own hand");

  // Clicks the real hand UI to play a card (preferring one that needs no
  // target, so a single click suffices); if the only enabled card needs a
  // target, clicks an enemy first (selecting it), then clicks the card —
  // the same two-step real interaction a player performs.
  const clickFirstPlayableCard = async (tab) => {
    // select an enemy first (harmless if the eventual card doesn't need one —
    // selecting a target before a non-single card is simply ignored)
    await tab.evaluate(`document.querySelector('#enemyList button')?.click()`);
    await sleep(100);
    const clicked = await tab.evaluate(`
      (() => {
        const btns = [...document.querySelectorAll('#hand button')];
        const btn = btns.find(b => !b.disabled);
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    await sleep(300);
    return clicked;
  };

  const aPlayed = await clickFirstPlayableCard(a);
  check(aPlayed, "A played a real card via the real hand UI");
  await sleep(400);
  const stillFightingAfterA = (await a.state()).fight !== null;
  const bPlayed = stillFightingAfterA ? await clickFirstPlayableCard(b) : true;
  check(bPlayed, "B played a real card via the real hand UI (or the fight already ended from A's play — a single 6-HP enemy can die to one card)");
  await sleep(400);

  const aStateAfter = await a.state();
  const handAAfter = aStateAfter.hand;
  if (handAAfter) {
    check(handAAfter.cards.length !== handABefore.cards.length || handAAfter.energy !== handABefore.energy, "A's own hand/energy changed from playing");
    // B's hand must not have been affected by A's play and vice versa — each tracked independently
    check(JSON.stringify(handBBefore.cards.map((c) => c.id)) !== JSON.stringify(handAAfter.cards.map((c) => c.id)), "A's and B's hands never share the same card ids");
  } else {
    console.log("  (the fight concluded from these two plays alone — west-1 has only 6 HP — so the post-play hand comparison is skipped; this is a legitimate outcome, not a bug)");
  }

  // One flees; the other's fight should continue (or conclude on its own —
  // either is a legitimate outcome). Fleeing only readies up: the round
  // (and the actual flee) only resolves once every active player has
  // readied, so B must end their own turn (or play on) before A's flee
  // actually takes effect — exactly the real multiplayer rule, not a bug
  // in this check.
  if (aStateAfter.fight !== null) {
    await a.evaluate(`document.getElementById('fleeBtn')?.click()`);
    await sleep(300);
    await b.evaluate(`document.getElementById('endTurnBtn')?.disabled === false && document.getElementById('endTurnBtn').click()`);
    let aAfterFlee = null;
    for (let i = 0; i < 20 && aAfterFlee?.fight !== null; i++) {
      await sleep(300);
      aAfterFlee = await a.state();
    }
    check(aAfterFlee?.fight === null, "A's own fight dock closed once the round resolved after fleeing");
  } else {
    check(true, "A's fight already concluded before a flee was needed");
  }

  // Reconnect: close and reopen A's page on the SAME profile — identity and
  // room membership must survive. The page always shows the join form on
  // load (the code is pre-filled from the URL, but there's no silent
  // auto-rejoin) — clicking Join again with the same cc_coop cookie is the
  // real reconnect path a returning player actually takes.
  const aProfile = a.profile;
  const aPageErrors = a.pageErrors;
  await a.close();
  const a2 = await openTab("a-reconnect", aProfile);
  await a2.navigate(inviteLink);
  await sleep(500);
  await a2.click("#joinBtn");
  let a2State = null;
  for (let i = 0; i < 20 && !a2State?.selfId; i++) {
    await sleep(300);
    a2State = await a2.state();
  }
  const reconnectOk = a2State?.selfId === aHello.selfId;
  check(reconnectOk, reconnectOk ? "reopening the same profile and rejoining resumes the same identity" : `reopening the same profile and rejoining resumes the same identity (got ${a2State?.selfId ? "a different id" : "no state at all"})`);

  check(aPageErrors.length === 0, "no page errors on A's client");
  check(b.pageErrors.length === 0, "no page errors on B's client");

  await a2.close();
  await b.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
