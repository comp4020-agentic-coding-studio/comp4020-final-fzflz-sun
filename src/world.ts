// Map content shared by the client (spawning) and the server (validating
// saves). Enemy ids are stable save keys: never reuse or renumber one, or old
// saves will point at the wrong enemy.

export const WORLD_WIDTH = 2200;
export const WORLD_HEIGHT = 1300;
export const PLAYER_START = { x: 220, y: 650 };
export const PLAYER_MAX_HP = 24;
export const PLAYER_EDGE = 16; // player is clamped this far inside the map

export const TRASH_HP = 6;
export const BOSS_HP = 40;

export interface Area {
  id: string;
  name: string;
}

export const AREAS: Area[] = [
  { id: "west", name: "West camp" },
  { id: "south", name: "South stray" },
  { id: "north", name: "North pack" },
  { id: "lair", name: "Boss lair" },
];

export interface EnemySpawn {
  id: string;
  area: string;
  x: number;
  y: number;
  boss: boolean;
  maxHp: number;
}

const trash = (id: string, area: string, x: number, y: number): EnemySpawn => ({
  id, area, x, y, boss: false, maxHp: TRASH_HP,
});

export const ENEMY_SPAWNS: EnemySpawn[] = [
  trash("west-1", "west", 700, 400),
  trash("west-2", "west", 760, 440),
  trash("south-1", "south", 650, 950),
  trash("north-1", "north", 1280, 280),
  trash("north-2", "north", 1330, 230),
  trash("north-3", "north", 1300, 360),
  trash("lair-guard", "lair", 1750, 640),
  { id: "lair-boss", area: "lair", x: 1850, y: 700, boss: true, maxHp: BOSS_HP },
];

export const SPAWN_BY_ID = new Map(ENEMY_SPAWNS.map((s) => [s.id, s]));
