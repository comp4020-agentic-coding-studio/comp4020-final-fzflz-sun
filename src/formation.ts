export interface V {
  x: number;
  y: number;
}
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** Footprint relative to a unit's centre, covering body, HP/block, intent and target marker. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const TRASH_BOX: Box = { left: -36, right: 36, top: -70, bottom: 18 };
export const BOSS_BOX: Box = { left: -58, right: 58, top: -108, bottom: 32 };
export const PLAYER_BOX: Box = { left: -24, right: 24, top: -24, bottom: 24 };
const BOX_PAD = 6;

export interface Viewport {
  viewW: number;
  viewH: number;
  worldW: number;
  worldH: number;
  /** Screen-space rect left clear of the HUD, hand, buttons and side list. */
  safe: Rect;
}

export interface Unit {
  id: number;
  isBoss: boolean;
  pos: V;
}

export interface Formation {
  slots: Map<number, V>;
  overflow: number[];
  stage: Rect;
}

export function boxAt(p: V, b: Box): Rect {
  return { x0: p.x + b.left, y0: p.y + b.top, x1: p.x + b.right, y1: p.y + b.bottom };
}

export function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;
}

function rectInside(inner: Rect, outer: Rect, tol = 0): boolean {
  return (
    inner.x0 >= outer.x0 - tol &&
    inner.y0 >= outer.y0 - tol &&
    inner.x1 <= outer.x1 + tol &&
    inner.y1 <= outer.y1 + tol
  );
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(Math.max(n, lo), hi);
}

function angleDiff(a: number, b: number) {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

/** World region a scale-1 camera can show inside the safe rect, even when clamped at map edges. */
export function visibleRegion(v: Viewport): Rect {
  return {
    x0: v.safe.x0,
    y0: v.safe.y0,
    x1: v.worldW - (v.viewW - v.safe.x1),
    y1: v.worldH - (v.viewH - v.safe.y1),
  };
}

/** A safe-rect-sized world area that contains the player, leans toward the enemies and stays on-map. */
export function stageRect(anchor: V, dir: V, v: Viewport): Rect {
  const w = v.safe.x1 - v.safe.x0;
  const h = v.safe.y1 - v.safe.y0;
  const margin = 30;
  const cx = clamp(anchor.x + dir.x * w * 0.2, anchor.x - w / 2 + margin, anchor.x + w / 2 - margin);
  const cy = clamp(anchor.y + dir.y * h * 0.2, anchor.y - h / 2 + margin, anchor.y + h / 2 - margin);
  const vis = visibleRegion(v);
  const x0 = clamp(cx - w / 2, vis.x0, vis.x1 - w);
  const y0 = clamp(cy - h / 2, vis.y0, vis.y1 - h);
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

/**
 * Assigns each unit a combat slot around the player, once, at engagement.
 * Candidate points sit on rings around the player, scored so nearer rings and
 * the side the enemies came from fill first (an arc, then further rows). A
 * point is taken only if its full footprint stays inside the stage and clear
 * of every other footprint. Bosses are placed first; whatever doesn't fit
 * goes to the overflow list instead of being squeezed in or dropped.
 */
export function layoutFormation(units: Unit[], anchor: V, v: Viewport, maxVisible = Infinity): Formation {
  let sx = 0;
  let sy = 0;
  for (const u of units) {
    sx += u.pos.x - anchor.x;
    sy += u.pos.y - anchor.y;
  }
  const len = Math.hypot(sx, sy);
  const dir = len > 1 ? { x: sx / len, y: sy / len } : { x: 1, y: 0 };
  const baseAngle = Math.atan2(dir.y, dir.x);
  const stage = stageRect(anchor, dir, v);

  const candidates: { p: V; score: number }[] = [];
  // Rings reach the far side of the stage so a player pinned at an edge can
  // still use the whole width.
  for (let r = 70; r <= 1000; r += 26) {
    const n = Math.max(12, Math.ceil((Math.PI * 2 * r) / 18));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      candidates.push({
        p: { x: anchor.x + Math.cos(a) * r, y: anchor.y + Math.sin(a) * r },
        score: r + 140 * angleDiff(a, baseAngle),
      });
    }
  }
  candidates.sort((a, b) => a.score - b.score);

  const placedRects: Rect[] = [boxAt(anchor, PLAYER_BOX)];
  const take = (box: Box): V | null => {
    for (const c of candidates) {
      const r = boxAt(c.p, box);
      if (!rectInside(r, stage)) continue;
      if (placedRects.some((o) => rectsOverlap(r, o, BOX_PAD))) continue;
      placedRects.push(r);
      return c.p;
    }
    return null;
  };

  const slots = new Map<number, V>();
  const overflow: number[] = [];
  let visibleCount = 0;

  for (const b of units.filter((u) => u.isBoss)) {
    const p = visibleCount < maxVisible ? take(BOSS_BOX) : null;
    if (p) {
      slots.set(b.id, p);
      visibleCount++;
    } else overflow.push(b.id);
  }

  // Nearest trash get the visible slots; slots are then handed out in angular
  // order so left-hand enemies stay on the left and paths don't cross.
  const trash = units
    .filter((u) => !u.isBoss)
    .sort((a, b) => dist(a.pos, anchor) - dist(b.pos, anchor));
  const trashSlots: V[] = [];
  for (let i = 0; i < trash.length && visibleCount < maxVisible; i++) {
    const p = take(TRASH_BOX);
    if (!p) break;
    trashSlots.push(p);
    visibleCount++;
  }
  const shown = trash.slice(0, trashSlots.length);
  for (const u of trash.slice(trashSlots.length)) overflow.push(u.id);

  const rel = (p: V) => {
    let a = Math.atan2(p.y - anchor.y, p.x - anchor.x) - baseAngle;
    while (a <= -Math.PI) a += Math.PI * 2;
    while (a > Math.PI) a -= Math.PI * 2;
    return a;
  };
  const unitsByAngle = shown.slice().sort((a, b) => rel(a.pos) - rel(b.pos));
  const slotsByAngle = trashSlots.slice().sort((a, b) => rel(a) - rel(b));
  unitsByAngle.forEach((u, i) => slots.set(u.id, slotsByAngle[i]));

  return { slots, overflow, stage };
}

function dist(a: V, b: V) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Union of the player's and every slotted unit's footprint. */
export function formationBounds(units: Unit[], slots: Map<number, V>, anchor: V): Rect {
  const rects = [boxAt(anchor, PLAYER_BOX)];
  for (const u of units) {
    const p = slots.get(u.id);
    if (p) rects.push(boxAt(p, u.isBoss ? BOSS_BOX : TRASH_BOX));
  }
  return {
    x0: Math.min(...rects.map((r) => r.x0)),
    y0: Math.min(...rects.map((r) => r.y0)),
    x1: Math.max(...rects.map((r) => r.x1)),
    y1: Math.max(...rects.map((r) => r.y1)),
  };
}

export function clampCam(center: V, scale: number, v: Viewport): V {
  const halfW = v.viewW / (2 * scale);
  const halfH = v.viewH / (2 * scale);
  return {
    x: clamp(center.x, halfW, v.worldW - halfW),
    y: clamp(center.y, halfH, v.worldH - halfH),
  };
}

export function toScreen(p: V, center: V, scale: number, v: Viewport): V {
  return { x: (p.x - center.x) * scale + v.viewW / 2, y: (p.y - center.y) * scale + v.viewH / 2 };
}

export function boundsOnScreen(bounds: Rect, center: V, scale: number, v: Viewport): Rect {
  const a = toScreen({ x: bounds.x0, y: bounds.y0 }, center, scale, v);
  const b = toScreen({ x: bounds.x1, y: bounds.y1 }, center, scale, v);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

export function fitsSafe(bounds: Rect, center: V, scale: number, v: Viewport): boolean {
  return rectInside(boundsOnScreen(bounds, center, scale, v), v.safe, 0.5);
}

/**
 * Frames the bounds inside the safe rect. Zoom is the largest allowed value
 * that still shows everything once the camera is clamped to the map; normal
 * fights pass {min: 1, max: 1} and so only pan.
 */
export function planCamera(bounds: Rect, v: Viewport, zoom: { min: number; max: number }) {
  const safeW = v.safe.x1 - v.safe.x0;
  const safeH = v.safe.y1 - v.safe.y0;
  const bw = Math.max(1, bounds.x1 - bounds.x0);
  const bh = Math.max(1, bounds.y1 - bounds.y0);
  const safeCx = (v.safe.x0 + v.safe.x1) / 2;
  const safeCy = (v.safe.y0 + v.safe.y1) / 2;
  let scale = clamp(Math.min(safeW / bw, safeH / bh), zoom.min, zoom.max);
  for (;;) {
    const raw = {
      x: (bounds.x0 + bounds.x1) / 2 - (safeCx - v.viewW / 2) / scale,
      y: (bounds.y0 + bounds.y1) / 2 - (safeCy - v.viewH / 2) / scale,
    };
    const center = clampCam(raw, scale, v);
    if (fitsSafe(bounds, center, scale, v) || scale <= zoom.min) return { center, scale };
    scale = Math.max(zoom.min, scale - 0.05);
  }
}
