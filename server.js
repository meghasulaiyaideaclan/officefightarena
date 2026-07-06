import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ARENA, ROOM, MATCH, PLAYER, COMBAT, ITEM_TYPES, ITEM_TYPE_KEYS,
  ITEM_RESPAWN_SEC, ITEM_PICKUP_RANGE, THROW_SELF_HIT_GRACE_SEC,
  POWERUPS, POWERUP_TYPE_KEYS, POWERUP_RESPAWN_SEC, POWERUP_PICKUP_RANGE, POWERUP_SPAWNS,
  CROWN, CROWN_SPAWNS, SCORE,
  CTO_TASKS, CTO_TASK_GAP_SEC, CTO_TASK_FIRST_DELAY_SEC, GRAB,
  ZONES, BOSS, COVER_OBSTACLES,
  OBSTACLES, ITEM_SPAWNS, TABLE_SPAWNS, TABLE_RESPAWN_SEC, PLAYER_SPAWNS, AVATARS, clamp, normalizeAngleDiff,
  DESTRUCTIBLE_KINDS, OBSTACLE_RESPAWN_SEC, DEBRIS_BLAST, THROWN_PLAYER_IMPACT_DAMAGE,
  DISASTERS, DISASTER_FIRST_DELAY_SEC, DISASTER_GAP_SEC, SPIRIT_WINDS
} from './shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: ROOM.codeLength }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function randomItemType() {
  return ITEM_TYPE_KEYS[Math.floor(Math.random() * ITEM_TYPE_KEYS.length)];
}

function randomPowerupType() {
  return POWERUP_TYPE_KEYS[Math.floor(Math.random() * POWERUP_TYPE_KEYS.length)];
}

function randomCrownSpawn() {
  return CROWN_SPAWNS[Math.floor(Math.random() * CROWN_SPAWNS.length)];
}

class Room {
  constructor(code) {
    this.code = code;
    this.io = io;
    this.hostId = null;
    this.state = 'lobby'; // 'lobby' | 'countdown' | 'playing' | 'ended'
    this.players = new Map();
    this.items = new Map();
    this.projectiles = new Map();
    this.powerups = new Map();
    this.crown = null;
    this.kingId = null;
    this.currentTask = null;
    this.taskTimeoutHandle = null;
    this.thrownPlayers = new Map();
    this.bossTimeoutHandle = null;
    this.obstacleStates = new Map();
    this.activeDisaster = null;
    this.disasterTimeoutHandle = null;
    this.itemSeq = 0;
    this.projSeq = 0;
    this.powerupSeq = 0;
    this.tickHandle = null;
    this.matchEndAt = 0;
    this.startingPlayerCount = 0;
    this.createdAt = Date.now();
  }

  get playerList() { return [...this.players.values()]; }

  isFull() { return this.players.size >= ROOM.maxPlayers; }

  lobbyPayload() {
    return {
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      players: this.playerList.map(p => ({ id: p.id, name: p.name, avatarId: p.avatarId, isHost: p.id === this.hostId }))
    };
  }
}

function serializePlayer(p) {
  return { id: p.id, name: p.name, avatarId: p.avatarId, x: p.x, y: p.y, angle: p.angle, hp: p.hp, lives: p.lives, status: p.status, holding: p.holding, score: p.score };
}

function spawnItemAt(room, spawnPoint, type) {
  const id = `item${room.itemSeq++}`;
  room.items.set(id, { id, type, x: spawnPoint.x, y: spawnPoint.y, heldBy: null, spawnPoint });
  return room.items.get(id);
}

function scheduleItemRespawn(room, spawnPoint, type) {
  const isTable = type === 'table';
  setTimeout(() => {
    if (room.state !== 'playing') return;
    const item = spawnItemAt(room, spawnPoint, isTable ? 'table' : randomItemType());
    room.io.to(room.code).emit('itemSpawned', item);
  }, (isTable ? TABLE_RESPAWN_SEC : ITEM_RESPAWN_SEC) * 1000);
}

function spawnPowerupAt(room, spawnPoint, type) {
  const id = `pw${room.powerupSeq++}`;
  room.powerups.set(id, { id, type, x: spawnPoint.x, y: spawnPoint.y, spawnPoint });
  return room.powerups.get(id);
}

function schedulePowerupRespawn(room, spawnPoint) {
  setTimeout(() => {
    if (room.state !== 'playing') return;
    const powerup = spawnPowerupAt(room, spawnPoint, randomPowerupType());
    room.io.to(room.code).emit('powerupSpawned', powerup);
  }, POWERUP_RESPAWN_SEC * 1000);
}

function collectPowerup(room, player, powerup) {
  const spec = POWERUPS[powerup.type];
  player.hp = Math.min(MATCH.startingHp, player.hp + spec.heal);
  if (spec.buff === 'speed') {
    player.speedBuffUntil = Date.now() + spec.buffDurationSec * 1000;
    player.speedBuffMultiplier = spec.buffMultiplier;
  } else if (spec.buff === 'damage') {
    player.damageBuffUntil = Date.now() + spec.buffDurationSec * 1000;
    player.damageBuffMultiplier = spec.buffMultiplier;
  }
  room.powerups.delete(powerup.id);
  schedulePowerupRespawn(room, powerup.spawnPoint);
  player.score = (player.score || 0) + SCORE.powerup;
  const kingChanged = recomputeKing(room);
  room.io.to(room.code).emit('powerupCollected', {
    id: powerup.id, type: powerup.type, playerId: player.id, newHp: player.hp,
    buff: spec.buff, buffDurationSec: spec.buffDurationSec, buffMultiplier: spec.buffMultiplier,
    score: player.score, kingId: room.kingId, kingChanged
  });

  if (room.currentTask && room.currentTask.id === 'collectPowerups') {
    player.taskProgress = (player.taskProgress || 0) + 1;
    if (player.taskProgress >= room.currentTask.target) completeCtoTask(room, player);
  }
}

function spawnCrown(room) {
  const spawnPoint = randomCrownSpawn();
  room.crown = { id: 'crown', x: spawnPoint.x, y: spawnPoint.y };
  return room.crown;
}

function scheduleCrownRespawn(room) {
  setTimeout(() => {
    if (room.state !== 'playing') return;
    const crown = spawnCrown(room);
    room.io.to(room.code).emit('crownSpawned', crown);
  }, CROWN.respawnSec * 1000);
}

function recomputeKing(room) {
  let king = null;
  for (const p of room.players.values()) {
    if (!king || p.score > king.score) king = p;
  }
  const kingChanged = king && room.kingId !== king.id;
  if (kingChanged) room.kingId = king.id;
  return kingChanged;
}

function collectCrown(room, player) {
  room.crown = null;
  player.score = (player.score || 0) + SCORE.crown;
  const kingChanged = recomputeKing(room);

  scheduleCrownRespawn(room);
  room.io.to(room.code).emit('crownCollected', {
    playerId: player.id, score: player.score,
    kingId: room.kingId, kingChanged
  });

  if (room.currentTask && room.currentTask.id === 'collectCrown') {
    completeCtoTask(room, player);
  }
}

function distanceToObstacle(x, y, ob) {
  const cx = Math.max(ob.x, Math.min(x, ob.x + ob.w));
  const cy = Math.max(ob.y, Math.min(y, ob.y + ob.h));
  return Math.hypot(x - cx, y - cy);
}

function isNearCover(room, x, y) {
  return COVER_OBSTACLES.some(ob => isObstacleSolid(room, ob) && distanceToObstacle(x, y, ob) <= BOSS.coverRadius);
}

// --- Destructible furniture ---
// Only obstacles whose `kind` appears in DESTRUCTIBLE_KINDS get an entry here; everything
// else (walls, trees, plants) has no entry and is therefore always solid/permanent.
function initObstacleStates(room) {
  room.obstacleStates.clear();
  for (const ob of OBSTACLES) {
    const def = DESTRUCTIBLE_KINDS[ob.kind];
    if (def) room.obstacleStates.set(ob.id, { hp: def.hp, destroyed: false });
  }
}

function isObstacleSolid(room, ob) {
  const state = room.obstacleStates.get(ob.id);
  return !state || !state.destroyed;
}

function scheduleObstacleRespawn(room, ob) {
  setTimeout(() => {
    if (room.state !== 'playing') return;
    const state = room.obstacleStates.get(ob.id);
    if (!state || !state.destroyed) return;
    state.hp = DESTRUCTIBLE_KINDS[ob.kind].hp;
    state.destroyed = false;
    room.io.to(room.code).emit('obstacleRespawned', { id: ob.id });
  }, OBSTACLE_RESPAWN_SEC * 1000);
}

// `allowChain` caps the "chain reaction" to a single hop: a destroyed obstacle can chip one
// neighboring destructible obstacle, but that secondary hit never chains any further.
function damageObstacle(room, ob, amount, hitX, hitY, allowChain = true) {
  const state = room.obstacleStates.get(ob.id);
  if (!state || state.destroyed) return;

  state.hp -= amount;
  if (state.hp > 0) return;

  state.destroyed = true;
  const blastHits = [];
  const cx = ob.x + ob.w / 2, cy = ob.y + ob.h / 2;

  if (allowChain) {
    for (const player of room.players.values()) {
      if (player.status !== 'active') continue;
      const dist = Math.hypot(player.x - cx, player.y - cy);
      if (dist > DEBRIS_BLAST.radius) continue;
      const dirx = dist > 0 ? (player.x - cx) / dist : 1;
      const diry = dist > 0 ? (player.y - cy) / dist : 0;
      const result = applyDamage(room, player, DEBRIS_BLAST.blastDamage, dirx, diry, DEBRIS_BLAST.knockback, null);
      if (result) blastHits.push({ targetId: player.id, ...result });
    }

    const neighbor = OBSTACLES.find(other =>
      other.id !== ob.id && DESTRUCTIBLE_KINDS[other.kind] && isObstacleSolid(room, other) &&
      distanceToObstacle(cx, cy, other) <= DEBRIS_BLAST.radius
    );
    if (neighbor) damageObstacle(room, neighbor, DEBRIS_BLAST.chainDamage, cx, cy, false);
  }

  room.io.to(room.code).emit('obstacleDestroyed', { id: ob.id, x: ob.x, y: ob.y, w: ob.w, h: ob.h, kind: ob.kind, blastHits });
  scheduleObstacleRespawn(room, ob);
}

function scheduleBossEvent(room, delaySec) {
  room.bossTimeoutHandle = setTimeout(() => {
    if (room.state !== 'playing') return;
    triggerBossWarning(room);
  }, delaySec * 1000);
}

function triggerBossWarning(room) {
  room.io.to(room.code).emit('bossWarning', { warningSec: BOSS.warningSec });
  room.bossTimeoutHandle = setTimeout(() => {
    if (room.state !== 'playing') return;
    resolveBossStomp(room);
  }, BOSS.warningSec * 1000);
}

function resolveBossStomp(room) {
  const hits = [];
  for (const player of room.players.values()) {
    if (player.status !== 'active') continue;
    if (isNearCover(room, player.x, player.y)) continue;
    const angle = Math.random() * Math.PI * 2;
    const result = applyDamage(room, player, BOSS.damage, Math.cos(angle), Math.sin(angle), BOSS.knockback, null);
    if (result) hits.push({ targetId: player.id, ...result });
  }
  room.io.to(room.code).emit('bossResolved', { hits });
  scheduleBossEvent(room, BOSS.gapSec);
}

// --- Realm Events ---
// Same schedule -> warn -> resolve -> reschedule shape as Sacred Trials and the Ancient
// Guardian above, so only one Realm Event is ever active and every one gets a reaction window.
function scheduleDisasterEvent(room, delaySec) {
  room.disasterTimeoutHandle = setTimeout(() => {
    if (room.state !== 'playing') return;
    triggerDisasterWarning(room);
  }, delaySec * 1000);
}

function triggerDisasterWarning(room) {
  const def = DISASTERS[Math.floor(Math.random() * DISASTERS.length)];
  room.io.to(room.code).emit('disasterWarning', { id: def.id, label: def.label, warningSec: def.warningSec });
  room.disasterTimeoutHandle = setTimeout(() => {
    if (room.state !== 'playing') return;
    resolveDisasterStart(room, def);
  }, def.warningSec * 1000);
}

function resolveDisasterStart(room, def) {
  if (def.kind === 'oneshot') {
    resolveCrystalResonance(room);
    scheduleDisasterEvent(room, DISASTER_GAP_SEC);
    return;
  }

  const meta = def.id === 'spiritWinds' ? { windAngle: Math.random() * Math.PI * 2 } : {};
  room.activeDisaster = { id: def.id, endsAt: Date.now() + def.durationSec * 1000, meta };
  room.io.to(room.code).emit('disasterStarted', { id: def.id, durationSec: def.durationSec, meta });

  room.disasterTimeoutHandle = setTimeout(() => {
    if (room.state !== 'playing') return;
    room.activeDisaster = null;
    room.io.to(room.code).emit('disasterEnded', { id: def.id });
    scheduleDisasterEvent(room, DISASTER_GAP_SEC);
  }, def.durationSec * 1000);
}

function resolveCrystalResonance(room) {
  // Reuses the destructible-obstacle blast/chain logic directly (DEBRIS_BLAST) rather than
  // applying a second, separate explosion - avoids double-damaging anyone caught in both radii.
  const target = OBSTACLES.find(ob => ob.kind === 'partition' && isObstacleSolid(room, ob));
  if (!target) {
    room.io.to(room.code).emit('disasterResolved', { id: 'crystalResonance', targetId: null });
    return;
  }
  const cx = target.x + target.w / 2, cy = target.y + target.h / 2;
  damageObstacle(room, target, 9999, cx, cy);
  room.io.to(room.code).emit('disasterResolved', { id: 'crystalResonance', targetId: target.id });
}

function scheduleCtoTask(room, delaySec) {
  setTimeout(() => {
    if (room.state !== 'playing') return;
    assignCtoTask(room);
  }, delaySec * 1000);
}

function isInZone(y, zone) {
  return y > zone.yMin && y < zone.yMax;
}

function pickCtoTaskDef(room) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const def = CTO_TASKS[Math.floor(Math.random() * CTO_TASKS.length)];
    if (!def.zone) return def;
    const activePlayers = room.playerList.filter(p => p.status !== 'eliminated');
    const allAlreadyThere = activePlayers.length > 0 && activePlayers.every(p => isInZone(p.y, ZONES[def.zone]));
    if (!allAlreadyThere) return def;
  }
  return CTO_TASKS.find(t => !t.zone) || CTO_TASKS[0];
}

function assignCtoTask(room) {
  const def = pickCtoTaskDef(room);
  const now = Date.now();
  const deadlineAt = now + def.durationSec * 1000;
  room.currentTask = { id: def.id, zone: def.zone || null, target: def.target, startedAt: now, deadlineAt };

  for (const p of room.players.values()) {
    p.taskProgress = 0;
    p.taskDone = false;
    if (def.zone) p.wasInZoneAtTaskStart = isInZone(p.y, ZONES[def.zone]);
  }

  room.io.to(room.code).emit('ctoTaskAssigned', {
    id: def.id, label: def.label.replace('{target}', def.target), target: def.target, deadlineAt
  });

  room.taskTimeoutHandle = setTimeout(() => {
    if (room.state !== 'playing' || !room.currentTask || room.currentTask.startedAt !== now) return;
    room.currentTask = null;
    room.io.to(room.code).emit('ctoTaskExpired', { id: def.id });
    scheduleCtoTask(room, CTO_TASK_GAP_SEC);
  }, def.durationSec * 1000);
}

function completeCtoTask(room, player) {
  if (!room.currentTask) return;
  const taskId = room.currentTask.id;
  room.currentTask = null;
  if (room.taskTimeoutHandle) {
    clearTimeout(room.taskTimeoutHandle);
    room.taskTimeoutHandle = null;
  }

  player.score = (player.score || 0) + SCORE.taskComplete;
  const kingChanged = recomputeKing(room);

  room.io.to(room.code).emit('ctoTaskCompleted', {
    taskId, playerId: player.id, reward: SCORE.taskComplete,
    score: player.score, kingId: room.kingId, kingChanged
  });

  scheduleCtoTask(room, CTO_TASK_GAP_SEC);
}

function dropHeldItem(room, player) {
  if (!player.holding) return;
  const item = room.items.get(player.holding);
  player.holding = null;
  if (!item) return;
  item.heldBy = null;
  item.x = player.x;
  item.y = player.y;
  room.io.to(room.code).emit('itemDropped', { id: item.id, type: item.type, x: item.x, y: item.y });
}

function dropCarriedPlayer(room, carrier) {
  if (!carrier.carrying) return;
  const carried = room.players.get(carrier.carrying);
  carrier.carrying = null;
  if (!carried) return;
  carried.carriedBy = null;
  carried.status = 'active';
  carried.x = carrier.x;
  carried.y = carrier.y;
  carried.invulnerableUntil = Date.now() + 400;
  room.io.to(room.code).emit('playerDropped', { id: carried.id, x: carried.x, y: carried.y });
}

function landThrownPlayer(room, thrown, x, y, damage) {
  thrown.x = x;
  thrown.y = y;
  thrown.hp -= damage;
  thrown.damageTaken += damage;

  let koed = false;
  let eliminated = false;
  if (thrown.hp <= 0) {
    koed = true;
    thrown.hp = 0;
    thrown.lives -= 1;
    dropHeldItem(room, thrown);
    if (thrown.lives <= 0) {
      thrown.status = 'eliminated';
      eliminated = true;
    } else {
      thrown.status = 'down';
      scheduleRespawn(room, thrown);
    }
  } else {
    thrown.status = 'active';
    thrown.invulnerableUntil = Date.now() + 600;
  }

  return { x: thrown.x, y: thrown.y, newHp: thrown.hp, newLives: thrown.lives, koed, eliminated };
}

function applyDamage(room, target, damage, dirx, diry, knockback, attackerId) {
  if (target.status !== 'active') return null;
  if (Date.now() < target.invulnerableUntil) return null;

  dropCarriedPlayer(room, target);

  target.hp -= damage;
  target.damageTaken += damage;
  target.lastDamagedAt = Date.now();
  const attacker = room.players.get(attackerId);
  if (attacker && attacker.id !== target.id) {
    attacker.damageDealt += damage;
    if (room.currentTask && room.currentTask.id === 'dealDamage') {
      attacker.taskProgress = (attacker.taskProgress || 0) + damage;
      if (attacker.taskProgress >= room.currentTask.target) completeCtoTask(room, attacker);
    }
  }

  target.x = clamp(target.x + dirx * knockback * 0.35, PLAYER.radius, ARENA.width - PLAYER.radius);
  target.y = clamp(target.y + diry * knockback * 0.35, PLAYER.radius, ARENA.height - PLAYER.radius);

  let koed = false;
  let eliminated = false;
  if (target.hp <= 0) {
    koed = true;
    target.hp = 0;
    target.lives -= 1;
    dropHeldItem(room, target);
    if (target.lives <= 0) {
      target.status = 'eliminated';
      eliminated = true;
    } else {
      target.status = 'down';
      scheduleRespawn(room, target);
    }
    if (attacker && attacker.id !== target.id && room.currentTask && room.currentTask.id === 'kos') {
      attacker.taskProgress = (attacker.taskProgress || 0) + 1;
      if (attacker.taskProgress >= room.currentTask.target) completeCtoTask(room, attacker);
    }
  }

  return { newHp: target.hp, newLives: target.lives, x: target.x, y: target.y, koed, eliminated, attackerId };
}

function scheduleRespawn(room, target) {
  setTimeout(() => {
    if (room.state !== 'playing' || !room.players.has(target.id) || target.status !== 'down') return;
    const idx = [...room.players.keys()].indexOf(target.id);
    const spawn = PLAYER_SPAWNS[idx % PLAYER_SPAWNS.length];
    target.x = spawn.x;
    target.y = spawn.y;
    target.hp = MATCH.startingHp;
    target.status = 'active';
    target.invulnerableUntil = Date.now() + MATCH.respawnInvulnSec * 1000;
    target.speedBuffUntil = 0;
    target.damageBuffUntil = 0;
    room.io.to(room.code).emit('playerRespawned', { id: target.id, x: target.x, y: target.y, hp: target.hp });
  }, MATCH.respawnDelaySec * 1000);
}

function beginCountdown(room) {
  room.state = 'countdown';
  room.io.to(room.code).emit('matchCountdown', { seconds: MATCH.countdownSec });
  setTimeout(() => {
    if (room.state !== 'countdown') return;
    beginPlaying(room);
  }, MATCH.countdownSec * 1000);
}

function beginPlaying(room) {
  room.state = 'playing';
  room.startingPlayerCount = room.players.size;

  let i = 0;
  room.players.forEach(p => {
    const spawn = PLAYER_SPAWNS[i % PLAYER_SPAWNS.length];
    i++;
    Object.assign(p, {
      hp: MATCH.startingHp, lives: MATCH.startingLives, x: spawn.x, y: spawn.y, angle: 0, moving: false,
      lastPunch: 0, lastKick: 0, holding: null, damageDealt: 0, damageTaken: 0, status: 'active',
      invulnerableUntil: Date.now() + MATCH.respawnInvulnSec * 1000,
      speedBuffUntil: 0, speedBuffMultiplier: 1, damageBuffUntil: 0, damageBuffMultiplier: 1,
      score: 0, taskProgress: 0, taskDone: false, lastDamagedAt: 0, wasInZoneAtTaskStart: false,
      carrying: null, carriedBy: null, lastGrab: 0, grabbedAt: 0
    });
  });

  room.items.clear();
  room.projectiles.clear();
  room.powerups.clear();
  room.thrownPlayers.clear();
  initObstacleStates(room);
  room.kingId = null;
  room.currentTask = null;
  if (room.taskTimeoutHandle) { clearTimeout(room.taskTimeoutHandle); room.taskTimeoutHandle = null; }
  if (room.bossTimeoutHandle) { clearTimeout(room.bossTimeoutHandle); room.bossTimeoutHandle = null; }
  if (room.disasterTimeoutHandle) { clearTimeout(room.disasterTimeoutHandle); room.disasterTimeoutHandle = null; }
  room.activeDisaster = null;
  ITEM_SPAWNS.forEach(pt => spawnItemAt(room, pt, randomItemType()));
  TABLE_SPAWNS.forEach(pt => spawnItemAt(room, pt, 'table'));
  POWERUP_SPAWNS.forEach(pt => spawnPowerupAt(room, pt, randomPowerupType()));
  spawnCrown(room);

  room.matchEndAt = Date.now() + MATCH.durationSec * 1000;
  room.io.to(room.code).emit('matchStarted', {
    durationSec: MATCH.durationSec,
    endAt: room.matchEndAt,
    players: room.playerList.map(serializePlayer),
    items: [...room.items.values()],
    powerups: [...room.powerups.values()],
    crown: room.crown
  });

  room.tickHandle = setInterval(() => tick(room), 50);
  scheduleCtoTask(room, CTO_TASK_FIRST_DELAY_SEC);
  scheduleBossEvent(room, BOSS.firstDelaySec);
  scheduleDisasterEvent(room, DISASTER_FIRST_DELAY_SEC);
}

function tick(room) {
  if (Date.now() >= room.matchEndAt) {
    endMatch(room, 'time');
    return;
  }

  const dt = 0.05;
  // Spirit Winds: a steady drift added on top of normal motion, not an accelerating force -
  // that keeps thrown relics/champions from picking up unbounded speed over the event's duration.
  let windX = 0, windY = 0;
  if (room.activeDisaster && room.activeDisaster.id === 'spiritWinds') {
    windX = Math.cos(room.activeDisaster.meta.windAngle) * SPIRIT_WINDS.forceMagnitude;
    windY = Math.sin(room.activeDisaster.meta.windAngle) * SPIRIT_WINDS.forceMagnitude;
  }

  for (const proj of [...room.projectiles.values()]) {
    proj.x += (proj.vx + windX) * dt;
    proj.y += (proj.vy + windY) * dt;
    proj.traveled += Math.hypot(proj.vx * dt, proj.vy * dt);

    let removed = false;

    if (proj.x < 0 || proj.x > ARENA.width || proj.y < 0 || proj.y > ARENA.height) {
      removed = true;
    }

    if (!removed) {
      for (const d of OBSTACLES) {
        if (isObstacleSolid(room, d) && proj.x > d.x && proj.x < d.x + d.w && proj.y > d.y && proj.y < d.y + d.h) {
          removed = true;
          if (DESTRUCTIBLE_KINDS[d.kind]) damageObstacle(room, d, ITEM_TYPES[proj.itemType].damage, proj.x, proj.y);
          break;
        }
      }
    }

    let hitEmitted = false;

    if (!removed) {
      const spec = ITEM_TYPES[proj.itemType];
      for (const target of room.players.values()) {
        if (target.status !== 'active') continue;
        if (target.id === proj.ownerId && (Date.now() - proj.spawnTime) < THROW_SELF_HIT_GRACE_SEC * 1000) continue;
        const dist = Math.hypot(target.x - proj.x, target.y - proj.y);
        if (dist < PLAYER.radius + spec.radius) {
          const dirx = dist > 0 ? (target.x - proj.x) / dist : 1;
          const diry = dist > 0 ? (target.y - proj.y) / dist : 0;
          const result = applyDamage(room, target, spec.damage, dirx, diry, spec.knockback, proj.ownerId);
          if (result) {
            room.io.to(room.code).emit('projectileHit', { itemId: proj.id, targetId: target.id, ...result });
            hitEmitted = true;
            if (result.koed && room.currentTask && room.currentTask.id === 'itemKo') {
              const attacker = room.players.get(proj.ownerId);
              if (attacker) completeCtoTask(room, attacker);
            }
          }
          removed = true;
          break;
        }
      }
    }

    if (!removed && proj.traveled >= ITEM_TYPES[proj.itemType].maxRange) {
      removed = true;
    }

    if (removed) {
      room.projectiles.delete(proj.id);
      if (!hitEmitted) {
        room.io.to(room.code).emit('projectileRemoved', { id: proj.id });
      }
      scheduleItemRespawn(room, proj.spawnPoint, proj.itemType);
    }
  }

  if (room.projectiles.size > 0) {
    room.io.to(room.code).emit('projectileSync', [...room.projectiles.values()].map(p => ({ id: p.id, x: p.x, y: p.y })));
  }

  for (const [id, tp] of [...room.thrownPlayers.entries()]) {
    const thrown = room.players.get(id);
    if (!thrown) { room.thrownPlayers.delete(id); continue; }

    tp.x += (tp.vx + windX) * dt;
    tp.y += (tp.vy + windY) * dt;
    tp.traveled += Math.hypot(tp.vx * dt, tp.vy * dt);

    let landed = false;
    let impactDamage = 0;
    let hitTarget = null;

    if (tp.x < PLAYER.radius || tp.x > ARENA.width - PLAYER.radius || tp.y < PLAYER.radius || tp.y > ARENA.height - PLAYER.radius) {
      tp.x = clamp(tp.x, PLAYER.radius, ARENA.width - PLAYER.radius);
      tp.y = clamp(tp.y, PLAYER.radius, ARENA.height - PLAYER.radius);
      landed = true;
      impactDamage = GRAB.damageToThrown;
    }

    if (!landed) {
      for (const ob of OBSTACLES) {
        if (isObstacleSolid(room, ob) && tp.x > ob.x && tp.x < ob.x + ob.w && tp.y > ob.y && tp.y < ob.y + ob.h) {
          landed = true;
          impactDamage = GRAB.damageToThrown;
          if (DESTRUCTIBLE_KINDS[ob.kind]) damageObstacle(room, ob, THROWN_PLAYER_IMPACT_DAMAGE, tp.x, tp.y);
          break;
        }
      }
    }

    if (!landed) {
      for (const other of room.players.values()) {
        if (other.id === id || other.id === tp.thrownBy || other.status !== 'active') continue;
        if (Date.now() < other.invulnerableUntil) continue;
        if (Math.hypot(other.x - tp.x, other.y - tp.y) < PLAYER.radius * 1.6) {
          hitTarget = other;
          landed = true;
          impactDamage = GRAB.damageToThrown;
          break;
        }
      }
    }

    if (!landed && tp.traveled >= GRAB.maxRange) {
      landed = true;
    }

    if (landed) {
      room.thrownPlayers.delete(id);
      let hitResult = null;
      if (hitTarget) {
        const dist = Math.hypot(hitTarget.x - tp.x, hitTarget.y - tp.y);
        const dirx = dist > 0 ? (hitTarget.x - tp.x) / dist : 1;
        const diry = dist > 0 ? (hitTarget.y - tp.y) / dist : 0;
        hitResult = applyDamage(room, hitTarget, GRAB.damageToTarget, dirx, diry, GRAB.knockback, tp.thrownBy);
      }
      const landResult = landThrownPlayer(room, thrown, tp.x, tp.y, impactDamage);
      room.io.to(room.code).emit('playerLanded', {
        id: thrown.id, x: landResult.x, y: landResult.y, newHp: landResult.newHp, newLives: landResult.newLives,
        koed: landResult.koed, eliminated: landResult.eliminated,
        hit: hitResult ? { targetId: hitTarget.id, ...hitResult } : null
      });
    }
  }

  if (room.thrownPlayers.size > 0) {
    room.io.to(room.code).emit('thrownPlayerSync', [...room.thrownPlayers.entries()].map(([id, tp]) => ({ id, x: tp.x, y: tp.y })));
  }

  for (const player of room.players.values()) {
    if (player.status === 'grabbed' && Date.now() - player.grabbedAt > GRAB.maxHoldSec * 1000) {
      const carrier = room.players.get(player.carriedBy);
      if (carrier) dropCarriedPlayer(room, carrier);
    }
  }

  for (const powerup of [...room.powerups.values()]) {
    for (const player of room.players.values()) {
      if (player.status !== 'active') continue;
      if (Math.hypot(player.x - powerup.x, player.y - powerup.y) < POWERUP_PICKUP_RANGE) {
        collectPowerup(room, player, powerup);
        break;
      }
    }
  }

  if (room.crown) {
    for (const player of room.players.values()) {
      if (player.status !== 'active') continue;
      if (Math.hypot(player.x - room.crown.x, player.y - room.crown.y) < CROWN.pickupRange) {
        collectCrown(room, player);
        break;
      }
    }
  }

  if (room.currentTask) {
    if (room.currentTask.zone) {
      const zone = ZONES[room.currentTask.zone];
      for (const player of room.players.values()) {
        if (player.status !== 'active') continue;
        const inZone = isInZone(player.y, zone);
        if (player.wasInZoneAtTaskStart) {
          // Excluded for starting there already - but once they actually leave,
          // a later genuine arrival should count.
          if (!inZone) player.wasInZoneAtTaskStart = false;
          continue;
        }
        if (inZone) {
          completeCtoTask(room, player);
          break;
        }
      }
    } else if (room.currentTask.id === 'surviveNoDamage') {
      for (const player of room.players.values()) {
        if (player.status !== 'active') continue;
        const safeSince = Math.max(room.currentTask.startedAt, player.lastDamagedAt || 0);
        if (Date.now() - safeSince >= room.currentTask.target * 1000) {
          completeCtoTask(room, player);
          break;
        }
      }
    }
  }

  const remaining = room.playerList.filter(p => p.status !== 'eliminated');
  if (room.startingPlayerCount > 1 && remaining.length <= 1) {
    endMatch(room, 'elimination');
  }
}

function endMatch(room, reason) {
  room.state = 'ended';
  if (room.tickHandle) {
    clearInterval(room.tickHandle);
    room.tickHandle = null;
  }
  if (room.taskTimeoutHandle) {
    clearTimeout(room.taskTimeoutHandle);
    room.taskTimeoutHandle = null;
  }
  if (room.bossTimeoutHandle) {
    clearTimeout(room.bossTimeoutHandle);
    room.bossTimeoutHandle = null;
  }
  if (room.disasterTimeoutHandle) {
    clearTimeout(room.disasterTimeoutHandle);
    room.disasterTimeoutHandle = null;
  }
  room.activeDisaster = null;
  room.currentTask = null;
  // The winner is whoever has the highest score - independent of lives remaining, so a
  // player eliminated early can still win the match on score. Lives/damage only break ties.
  const standings = room.playerList
    .map(p => ({
      id: p.id, name: p.name, avatarId: p.avatarId, lives: p.lives,
      damageDealt: Math.round(p.damageDealt), damageTaken: Math.round(p.damageTaken),
      score: p.score || 0, eliminated: p.status === 'eliminated'
    }))
    .sort((a, b) => (b.score - a.score) || (b.lives - a.lives) || (a.damageTaken - b.damageTaken) || (b.damageDealt - a.damageDealt));
  const winner = standings[0] || null;
  room.io.to(room.code).emit('matchEnded', { reason, standings, winnerId: winner ? winner.id : null, kingId: room.kingId });
}

function joinPlayerToRoom(room, socket, name, avatarId, isHost) {
  const cleanName = String(name || 'Player').trim().slice(0, 16) || 'Player';
  const avId = AVATARS.some(a => a.id === avatarId) ? avatarId : 0;
  const idx = room.players.size;
  const spawn = PLAYER_SPAWNS[idx % PLAYER_SPAWNS.length];

  const player = {
    id: socket.id, name: cleanName, avatarId: avId,
    x: spawn.x, y: spawn.y, angle: 0, moving: false,
    hp: MATCH.startingHp, lives: MATCH.startingLives, status: 'active',
    lastPunch: 0, lastKick: 0, invulnerableUntil: 0, holding: null,
    damageDealt: 0, damageTaken: 0,
    speedBuffUntil: 0, speedBuffMultiplier: 1, damageBuffUntil: 0, damageBuffMultiplier: 1,
    score: 0, taskProgress: 0, taskDone: false, lastDamagedAt: 0, wasInZoneAtTaskStart: false,
      carrying: null, carriedBy: null, lastGrab: 0, grabbedAt: 0
  };

  room.players.set(socket.id, player);
  if (isHost) room.hostId = socket.id;
  socket.join(room.code);
  socket.data.roomCode = room.code;

  socket.emit('roomJoined', { code: room.code, selfId: socket.id });
  room.io.to(room.code).emit('lobbyState', room.lobbyPayload());
}

function handleLeave(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  delete socket.data.roomCode;
  if (!room) return;

  const leavingPlayer = room.players.get(socket.id);
  if (leavingPlayer) {
    dropHeldItem(room, leavingPlayer);
    dropCarriedPlayer(room, leavingPlayer);
    if (leavingPlayer.carriedBy) {
      const carrier = room.players.get(leavingPlayer.carriedBy);
      if (carrier) carrier.carrying = null;
    }
    room.thrownPlayers.delete(leavingPlayer.id);
  }
  room.players.delete(socket.id);

  if (room.players.size === 0) {
    if (room.tickHandle) clearInterval(room.tickHandle);
    rooms.delete(code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.playerList[0].id;
  }

  room.io.to(code).emit('playerLeft', { id: socket.id });

  if (room.state === 'lobby' || room.state === 'ended') {
    room.io.to(code).emit('lobbyState', room.lobbyPayload());
  } else if (room.state === 'playing') {
    const remaining = room.playerList.filter(p => p.status !== 'eliminated');
    if (room.startingPlayerCount > 1 && remaining.length <= 1) {
      endMatch(room, 'elimination');
    }
  }
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name, avatarId } = {}) => {
    if (socket.data.roomCode) return;
    const code = generateRoomCode();
    const room = new Room(code);
    rooms.set(code, room);
    joinPlayerToRoom(room, socket, name, avatarId, true);
  });

  socket.on('joinRoom', ({ code, name, avatarId } = {}) => {
    if (socket.data.roomCode) return;
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return socket.emit('roomError', { message: 'Room not found.' });
    if (room.state !== 'lobby') return socket.emit('roomError', { message: 'Match already in progress.' });
    if (room.isFull()) return socket.emit('roomError', { message: 'Room is full.' });
    joinPlayerToRoom(room, socket, name, avatarId, false);
  });

  socket.on('quickPlay', ({ name, avatarId } = {}) => {
    if (socket.data.roomCode) return;
    let room = [...rooms.values()].find(r => r.state === 'lobby' && !r.isFull());
    let isHost = false;
    if (!room) {
      const code = generateRoomCode();
      room = new Room(code);
      rooms.set(code, room);
      isHost = true;
    }
    joinPlayerToRoom(room, socket, name, avatarId, isHost);
  });

  socket.on('startMatch', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
    if (room.players.size < ROOM.minToStart) {
      return socket.emit('roomError', { message: `Need at least ${ROOM.minToStart} players to start.` });
    }
    beginCountdown(room);
  });

  socket.on('returnToLobby', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'ended') return;
    room.state = 'lobby';
    room.io.to(room.code).emit('lobbyState', room.lobbyPayload());
  });

  socket.on('move', ({ x, y, angle, moving } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.status !== 'active') return;
    if (typeof x === 'number' && isFinite(x)) player.x = clamp(x, PLAYER.radius, ARENA.width - PLAYER.radius);
    if (typeof y === 'number' && isFinite(y)) player.y = clamp(y, PLAYER.radius, ARENA.height - PLAYER.radius);
    if (typeof angle === 'number' && isFinite(angle)) player.angle = angle;
    player.moving = !!moving;
    socket.to(room.code).emit('playerMoved', { id: player.id, x: player.x, y: player.y, angle: player.angle, moving: player.moving });
  });

  socket.on('attack', ({ type, angle } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const attacker = room.players.get(socket.id);
    if (!attacker || attacker.status !== 'active') return;
    const spec = COMBAT[type];
    if (!spec) return;

    const now = Date.now();
    const lastKey = type === 'punch' ? 'lastPunch' : 'lastKick';
    if (now - attacker[lastKey] < spec.cooldownSec * 1000 - 30) return;
    attacker[lastKey] = now;
    if (typeof angle === 'number' && isFinite(angle)) attacker.angle = angle;

    const arcRad = (spec.arcDeg * Math.PI) / 180;
    const damageMultiplier = Date.now() < attacker.damageBuffUntil ? attacker.damageBuffMultiplier : 1;
    const hits = [];
    for (const target of room.players.values()) {
      if (target.id === attacker.id || target.status !== 'active') continue;
      const dx = target.x - attacker.x;
      const dy = target.y - attacker.y;
      const dist = Math.hypot(dx, dy);
      if (dist > spec.range + PLAYER.radius) continue;
      const angleTo = Math.atan2(dy, dx);
      if (Math.abs(normalizeAngleDiff(angleTo - attacker.angle)) > arcRad / 2) continue;
      const dirx = dist > 0 ? dx / dist : 1;
      const diry = dist > 0 ? dy / dist : 0;
      const result = applyDamage(room, target, spec.damage * damageMultiplier, dirx, diry, spec.knockback, attacker.id);
      if (result) hits.push({ targetId: target.id, ...result });
    }

    room.io.to(room.code).emit('attackResult', { attackerId: attacker.id, type, angle: attacker.angle, x: attacker.x, y: attacker.y, hits });

    if (hits.length > 0 && room.currentTask && room.currentTask.id === 'landHits') {
      attacker.taskProgress = (attacker.taskProgress || 0) + hits.length;
      if (attacker.taskProgress >= room.currentTask.target) completeCtoTask(room, attacker);
    }
  });

  socket.on('pickupItem', ({ itemId } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.status !== 'active' || player.holding) return;
    const item = room.items.get(itemId);
    if (!item || item.heldBy) return;
    if (Math.hypot(item.x - player.x, item.y - player.y) > ITEM_PICKUP_RANGE) return;
    item.heldBy = player.id;
    player.holding = item.id;
    room.io.to(room.code).emit('itemPickedUp', { itemId: item.id, playerId: player.id });
  });

  socket.on('throwItem', ({ angle } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.status !== 'active' || !player.holding) return;
    const item = room.items.get(player.holding);
    if (!item) { player.holding = null; return; }
    if (typeof angle === 'number' && isFinite(angle)) player.angle = angle;

    const spec = ITEM_TYPES[item.type];
    const id = `proj${room.projSeq++}`;
    const proj = {
      id, itemType: item.type,
      x: player.x + Math.cos(player.angle) * PLAYER.radius,
      y: player.y + Math.sin(player.angle) * PLAYER.radius,
      vx: Math.cos(player.angle) * spec.throwSpeed,
      vy: Math.sin(player.angle) * spec.throwSpeed,
      ownerId: player.id, spawnTime: Date.now(), traveled: 0, spawnPoint: item.spawnPoint
    };
    room.projectiles.set(id, proj);
    room.items.delete(item.id);
    player.holding = null;

    room.io.to(room.code).emit('itemThrown', {
      groundItemId: item.id,
      projectile: { id: proj.id, itemType: proj.itemType, x: proj.x, y: proj.y },
      playerId: player.id, angle: player.angle
    });

    if (room.currentTask && room.currentTask.id === 'throwItem' && !player.taskDone) {
      player.taskDone = true;
      completeCtoTask(room, player);
    }
  });

  socket.on('grabPlayer', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.status !== 'active' || player.holding || player.carrying || player.carriedBy) return;
    if (Date.now() - player.lastGrab < GRAB.cooldownSec * 1000) return;

    let target = null;
    let nearestDist = Infinity;
    for (const other of room.players.values()) {
      if (other.id === player.id || other.status !== 'active') continue;
      if (other.carriedBy || Date.now() < other.invulnerableUntil) continue;
      const dist = Math.hypot(other.x - player.x, other.y - player.y);
      if (dist < GRAB.range && dist < nearestDist) { nearestDist = dist; target = other; }
    }
    if (!target) return;

    player.lastGrab = Date.now();
    player.carrying = target.id;
    target.carriedBy = player.id;
    target.status = 'grabbed';
    target.grabbedAt = Date.now();
    target.speedBuffUntil = 0;
    target.damageBuffUntil = 0;
    room.io.to(room.code).emit('playerGrabbed', { carrierId: player.id, targetId: target.id });
  });

  socket.on('throwPlayer', ({ angle } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.status !== 'active' || !player.carrying) return;
    const thrown = room.players.get(player.carrying);
    player.carrying = null;
    if (!thrown) return;
    if (typeof angle === 'number' && isFinite(angle)) player.angle = angle;

    thrown.carriedBy = null;
    thrown.status = 'thrown';
    const x = player.x + Math.cos(player.angle) * PLAYER.radius;
    const y = player.y + Math.sin(player.angle) * PLAYER.radius;
    room.thrownPlayers.set(thrown.id, {
      x, y,
      vx: Math.cos(player.angle) * GRAB.throwSpeed,
      vy: Math.sin(player.angle) * GRAB.throwSpeed,
      thrownBy: player.id, traveled: 0
    });

    player.score = (player.score || 0) + SCORE.throwPlayer;
    const kingChanged = recomputeKing(room);

    room.io.to(room.code).emit('playerThrown', {
      carrierId: player.id, targetId: thrown.id, x, y, angle: player.angle,
      score: player.score, kingId: room.kingId, kingChanged
    });

    if (room.currentTask && room.currentTask.id === 'throwPlayers') {
      player.taskProgress = (player.taskProgress || 0) + 1;
      if (player.taskProgress >= room.currentTask.target) completeCtoTask(room, player);
    }
  });

  socket.on('leaveRoom', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Office Fight Arena listening on http://localhost:${PORT}`);
});
