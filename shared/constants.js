// Single source of truth for values that both server.js and public/client.js depend on.
// Keeping this shared avoids server/client drifting apart on arena size, combat math, etc.

export const ARENA = { width: 1600, height: 1000 };

export const ROOM = { maxPlayers: 7, minToStart: 2, codeLength: 5 };

export const MATCH = {
  durationSec: 180,
  startingLives: 3,
  startingHp: 100,
  respawnDelaySec: 2,
  respawnInvulnSec: 2,
  countdownSec: 3
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
  { x: 1000, y: 500 }, { x: 600, y: 500 },
  { x: 800, y: 350 }, { x: 800, y: 650 },
  { x: 1050, y: 250 }, { x: 550, y: 750 }
];

export const DESKS = [
  { x: 150, y: 140, w: 150, h: 75 },
  { x: 1300, y: 140, w: 150, h: 75 },
  { x: 150, y: 785, w: 150, h: 75 },
  { x: 1300, y: 785, w: 150, h: 75 },
  { x: 725, y: 110, w: 150, h: 70 },
  { x: 725, y: 820, w: 150, h: 70 }
];

// Cubicle divider walls placed alongside desks. Same rectangle collision as desks
// (block players + thrown items) but rendered as thin partition panels, not furniture.
export const PARTITIONS = [
  { x: 310, y: 140, w: 14, h: 130 },
  { x: 1276, y: 140, w: 14, h: 130 },
  { x: 310, y: 730, w: 14, h: 130 },
  { x: 1276, y: 730, w: 14, h: 130 },
  { x: 660, y: 180, w: 14, h: 160 },
  { x: 926, y: 660, w: 14, h: 160 }
];

export const OBSTACLES = [...DESKS, ...PARTITIONS];

export const ITEM_SPAWNS = [
  { x: 420, y: 300 }, { x: 1180, y: 300 },
  { x: 420, y: 700 }, { x: 1180, y: 700 },
  { x: 800, y: 200 }, { x: 800, y: 800 },
  { x: 220, y: 500 }, { x: 1380, y: 500 }
];

export const PLAYER_SPAWNS = [
  { x: 100, y: 100 }, { x: 1500, y: 100 },
  { x: 100, y: 900 }, { x: 1500, y: 900 },
  { x: 800, y: 70 }, { x: 800, y: 930 },
  { x: 70, y: 500 }, { x: 1530, y: 500 }
];

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
