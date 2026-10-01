// Map content shared by the client (spawning, AI, combat) and the server
// (validating saves). Enemy ids are stable save keys: never reuse or renumber
// one, or old saves will point at the wrong enemy. New members get new ids.

export const WORLD_WIDTH = 2200;
export const WORLD_HEIGHT = 1300;
export const PLAYER_START = { x: 220, y: 650 };
export const PLAYER_MAX_HP = 24;
export const PLAYER_EDGE = 16; // player is clamped this far inside the map

// ---------- units: tier = how dangerous, role = what it does in a fight ----------

export type Tier = "normal" | "elite" | "boss";
export type Role = "brute" | "swarm" | "mage" | "heavy" | "boss";

export type Intent =
  | { kind: "attack"; value: number; ranged?: boolean }
  | { kind: "defend"; value: number }
  | { kind: "charge"; next: number }
  | { kind: "revive"; target: string; value: number };

export interface UnitDef {
  role: Role;
  tier: Tier;
  name: string;
  maxHp: number;
  /** Repeating action cycle; the unit's saved `phase` indexes into it. Mages decide per turn instead. */
  pattern: Intent[];
  aggroRange: number;
  engageRange: number;
  speed: number;
  /** half the body size, for separation and slot clamping */
  radius: number;
  /** how much this unit pushes a fight towards "dangerous" framing */
  threat: number;
}

export const MAGE_SHOT = 2;

export const UNITS: Record<Role, UnitDef> = {
  brute: {
    role: "brute", tier: "normal", name: "Grunt", maxHp: 6,
    pattern: [{ kind: "attack", value: 3 }],
    aggroRange: 210, engageRange: 40, speed: 100, radius: 14, threat: 1,
  },
  swarm: {
    role: "swarm", tier: "normal", name: "Swarmling", maxHp: 3,
    pattern: [{ kind: "attack", value: 2 }],
    aggroRange: 190, engageRange: 36, speed: 115, radius: 10, threat: 0.5,
  },
  mage: {
    role: "mage", tier: "normal", name: "Mage", maxHp: 9,
    pattern: [{ kind: "attack", value: MAGE_SHOT, ranged: true }],
    aggroRange: 230, engageRange: 40, speed: 90, radius: 13, threat: 2,
  },
  heavy: {
    role: "heavy", tier: "elite", name: "Brute captain", maxHp: 14,
    pattern: [{ kind: "attack", value: 4 }, { kind: "charge", next: 10 }, { kind: "attack", value: 10 }],
    aggroRange: 220, engageRange: 44, speed: 85, radius: 20, threat: 3,
  },
  boss: {
    role: "boss", tier: "boss", name: "Warlord", maxHp: 40,
    pattern: [{ kind: "attack", value: 5 }, { kind: "defend", value: 8 }, { kind: "charge", next: 12 }, { kind: "attack", value: 12 }],
    aggroRange: 260, engageRange: 46, speed: 78, radius: 28, threat: 6,
  },
};

/** Roles a mage may bring back; elites and bosses can't be revived. */
export const REVIVABLE: Role[] = ["brute", "swarm"];

// ---------- groups: how a camp reacts ----------

/**
 * skirmish: every member notices, chases and gives up on its own (you can
 * split them). pack: noticing one alerts every living member of that pack and
 * only that pack; the pack gives up together once you are `leash` px from its
 * anchor; and if any member starts a fight, the whole alerted pack joins it.
 */
export interface Group {
  id: string;
  area: string;
  kind: "skirmish" | "pack";
  label: string;
  leash: number;
}

export interface Area {
  id: string;
  name: string;
}

export const AREAS: Area[] = [
  { id: "west", name: "West camp" },
  { id: "south", name: "South stray" },
  { id: "hollow", name: "Swarm hollow" },
  { id: "north", name: "North pack" },
  { id: "ridge", name: "Captain's ridge" },
  { id: "lair", name: "Boss lair" },
];

export const GROUPS: Group[] = [
  { id: "west", area: "west", kind: "skirmish", label: "Scouts", leash: 0 },
  { id: "south", area: "south", kind: "skirmish", label: "Stray", leash: 0 },
  { id: "hollow", area: "hollow", kind: "pack", label: "Swarm", leash: 420 },
  { id: "north-sentry", area: "north", kind: "skirmish", label: "Sentry", leash: 0 },
  { id: "north", area: "north", kind: "pack", label: "Mage guard", leash: 440 },
  { id: "ridge", area: "ridge", kind: "pack", label: "Captain's guard", leash: 440 },
  { id: "lair", area: "lair", kind: "pack", label: "Warlord's guard", leash: 480 },
];

export interface EnemySpawn {
  id: string;
  role: Role;
  group: string;
  area: string;
  x: number;
  y: number;
  maxHp: number;
  boss: boolean;
}

const spawn = (id: string, role: Role, group: string, x: number, y: number): EnemySpawn => {
  const g = GROUPS.find((gr) => gr.id === group);
  if (!g) throw new Error(`unknown group ${group}`);
  return { id, role, group, area: g.area, x, y, maxHp: UNITS[role].maxHp, boss: role === "boss" };
};

// Ids up to lair-boss date from save v1 and keep their roles; the rest are v2.
export const ENEMY_SPAWNS: EnemySpawn[] = [
  // 1. scouts you can split: far enough apart to pull one at a time
  spawn("west-1", "brute", "west", 640, 380),
  spawn("west-2", "brute", "west", 860, 470),
  spawn("south-1", "brute", "south", 560, 1010),
  // 2. a swarm pack: one Cleave clears it if you take all three
  spawn("swarm-1", "swarm", "hollow", 990, 1050),
  spawn("swarm-2", "swarm", "hollow", 1040, 1095),
  spawn("swarm-3", "swarm", "hollow", 1075, 1040),
  // 3. a mage behind two grunts, plus a lone sentry on the way in
  spawn("north-3", "brute", "north-sentry", 1120, 470),
  spawn("north-1", "brute", "north", 1290, 300),
  spawn("north-2", "brute", "north", 1350, 255),
  spawn("north-mage", "mage", "north", 1395, 195),
  // 4. an elite captain with two grunts
  spawn("ridge-captain", "heavy", "ridge", 1680, 1060),
  spawn("ridge-1", "brute", "ridge", 1610, 1100),
  spawn("ridge-2", "swarm", "ridge", 1740, 1115),
  // 5. the warlord and its guard
  spawn("lair-guard", "brute", "lair", 1800, 650),
  spawn("lair-guard-2", "swarm", "lair", 1815, 560),
  spawn("lair-boss", "boss", "lair", 1905, 615),
];

export const SPAWN_BY_ID = new Map(ENEMY_SPAWNS.map((s) => [s.id, s]));
export const GROUP_BY_ID = new Map(GROUPS.map((g) => [g.id, g]));

/** Units whose action cycle position is part of the save. */
export const PHASED_IDS = ENEMY_SPAWNS.filter((s) => UNITS[s.role].pattern.length > 1).map((s) => s.id);

/** Where a pack's leash is measured from: the centre of its members' homes. */
export function groupAnchor(groupId: string): { x: number; y: number } {
  const members = ENEMY_SPAWNS.filter((s) => s.group === groupId);
  return {
    x: members.reduce((a, s) => a + s.x, 0) / members.length,
    y: members.reduce((a, s) => a + s.y, 0) / members.length,
  };
}

// Legacy (save v1) layout, kept only so old saves can be migrated.
export const V1_ENEMIES: { id: string; area: string; maxHp: number }[] = [
  { id: "west-1", area: "west", maxHp: 6 },
  { id: "west-2", area: "west", maxHp: 6 },
  { id: "south-1", area: "south", maxHp: 6 },
  { id: "north-1", area: "north", maxHp: 6 },
  { id: "north-2", area: "north", maxHp: 6 },
  { id: "north-3", area: "north", maxHp: 6 },
  { id: "lair-guard", area: "lair", maxHp: 6 },
  { id: "lair-boss", area: "lair", maxHp: 40 },
];

// kept for older call sites
export const TRASH_HP = UNITS.brute.maxHp;
export const BOSS_HP = UNITS.boss.maxHp;
