import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { CoopClientMsg, CoopHelloMsg, CoopServerMsg } from "../../src/coop-protocol.ts";
import { HttpError, json, parseCookies, readBody } from "../http.ts";
import { CoopRoom, MEMBER_COLORS, type RoomEnemy } from "./room.ts";
import { openCoopStore, type CoopStore } from "./store.ts";

// The co-op layer: a WebSocket per connected player, a room per shared
// expedition, ticked on one shared interval and broadcast to every socket in
// that room. REST (`/api/coop/rooms`...) creates/joins a room and establishes
// the player's identity cookie; the socket itself (`/coop/ws?code=`) only
// works once that identity is already a member (joining always goes through
// REST first, same-origin, so the cookie is already set by the time the
// browser opens the socket).
const COOKIE = "cc_coop";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L: read aloud or typed from a phone
const CODE_LEN = 6;
const TICK_MS = 150;
const SAVE_DEBOUNCE_MS = 2000;
const NAME_MAX = 24;

function newCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return out;
}

function cleanName(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw.trim().slice(0, NAME_MAX) : "";
  return s || fallback;
}

interface PersistedRoom {
  players: { id: string; x: number; y: number; hp: number }[];
  enemies: { key: string; x: number; y: number; cx: number; cy: number; state: string; targetId: string | null; hp: number }[];
}

export class CoopServer {
  private store: CoopStore;
  private rooms = new Map<string, CoopRoom>();
  private sockets = new Map<string, Set<{ ws: WebSocket; playerId: string }>>();
  private lastSaved = new Map<string, number>();
  private timer: ReturnType<typeof setInterval>;

  constructor(dataDir: string) {
    this.store = openCoopStore(dataDir);
    this.timer = setInterval(() => this.tickAll(), TICK_MS).unref();
  }

  private identityFor(req: IncomingMessage, res?: ServerResponse): string {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) return createHash("sha256").update(token).digest("hex");
    if (!res) throw new HttpError(401, "no co-op identity: use the REST join endpoint first");
    const fresh = randomBytes(32).toString("base64url");
    const secure = req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("set-cookie", `${COOKIE}=${fresh}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`);
    return createHash("sha256").update(fresh).digest("hex");
  }

  private colorFor(code: string, playerId: string): string {
    const existing = this.rooms.get(code)?.players.get(playerId);
    if (existing) return existing.color;
    const n = this.store.members(code).length;
    return MEMBER_COLORS[n % MEMBER_COLORS.length];
  }

  private getOrLoadRoom(code: string): CoopRoom | null {
    const live = this.rooms.get(code);
    if (live) return live;
    if (!this.store.roomExists(code)) return null;
    const room = new CoopRoom(code, Date.now());
    const now = Date.now();
    for (const m of this.store.members(code)) room.addPlayer(m.playerId, m.name, m.color, now);
    const raw = this.store.getState(code);
    if (raw) {
      try {
        restore(room, JSON.parse(raw) as PersistedRoom);
      } catch {
        // a corrupt or pre-release snapshot: start this room's world fresh rather than fail the join
      }
    }
    for (const p of room.players.values()) p.online = false; // nobody has an open socket yet
    this.rooms.set(code, room);
    return room;
  }

  // ---------- REST: create / join / peek ----------

  async handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path === "/api/coop/rooms" && req.method === "POST") {
      const playerId = this.identityFor(req, res);
      const body = (await readBody(req)) as { name?: unknown };
      const code = newCode();
      const now = Date.now();
      this.store.createRoom(code, now);
      const color = MEMBER_COLORS[0];
      const name = cleanName(body.name, "Explorer 1");
      this.store.upsertMember(code, playerId, name, color, now);
      const room = this.getOrLoadRoom(code)!;
      room.addPlayer(playerId, name, color, now);
      json(res, 200, { code, name, color });
      return true;
    }

    const joinMatch = path.match(/^\/api\/coop\/rooms\/([A-Z0-9]{6})\/join$/);
    if (joinMatch && req.method === "POST") {
      const code = joinMatch[1];
      if (!this.store.roomExists(code)) throw new HttpError(404, "no such room: check the code or link");
      const playerId = this.identityFor(req, res);
      const body = (await readBody(req)) as { name?: unknown };
      const now = Date.now();
      const color = this.colorFor(code, playerId);
      const existingMember = this.store.members(code).find((m) => m.playerId === playerId);
      const name = cleanName(body.name, existingMember?.name ?? `Explorer ${this.store.members(code).length + 1}`);
      this.store.upsertMember(code, playerId, name, color, now);
      const room = this.getOrLoadRoom(code)!;
      room.addPlayer(playerId, name, color, now);
      room.setOnline(playerId, false, now); // online only once the socket actually connects
      json(res, 200, {
        code,
        name,
        color,
        members: this.store.members(code).map((m) => ({ id: m.playerId, name: m.name, color: m.color })),
      });
      return true;
    }

    const peekMatch = path.match(/^\/api\/coop\/rooms\/([A-Z0-9]{6})$/);
    if (peekMatch && req.method === "GET") {
      const code = peekMatch[1];
      if (!this.store.roomExists(code)) throw new HttpError(404, "no such room: check the code or link");
      json(res, 200, { code, members: this.store.members(code).map((m) => ({ id: m.playerId, name: m.name, color: m.color })) });
      return true;
    }

    return false;
  }

  // ---------- WebSocket upgrade ----------

  attach(server: Server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(req.url ?? "", "http://local");
      if (url.pathname !== "/coop/ws") return; // not ours: leave it for anything else that might attach later
      let playerId: string;
      try {
        playerId = this.identityFor(req);
      } catch {
        socket.destroy();
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const room = this.getOrLoadRoom(code);
      const member = room?.players.get(playerId);
      if (!room || !member) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(room, playerId, ws));
    });
  }

  private onConnect(room: CoopRoom, playerId: string, ws: WebSocket) {
    const now = Date.now();
    room.setOnline(playerId, true, now);
    const entry = { ws, playerId };
    let set = this.sockets.get(room.code);
    if (!set) this.sockets.set(room.code, (set = new Set()));
    // the same identity opening a second tab replaces the stale socket; it never
    // gets a second character in the room.
    for (const other of set) if (other.playerId === playerId && other.ws !== ws) other.ws.close(4000, "replaced by another tab");
    set.add(entry);

    const hello: CoopHelloMsg = {
      type: "hello",
      selfId: playerId,
      room: { code: room.code, members: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color })) },
    };
    ws.send(JSON.stringify(hello));

    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const m = msg as Partial<CoopClientMsg>;
      if (m.type === "move" && typeof m.dx === "number" && typeof m.dy === "number" && Number.isFinite(m.dx) && Number.isFinite(m.dy)) {
        const dx = Math.max(-1, Math.min(1, m.dx));
        const dy = Math.max(-1, Math.min(1, m.dy));
        room.setIntent(playerId, dx, dy, Date.now());
      }
    });

    const onClose = () => {
      set!.delete(entry);
      room.setOnline(playerId, false, Date.now());
      if (set!.size === 0) this.sockets.delete(room.code);
    };
    ws.on("close", onClose);
    ws.on("error", onClose);
  }

  // ---------- shared tick loop ----------

  private tickAll() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const sockets = this.sockets.get(code);
      if (!sockets || sockets.size === 0) continue; // nobody connected: don't simulate or broadcast an empty room
      room.tick(now / 1000, TICK_MS / 1000, Math.random);
      const snapshot = room.snapshot(now);
      const msg: CoopServerMsg = { type: "state", ...snapshot };
      broadcast(sockets, msg);
      const last = this.lastSaved.get(code) ?? 0;
      if (now - last >= SAVE_DEBOUNCE_MS) {
        this.lastSaved.set(code, now);
        this.store.putState(code, JSON.stringify(persist(room)), now);
      }
    }
  }

  close() {
    clearInterval(this.timer);
    this.store.close();
  }
}

function broadcast(sockets: Set<{ ws: WebSocket; playerId: string }>, msg: CoopServerMsg) {
  const data = JSON.stringify(msg);
  for (const { ws } of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function persist(room: CoopRoom): PersistedRoom {
  return {
    players: [...room.players.values()].map((p) => ({ id: p.id, x: p.pos.x, y: p.pos.y, hp: p.hp })),
    enemies: room.enemies.map((e) => ({ key: e.key, x: e.pos.x, y: e.pos.y, cx: e.center.x, cy: e.center.y, state: e.state, targetId: e.targetId, hp: e.hp })),
  };
}

function restore(room: CoopRoom, data: PersistedRoom) {
  const byKey = new Map(room.enemies.map((e) => [e.key, e]));
  for (const saved of data.enemies ?? []) {
    const e = byKey.get(saved.key) as RoomEnemy | undefined;
    if (!e) continue;
    e.pos = { x: saved.x, y: saved.y };
    e.center = { x: saved.cx, y: saved.cy };
    e.state = saved.state as RoomEnemy["state"];
    e.targetId = saved.targetId;
    e.hp = saved.hp;
  }
  for (const saved of data.players ?? []) {
    const p = room.players.get(saved.id);
    if (!p) continue; // a snapshot's player who's since left the member list: nothing to restore onto
    p.pos = { x: saved.x, y: saved.y };
    p.hp = saved.hp;
  }
}

export function attachCoop(server: Server, dataDir: string): CoopServer {
  const coop = new CoopServer(dataDir);
  coop.attach(server);
  return coop;
}
