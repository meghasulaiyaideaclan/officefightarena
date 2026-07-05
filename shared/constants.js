// Single source of truth for values that both server.js and public/client.js depend on.
// Keeping this shared avoids server/client drifting apart on arena size, combat math, etc.

// The building is a vertical stack of zones, each separated by a solid wall only
// crossable via a staircase pair: Main Floor -> Rooftop -> Lobby -> Terrace -> Park.
export const ARENA = { width: 1600, height: 3400 };
export const MAIN_FLOOR_HEIGHT = 1000;

export const ZONES = {
  mainFloor: { yMin: 0, yMax: 1000, label: null, tint: null },
  rooftop: { yMin: 1050, yMax: 1550, label: 'ROOFTOP LOUNGE', tint: 'rgba(255, 190, 110, 0.05)' },
  lobby: { yMin: 1600, yMax: 2100, label: 'RECEPTION LOBBY', tint: 'rgba(255, 225, 180, 0.04)' },
  terrace: { yMin: 2150, yMax: 2650, label: 'TERRACE', tint: 'rgba(120, 200, 255, 0.06)' },
  park: { yMin: 2700, yMax: 3400, label: 'PARK', tint: 'rgba(110, 255, 140, 0.07)' }
};

export const ROOM = { maxPlayers: 7, minToStart: 2, codeLength: 5 };

export const MATCH = {
  durationSec: 180,
  startingLives: 3,
  startingHp: 100,
  respawnDelaySec: 2,
  respawnInvulnSec: 2,
  countdownSec: 3
};

// CTO Directives: periodic race-to-complete objectives. First player to finish
// the current task wins the crown-score reward; the task then resets after a gap.
export const CTO_TASKS = [
  { id: 'kos', label: 'Land {target} KOs', target: 2, durationSec: 30 },
  { id: 'reachRooftop', label: 'Reach the Rooftop Lounge', target: 1, durationSec: 20 },
  { id: 'surviveNoDamage', label: 'Survive {target}s without taking damage', target: 12, durationSec: 25 },
  { id: 'collectPowerups', label: 'Collect {target} power-ups', target: 2, durationSec: 25 },
  { id: 'dealDamage', label: 'Deal {target} total damage', target: 40, durationSec: 25 },
  { id: 'throwItem', label: 'Throw an office item at someone', target: 1, durationSec: 20 },
  { id: 'throwPlayers', label: 'Grab and throw {target} players', target: 2, durationSec: 35 },
  { id: 'collectCrown', label: 'Collect the hidden crown', target: 1, durationSec: 30 },
  { id: 'itemKo', label: 'KO a player with a thrown item', target: 1, durationSec: 30 }
];
export const CTO_TASK_REWARD_CROWN = 2;
export const CTO_TASK_GAP_SEC = 8;
export const CTO_TASK_FIRST_DELAY_SEC = 8;

// Grabbing: instead of picking up an item, a player can grab a nearby opponent,
// carry them around, and throw them into someone else for big damage.
export const GRAB = {
  range: 55,
  cooldownSec: 1.2,
  maxHoldSec: 3,
  throwSpeed: 780,
  maxRange: 1000,
  damageToTarget: 26,
  damageToThrown: 14,
  knockback: 480
};

export const PLAYER = { radius: 26, speed: 260 };

export const COMBAT = {
  punch: { range: 70, arcDeg: 100, damage: 8, cooldownSec: 0.45, knockback: 260 },
  kick: { range: 88, arcDeg: 80, damage: 14, cooldownSec: 0.85, knockback: 420 }
};

export const ITEM_TYPES = {
  stapler: { damage: 14, throwSpeed: 900, knockback: 300, radius: 12, maxRange: 1100, color: '#ff6b6b' },
  keyboard: { damage: 20, throwSpeed: 720, knockback: 380, radius: 15, maxRange: 1000, color: '#2d3436' },
  chair: { damage: 28, throwSpeed: 540, knockback: 520, radius: 20, maxRange: 900, color: '#a29bfe' }
};
export const ITEM_TYPE_KEYS = Object.keys(ITEM_TYPES);
export const ITEM_RESPAWN_SEC = 8;
export const ITEM_PICKUP_RANGE = 46;
export const THROW_SELF_HIT_GRACE_SEC = 0.12;

// Power-ups restore HP players lost in combat, and a few grant a short buff.
// Picked up automatically by walking over them (no throw/hold, unlike office items above).
export const POWERUPS = {
  coffee: { heal: 15, buff: 'speed', buffMultiplier: 1.6, buffDurationSec: 5, color: '#c68958' },
  tea: { heal: 18, buff: null, buffMultiplier: 1, buffDurationSec: 0, color: '#8bc98a' },
  lemonade: { heal: 20, buff: null, buffMultiplier: 1, buffDurationSec: 0, color: '#f4d03f' },
  pizza: { heal: 30, buff: 'damage', buffMultiplier: 1.3, buffDurationSec: 6, color: '#e17055' },
  burger: { heal: 35, buff: null, buffMultiplier: 1, buffDurationSec: 0, color: '#c0783c' }
};
export const POWERUP_TYPE_KEYS = Object.keys(POWERUPS);
export const POWERUP_RESPAWN_SEC = 10;
export const POWERUP_PICKUP_RANGE = 42;

export const POWERUP_SPAWNS = [
  { x: 800, y: 500 }, { x: 800, y: 250 }, { x: 800, y: 750 },
  { x: 330, y: 500 }, { x: 1270, y: 500 }, { x: 1000, y: 300 },
  { x: 1200, y: 1350 },
  { x: 800, y: 1950 }, { x: 800, y: 2550 }, { x: 700, y: 3100 }
];

// Main office floor: a 4x3 cubicle grid (12 desks) with open corridors between pods.
const MAIN_DESKS = [];
for (const cx of [200, 600, 1000, 1400]) {
  for (const cy of [200, 500, 800]) {
    MAIN_DESKS.push({ x: cx - 70, y: cy - 35, w: 140, h: 70 });
  }
}

// Upstairs lounge floor: a couple of desks for coworkers who "work from the roof deck".
const UPSTAIRS_DESKS = [
  { x: 325, y: 1150, w: 150, h: 75 },
  { x: 1125, y: 1150, w: 150, h: 75 }
];

export const DESKS = [...MAIN_DESKS, ...UPSTAIRS_DESKS];

// Cubicle divider walls between desk pods. Same rectangle collision as desks
// (block players + thrown items) but rendered as thin partition panels, not furniture.
export const PARTITIONS = [
  { x: 393, y: 145, w: 14, h: 110 }, { x: 1193, y: 145, w: 14, h: 110 },
  { x: 393, y: 445, w: 14, h: 110 }, { x: 1193, y: 445, w: 14, h: 110 },
  { x: 393, y: 745, w: 14, h: 110 }, { x: 1193, y: 745, w: 14, h: 110 }
];

// Solid dividers between vertical zones. Only crossable via STAIRCASES.
export const FLOOR_WALLS = [
  { x: 0, y: 1000, w: 1600, h: 50 }, // main floor -> rooftop
  { x: 0, y: 1550, w: 1600, h: 50 }, // rooftop -> lobby
  { x: 0, y: 2100, w: 1600, h: 50 }, // lobby -> terrace
  { x: 0, y: 2650, w: 1600, h: 50 } // terrace -> park
];

// Lobby: reception desk + waiting benches.
const LOBBY_OBSTACLES = [
  { x: 700, y: 1650, w: 200, h: 80, kind: 'reception' },
  { x: 420, y: 1900, w: 110, h: 45, kind: 'bench' },
  { x: 1070, y: 1900, w: 110, h: 45, kind: 'bench' }
];

// Terrace: outdoor bistro tables.
const TERRACE_OBSTACLES = [
  { x: 500, y: 2250, w: 70, h: 70, kind: 'bistro' },
  { x: 1030, y: 2250, w: 70, h: 70, kind: 'bistro' },
  { x: 500, y: 2480, w: 70, h: 70, kind: 'bistro' },
  { x: 1030, y: 2480, w: 70, h: 70, kind: 'bistro' }
];

// Park: lots of trees (small trunk hitbox, bigger visual canopy).
const PARK_TREES = [
  { x: 300, y: 2800, w: 40, h: 40, kind: 'tree' }, { x: 500, y: 2950, w: 40, h: 40, kind: 'tree' },
  { x: 750, y: 2820, w: 40, h: 40, kind: 'tree' }, { x: 950, y: 3000, w: 40, h: 40, kind: 'tree' },
  { x: 1150, y: 2850, w: 40, h: 40, kind: 'tree' }, { x: 1350, y: 3000, w: 40, h: 40, kind: 'tree' },
  { x: 400, y: 3150, w: 40, h: 40, kind: 'tree' }, { x: 900, y: 3200, w: 40, h: 40, kind: 'tree' },
  { x: 1250, y: 3200, w: 40, h: 40, kind: 'tree' }
];

export const ZONE_OBSTACLES = [...LOBBY_OBSTACLES, ...TERRACE_OBSTACLES, ...PARK_TREES];

export const OBSTACLES = [...DESKS, ...PARTITIONS, ...FLOOR_WALLS, ...ZONE_OBSTACLES];

// Walking onto a staircase hotspot teleports the player to its target point.
export const STAIRCASES = [
  { id: 'main-up', x: 770, y: 950, w: 60, h: 45, targetX: 800, targetY: 1110 },
  { id: 'rooftop-down', x: 770, y: 1055, w: 60, h: 45, targetX: 800, targetY: 940 },
  { id: 'rooftop-up', x: 770, y: 1500, w: 60, h: 45, targetX: 800, targetY: 1660 },
  { id: 'lobby-down', x: 770, y: 1605, w: 60, h: 45, targetX: 800, targetY: 1490 },
  { id: 'lobby-up', x: 770, y: 2050, w: 60, h: 45, targetX: 800, targetY: 2210 },
  { id: 'terrace-down', x: 770, y: 2155, w: 60, h: 45, targetX: 800, targetY: 2040 },
  { id: 'terrace-up', x: 770, y: 2600, w: 60, h: 45, targetX: 800, targetY: 2760 },
  { id: 'park-down', x: 770, y: 2705, w: 60, h: 45, targetX: 800, targetY: 2590 }
];
export const STAIRCASE_TELEPORT_COOLDOWN_SEC = 1.0;

// Purely decorative potted plants/trees - no collision, just atmosphere.
export const PLANTS = [
  { x: 800, y: 50 }, { x: 800, y: 950 },
  { x: 50, y: 250 }, { x: 50, y: 750 },
  { x: 1550, y: 250 }, { x: 1550, y: 750 },
  { x: 200, y: 1450 }, { x: 1400, y: 1450 },
  { x: 800, y: 1080 },
  { x: 250, y: 1700 }, { x: 1350, y: 1700 }, { x: 800, y: 2020 },
  { x: 250, y: 2250 }, { x: 1350, y: 2250 }, { x: 250, y: 2500 }, { x: 1350, y: 2500 }
];

export const ITEM_SPAWNS = [
  { x: 440, y: 300 }, { x: 1160, y: 300 },
  { x: 440, y: 700 }, { x: 1160, y: 700 },
  { x: 800, y: 200 }, { x: 800, y: 800 },
  { x: 330, y: 500 }, { x: 1270, y: 500 },
  { x: 800, y: 1350 },
  { x: 800, y: 1750 }, { x: 800, y: 2300 }, { x: 800, y: 2900 }
];

export const PLAYER_SPAWNS = [
  { x: 100, y: 100 }, { x: 1500, y: 100 },
  { x: 100, y: 900 }, { x: 1500, y: 900 },
  { x: 800, y: 70 }, { x: 800, y: 930 },
  { x: 70, y: 500 }, { x: 1530, y: 500 }
];

// The King of the Clan collectible: one crown active at a time, tucked away near desks
// or in one of the further-flung areas. Collecting it adds to a player's score; whoever
// has the most crowns collected this match is crowned "King of the Clan".
export const CROWN_SPAWNS = [
  { x: 330, y: 200 }, { x: 1270, y: 200 },
  { x: 330, y: 800 }, { x: 1270, y: 800 },
  { x: 485, y: 1140 }, { x: 1115, y: 1140 },
  { x: 800, y: 1850 }, { x: 800, y: 2400 }, { x: 1200, y: 2900 }
];
export const CROWN = { pickupRange: 40, respawnSec: 14, color: '#ffd700' };

export const AVATARS = [
  { id: 0, name: 'Red', color: '#ff6b6b', accessory: 'tie' },
  { id: 1, name: 'Blue', color: '#4facfe', accessory: 'glasses' },
  { id: 2, name: 'Green', color: '#05c46b', accessory: 'headphones' },
  { id: 3, name: 'Yellow', color: '#ffc048', accessory: 'cap' },
  { id: 4, name: 'Purple', color: '#a29bfe', accessory: 'bow' },
  { id: 5, name: 'Orange', color: '#ff9f43', accessory: 'scarf' },
  { id: 6, name: 'Pink', color: '#fd79a8', accessory: 'glasses' },
  { id: 7, name: 'Cyan', color: '#00d2d3', accessory: 'tie' }
];

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function normalizeAngleDiff(diff) {
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}
