import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ARENA, ROOM, MATCH, PLAYER, COMBAT, ITEM_TYPES, ITEM_TYPE_KEYS,
  ITEM_RESPAWN_SEC, ITEM_PICKUP_RANGE, THROW_SELF_HIT_GRACE_SEC,
  DESKS, ITEM_SPAWNS, PLAYER_SPAWNS, AVATARS, clamp, normalizeAngleDiff
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

class Room {
  constructor(code) {
    this.code = code;
    this.io = io;
    this.hostId = null;
    this.state = 'lobby'; // 'lobby' | 'countdown' | 'playing' | 'ended'
    this.players = new Map();
    this.items = new Map();
    this.projectiles = new Map();
    this.itemSeq = 0;
    this.projSeq = 0;
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
  return { id: p.id, name: p.name, avatarId: p.avatarId, x: p.x, y: p.y, angle: p.angle, hp: p.hp, lives: p.lives, status: p.status, holding: p.holding };
}

function spawnItemAt(room, spawnPoint, type) {
  const id = `item${room.itemSeq++}`;
  room.items.set(id, { id, type, x: spawnPoint.x, y: spawnPoint.y, heldBy: null, spawnPoint });
  return room.items.get(id);
}

function scheduleItemRespawn(room, spawnPoint) {
  setTimeout(() => {
    if (room.state !== 'playing') return;
    const item = spawnItemAt(room, spawnPoint, randomItemType());
    room.io.to(room.code).emit('itemSpawned', item);
  }, ITEM_RESPAWN_SEC * 1000);
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

function applyDamage(room, target, damage, dirx, diry, knockback, attackerId) {
  if (target.status !== 'active') return null;
  if (Date.now() < target.invulnerableUntil) return null;

  target.hp -= damage;
  target.damageTaken += damage;
  const attacker = room.players.get(attackerId);
  if (attacker && attacker.id !== target.id) attacker.damageDealt += damage;

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
      invulnerableUntil: Date.now() + MATCH.respawnInvulnSec * 1000
    });
  });

  room.items.clear();
  room.projectiles.clear();
  ITEM_SPAWNS.forEach(pt => spawnItemAt(room, pt, randomItemType()));

  room.matchEndAt = Date.now() + MATCH.durationSec * 1000;
  room.io.to(room.code).emit('matchStarted', {
    durationSec: MATCH.durationSec,
    endAt: room.matchEndAt,
    players: room.playerList.map(serializePlayer),
    items: [...room.items.values()]
  });

  room.tickHandle = setInterval(() => tick(room), 50);
}

function tick(room) {
  if (Date.now() >= room.matchEndAt) {
    endMatch(room, 'time');
    return;
  }

  const dt = 0.05;
  for (const proj of [...room.projectiles.values()]) {
    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;
    proj.traveled += Math.hypot(proj.vx * dt, proj.vy * dt);

    let removed = false;

    if (proj.x < 0 || proj.x > ARENA.width || proj.y < 0 || proj.y > ARENA.height) {
      removed = true;
    }

    if (!removed) {
      for (const d of DESKS) {
        if (proj.x > d.x && proj.x < d.x + d.w && proj.y > d.y && proj.y < d.y + d.h) {
          removed = true;
          break;
        }
      }
    }

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
      scheduleItemRespawn(room, proj.spawnPoint);
    }
  }

  if (room.projectiles.size > 0) {
    room.io.to(room.code).emit('projectileSync', [...room.projectiles.values()].map(p => ({ id: p.id, x: p.x, y: p.y })));
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
  const standings = room.playerList
    .map(p => ({
      id: p.id, name: p.name, avatarId: p.avatarId, lives: p.lives,
      damageDealt: Math.round(p.damageDealt), damageTaken: Math.round(p.damageTaken),
      eliminated: p.status === 'eliminated'
    }))
    .sort((a, b) => (b.lives - a.lives) || (a.damageTaken - b.damageTaken) || (b.damageDealt - a.damageDealt));
  const winner = standings[0] || null;
  room.io.to(room.code).emit('matchEnded', { reason, standings, winnerId: winner ? winner.id : null });
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
    damageDealt: 0, damageTaken: 0
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
  if (leavingPlayer) dropHeldItem(room, leavingPlayer);
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
      const result = applyDamage(room, target, spec.damage, dirx, diry, spec.knockback, attacker.id);
      if (result) hits.push({ targetId: target.id, ...result });
    }

    room.io.to(room.code).emit('attackResult', { attackerId: attacker.id, type, angle: attacker.angle, x: attacker.x, y: attacker.y, hits });
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
  });

  socket.on('leaveRoom', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Office Fight Arena listening on http://localhost:${PORT}`);
});
