import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { verifyDeploy } from "../scripts/verify-deploy.ts";
import { newRun, type SaveData } from "./save.ts";

// A deliberately small HTTP fixture, separate from the real server and Chrome.
// Each defect changes one externally visible result the release smoke must see.
type Mode = "ok" | "missing-js" | "html-js" | "headings-only" | "lost-save" | "shared-save";
const README = `# Camp Clearer\n\nA complete README has more than a title. This fixture describes a small
card game in which players choose a camp, read enemy intentions, and use a hand of cards to
finish the fight. The visitor can return later and continue a saved run. The deploy check
must compare all of this prose, not just the first heading.\n\n![Fight](docs/fight.png)\n`;
const marked = new Marked({ gfm: true });

interface Stored { revision: number; save: SaveData | null }

async function fixture(mode: Mode) {
  const states = new Map<string, Stored>();
  let erased = 0;
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  };
  const body = async (req: IncomingMessage): Promise<Record<string, any>> => {
    let text = "";
    for await (const chunk of req) text += chunk.toString();
    return text ? JSON.parse(text) : {};
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end(
        '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head><body><script type="module" src="/assets/app.js"></script></body></html>',
      );
      return;
    }
    if (path === "/assets/app.css") return void res.writeHead(200, { "content-type": "text/css" }).end("body { color: white; }");
    if (path === "/assets/app.js") {
      if (mode === "missing-js") return void res.writeHead(404, { "content-type": "text/plain" }).end("missing");
      if (mode === "html-js") return void res.writeHead(200, { "content-type": "text/html" }).end("<html>fallback</html>");
      return void res.writeHead(200, { "content-type": "text/javascript" }).end("window.appReady = true;");
    }
    if (path === "/readme/") {
      const content = mode === "headings-only" ? "<h1>Camp Clearer</h1>" : marked.parse(README, { async: false });
      return void res.writeHead(200, { "content-type": "text/html" }).end(`<main>${content}</main>`);
    }
    if (path === "/readme/docs/fight.png") {
      return void res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([137, 80, 78, 71]));
    }
    if (!path.startsWith("/api/")) return void res.writeHead(404).end();

    // Fresh random identities belong only to this isolated HTTP fixture.
    const fixtureIdentity = req.headers.cookie?.match(/(?:^|;\s*)cc_visitor=([A-Za-z0-9_-]{43})/)?.[1]
      ?? randomBytes(32).toString("base64url");
    if (!req.headers.cookie) res.setHeader("set-cookie", `cc_visitor=${fixtureIdentity}; Path=/; HttpOnly; SameSite=Lax`);
    const id = mode === "shared-save" ? "all-visitors" : fixtureIdentity;
    const current = () => states.get(id) ?? { revision: 0, save: null };
    const payload = () => ({ ...current(), runs: [] });
    if (path === "/api/save" && req.method === "GET") return void reply(res, 200, payload());
    if (path === "/api/runs" && req.method === "POST") {
      const input = await body(req);
      if (input.baseRevision !== current().revision) return void reply(res, 409, { error: "stale" });
      const save = newRun(`run_${randomBytes(9).toString("base64url")}`, 1, Date.now());
      states.set(id, { revision: current().revision + 1, save });
      return void reply(res, 200, payload());
    }
    if (path === "/api/save" && req.method === "PUT") {
      const input = await body(req);
      if (input.baseRevision !== current().revision) return void reply(res, 409, { error: "stale" });
      if (mode !== "lost-save") states.set(id, { revision: current().revision + 1, save: input.save });
      return void reply(res, 200, { revision: input.baseRevision + 1, savedAt: input.save.savedAt });
    }
    if (path === "/api/erase" && req.method === "POST") {
      if ((await body(req)).confirm !== "erase") return void reply(res, 400, { error: "confirm" });
      states.delete(id);
      erased++;
      return void reply(res, 200, payload());
    }
    reply(res, 404, { error: "missing" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    erasures: () => erased,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function checkFixture(mode: Mode) {
  const server = await fixture(mode);
  try {
    return await verifyDeploy(server.url, { readmeMarkdown: README, requestTimeoutMs: 1500, startupTimeoutMs: 2000 });
  } finally {
    await server.close();
  }
}

describe("deployed-site smoke", () => {
  it("checks files, a saved checkpoint, a separate visitor and cleanup", async () => {
    const server = await fixture("ok");
    try {
      const result = await verifyDeploy(server.url, { readmeMarkdown: README, requestTimeoutMs: 1500, startupTimeoutMs: 2000 });
      expect(result.ok).toBe(true);
      expect(result.assetPaths).toEqual(["/assets/app.css", "/assets/app.js"]);
      expect(result.readmeImagePaths).toEqual(["/readme/docs/fight.png"]);
      expect(result.saveRoundTrip && result.visitorIsolation && result.testVisitorsErased).toBe(true);
      expect(server.erasures()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it.each(["missing-js", "html-js"] as const)("rejects a 200 homepage with %s", async (mode) => {
    await expect(checkFixture(mode)).rejects.toThrow(/app\.js/);
  });

  it("rejects a README page that serves only a title", async () => {
    await expect(checkFixture("headings-only")).rejects.toThrow(/complete local README/);
  });

  it("rejects an acknowledged checkpoint that is gone on return", async () => {
    await expect(checkFixture("lost-save")).rejects.toThrow(/did not survive a fresh GET/);
  });

  it("rejects an API that shares one visitor's save with another", async () => {
    await expect(checkFixture("shared-save")).rejects.toThrow(/second visitor saw the first visitor/);
  });
});
