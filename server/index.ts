import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { checkProgression, MAX_SAVE_BYTES, newRun, validateSave, type SaveData } from "../src/save.ts";
import { renderReadme } from "./readme.ts";
import { openStore } from "./store.ts";

// One process serves everything: the built game, the save API, and README.md
// at /readme/. In development the same process mounts Vite as middleware, so
// local play uses the real API and cookie on one origin.
const DEV = process.env.NODE_ENV !== "production";
const PORT = Number(process.env.PORT ?? 8080);
const ROOT = resolve(import.meta.dirname, "..");
const DATA_DIR = process.env.DATA_DIR ?? (DEV ? join(ROOT, ".data") : "/data");
const DIST = join(ROOT, "dist");
const DOCS = join(ROOT, "docs");
const README = join(ROOT, "README.md");

const COOKIE = "cc_visitor";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const MAX_BODY = 16 * 1024;

const store = openStore(DATA_DIR);

// ---------- helpers ----------

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new HttpError(413, "body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        fail(new HttpError(400, "body is not JSON"));
      }
    });
    req.on("error", fail);
  });
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * The visitor is whoever holds the cookie: a random 256-bit token, stored only
 * as its SHA-256, so the database never holds a usable credential. No account,
 * no name; a different browser is a different visitor.
 */
function visitorFor(req: IncomingMessage, res: ServerResponse): string {
  let token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    token = randomBytes(32).toString("base64url");
    const secure = !DEV || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader(
      "set-cookie",
      `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`,
    );
  }
  const id = createHash("sha256").update(token).digest("hex");
  store.ensureVisitor(id);
  return id;
}

const newRunId = () => `run_${randomBytes(9).toString("base64url")}`;

function savePayload(visitor: string) {
  const cur = store.getSave(visitor);
  return { revision: cur?.revision ?? 0, save: cur?.save ?? null, runs: store.runs(visitor, 5) };
}

function intField(body: unknown, key: string): number {
  const v = (body as Record<string, unknown>)?.[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new HttpError(400, `${key} must be a revision number`);
  return v;
}

// ---------- API ----------

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  const visitor = visitorFor(req, res);

  if (path === "/api/save" && req.method === "GET") return json(res, 200, savePayload(visitor));

  if (path === "/api/save" && req.method === "PUT") {
    const body = (await readBody(req)) as { baseRevision?: unknown; save?: unknown };
    const base = intField(body, "baseRevision");
    if (JSON.stringify(body.save ?? null).length > MAX_SAVE_BYTES) throw new HttpError(413, "save too large");
    const v = validateSave(body.save);
    if (!v.ok) return json(res, 400, { error: v.error });
    const cur = store.getSave(visitor);
    if ((cur?.revision ?? 0) !== base) {
      return json(res, 409, { error: "your progress changed elsewhere (another tab?)", ...savePayload(visitor) });
    }
    if (!cur) return json(res, 409, { error: "no run to save into: start a run first", ...savePayload(visitor) });
    const problem = checkProgression(cur.save, v.save);
    if (problem) return json(res, 422, { error: problem });
    const revision = store.putSave(visitor, base, v.save);
    if (revision === null) return json(res, 409, { error: "conflict", ...savePayload(visitor) });
    return json(res, 200, { revision, savedAt: v.save.savedAt });
  }

  // Starting a run never deletes anything: the run being replaced goes into
  // the visitor's run history, marked "abandoned" if it was still going.
  if (path === "/api/runs" && req.method === "POST") {
    const body = await readBody(req);
    const base = intField(body, "baseRevision");
    const cur = store.getSave(visitor);
    const prev: SaveData | undefined = cur?.save;
    const count = store.runs(visitor, 1_000_000).length + (prev ? 1 : 0);
    const next = newRun(newRunId(), Math.max(count + 1, (prev?.runNumber ?? 0) + 1), Date.now());
    const ended = prev ? (prev.outcome === "playing" ? "abandoned" : prev.outcome) : "";
    const revision = store.archiveAndReplace(visitor, base, next, ended);
    if (revision === null) return json(res, 409, { error: "your progress changed elsewhere", ...savePayload(visitor) });
    return json(res, 200, savePayload(visitor));
  }

  // Erasing is the only destructive action, and needs the literal confirm word.
  if (path === "/api/erase" && req.method === "POST") {
    const body = (await readBody(req)) as { confirm?: unknown };
    if (body?.confirm !== "erase") throw new HttpError(400, 'send {"confirm":"erase"} to delete your save and history');
    store.erase(visitor);
    return json(res, 200, savePayload(visitor));
  }

  throw new HttpError(404, "no such endpoint");
}

// ---------- static ----------

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function sendFile(res: ServerResponse, base: string, rel: string, cache: string): boolean {
  const file = normalize(join(base, rel));
  if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": cache });
  res.end(readFileSync(file));
  return true;
}

let readmeCache: { mtime: number; html: string } | null = null;
function readmeHtml(): string {
  const mtime = statSync(README).mtimeMs;
  if (!readmeCache || readmeCache.mtime !== mtime) readmeCache = { mtime, html: renderReadme(README) };
  return readmeCache.html;
}

// ---------- server ----------

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
let vite: Middleware | null = null;
if (DEV) {
  const { createViteMiddleware } = await import("./dev.ts");
  vite = await createViteMiddleware(ROOT);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  const path = url.pathname;
  try {
    if (path.startsWith("/api/")) return await api(req, res, path);

    if (path === "/readme") {
      res.writeHead(301, { location: "/readme/" });
      return res.end();
    }
    if (path === "/readme/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      return res.end(readmeHtml());
    }
    if (path.startsWith("/readme/docs/")) {
      if (sendFile(res, DOCS, decodeURIComponent(path.slice("/readme/docs/".length)), "public, max-age=300")) return;
      throw new HttpError(404, "not found");
    }

    if (vite) return vite(req, res, () => {
      res.writeHead(404).end("not found");
    });

    if (path === "/" || path === "/index.html") {
      if (sendFile(res, DIST, "index.html", "no-cache")) return;
    } else if (path.startsWith("/assets/")) {
      if (sendFile(res, DIST, path.slice(1), "public, max-age=31536000, immutable")) return;
    } else if (sendFile(res, DIST, decodeURIComponent(path.slice(1)), "public, max-age=300")) return;
    throw new HttpError(404, "not found");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return res.end();
    if (path.startsWith("/api/")) return json(res, status, { error: e instanceof Error ? e.message : "error" });
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(status === 404 ? "not found" : "error");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on http://0.0.0.0:${PORT} (${DEV ? "development" : "production"}, data in ${DATA_DIR})`);
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
