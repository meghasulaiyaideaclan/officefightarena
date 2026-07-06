// Single source of truth for values that both server.js and public/client.js depend on.
// Keeping this shared avoids server/client drifting apart on arena size, combat math, etc.

// The Meeting of Realms is a vertical stack of realms, each separated by a Realm Ward only
// crossable via a Ley Portal pair: Sacred Grove -> Sky Sanctum -> Hall of the First Trial ->
// Mystic Garden Terrace -> Elderwood Wilds.
export const ARENA = { width: 1600, height: 3400 };
export const MAIN_FLOOR_HEIGHT = 1000;

export const ZONES = {
  mainFloor: { yMin: 0, yMax: 1000, label: 'THE SACRED GROVE', tint: 'rgba(90, 200, 140, 0.04)' },
  rooftop: { yMin: 1050, yMax: 1550, label: 'THE SKY SANCTUM', tint: 'rgba(140, 200, 255, 0.06)' },
  lobby: { yMin: 1600, yMax: 2100, label: 'HALL OF THE FIRST TRIAL', tint: 'rgba(212, 166, 61, 0.05)' },
  terrace: { yMin: 2150, yMax: 2650, label: 'MYSTIC GARDEN TERRACE', tint: 'rgba(79, 179, 158, 0.06)' },
  park: { yMin: 2700, yMax: 3400, label: 'THE ELDERWOOD WILDS', tint: 'rgba(60, 180, 90, 0.08)' }
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
// Tasks with a `zone` field use generalized "arrive at this area" logic - a player already
// standing there when the task starts doesn't get free credit; they must actually arrive.
export const CTO_TASKS = [
  { id: 'kos', label: 'Defeat {target} rival champions in single combat', target: 2, durationSec: 30 },
  { id: 'reachRooftop', zone: 'rooftop', label: 'Ascend to the Sky Sanctum', target: 1, durationSec: 20 },
  { id: 'reachPark', zone: 'park', label: 'Journey to the Elderwood Wilds', target: 1, durationSec: 30 },
  { id: 'surviveNoDamage', label: 'Endure unscathed for {target} seconds', target: 12, durationSec: 25 },
  { id: 'collectPowerups', label: 'Gather {target} Blessings from the realms', target: 2, durationSec: 25 },
  { id: 'dealDamage', label: 'Strike {target} damage upon rival champions', target: 40, durationSec: 25 },
  { id: 'throwItem', label: 'Hurl a relic at a rival champion', target: 1, durationSec: 20 },
  { id: 'throwPlayers', label: 'Grapple and hurl {target} champions', target: 2, durationSec: 35 },
  { id: 'collectCrown', label: 'Claim the hidden Relic of Ascension', target: 1, durationSec: 30 },
  { id: 'itemKo', label: 'Defeat a champion with a hurled relic', target: 1, durationSec: 30 },
  { id: 'landHits', label: 'Land {target} strikes upon rival champions', target: 5, durationSec: 30 }
];
// Scoring: the match winner is whoever has the highest score, completely independent of
// lives remaining - even a player who was eliminated early can still win on score.
export const SCORE = {
  crown: 1000,
  taskComplete: 300,
  throwPlayer: 100,
  powerup: 20
};
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
  stapler: { damage: 14, throwSpeed: 900, knockback: 300, radius: 12, maxRange: 1100, color: '#8fd6e8' },
  keyboard: { damage: 20, throwSpeed: 720, knockback: 380, radius: 15, maxRange: 1000, color: '#8a8578' },
  chair: { damage: 28, throwSpeed: 540, knockback: 520, radius: 20, maxRange: 900, color: '#5a4632' },
  // A rare, devastating heavy weapon - a full hit takes a player from 100 HP straight to a KO.
  // Deliberately slow and short-ranged so it can't be spammed like the lighter items.
  table: { damage: 100, throwSpeed: 420, knockback: 650, radius: 26, maxRange: 650, color: '#7d7a72' }
};
// Only these spawn in the common random rotation; 'table' spawns separately (see TABLE_SPAWNS).
export const ITEM_TYPE_KEYS = ['stapler', 'keyboard', 'chair'];
export const ITEM_RESPAWN_SEC = 8;
export const TABLE_SPAWNS = [{ x: 800, y: 650 }, { x: 800, y: 1300 }, { x: 600, y: 3050 }];
export const TABLE_RESPAWN_SEC = 25;
export const ITEM_PICKUP_RANGE = 46;
export const THROW_SELF_HIT_GRACE_SEC = 0.12;

// Power-ups restore HP players lost in combat, and a few grant a short buff.
// Picked up automatically by walking over them (no throw/hold, unlike office items above).
export const POWERUPS = {
  coffee: { heal: 15, buff: 'speed', buffMultiplier: 1.6, buffDurationSec: 5, color: '#4fb3e8' },
  tea: { heal: 18, buff: null, buffMultiplier: 1, buffDurationSec: 0, color: '#4fb39e' },
  lemonade: { heal: 20, buff: null, buffMultiplier: 1, buffDurationSec: 0, color: '#f4d03f' },
  pizza: { heal: 30, buff: 'damage', buffMultiplier: 1.3, buffDurationSec: 6, color: '#d9694a' },
  burger: { heal: 35, buff: null, buffMultiplier: 1, buffDurationSec: 0, color: '#d4a63d' }
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
let deskSeq = 0;
for (const cx of [200, 600, 1000, 1400]) {
  for (const cy of [200, 500, 800]) {
    MAIN_DESKS.push({ id: `desk-${deskSeq++}`, kind: 'desk', x: cx - 70, y: cy - 35, w: 140, h: 70 });
  }
}

// Upstairs lounge floor: a couple of desks for coworkers who "work from the roof deck".
const UPSTAIRS_DESKS = [
  { id: `desk-${deskSeq++}`, kind: 'desk', x: 325, y: 1150, w: 150, h: 75 },
  { id: `desk-${deskSeq++}`, kind: 'desk', x: 1125, y: 1150, w: 150, h: 75 }
];

export const DESKS = [...MAIN_DESKS, ...UPSTAIRS_DESKS];

// Cubicle divider walls between desk pods. Same rectangle collision as desks
// (block players + thrown items) but rendered as thin partition panels, not furniture.
export const PARTITIONS = [
  { id: 'partition-0', kind: 'partition', x: 393, y: 145, w: 14, h: 110 },
  { id: 'partition-1', kind: 'partition', x: 1193, y: 145, w: 14, h: 110 },
  { id: 'partition-2', kind: 'partition', x: 393, y: 445, w: 14, h: 110 },
  { id: 'partition-3', kind: 'partition', x: 1193, y: 445, w: 14, h: 110 },
  { id: 'partition-4', kind: 'partition', x: 393, y: 745, w: 14, h: 110 },
  { id: 'partition-5', kind: 'partition', x: 1193, y: 745, w: 14, h: 110 }
];

// Solid dividers between vertical zones. Only crossable via STAIRCASES.
export const FLOOR_WALLS = [
  { x: 0, y: 1000, w: 1600, h: 50 }, // main floor -> rooftop
  { x: 0, y: 1550, w: 1600, h: 50 }, // rooftop -> lobby
  { x: 0, y: 2100, w: 1600, h: 50 }, // lobby -> terrace
  { x: 0, y: 2650, w: 1600, h: 50 } // terrace -> park
];

// Lobby: reception desk + waiting benches.
// Kept well clear of the staircase clusters near the top (y~1490-1660) and
// bottom (y~2040-2210) of this zone so furniture never blocks the entry/exit path.
const LOBBY_OBSTACLES = [
  { id: 'reception-0', x: 700, y: 1810, w: 200, h: 80, kind: 'reception' },
  { id: 'bench-0', x: 420, y: 1920, w: 110, h: 45, kind: 'bench' },
  { id: 'bench-1', x: 1070, y: 1920, w: 110, h: 45, kind: 'bench' }
];

// Terrace: outdoor bistro tables.
const TERRACE_OBSTACLES = [
  { id: 'bistro-0', x: 500, y: 2250, w: 70, h: 70, kind: 'bistro' },
  { id: 'bistro-1', x: 1030, y: 2250, w: 70, h: 70, kind: 'bistro' },
  { id: 'bistro-2', x: 500, y: 2480, w: 70, h: 70, kind: 'bistro' },
  { id: 'bistro-3', x: 1030, y: 2480, w: 70, h: 70, kind: 'bistro' }
];

// Park: lots of trees (small trunk hitbox, bigger visual canopy).
const PARK_TREES = [
  { id: 'tree-0', x: 300, y: 2800, w: 40, h: 40, kind: 'tree' }, { id: 'tree-1', x: 500, y: 2950, w: 40, h: 40, kind: 'tree' },
  { id: 'tree-2', x: 750, y: 2820, w: 40, h: 40, kind: 'tree' }, { id: 'tree-3', x: 950, y: 3000, w: 40, h: 40, kind: 'tree' },
  { id: 'tree-4', x: 1150, y: 2850, w: 40, h: 40, kind: 'tree' }, { id: 'tree-5', x: 1350, y: 3000, w: 40, h: 40, kind: 'tree' },
  { id: 'tree-6', x: 400, y: 3150, w: 40, h: 40, kind: 'tree' }, { id: 'tree-7', x: 900, y: 3200, w: 40, h: 40, kind: 'tree' },
  { id: 'tree-8', x: 1250, y: 3200, w: 40, h: 40, kind: 'tree' }
];

export const ZONE_OBSTACLES = [...LOBBY_OBSTACLES, ...TERRACE_OBSTACLES, ...PARK_TREES];

export const OBSTACLES = [...DESKS, ...PARTITIONS, ...FLOOR_WALLS, ...ZONE_OBSTACLES];

// Everything that counts as "cover" from the Boss stomp - furniture and trees, but not the
// zone-divider walls (you can't hide inside a wall).
export const COVER_OBSTACLES = [...DESKS, ...PARTITIONS, ...ZONE_OBSTACLES];

// Destructible relics of the realms: every obstacle above with a `kind` in this map can be
// smashed by a thrown relic or a hurled champion. FLOOR_WALLS have no `kind` here and stay
// indestructible - breaking a Realm Ward would let champions skip the Ley Portal gating, which
// is load-bearing for the level design. Ancient Trees are left out too (permanent cover, not
// "breakable" set dressing).
export const DESTRUCTIBLE_KINDS = {
  desk: { hp: 60, debris: 'rubble', color: '#8a8578' },
  partition: { hp: 40, debris: 'shards', color: '#5fb3a3' },
  reception: { hp: 90, debris: 'rubble', color: '#c9a63d' },
  bench: { hp: 50, debris: 'rubble', color: '#9a9384' },
  bistro: { hp: 55, debris: 'shards', color: '#7bc4b0' }
};
export const OBSTACLE_RESPAWN_SEC = 25;
// A destroyed obstacle knocks back/dings nearby players and can chip one neighboring
// obstacle - a small, one-hop "chain reaction" rather than a real physics cascade.
export const DEBRIS_BLAST = { radius: 90, knockback: 220, blastDamage: 10, chainDamage: 20 };
// A thrown player slamming into furniture does more structural damage than a thrown item.
export const THROWN_PLAYER_IMPACT_DAMAGE = 50;

// Walking onto a staircase hotspot teleports the player to its target point.
export const STAIRCASES = [
  { id: 'main-up', x: 770, y: 950, w: 60, h: 45, targetX: 800, targetY: 1110, arrow: '▲', to: 'SKY' },
  { id: 'rooftop-down', x: 770, y: 1055, w: 60, h: 45, targetX: 800, targetY: 940, arrow: '▼', to: 'GROVE' },
  { id: 'rooftop-up', x: 770, y: 1500, w: 60, h: 45, targetX: 800, targetY: 1660, arrow: '▼', to: 'TRIAL' },
  { id: 'lobby-down', x: 770, y: 1605, w: 60, h: 45, targetX: 800, targetY: 1490, arrow: '▲', to: 'SKY' },
  { id: 'lobby-up', x: 770, y: 2050, w: 60, h: 45, targetX: 800, targetY: 2210, arrow: '▼', to: 'GARDEN' },
  { id: 'terrace-down', x: 770, y: 2155, w: 60, h: 45, targetX: 800, targetY: 2040, arrow: '▲', to: 'TRIAL' },
  { id: 'terrace-up', x: 770, y: 2600, w: 60, h: 45, targetX: 800, targetY: 2760, arrow: '▼', to: 'WILDS' },
  { id: 'park-down', x: 770, y: 2705, w: 60, h: 45, targetX: 800, targetY: 2590, arrow: '▲', to: 'GARDEN' }
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
  { x: 300, y: 1850 }, { x: 800, y: 2400 }, { x: 1200, y: 2900 }
];
export const CROWN = { pickupRange: 40, respawnSec: 14, color: '#ffd700' };

// The Boss: a periodic event visible to every player regardless of which area they're in.
// A warning plays, then anyone not near cover (a desk, partition, bench, table, or tree)
// takes a heavy stomp hit.
export const BOSS = {
  firstDelaySec: 40,
  gapSec: 55,
  warningSec: 5,
  coverRadius: 70,
  damage: 60,
  knockback: 150
};

export const AVATARS = [
  { id: 0, name: 'Ember Champion', color: '#ff6b6b', accessory: 'tie' },
  { id: 1, name: 'Tide Champion', color: '#4facfe', accessory: 'glasses' },
  { id: 2, name: 'Verdant Champion', color: '#05c46b', accessory: 'headphones' },
  { id: 3, name: 'Sunfire Champion', color: '#ffc048', accessory: 'cap' },
  { id: 4, name: 'Void Champion', color: '#a29bfe', accessory: 'bow' },
  { id: 5, name: 'Dawn Champion', color: '#ff9f43', accessory: 'scarf' },
  { id: 6, name: 'Bloom Champion', color: '#fd79a8', accessory: 'glasses' },
  { id: 7, name: 'Frost Champion', color: '#00d2d3', accessory: 'tie' }
];

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function normalizeAngleDiff(diff) {
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}
