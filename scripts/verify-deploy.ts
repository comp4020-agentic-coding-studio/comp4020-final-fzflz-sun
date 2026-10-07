#!/usr/bin/env node
// HTTP release smoke: checks the shipped files and one disposable visitor's
// save round trip. This does not play the game or prove a Fly restart survived.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { Marked } from "marked";
import { validateSave, type SaveData } from "../src/save.ts";

export interface VerifyDeployOptions {
  /** Tests may provide a small README; the CLI always uses this repo's README.md. */
  readmeMarkdown?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}

export interface DeployVerification {
  ok: true;
  checkedAtUtc: string;
  assetPaths: string[];
  readmeImagePaths: string[];
  readmeSha256: string;
  saveRoundTrip: true;
  visitorIsolation: true;
  testVisitorsErased: true;
}

type JsonRecord = Record<string, unknown>;
type ApiReply = { status: number; data: unknown };
const marked = new Marked({ gfm: true });
const defaultReadme = resolve(import.meta.dirname, "../README.md");

const record = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(message); };
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const bodyText = (html: string) => new JSDOM(html).window.document.body.textContent ?? "";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function baseUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return fail("Pass an absolute HTTP(S) app URL (or set APP_URL)."); }
  requireThat(
    ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash,
    "App URL must be an HTTP(S) origin with no credentials, path, query or fragment.",
  );
  return new URL("/", url);
}

async function request(url: URL, label: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Never copy response headers, bodies, cookies or arbitrary URLs into logs.
    return fail(`${label} did not respond within ${timeoutMs} ms.`);
  }
}

async function json(response: Response, label: string): Promise<unknown> {
  try { return await response.json(); } catch { return fail(`${label} did not return JSON.`); }
}

async function waitForHome(root: URL, timeoutMs: number, startupMs: number): Promise<string> {
  const deadline = Date.now() + startupMs;
  let last = "unavailable";
  do {
    try {
      const res = await request(root, "/", timeoutMs);
      if (res.status === 200) {
        requireThat(/^text\/html(?:;|$)/i.test(res.headers.get("content-type") ?? ""), "/ has the wrong MIME type.");
        return await res.text();
      }
      last = `HTTP ${res.status}`;
    } catch {
      last = "unavailable";
    }
    if (Date.now() < deadline) await new Promise((done) => setTimeout(done, Math.min(1000, deadline - Date.now())));
  } while (Date.now() < deadline);
  return fail(`/ did not become ready (${last}).`);
}

type Asset = { url: URL; kind: "js" | "css" };
function htmlAssets(html: string, root: URL): Asset[] {
  const dom = new JSDOM(html, { url: root.href });
  const doc = dom.window.document;
  const assets = new Map<string, Asset>();
  const add = (reference: string, kind: Asset["kind"]) => {
    let url: URL;
    try { url = new URL(reference, doc.baseURI); } catch { return fail(`Invalid ${kind.toUpperCase()} asset reference.`); }
    if (url.origin === root.origin) assets.set(`${kind}:${url.href}`, { url, kind });
  };
  for (const script of doc.querySelectorAll<HTMLScriptElement>("script[src]")) add(script.src, "js");
  for (const link of doc.querySelectorAll<HTMLLinkElement>("link[href][rel]")) {
    const rel = link.rel.toLowerCase().split(/\s+/);
    if (rel.includes("stylesheet") || (rel.includes("preload") && link.as === "style")) add(link.href, "css");
    if (rel.includes("modulepreload") || (rel.includes("preload") && link.as === "script")) add(link.href, "js");
  }
  requireThat([...assets.values()].some((asset) => asset.kind === "js"), "/ does not reference a local JavaScript bundle.");
  return [...assets.values()];
}

async function verifyAssets(assets: Asset[], timeoutMs: number): Promise<string[]> {
  for (const asset of assets) {
    const path = asset.url.pathname;
    const res = await request(asset.url, path, timeoutMs);
    requireThat(res.status === 200, `${path} returned HTTP ${res.status}.`);
    const mime = res.headers.get("content-type") ?? "";
    const correct = asset.kind === "js" ? /(?:java|ecma)script/i.test(mime) : /^text\/css(?:;|$)/i.test(mime);
    requireThat(correct, `${path} returned the wrong ${asset.kind.toUpperCase()} MIME type (possibly an HTML fallback).`);
    await res.arrayBuffer(); // also require the entire asset to finish within the request timeout
  }
  return [...new Set(assets.map((asset) => asset.url.pathname))].sort();
}

async function verifyReadme(root: URL, markdown: string, timeoutMs: number): Promise<{ paths: string[]; hash: string }> {
  const readmeUrl = new URL("/readme/", root);
  const expectedHtml = marked.parse(markdown, { async: false });
  const expected = squash(bodyText(expectedHtml));
  requireThat(expected.length > 200, "Local README text is too short to verify a deployment.");
  const res = await request(readmeUrl, "/readme/", timeoutMs);
  requireThat(res.status === 200, `/readme/ returned HTTP ${res.status}.`);
  requireThat(/^text\/html(?:;|$)/i.test(res.headers.get("content-type") ?? ""), "/readme/ has the wrong MIME type.");
  const served = squash(bodyText(await res.text()));
  requireThat(served.includes(expected), "/readme/ does not contain the complete local README text.");

  const doc = new JSDOM(expectedHtml, { url: readmeUrl.href }).window.document;
  const images = new Map<string, URL>();
  for (const image of doc.querySelectorAll<HTMLImageElement>("img[src]")) {
    const url = new URL(image.getAttribute("src")!, readmeUrl);
    if (url.origin === root.origin) images.set(url.href, url);
  }
  for (const url of images.values()) {
    const res = await request(url, url.pathname, timeoutMs);
    requireThat(res.status === 200, `${url.pathname} returned HTTP ${res.status}.`);
    requireThat(/^image\//i.test(res.headers.get("content-type") ?? ""), `${url.pathname} has the wrong image MIME type.`);
    await res.arrayBuffer();
  }
  return { paths: [...new Set([...images.values()].map((url) => url.pathname))].sort(), hash: sha256(expected) };
}

class TestVisitor {
  private cookie: string | null = null;
  private mayErase = false;
  private root: URL;
  private timeoutMs: number;
  constructor(root: URL, timeoutMs: number) {
    this.root = root;
    this.timeoutMs = timeoutMs;
  }

  get identity(): string | null { return this.cookie; }

  async call(method: "GET" | "POST" | "PUT", path: "/api/save" | "/api/runs" | "/api/erase", body?: unknown): Promise<ApiReply & { response: Response }> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await request(new URL(path, this.root), path, this.timeoutMs, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await json(response, path), response };
  }

  async firstSave(): Promise<void> {
    const reply = await this.call("GET", "/api/save");
    requireThat(reply.status === 200, `/api/save returned HTTP ${reply.status} for a new visitor.`);
    const setCookie = reply.response.headers.get("set-cookie") ?? "";
    requireThat(/(?:^|;)\s*HttpOnly(?:;|$)/i.test(setCookie) && /(?:^|;)\s*SameSite=Lax(?:;|$)/i.test(setCookie),
      "A new visitor cookie is missing HttpOnly or SameSite=Lax.");
    const pair = setCookie.split(";", 1)[0].trim();
    requireThat(/^cc_visitor=[A-Za-z0-9_-]{43}$/.test(pair), "The new visitor cookie has an unexpected shape.");
    this.cookie = pair;
    const data = reply.data;
    requireThat(record(data) && data.save === null && data.revision === 0 && Array.isArray(data.runs) && data.runs.length === 0,
      "A new visitor unexpectedly has a save or history; refusing to modify or erase it.");
    this.mayErase = true;
  }

  async eraseOwnData(): Promise<void> {
    if (!this.mayErase || !this.cookie) return;
    const erased = await this.call("POST", "/api/erase", { confirm: "erase" });
    requireThat(erased.status === 200, `/api/erase returned HTTP ${erased.status} for a disposable visitor.`);
    requireThat(record(erased.data) && erased.data.save === null && Array.isArray(erased.data.runs) && erased.data.runs.length === 0,
      "Disposable visitor data was not cleared.");
    const back = await this.call("GET", "/api/save");
    requireThat(back.status === 200 && record(back.data) && back.data.save === null && Array.isArray(back.data.runs) && back.data.runs.length === 0,
      "Disposable visitor data reappeared after erase.");
    this.mayErase = false;
  }
}

async function verifySaveRoundTrip(root: URL, timeoutMs: number): Promise<void> {
  const a = new TestVisitor(root, timeoutMs);
  const b = new TestVisitor(root, timeoutMs);
  let failure: unknown;
  try {
    await a.firstSave();
    await b.firstSave();
    requireThat(a.identity !== b.identity, "The server gave two new visitors the same identity.");

    const started = await a.call("POST", "/api/runs", { baseRevision: 0 });
    requireThat(started.status === 200 && record(started.data) && started.data.revision === 1,
      "A disposable visitor could not start a run.");
    const initial = started.data.save;
    const valid = validateSave(initial);
    requireThat(valid.ok && valid.save.outcome === "playing" && valid.save.player.hp > 0,
      "The server did not return a valid new run.");
    const save: SaveData = {
      ...valid.save,
      savedAt: Math.max(Date.now(), valid.save.savedAt + 1),
      reason: "flee",
      player: { ...valid.save.player, hp: valid.save.player.hp - 1 },
      stats: { ...valid.save.stats, fights: valid.save.stats.fights + 1, flees: valid.save.stats.flees + 1 },
    };
    requireThat(validateSave(save).ok, "The release smoke could not construct a valid checkpoint.");
    const written = await a.call("PUT", "/api/save", { baseRevision: 1, save });
    requireThat(written.status === 200 && record(written.data) && written.data.revision === 2,
      "The disposable checkpoint was not accepted at revision 2.");
    const restored = await a.call("GET", "/api/save");
    requireThat(restored.status === 200 && record(restored.data) && restored.data.revision === 2 && isDeepStrictEqual(restored.data.save, save),
      "The disposable checkpoint did not survive a fresh GET exactly.");
    const other = await b.call("GET", "/api/save");
    requireThat(other.status === 200 && record(other.data) && other.data.revision === 0 && other.data.save === null &&
      Array.isArray(other.data.runs) && other.data.runs.length === 0,
      "The second visitor saw the first visitor's run.");
  } catch (error) {
    failure = error;
  }
  const cleanupErrors: string[] = [];
  for (const visitor of [a, b]) {
    try { await visitor.eraseOwnData(); } catch { cleanupErrors.push("A disposable visitor could not be erased and verified."); }
  }
  if (failure || cleanupErrors.length) {
    const message = failure instanceof Error ? failure.message : failure ? "Release smoke failed." : "";
    fail([message, ...cleanupErrors].filter(Boolean).join(" "));
  }
}

/** Verifies the deployed files and a newly created anonymous visitor only. */
export async function verifyDeploy(input: string, options: VerifyDeployOptions = {}): Promise<DeployVerification> {
  const root = baseUrl(input);
  const timeoutMs = options.requestTimeoutMs ?? 6000;
  const startupMs = options.startupTimeoutMs ?? 25000;
  requireThat(Number.isFinite(timeoutMs) && timeoutMs > 0 && Number.isFinite(startupMs) && startupMs > 0,
    "Timeouts must be positive numbers.");
  const markdown = options.readmeMarkdown ?? readFileSync(defaultReadme, "utf8");
  const html = await waitForHome(root, timeoutMs, startupMs);
  const assetPaths = await verifyAssets(htmlAssets(html, root), timeoutMs);
  const readme = await verifyReadme(root, markdown, timeoutMs);
  await verifySaveRoundTrip(root, timeoutMs);
  return {
    ok: true,
    checkedAtUtc: new Date().toISOString(),
    assetPaths,
    readmeImagePaths: readme.paths,
    readmeSha256: readme.hash,
    saveRoundTrip: true,
    visitorIsolation: true,
    testVisitorsErased: true,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.slice(2).filter((value) => value !== "--")[0];
  const appUrl = arg ?? process.env.APP_URL;
  if (!appUrl) {
    console.error("Pass the app URL after --, or set APP_URL.");
    process.exitCode = 1;
  } else {
    verifyDeploy(appUrl).then(
      (result) => {
        const repoRoot = resolve(import.meta.dirname, "..");
        // These are source provenance only; do not include server data or cookies.
        let sourceRevision = "unavailable";
        let worktreeDirty = true;
        try {
          sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
          worktreeDirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim().length > 0;
        } catch { /* a source archive may have no .git directory */ }
        console.log(JSON.stringify({ ...result, sourceRevision, worktreeDirty }, null, 2));
      },
      (error: unknown) => {
        console.error(`Deployment verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
        process.exitCode = 1;
      },
    );
  }
}
