import {
  ARENA, ROOM, MATCH, PLAYER, COMBAT, ITEM_TYPES, POWERUPS, CROWN,
  DESKS, PARTITIONS, OBSTACLES, PLANTS, STAIRCASES, STAIRCASE_TELEPORT_COOLDOWN_SEC,
  FLOOR_WALLS, ZONES, ZONE_OBSTACLES, AVATARS, clamp, normalizeAngleDiff, DESTRUCTIBLE_KINDS,
  VOLCANIC_ERUPTION, SACRED_RAIN, SPIRIT_WINDS
} from '/shared/constants.js';

const socket = io();

// ---------------- DOM ----------------
const screens = {
  landing: document.getElementById('landing-screen'),
  lobby: document.getElementById('lobby-screen'),
  countdown: document.getElementById('countdown-screen'),
  results: document.getElementById('results-screen')
};
const hud = document.getElementById('hud');
const leaderboardEl = document.getElementById('leaderboard');
const killFeedEl = document.getElementById('kill-feed');
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const mobileActions = document.getElementById('mobile-actions');

function switchScreen(name) {
  state.screen = name;
  Object.entries(screens).forEach(([key, el]) => el.classList.toggle('active', key === name));
  hud.style.display = name === 'arena' ? 'flex' : 'none';
  leaderboardEl.style.display = name === 'arena' ? 'flex' : 'none';
  document.getElementById('cto-task-banner').style.display = 'none';
  if (name === 'arena' && isTouchDevice()) mobileActions.style.display = 'flex';
  else mobileActions.style.display = 'none';
  document.getElementById('controls-hint').style.display = (name === 'arena' && !isTouchDevice()) ? 'flex' : 'none';
}

function isTouchDevice() {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

// ---------------- Local State ----------------
const state = {
  screen: 'landing',
  selfId: null,
  roomCode: null,
  hostId: null,
  avatarId: 0,
  lobbyPlayers: [],
  match: {
    endAt: 0,
    players: new Map(),
    items: new Map(),
    projectiles: new Map(),
    powerups: new Map(),
    crown: null,
    kingId: null,
    ctoTask: null,
    thrownPlayers: new Map(),
    bossEvent: null,
    destroyedObstacles: new Set(),
    activeDisaster: null
  },
  shakeAmount: 0,
  lastPunchAt: 0,
  lastKickAt: 0,
  lastTeleportAt: 0
};

// ---------------- Sound ----------------
class SoundManager {
  constructor() { this.ctx = null; this.gain = null; }
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.15;
    this.gain.connect(this.ctx.destination);
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  tone(freq, dur, type = 'sine', vol = 0.15, startFreq = null) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq || freq, now);
    if (startFreq) osc.frequency.exponentialRampToValueAtTime(freq, now + dur * 0.6);
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(g); g.connect(this.gain);
    osc.start(now); osc.stop(now + dur + 0.02);
  }
  punch() { this.tone(140, 0.12, 'square', 0.2, 260); }
  kick() { this.tone(90, 0.18, 'sawtooth', 0.22, 220); }
  throwSfx() { this.tone(700, 0.1, 'sine', 0.12, 300); }
  hit() { this.tone(180, 0.15, 'square', 0.18); }
  ko() { this.tone(500, 0.35, 'sawtooth', 0.2, 900); }
  pickup() { this.tone(900, 0.08, 'triangle', 0.1, 500); }
  victory() {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.4, 'triangle', 0.15), i * 100));
  }
  defeat() { this.tone(200, 0.5, 'sawtooth', 0.15, 400); }
  click() { this.tone(600, 0.05, 'sine', 0.08); }
  taskAlert() {
    this.tone(500, 0.12, 'triangle', 0.14);
    setTimeout(() => this.tone(750, 0.18, 'triangle', 0.16), 110);
  }
  bossWarning() {
    [0, 220, 440].forEach(delay => setTimeout(() => this.tone(110, 0.3, 'sawtooth', 0.22, 180), delay));
  }
  bossStomp() { this.tone(70, 0.4, 'square', 0.25, 140); }
  crash() { this.tone(120, 0.3, 'sawtooth', 0.22, 90); }
}
const sound = new SoundManager();
window.addEventListener('pointerdown', () => { sound.init(); sound.resume(); }, { once: true });

// ---------------- Particles ----------------
class ParticleSystem {
  constructor() { this.list = []; }
  spawn(x, y, count, color) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 200;
      this.list.push({
        x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        life: 0.3 + Math.random() * 0.4, maxLife: 0.5, color, r: 2 + Math.random() * 3
      });
    }
  }
  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 100 * dt; p.life -= dt;
      if (p.life <= 0) this.list.splice(i, 1);
    }
  }
  draw(ctx) {
    for (const p of this.list) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}
const particles = new ParticleSystem();

// ---------------- Input ----------------
const keys = {};
let joystick = { active: false, x: 0, y: 0, startX: 0, startY: 0 };

window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (state.screen !== 'arena') return;
  if (k === 'f') doPunch();
  if (k === 'g') doKick();
  if (k === 'e') doInteract();
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

function getMovementVector() {
  if (joystick.active) return { x: joystick.x, y: joystick.y };
  let kx = 0, ky = 0;
  if (keys['w'] || keys['arrowup']) ky -= 1;
  if (keys['s'] || keys['arrowdown']) ky += 1;
  if (keys['a'] || keys['arrowleft']) kx -= 1;
  if (keys['d'] || keys['arrowright']) kx += 1;
  if (kx || ky) {
    const len = Math.hypot(kx, ky);
    return { x: kx / len, y: ky / len };
  }
  return { x: 0, y: 0 };
}

function setupTouch() {
  const joyEl = document.getElementById('mobile-joystick');
  const knob = document.getElementById('mobile-joystick-knob');
  const container = document.getElementById('game-container');

  container.addEventListener('touchstart', e => {
    if (state.screen !== 'arena') return;
    const rect = container.getBoundingClientRect();
    for (const t of e.changedTouches) {
      const tx = t.clientX - rect.left;
      if (tx < rect.width / 2) {
        joystick.active = true;
        joystick.touchId = t.identifier;
        joyEl.style.display = 'block';
        joyEl.style.left = `${tx - 60}px`;
        joyEl.style.top = `${(t.clientY - rect.top) - 60}px`;
        joystick.startX = t.clientX; joystick.startY = t.clientY;
        knob.style.left = '37px'; knob.style.top = '37px';
        joystick.x = 0; joystick.y = 0;
      }
    }
  }, { passive: true });

  container.addEventListener('touchmove', e => {
    if (!joystick.active) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== joystick.touchId) continue;
      const dx = t.clientX - joystick.startX, dy = t.clientY - joystick.startY;
      const dist = Math.hypot(dx, dy);
      const max = 42;
      const mx = dist > max ? (dx / dist) * max : dx;
      const my = dist > max ? (dy / dist) * max : dy;
      knob.style.left = `${37 + mx}px`; knob.style.top = `${37 + my}px`;
      joystick.x = mx / max; joystick.y = my / max;
    }
  }, { passive: true });

  const endTouch = e => {
    for (const t of e.changedTouches) {
      if (t.identifier === joystick.touchId) {
        joystick.active = false; joystick.x = 0; joystick.y = 0; joyEl.style.display = 'none';
      }
    }
  };
  container.addEventListener('touchend', endTouch);
  container.addEventListener('touchcancel', endTouch);

  const bindAction = (id, fn) => {
    const el = document.getElementById(id);
    el.addEventListener('touchstart', e => { e.preventDefault(); fn(); }, { passive: false });
  };
  bindAction('btn-punch', doPunch);
  bindAction('btn-kick', doKick);
  bindAction('btn-interact', doInteract);
}
setupTouch();

// ---------------- Combat actions ----------------
function doPunch() {
  const me = state.match.players.get(state.selfId);
  if (!me || me.status !== 'active') return;
  const now = performance.now();
  if (now - state.lastPunchAt < COMBAT.punch.cooldownSec * 1000) return;
  state.lastPunchAt = now;
  me.attackAnim = { type: 'punch', timer: 0.22 };
  sound.punch();
  socket.emit('attack', { type: 'punch', angle: me.angle });
}

function doKick() {
  const me = state.match.players.get(state.selfId);
  if (!me || me.status !== 'active') return;
  const now = performance.now();
  if (now - state.lastKickAt < COMBAT.kick.cooldownSec * 1000) return;
  state.lastKickAt = now;
  me.attackAnim = { type: 'kick', timer: 0.28 };
  sound.kick();
  socket.emit('attack', { type: 'kick', angle: me.angle });
}

function doInteract() {
  const me = state.match.players.get(state.selfId);
  if (!me || me.status !== 'active') return;

  if (me.carrying) {
    sound.throwSfx();
    me.carrying = null;
    socket.emit('throwPlayer', { angle: me.angle });
    return;
  }

  if (me.holding) {
    sound.throwSfx();
    me.holding = null;
    me.holdingType = null;
    socket.emit('throwItem', { angle: me.angle });
    return;
  }

  let nearestPlayerId = null, nearestPlayerDist = Infinity;
  for (const p of state.match.players.values()) {
    if (p.id === me.id || p.status !== 'active') continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (d < nearestPlayerDist) { nearestPlayerDist = d; nearestPlayerId = p.id; }
  }
  if (nearestPlayerId !== null && nearestPlayerDist < 60) {
    socket.emit('grabPlayer');
    return;
  }

  let nearestId = null, nearestDist = Infinity;
  for (const item of state.match.items.values()) {
    if (item.heldBy) continue;
    const d = Math.hypot(item.x - me.x, item.y - me.y);
    if (d < nearestDist) { nearestDist = d; nearestId = item.id; }
  }
  if (nearestId !== null && nearestDist < 60) {
    socket.emit('pickupItem', { itemId: nearestId });
  }
}

// ---------------- Rendering ----------------
const camera = { x: ARENA.width / 2, y: ARENA.height / 2 };

function resizeCanvas() {
  const container = document.getElementById('game-container');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// An Ancient Pillar, seen from above: a weathered stone slab carved with a glowing rune.
function drawDesk(d) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath(); ctx.roundRect(d.x + 8, d.y + 12, d.w, d.h, 10); ctx.fill();

  ctx.fillStyle = '#6d6a60';
  ctx.strokeStyle = '#46433c';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.roundRect(d.x, d.y, d.w, d.h, 10); ctx.fill(); ctx.stroke();

  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(d.x + 6, d.y + (d.h / 3) * i);
    ctx.lineTo(d.x + d.w - 6, d.y + (d.h / 3) * i);
    ctx.stroke();
  }

  const cx = d.x + d.w / 2, cy = d.y + d.h / 2;

  ctx.save();
  ctx.shadowColor = '#d4a63d'; ctx.shadowBlur = 12;
  ctx.strokeStyle = 'rgba(212,166,61,0.85)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, 16, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(212,166,61,0.22)';
  ctx.beginPath(); ctx.arc(cx, cy, 16, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,224,150,0.9)'; ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 10); ctx.lineTo(cx + 8, cy + 5); ctx.lineTo(cx - 8, cy + 5); ctx.closePath();
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
    ctx.beginPath(); ctx.arc(cx + sx * (d.w / 2 - 12), cy + sy * (d.h / 2 - 12), 4, 0, Math.PI * 2); ctx.fill();
  });

  ctx.restore();
}

// A Crystal Ward: a translucent glowing shard that blocks the way until it's shattered.
function drawPartition(p) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(p.x + 4, p.y + 5, p.w, p.h);

  const grad = ctx.createLinearGradient(p.x, p.y, p.x + p.w, p.y);
  grad.addColorStop(0, 'rgba(95, 179, 163, 0.85)');
  grad.addColorStop(1, 'rgba(63, 155, 141, 0.85)');
  ctx.fillStyle = grad;
  ctx.strokeStyle = 'rgba(190, 240, 225, 0.9)';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#4fb39e'; ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.roundRect(p.x, p.y, p.w, p.h, 4); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(p.x, p.y + (p.h / 5) * i);
    ctx.lineTo(p.x + p.w, p.y + (p.h / 5) * i);
    ctx.stroke();
  }
  ctx.restore();
}

const COWORKER_DESK_INDICES = [0, 1, 4, 5];
// Pilgrim spirits keeping quiet vigil beside the pillars - decorative only, no collision.
const COWORKERS = COWORKER_DESK_INDICES.map((deskIdx, i) => ({
  desk: DESKS[deskIdx],
  seed: i * 1.7,
  skinTone: ['#e8b98a', '#c68863', '#8d5a3c', '#f0c9a0'][i % 4],
  shirt: ['#4a3f78', '#2f7a6b', '#7a4a3c', '#5a5468'][i % 4]
}));

function drawCoworker(npc) {
  const cx = npc.desk.x + npc.desk.w / 2;
  const cy = npc.desk.y + npc.desk.h + 16;
  const bob = Math.sin(performance.now() / 900 + npc.seed) * 1.5;
  ctx.save();
  ctx.translate(cx, cy + bob);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath(); ctx.ellipse(0, 10, 13, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = npc.shirt;
  ctx.beginPath(); ctx.ellipse(0, 4, 13, 9, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = npc.skinTone;
  ctx.beginPath(); ctx.arc(0, -6, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(40,30,25,0.6)';
  ctx.beginPath(); ctx.arc(0, -9, 8, Math.PI, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawPlant(pt) {
  ctx.save();
  ctx.translate(pt.x, pt.y);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath(); ctx.ellipse(0, 22, 12, 5, 0, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = '#a9673f'; ctx.strokeStyle = '#7a4a2c'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-10, 8); ctx.lineTo(10, 8); ctx.lineTo(7, 20); ctx.lineTo(-7, 20); ctx.closePath();
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#3f9142';
  [[-6, -4], [6, -4], [0, -12], [-9, 4], [9, 4]].forEach(([dx, dy]) => {
    ctx.beginPath(); ctx.arc(dx, dy, 8, 0, Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = '#2f7a34';
  ctx.beginPath(); ctx.arc(0, -4, 7, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// A Ley Portal - a glowing gateway between realms.
function drawStaircase(s) {
  ctx.save();
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
  ctx.translate(cx, cy);
  ctx.fillStyle = 'rgba(212,166,61,0.15)';
  ctx.strokeStyle = 'rgba(212,166,61,0.65)'; ctx.lineWidth = 2;
  ctx.shadowColor = '#d4a63d'; ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.roundRect(-s.w / 2, -s.h / 2, s.w, s.h, 8); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 2;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath(); ctx.moveTo(-s.w / 2 + 4, i * 7); ctx.lineTo(s.w / 2 - 4, i * 7); ctx.stroke();
  }

  ctx.fillStyle = '#ffdb85';
  ctx.font = 'bold 16px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(s.arrow, 0, -s.h / 2 - 14);
  ctx.font = 'bold 9px system-ui';
  ctx.fillText(s.to, 0, s.h / 2 + 12);
  ctx.restore();
}

// A Realm Ward - a ley-line barrier only crossable at a Ley Portal.
function drawFloorWall(w) {
  ctx.save();
  ctx.fillStyle = '#211d2c';
  ctx.fillRect(w.x, w.y, w.w, w.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 2;
  for (let x = w.x - w.h; x < w.x + w.w; x += 30) {
    ctx.beginPath(); ctx.moveTo(x, w.y); ctx.lineTo(x + w.h, w.y + w.h); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(212,166,61,0.45)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(w.x, w.y); ctx.lineTo(w.x + w.w, w.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w.x, w.y + w.h); ctx.lineTo(w.x + w.w, w.y + w.h); ctx.stroke();
  ctx.restore();
}

// Lightweight "destroyed" state: a flattened rubble sprite, not simulated debris pieces.
function drawRubble(ob) {
  ctx.save();
  const cx = ob.x + ob.w / 2, cy = ob.y + ob.h / 2;
  const color = (DESTRUCTIBLE_KINDS[ob.kind] || {}).color || '#6b5540';
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath(); ctx.ellipse(cx, cy + 4, ob.w / 2, ob.h / 3, 0, 0, Math.PI * 2); ctx.fill();

  const seed = (ob.x * 31 + ob.y * 17) % 100;
  ctx.fillStyle = color; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.5;
  for (let i = 0; i < 5; i++) {
    const r = ((seed + i * 37) % 100) / 100;
    const px = ob.x + r * ob.w;
    const py = ob.y + ((seed + i * 53) % 100) / 100 * ob.h;
    const rot = ((seed + i * 71) % 360) * Math.PI / 180;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rot);
    ctx.beginPath(); ctx.rect(-10 - r * 8, -4, 20 + r * 10, 8); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawZoneObstacle(o) {
  ctx.save();
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;

  if (o.kind === 'reception') {
    // The Convergence Altar: where every champion is marked at the start of the trial.
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.roundRect(o.x + 6, o.y + 10, o.w, o.h, 10); ctx.fill();
    ctx.fillStyle = '#5a4d2e'; ctx.strokeStyle = '#3a3020'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 10); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7a6a40';
    ctx.fillRect(o.x + 8, o.y + o.h - 14, o.w - 16, 8);
    ctx.save();
    ctx.shadowColor = '#d4a63d'; ctx.shadowBlur = 14;
    ctx.strokeStyle = 'rgba(212,166,61,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, o.y + 20, 15, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(212,166,61,0.25)';
    ctx.beginPath(); ctx.arc(cx, o.y + 20, 15, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#e8d9a8'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('CONVERGENCE', cx, o.y - 8);
  } else if (o.kind === 'bench') {
    // A Pilgrim's Bench, worn smooth by champions awaiting their trial.
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.roundRect(o.x + 4, o.y + 8, o.w, o.h, 10); ctx.fill();
    ctx.fillStyle = '#8f897a'; ctx.strokeStyle = '#5c584c'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 10); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#a49e8e';
    for (let i = 0; i < 3; i++) ctx.fillRect(o.x + 8 + i * (o.w - 16) / 3, o.y + 6, (o.w - 16) / 3 - 4, o.h - 12);
  } else if (o.kind === 'bistro') {
    // An Offering Fountain, its still water reflecting the garden light.
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.arc(cx, cy + 6, o.w / 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6b5d43'; ctx.strokeStyle = '#443a29'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(cx, cy, o.w / 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.save();
    ctx.shadowColor = '#7bc4b0'; ctx.shadowBlur = 10;
    ctx.fillStyle = 'rgba(123,196,176,0.55)';
    ctx.beginPath(); ctx.arc(cx, cy, o.w / 2 - 8, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.arc(cx - 6, cy - 6, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#443a29';
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([dx, dy]) => {
      ctx.beginPath(); ctx.arc(cx + dx * (o.w / 2 + 10), cy + dy * (o.w / 2 + 10), 8, 0, Math.PI * 2); ctx.fill();
    });
  } else if (o.kind === 'tree') {
    // An Ancient Tree of the Elderwood - permanent cover, older than the Convergence itself.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.ellipse(cx, cy + 30, 34, 12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#5c4128';
    ctx.fillRect(cx - 6, cy - 4, 12, 34);
    ctx.fillStyle = '#2a6b52';
    [[-16, -10], [16, -10], [0, -26], [-10, 6], [10, 6]].forEach(([dx, dy]) => {
      ctx.beginPath(); ctx.arc(cx + dx, cy + dy, 24, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = '#357d61';
    ctx.beginPath(); ctx.arc(cx, cy - 8, 26, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// The Relic of Ascension: an ancient circlet, its central gem lit from within.
function drawCrownIcon(ctx) {
  ctx.fillStyle = CROWN.color; ctx.strokeStyle = '#b8860b'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-12, 6); ctx.lineTo(-12, -4); ctx.lineTo(-6, 2); ctx.lineTo(0, -8);
  ctx.lineTo(6, 2); ctx.lineTo(12, -4); ctx.lineTo(12, 6); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.save();
  ctx.shadowColor = '#fff5cc'; ctx.shadowBlur = 8;
  ctx.fillStyle = '#fff5cc';
  ctx.beginPath(); ctx.arc(0, -3, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(255,245,204,0.7)';
  [-9, 9].forEach(dx => { ctx.beginPath(); ctx.arc(dx, -2, 1.6, 0, Math.PI * 2); ctx.fill(); });
}

function drawGroundCrown(crown) {
  ctx.save();
  const floatY = Math.sin(performance.now() / 220) * 5;
  const pulse = 0.5 + Math.sin(performance.now() / 260) * 0.15;
  ctx.translate(crown.x, crown.y + floatY);
  ctx.shadowColor = CROWN.color; ctx.shadowBlur = 24;
  ctx.globalAlpha = pulse; ctx.strokeStyle = CROWN.color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  drawCrownIcon(ctx);
  ctx.restore();
}

function drawItemIcon(type, ctx) {
  const spec = ITEM_TYPES[type];
  if (type === 'stapler') {
    // Throwing Shard: a sliver of crystal, light and fast.
    ctx.save();
    ctx.shadowColor = spec.color; ctx.shadowBlur = 8;
    ctx.fillStyle = spec.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -15); ctx.lineTo(6, -2); ctx.lineTo(0, 15); ctx.lineTo(-6, -2); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(0, 15); ctx.stroke();
    ctx.restore();
  } else if (type === 'keyboard') {
    // Rune Tablet: carved stone etched with a glowing sigil.
    ctx.fillStyle = spec.color; ctx.strokeStyle = '#5c584c'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(-16, -9, 32, 18, 3); ctx.fill(); ctx.stroke();
    ctx.save();
    ctx.shadowColor = '#d4a63d'; ctx.shadowBlur = 6;
    ctx.fillStyle = 'rgba(212,166,61,0.9)';
    for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) ctx.fillRect(-13 + c * 6, -5 + r * 7, 3, 3);
    ctx.restore();
  } else if (type === 'chair') {
    // Ironwood Bough: a heavy branch torn from an ancient tree.
    ctx.save();
    ctx.rotate(0.5);
    ctx.fillStyle = spec.color; ctx.strokeStyle = '#3a2d1e'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(-18, -6, 36, 12, 6); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1;
    [-9, 0, 9].forEach(x => { ctx.beginPath(); ctx.arc(x, 0, 2.5, 0, Math.PI * 2); ctx.stroke(); });
    ctx.restore();
  } else if (type === 'table') {
    // Sundering Boulder: a jagged chunk of stone, rare and devastating.
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath(); ctx.ellipse(0, 14, 20, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = spec.color; ctx.strokeStyle = '#4a4740'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-18, -6); ctx.lineTo(-6, -16); ctx.lineTo(10, -14); ctx.lineTo(19, 2);
    ctx.lineTo(12, 14); ctx.lineTo(-8, 16); ctx.lineTo(-19, 6); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(-6, -16); ctx.lineTo(-2, 6); ctx.lineTo(-8, 16); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(10, -14); ctx.lineTo(-2, 6); ctx.lineTo(12, 14); ctx.stroke();
  }
}

function drawGroundItem(item) {
  ctx.save();
  const floatY = Math.sin(performance.now() / 300 + item.x) * 3;
  ctx.translate(item.x, item.y + floatY);
  drawItemIcon(item.type, ctx);
  ctx.restore();
}

const POWERUP_ICONS = { coffee: '☕', tea: '🍵', lemonade: '🍋', pizza: '🍕', burger: '🍔' };
const POWERUP_NAMES = {
  coffee: 'Blessing of Swiftness', tea: 'Spirit Herb', lemonade: 'Sunfruit Nectar',
  pizza: 'Blessing of Power', burger: 'Ancient Feast'
};

function drawPowerupIcon(type, ctx) {
  const spec = POWERUPS[type];
  if (type === 'coffee') {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#3d2c20'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(-9, -6, 18, 14, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = spec.color;
    ctx.beginPath(); ctx.roundRect(-7, -4, 14, 6, 2); ctx.fill();
    ctx.strokeStyle = '#3d2c20';
    ctx.beginPath(); ctx.arc(10, 0, 4, -Math.PI / 2, Math.PI / 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(-3, -10); ctx.quadraticCurveTo(-6, -14, -3, -18); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(3, -10); ctx.quadraticCurveTo(0, -14, 3, -18); ctx.stroke();
  } else if (type === 'tea') {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#2d5a3d'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(-9, -6, 18, 14, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = spec.color;
    ctx.beginPath(); ctx.roundRect(-7, -4, 14, 6, 2); ctx.fill();
    ctx.strokeStyle = '#2d5a3d';
    ctx.beginPath(); ctx.arc(10, 0, 4, -Math.PI / 2, Math.PI / 2); ctx.stroke();
    ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(2, -6); ctx.lineTo(6, -14); ctx.stroke();
    ctx.fillStyle = '#f4d03f'; ctx.fillRect(4, -17, 5, 4);
  } else if (type === 'lemonade') {
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-7, -10); ctx.lineTo(7, -10); ctx.lineTo(5, 10); ctx.lineTo(-5, 10); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = spec.color;
    ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(6, 0); ctx.lineTo(5, 10); ctx.lineTo(-5, 10); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(2, -10); ctx.lineTo(6, -18); ctx.stroke();
    ctx.fillStyle = '#f6e58d';
    ctx.beginPath(); ctx.arc(0, -12, 3, 0, Math.PI * 2); ctx.fill();
  } else if (type === 'pizza') {
    // Blessing of Power: a smoldering ember-fruit, warm to the touch.
    ctx.save();
    ctx.shadowColor = spec.color; ctx.shadowBlur = 10;
    ctx.fillStyle = spec.color; ctx.strokeStyle = '#7a2f1a'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,220,180,0.7)'; ctx.lineWidth = 1.2;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * 4, Math.sin(a) * 4); ctx.lineTo(Math.cos(a) * 10, Math.sin(a) * 10); ctx.stroke();
    }
  } else if (type === 'burger') {
    // Ancient Feast: a stacked bundle of enchanted bread, hearty and warm.
    ctx.fillStyle = '#c68958'; ctx.strokeStyle = '#7a5230'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(0, -5, 10, 6, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = spec.color; ctx.strokeStyle = '#7a5230';
    ctx.beginPath(); ctx.ellipse(0, 5, 11, 6.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, -5, 5, Math.PI, Math.PI * 2); ctx.stroke();
  }
}

function drawGroundPowerup(pu) {
  ctx.save();
  const floatY = Math.sin(performance.now() / 260 + pu.x * 1.3) * 4;
  ctx.translate(pu.x, pu.y + floatY);
  const glowColor = POWERUPS[pu.type].color;
  ctx.shadowColor = glowColor; ctx.shadowBlur = 14;
  ctx.globalAlpha = 0.5; ctx.strokeStyle = glowColor; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  drawPowerupIcon(pu.type, ctx);
  ctx.restore();
}

function drawProjectile(proj) {
  ctx.save();
  ctx.translate(proj.renderX, proj.renderY);
  ctx.rotate(performance.now() / 60);
  drawItemIcon(proj.itemType, ctx);
  ctx.restore();
}

function shadeColor(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amount));
  const b = Math.min(255, Math.max(0, (num & 0xff) + amount));
  return `rgb(${r},${g},${b})`;
}

function drawAccessory(accessory) {
  ctx.fillStyle = 'rgba(20,20,25,0.9)';
  ctx.strokeStyle = 'rgba(20,20,25,0.9)';
  switch (accessory) {
    case 'tie':
      ctx.beginPath(); ctx.moveTo(-4, 6); ctx.lineTo(4, 6); ctx.lineTo(0, 20); ctx.closePath(); ctx.fill();
      break;
    case 'glasses':
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(-7, -3, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(7, -3, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-1, -3); ctx.lineTo(1, -3); ctx.stroke();
      break;
    case 'headphones':
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, -3, 18, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      ctx.beginPath(); ctx.arc(-17, -3, 4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(17, -3, 4, 0, Math.PI * 2); ctx.fill();
      break;
    case 'cap':
      ctx.beginPath(); ctx.arc(0, -12, 15, Math.PI, 0); ctx.fill();
      ctx.fillRect(8, -12, 16, 5);
      break;
    case 'bow':
      ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(-9, 3); ctx.lineTo(-9, 13); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(9, 3); ctx.lineTo(9, 13); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(0, 8, 3, 0, Math.PI * 2); ctx.fill();
      break;
    case 'scarf':
      ctx.fillRect(-16, 5, 32, 7);
      break;
  }
}

function drawPlayer(p) {
  const avatar = AVATARS[p.avatarId] || AVATARS[0];
  const eliminated = p.status === 'eliminated';
  const down = p.status === 'down';
  const grabbed = p.status === 'grabbed';

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath(); ctx.arc(p.renderX, p.renderY + 12, PLAYER.radius, 0, Math.PI * 2); ctx.fill();

  ctx.translate(p.renderX, p.renderY);
  ctx.globalAlpha = eliminated ? 0.25 : (down ? 0.55 : (grabbed ? 0.85 : 1));

  if (Date.now() < p.invulnUntil) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,242,254,0.6)';
    ctx.shadowColor = '#00f2fe'; ctx.shadowBlur = 12; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, PLAYER.radius * 1.4, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.rotate(p.renderAngle + (grabbed ? Math.PI / 2 : 0));

  const bodyColor = avatar.color;
  const limbShade = shadeColor(bodyColor, -35);
  const punching = p.attackAnim && p.attackAnim.type === 'punch' && p.attackAnim.timer > 0;
  const kicking = p.attackAnim && p.attackAnim.type === 'kick' && p.attackAnim.timer > 0;
  const animProgress = p.attackAnim ? 1 - p.attackAnim.timer / (punching ? 0.22 : 0.28) : 0;
  const armPunch = punching ? Math.sin(animProgress * Math.PI) * 16 : 0;
  const legKick = kicking ? Math.sin(animProgress * Math.PI) * 14 : 0;
  const walkSwing = (!punching && !kicking && p.moving) ? Math.sin(performance.now() / 110 + (p.id ? p.id.length : 0)) * 3 : 0;

  ctx.fillStyle = limbShade;
  ctx.beginPath(); ctx.ellipse(-11, -8 - walkSwing, 8, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-11 + legKick, 8 + walkSwing, 8, 6, 0, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = bodyColor; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.ellipse(2 + armPunch, -17, 7, 5.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(2 + armPunch, 17, 7, 5.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  ctx.fillStyle = bodyColor; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(-2, 0, 13, 15, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  if (p.hitFlashTimer > 0) {
    ctx.globalAlpha = (p.hitFlashTimer / 0.2) * 0.6;
    ctx.fillStyle = '#ff0844';
    ctx.beginPath(); ctx.ellipse(-2, 0, 13, 15, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = eliminated ? 0.25 : (down ? 0.55 : (grabbed ? 0.85 : 1));
  }

  const headX = 15;
  ctx.fillStyle = bodyColor; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(headX, 0, 10.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(headX + 4, -4, 2, 0, Math.PI * 2); ctx.arc(headX + 4, 4, 2, 0, Math.PI * 2); ctx.fill();

  ctx.save();
  ctx.translate(headX, 0);
  ctx.scale(0.75, 0.75);
  drawAccessory(avatar.accessory);
  ctx.restore();

  const isKing = state.match.kingId === p.id;
  if (isKing) {
    ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('👑', headX, -17);
  }

  if (p.attackAnim && p.attackAnim.timer > 0) {
    const t = p.attackAnim.timer;
    ctx.globalAlpha = Math.min(1, t * 4);
    ctx.fillStyle = p.attackAnim.type === 'punch' ? 'rgba(0,242,254,0.7)' : 'rgba(255,8,68,0.7)';
    const dist = headX + (p.attackAnim.type === 'punch' ? COMBAT.punch.range * 0.5 : COMBAT.kick.range * 0.5);
    ctx.beginPath(); ctx.arc(dist, 0, p.attackAnim.type === 'punch' ? 10 : 14, 0, Math.PI * 2); ctx.fill();
  }

  if (p.holding && p.holdingType) {
    ctx.save();
    ctx.translate(headX + 16, 0);
    ctx.scale(0.8, 0.8);
    drawItemIcon(p.holdingType, ctx);
    ctx.restore();
  }

  ctx.restore(); // rotation
  ctx.globalAlpha = 1;

  if (eliminated) {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('OUT', 0, -PLAYER.radius - 16);
  } else if (grabbed) {
    ctx.fillStyle = '#ffc048';
    ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('HELD', 0, -PLAYER.radius - 16);
  } else {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
    let nameY = -PLAYER.radius - 22;
    const hasSpeedBuff = Date.now() < p.speedBuffUntil;
    const hasDamageBuff = Date.now() < p.damageBuffUntil;
    if (hasSpeedBuff || hasDamageBuff) {
      ctx.font = '12px system-ui';
      const buffText = `${hasSpeedBuff ? '⚡' : ''}${hasDamageBuff ? '🔥' : ''}`;
      ctx.fillText(buffText, 0, nameY - 12);
    }
    ctx.font = 'bold 11px system-ui';
    ctx.fillText(p.name, 0, nameY);

    const barW = 50;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(-barW / 2, -PLAYER.radius - 16, barW, 5);
    const pct = Math.max(0, p.hp) / MATCH.startingHp;
    ctx.fillStyle = pct > 0.5 ? '#05c46b' : pct > 0.25 ? '#ffc048' : '#ff0844';
    ctx.fillRect(-barW / 2, -PLAYER.radius - 16, barW * pct, 5);

    let hearts = '';
    for (let i = 0; i < MATCH.startingLives; i++) hearts += i < p.lives ? '❤' : '🖤';
    ctx.font = '9px system-ui';
    ctx.fillStyle = '#fff';
    ctx.fillText(hearts, 0, -PLAYER.radius - 24 - 10);
  }

  ctx.restore();
}

function render() {
  const w = canvas.width, h = canvas.height;
  const me = state.match.players.get(state.selfId);
  if (me) {
    camera.x += (me.renderX - camera.x) * 0.12;
    camera.y += (me.renderY - camera.y) * 0.12;
  }
  const tx = w / 2 - camera.x, ty = h / 2 - camera.y;

  ctx.clearRect(0, 0, w, h);
  ctx.save();

  let sx = 0, sy = 0;
  if (state.shakeAmount > 0.2) {
    sx = (Math.random() - 0.5) * state.shakeAmount;
    sy = (Math.random() - 0.5) * state.shakeAmount;
    state.shakeAmount *= 0.85;
  } else state.shakeAmount = 0;

  ctx.translate(tx + sx, ty + sy);

  ctx.fillStyle = '#151221';
  ctx.fillRect(0, 0, ARENA.width, ARENA.height);
  ctx.strokeStyle = '#211f31'; ctx.lineWidth = 2;
  const grid = 80;
  for (let x = 0; x <= ARENA.width; x += grid) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ARENA.height); ctx.stroke(); }
  for (let y = 0; y <= ARENA.height; y += grid) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ARENA.width, y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(212, 166, 61, 0.35)'; ctx.lineWidth = 10;
  ctx.strokeRect(0, 0, ARENA.width, ARENA.height);

  Object.values(ZONES).forEach(z => {
    if (!z.tint) return;
    ctx.fillStyle = z.tint;
    ctx.fillRect(0, z.yMin, ARENA.width, z.yMax - z.yMin);
  });
  Object.values(ZONES).forEach(z => {
    if (!z.label) return;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.font = '900 34px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(z.label, ARENA.width / 2, z.yMin + 60);
  });
  FLOOR_WALLS.forEach(drawFloorWall);
  STAIRCASES.forEach(drawStaircase);

  PLANTS.forEach(drawPlant);
  ZONE_OBSTACLES.forEach(o => state.match.destroyedObstacles.has(o.id) ? drawRubble(o) : drawZoneObstacle(o));
  DESKS.forEach(d => state.match.destroyedObstacles.has(d.id) ? drawRubble(d) : drawDesk(d));
  PARTITIONS.forEach(p => state.match.destroyedObstacles.has(p.id) ? drawRubble(p) : drawPartition(p));
  COWORKERS.forEach(drawCoworker);
  if (state.match.crown) drawGroundCrown(state.match.crown);
  state.match.powerups.forEach(drawGroundPowerup);
  state.match.items.forEach(item => { if (!item.heldBy) drawGroundItem(item); });
  state.match.projectiles.forEach(drawProjectile);
  particles.draw(ctx);
  state.match.players.forEach(p => { if (p.status !== 'eliminated' || true) drawPlayer(p); });

  ctx.restore();

  drawPlayerArrows(w, h);
  drawBossOverlay(w);
  drawRealmEventOverlay(w, h);
}

// Fixed-size seed arrays so rain/wind streaks don't allocate every frame - cheap, capped particle
// counts per the "no visual clutter, stay performance-friendly" design goal.
const RAIN_STREAKS = Array.from({ length: 30 }, () => ({ x: Math.random(), y: Math.random(), speed: 0.6 + Math.random() * 0.4 }));
const WIND_STREAKS = Array.from({ length: 18 }, () => ({ x: Math.random(), y: Math.random(), speed: 0.5 + Math.random() * 0.5 }));
const ECLIPSE_WISPS = Array.from({ length: 10 }, () => ({ x: Math.random(), y: Math.random(), seed: Math.random() * 10 }));

function drawRealmEventOverlay(w, h) {
  const disaster = state.match.activeDisaster;
  if (!disaster) return;
  const t = performance.now() / 1000;

  if (disaster.id === 'volcanicEruption') {
    const pulse = 0.12 + Math.sin(t * 3) * 0.05;
    ctx.fillStyle = `rgba(217, 105, 74, ${pulse})`;
    ctx.fillRect(0, 0, w, h);
  } else if (disaster.id === 'arcaneEclipse') {
    ctx.fillStyle = 'rgba(8, 6, 16, 0.55)';
    ctx.fillRect(0, 0, w, h);
    ECLIPSE_WISPS.forEach(wisp => {
      const flicker = 0.15 + Math.abs(Math.sin(t * 0.8 + wisp.seed)) * 0.25;
      ctx.save();
      ctx.shadowColor = '#d4a63d'; ctx.shadowBlur = 8;
      ctx.fillStyle = `rgba(212, 166, 61, ${flicker})`;
      ctx.beginPath(); ctx.arc(wisp.x * w, wisp.y * h, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
  } else if (disaster.id === 'spiritWinds') {
    const angle = disaster.meta.windAngle || 0;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    ctx.strokeStyle = 'rgba(230, 240, 245, 0.28)'; ctx.lineWidth = 2;
    WIND_STREAKS.forEach(s => {
      const prog = (s.x + t * s.speed * 0.4) % 1.2 - 0.1;
      const sx = prog * w, sy = s.y * h;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - dx * 26, sy - dy * 26); ctx.stroke();
    });
  } else if (disaster.id === 'sacredRain') {
    ctx.fillStyle = 'rgba(79, 179, 232, 0.06)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(200, 230, 255, 0.35)'; ctx.lineWidth = 1.5;
    RAIN_STREAKS.forEach(s => {
      const prog = (s.y + t * s.speed * 0.9) % 1.1 - 0.05;
      const sx = s.x * w, sy = prog * h;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - 4, sy + 16); ctx.stroke();
    });
  }
}

function drawPlayerArrows(w, h) {
  const me = state.match.players.get(state.selfId);
  if (!me) return;

  const margin = 46;
  const topMargin = margin + 60; // stay clear of the HUD bar
  const halfW = w / 2 - margin;
  const halfH = h / 2 - topMargin;

  for (const p of state.match.players.values()) {
    if (p.id === me.id || p.status === 'eliminated') continue;

    const screenX = p.renderX - camera.x + w / 2;
    const screenY = p.renderY - camera.y + h / 2;
    const onScreen = screenX > margin && screenX < w - margin && screenY > topMargin && screenY < h - margin;
    if (onScreen) continue;

    const dx = screenX - w / 2;
    const dy = screenY - h / 2;
    const scale = Math.min(
      dx !== 0 ? halfW / Math.abs(dx) : Infinity,
      dy !== 0 ? halfH / Math.abs(dy) : Infinity
    );
    const ax = w / 2 + dx * scale;
    const ay = h / 2 + dy * scale;
    const angle = Math.atan2(dy, dx);
    const avatar = AVATARS[p.avatarId] || AVATARS[0];

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(angle);
    ctx.fillStyle = avatar.color;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(15, 0); ctx.lineTo(-9, -9); ctx.lineTo(-9, 9); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.name, ax - Math.cos(angle) * 20, ay - Math.sin(angle) * 20);
    ctx.restore();
  }
}

function drawBossOverlay(canvasWidth) {
  if (!state.match.bossEvent) return;
  if (Date.now() > state.match.bossEvent.endsAt) { state.match.bossEvent = null; return; }

  const cx = canvasWidth / 2, cy = 140;
  const shake = state.match.bossEvent.phase === 'impact' ? (Math.random() - 0.5) * 14 : 0;
  const bob = state.match.bossEvent.phase === 'warning' ? Math.sin(performance.now() / 220) * 8 : 0;

  ctx.save();
  ctx.translate(cx + shake, cy + bob);

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(0, 115, 95, 20, 0, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = '#3d3a34';
  ctx.beginPath(); ctx.ellipse(-32, 92, 19, 28, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(32, 92, 19, 28, 0, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = '#4a4740'; ctx.strokeStyle = '#2b2924'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.ellipse(0, 20, 98, 88, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#4a4740';
  ctx.beginPath(); ctx.ellipse(-98, 10, 25, 42, -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(98, 10, 25, 42, 0.3, 0, Math.PI * 2); ctx.fill();

  // A carved rune of judgment glowing across the Guardian's chest, where a tie once was.
  ctx.save();
  ctx.shadowColor = '#d4a63d'; ctx.shadowBlur = 12;
  ctx.strokeStyle = 'rgba(212,166,61,0.9)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-22, -50); ctx.lineTo(22, -50); ctx.lineTo(11, 62); ctx.lineTo(-11, 62); ctx.closePath(); ctx.stroke();
  ctx.fillStyle = 'rgba(212,166,61,0.18)';
  ctx.beginPath(); ctx.moveTo(-22, -50); ctx.lineTo(22, -50); ctx.lineTo(11, 62); ctx.lineTo(-11, 62); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(212,166,61,0.7)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-9, -45); ctx.lineTo(9, -45); ctx.lineTo(4, 56); ctx.lineTo(-4, 56); ctx.closePath(); ctx.stroke();

  ctx.fillStyle = '#6d6a60'; ctx.strokeStyle = '#46433c'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, -88, 44, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-25, -102); ctx.lineTo(-6, -95); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(25, -102); ctx.lineTo(6, -95); ctx.stroke();

  ctx.save();
  ctx.shadowColor = '#d4a63d'; ctx.shadowBlur = 10;
  ctx.fillStyle = '#ffdb85';
  ctx.beginPath(); ctx.arc(-13, -88, 4.5, 0, Math.PI * 2); ctx.arc(13, -88, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(0, -58, 15, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();

  ctx.restore();

  ctx.fillStyle = state.match.bossEvent.phase === 'warning' ? '#d4a63d' : '#d9694a';
  ctx.font = '900 16px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(
    state.match.bossEvent.phase === 'warning' ? '⚠️ FIND SHELTER! ⚠️' : '💥 GUARDIAN\'S JUDGMENT! 💥',
    cx, cy + 145
  );
}

// ---------------- Game loop ----------------
let lastTime = 0;
let leaderboardTimer = 0;

function loop(ts) {
  requestAnimationFrame(loop);
  if (!lastTime) lastTime = ts;
  const dt = Math.min(0.1, (ts - lastTime) / 1000);
  lastTime = ts;

  if (state.screen === 'arena') {
    updateArena(dt);
    render();
    leaderboardTimer -= dt;
    if (leaderboardTimer <= 0) { leaderboardTimer = 0.15; renderLeaderboard(); }
    updateHudTimer();
    updateCtoBanner();
    updateRealmEventBanner();
  }
}
requestAnimationFrame(loop);

let moveSendTimer = 0;

function updateArena(dt) {
  particles.update(dt);

  for (const p of state.match.players.values()) {
    if (p.attackAnim) { p.attackAnim.timer -= dt; if (p.attackAnim.timer <= 0) p.attackAnim = null; }
    if (p.hitFlashTimer > 0) p.hitFlashTimer -= dt;
    if (p.stunTimer > 0) p.stunTimer -= dt;

    if (p.status === 'grabbed') {
      const carrier = state.match.players.get(p.carriedBy);
      if (carrier) {
        const offset = PLAYER.radius + 14;
        p.x = carrier.x + Math.cos(carrier.angle) * offset;
        p.y = carrier.y + Math.sin(carrier.angle) * offset;
        p.renderX = carrier.renderX + Math.cos(carrier.renderAngle) * offset;
        p.renderY = carrier.renderY + Math.sin(carrier.renderAngle) * offset;
        p.renderAngle = carrier.renderAngle;
      }
      continue;
    }

    if (p.status === 'thrown') {
      const tp = state.match.thrownPlayers.get(p.id);
      if (tp) {
        tp.renderX += (tp.x - tp.renderX) * 0.4;
        tp.renderY += (tp.y - tp.renderY) * 0.4;
        p.x = tp.x; p.y = tp.y;
        p.renderX = tp.renderX; p.renderY = tp.renderY;
        p.renderAngle += dt * 14;
      }
      continue;
    }

    if (p.id === state.selfId) {
      if (p.status === 'active' && p.stunTimer <= 0) {
        const mv = getMovementVector();
        const disaster = state.match.activeDisaster;
        const disasterSpeedMult = disaster && disaster.id === 'volcanicEruption' ? VOLCANIC_ERUPTION.speedMultiplier : 1;
        const friction = disaster && disaster.id === 'sacredRain' ? SACRED_RAIN.frictionMultiplier : 0.85;
        const speed = PLAYER.speed * disasterSpeedMult * (Date.now() < p.speedBuffUntil ? p.speedBuffMultiplier : 1);
        p.vx += mv.x * speed * 10 * dt;
        p.vy += mv.y * speed * 10 * dt;
        p.vx *= friction; p.vy *= friction;
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (disaster && disaster.id === 'spiritWinds') {
          p.x += Math.cos(disaster.meta.windAngle) * SPIRIT_WINDS.forceMagnitude * dt;
          p.y += Math.sin(disaster.meta.windAngle) * SPIRIT_WINDS.forceMagnitude * dt;
        }

        p.x = clamp(p.x, PLAYER.radius, ARENA.width - PLAYER.radius);
        p.y = clamp(p.y, PLAYER.radius, ARENA.height - PLAYER.radius);
        for (const d of OBSTACLES) { if (!state.match.destroyedObstacles.has(d.id)) resolveDeskCollision(p, d); }

        if (performance.now() - state.lastTeleportAt > STAIRCASE_TELEPORT_COOLDOWN_SEC * 1000) {
          for (const s of STAIRCASES) {
            if (p.x > s.x && p.x < s.x + s.w && p.y > s.y && p.y < s.y + s.h) {
              p.x = s.targetX; p.y = s.targetY;
              p.vx = 0; p.vy = 0;
              camera.x = p.x; camera.y = p.y;
              state.lastTeleportAt = performance.now();
              sound.throwSfx();
              particles.spawn(p.x, p.y, 14, 'rgba(0,242,254,0.6)');
              break;
            }
          }
        }

        if (mv.x !== 0 || mv.y !== 0) p.angle = Math.atan2(mv.y, mv.x);
        p.moving = mv.x !== 0 || mv.y !== 0;
      }
      p.renderX = p.x; p.renderY = p.y; p.renderAngle = p.angle;
    } else {
      p.renderX += (p.x - p.renderX) * 0.25;
      p.renderY += (p.y - p.renderY) * 0.25;
      p.renderAngle += normalizeAngleDiff(p.angle - p.renderAngle) * 0.25;
    }
  }

  for (const proj of state.match.projectiles.values()) {
    proj.renderX += (proj.x - proj.renderX) * 0.4;
    proj.renderY += (proj.y - proj.renderY) * 0.4;
  }

  moveSendTimer -= dt;
  if (moveSendTimer <= 0) {
    moveSendTimer = 0.066;
    const me = state.match.players.get(state.selfId);
    if (me && me.status === 'active') {
      socket.emit('move', { x: me.x, y: me.y, angle: me.angle, moving: me.moving });
    }
  }
}

function resolveDeskCollision(p, d) {
  const cx = clamp(p.x, d.x, d.x + d.w);
  const cy = clamp(p.y, d.y, d.y + d.h);
  const dx = p.x - cx, dy = p.y - cy;
  const dist = Math.hypot(dx, dy);
  if (dist < PLAYER.radius && dist > 0) {
    const push = PLAYER.radius - dist;
    p.x += (dx / dist) * push;
    p.y += (dy / dist) * push;
    p.vx *= 0.3; p.vy *= 0.3;
  }
}

function updateHudTimer() {
  const remaining = Math.max(0, state.match.endAt - Date.now()) / 1000;
  const m = Math.floor(remaining / 60);
  const s = Math.floor(remaining % 60);
  const timerEl = document.getElementById('hud-timer');
  timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  timerEl.classList.toggle('critical', remaining <= 30);

  const me = state.match.players.get(state.selfId);
  if (me) {
    document.getElementById('hud-hp-fill').style.width = `${Math.max(0, me.hp)}%`;
    let hearts = '';
    for (let i = 0; i < MATCH.startingLives; i++) hearts += i < me.lives ? '❤' : '🖤';
    document.getElementById('hud-lives').textContent = me.status === 'eliminated' ? 'OUT' : hearts;
  }

  [['btn-punch', state.lastPunchAt, COMBAT.punch.cooldownSec], ['btn-kick', state.lastKickAt, COMBAT.kick.cooldownSec]].forEach(([id, last, cd]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('on-cooldown', performance.now() - last < cd * 1000);
  });
}

function updateCtoBanner() {
  const el = document.getElementById('cto-task-banner');
  if (!state.match.ctoTask) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const remaining = Math.max(0, state.match.ctoTask.deadlineAt - Date.now()) / 1000;
  document.getElementById('cto-task-label').textContent = state.match.ctoTask.label;
  document.getElementById('cto-task-timer').textContent = `${remaining.toFixed(0)}s`;
}

const DISASTER_LABELS = {
  volcanicEruption: 'Volcanic Eruption', arcaneEclipse: 'Arcane Eclipse',
  spiritWinds: 'Spirit Winds', sacredRain: 'Sacred Rain', crystalResonance: 'Crystal Resonance'
};

function updateRealmEventBanner() {
  const el = document.getElementById('realm-event-banner');
  const disaster = state.match.activeDisaster;
  if (!disaster) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const remaining = Math.max(0, disaster.endsAt - Date.now()) / 1000;
  document.getElementById('realm-event-label').textContent = DISASTER_LABELS[disaster.id] || disaster.id;
  document.getElementById('realm-event-timer').textContent = `${remaining.toFixed(0)}s`;
}

function renderLeaderboard() {
  const rows = [...state.match.players.values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const king = state.match.kingId ? state.match.players.get(state.match.kingId) : null;
  const kingBanner = king ? `<div class="leaderboard-king">👑 Leading: ${escapeHtml(king.name)}</div>` : '';
  leaderboardEl.innerHTML = `<span class="hud-label">HALL OF HONOR</span>` + kingBanner + rows.map(p => {
    const avatar = AVATARS[p.avatarId] || AVATARS[0];
    const status = p.status === 'eliminated' ? ' (out)' : '';
    const crownPrefix = p.id === state.match.kingId ? '👑 ' : '';
    return `<div class="leaderboard-row">
      <span class="player-dot" style="background:${avatar.color}"></span>
      <span class="leaderboard-name">${crownPrefix}${escapeHtml(p.name)}${status}</span>
      <span class="leaderboard-score">${p.score || 0}</span>
      <span>${p.lives}❤</span>
    </div>`;
  }).join('');
}

function pushKillFeed(text) {
  const el = document.createElement('div');
  el.className = 'kill-feed-item';
  el.textContent = text;
  killFeedEl.appendChild(el);
  while (killFeedEl.children.length > 5) killFeedEl.removeChild(killFeedEl.firstChild);
  setTimeout(() => el.remove(), 3200);
}

function triggerDamageFlash() {
  const vig = document.getElementById('damage-vignette');
  vig.classList.add('damaged-vignette');
  setTimeout(() => vig.classList.remove('damaged-vignette'), 180);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- Applying combat results ----------------
function applyHitToPlayer(target, hit) {
  target.x = hit.x; target.y = hit.y;
  if (target.id === state.selfId) { target.renderX = hit.x; target.renderY = hit.y; target.vx = 0; target.vy = 0; }
  target.hp = hit.newHp;
  target.lives = hit.newLives;
  target.status = hit.eliminated ? 'eliminated' : (hit.koed ? 'down' : 'active');
  target.hitFlashTimer = 0.2;
  target.stunTimer = hit.koed ? 0.6 : 0.22;
  particles.spawn(target.renderX, target.renderY, hit.koed ? 18 : 8, '#ff0844');

  if (target.id === state.selfId) {
    triggerDamageFlash();
    state.shakeAmount = hit.koed ? 22 : 10;
  }

  const attackerName = (state.match.players.get(hit.attackerId) || {}).name || 'Someone';
  if (hit.eliminated) {
    pushKillFeed(`💥 ${attackerName} defeated ${target.name}!`);
    sound.ko();
  } else if (hit.koed) {
    pushKillFeed(`🤕 ${attackerName} struck down ${target.name}!`);
    sound.ko();
  } else {
    sound.hit();
  }
}

// ---------------- Socket events ----------------
socket.on('roomJoined', ({ code, selfId }) => {
  state.roomCode = code;
  state.selfId = selfId;
  document.getElementById('lobby-code').textContent = code;
});

socket.on('roomError', ({ message }) => {
  if (state.screen === 'landing') document.getElementById('landing-error').textContent = message;
  else document.getElementById('lobby-error').textContent = message;
});

socket.on('lobbyState', data => {
  state.lobbyPlayers = data.players;
  state.hostId = data.hostId;
  if (data.state === 'lobby' && state.screen !== 'lobby') switchScreen('lobby');
  if (state.screen === 'lobby') renderLobby();
});

function renderLobby() {
  const listEl = document.getElementById('lobby-players');
  listEl.innerHTML = state.lobbyPlayers.map(p => {
    const avatar = AVATARS[p.avatarId] || AVATARS[0];
    return `<div class="lobby-player-row">
      <span class="player-dot" style="background:${avatar.color}"></span>
      <span>${escapeHtml(p.name)}</span>
      ${p.isHost ? '<span class="host-badge">HOST</span>' : ''}
    </div>`;
  }).join('');
  document.getElementById('lobby-count').textContent = `${state.lobbyPlayers.length} / ${ROOM.maxPlayers} PLAYERS`;

  const isHost = state.hostId === state.selfId;
  const startBtn = document.getElementById('start-match-btn');
  startBtn.style.display = isHost ? 'block' : 'none';
  startBtn.disabled = state.lobbyPlayers.length < ROOM.minToStart;
  document.getElementById('lobby-hint').style.display = isHost ? 'none' : 'block';
}

socket.on('matchCountdown', ({ seconds }) => {
  switchScreen('countdown');
  let remaining = seconds;
  const el = document.getElementById('countdown-number');
  const pop = () => {
    el.textContent = remaining;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  };
  pop();
  sound.click();
  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0) { clearInterval(interval); return; }
    pop();
    sound.click();
  }, 1000);
});

socket.on('matchStarted', data => {
  state.match.endAt = data.endAt;
  state.match.players.clear();
  state.match.items.clear();
  state.match.projectiles.clear();
  state.match.powerups.clear();
  state.match.crown = data.crown || null;
  state.match.kingId = null;
  state.match.ctoTask = null;
  state.match.thrownPlayers.clear();
  state.match.bossEvent = null;
  state.match.destroyedObstacles.clear();
  state.match.activeDisaster = null;

  data.players.forEach(sp => {
    const avatar = AVATARS[sp.avatarId] || AVATARS[0];
    state.match.players.set(sp.id, {
      id: sp.id, name: sp.name, avatarId: sp.avatarId, color: avatar.color,
      x: sp.x, y: sp.y, renderX: sp.x, renderY: sp.y, angle: sp.angle, renderAngle: sp.angle,
      vx: 0, vy: 0, hp: sp.hp, lives: sp.lives, status: sp.status, holding: sp.holding, holdingType: null,
      score: sp.score || 0, carrying: null, carriedBy: null,
      attackAnim: null, hitFlashTimer: 0, stunTimer: 0, invulnUntil: Date.now() + MATCH.respawnInvulnSec * 1000,
      speedBuffUntil: 0, speedBuffMultiplier: 1, damageBuffUntil: 0,
      moving: false
    });
  });
  data.items.forEach(it => state.match.items.set(it.id, { ...it }));
  (data.powerups || []).forEach(pu => state.match.powerups.set(pu.id, { ...pu }));

  killFeedEl.innerHTML = '';
  camera.x = ARENA.width / 2; camera.y = ARENA.height / 2;
  switchScreen('arena');
});

socket.on('playerMoved', ({ id, x, y, angle, moving }) => {
  const p = state.match.players.get(id);
  if (!p || id === state.selfId) return;
  p.x = x; p.y = y; p.angle = angle; p.moving = moving;
});

socket.on('attackResult', ({ attackerId, type, angle, x, y, hits }) => {
  const attacker = state.match.players.get(attackerId);
  if (attacker) {
    if (attacker.id !== state.selfId) { attacker.angle = angle; attacker.x = x; attacker.y = y; }
    if (!attacker.attackAnim) attacker.attackAnim = { type, timer: type === 'punch' ? 0.22 : 0.28 };
  }
  hits.forEach(hit => {
    const target = state.match.players.get(hit.targetId);
    if (target) applyHitToPlayer(target, hit);
  });
});

socket.on('projectileHit', ({ itemId, targetId, ...hit }) => {
  const proj = state.match.projectiles.get(itemId);
  if (proj) {
    particles.spawn(proj.renderX, proj.renderY, 10, ITEM_TYPES[proj.itemType].color);
    state.match.projectiles.delete(itemId);
  }
  const target = state.match.players.get(targetId);
  if (target) applyHitToPlayer(target, { ...hit, attackerId: hit.attackerId });
});

socket.on('projectileSync', list => {
  list.forEach(u => {
    const proj = state.match.projectiles.get(u.id);
    if (proj) { proj.x = u.x; proj.y = u.y; }
  });
});

socket.on('projectileRemoved', ({ id }) => {
  state.match.projectiles.delete(id);
});

socket.on('itemPickedUp', ({ itemId, playerId }) => {
  const item = state.match.items.get(itemId);
  const player = state.match.players.get(playerId);
  if (item) item.heldBy = playerId;
  if (player) { player.holding = itemId; player.holdingType = item ? item.type : null; sound.pickup(); }
});

socket.on('itemThrown', ({ groundItemId, projectile, playerId }) => {
  state.match.items.delete(groundItemId);
  const player = state.match.players.get(playerId);
  if (player) { player.holding = null; player.holdingType = null; }
  state.match.projectiles.set(projectile.id, {
    id: projectile.id, itemType: projectile.itemType,
    x: projectile.x, y: projectile.y, renderX: projectile.x, renderY: projectile.y
  });
});

socket.on('itemDropped', item => {
  state.match.items.set(item.id, { id: item.id, type: item.type, x: item.x, y: item.y, heldBy: null });
  for (const p of state.match.players.values()) {
    if (p.holding === item.id) { p.holding = null; p.holdingType = null; }
  }
});

socket.on('playerGrabbed', ({ carrierId, targetId }) => {
  const carrier = state.match.players.get(carrierId);
  const target = state.match.players.get(targetId);
  if (carrier) carrier.carrying = targetId;
  if (target) {
    target.carriedBy = carrierId;
    target.status = 'grabbed';
  }
  sound.pickup();
  pushKillFeed(`🤼 ${carrier ? carrier.name : 'Someone'} grappled ${target ? target.name : 'someone'}!`);
});

socket.on('playerThrown', ({ carrierId, targetId, x, y, angle, score, kingId, kingChanged }) => {
  const carrier = state.match.players.get(carrierId);
  const target = state.match.players.get(targetId);
  if (carrier) carrier.carrying = null;
  if (target) {
    target.carriedBy = null;
    target.status = 'thrown';
    target.x = x; target.y = y; target.renderX = x; target.renderY = y; target.angle = angle;
  }
  sound.throwSfx();
  pushKillFeed(`🤾 ${carrier ? carrier.name : 'Someone'} hurled ${target ? target.name : 'someone'}!`);
  state.match.thrownPlayers.set(targetId, { x, y, renderX: x, renderY: y });
  applyScoreUpdate(carrierId, score, kingId, kingChanged);
});

socket.on('thrownPlayerSync', list => {
  list.forEach(u => {
    const tp = state.match.thrownPlayers.get(u.id);
    if (tp) { tp.x = u.x; tp.y = u.y; }
  });
});

socket.on('playerLanded', ({ id, x, y, newHp, newLives, koed, eliminated, hit }) => {
  state.match.thrownPlayers.delete(id);
  const target = state.match.players.get(id);
  if (target) {
    target.x = x; target.y = y; target.renderX = x; target.renderY = y;
    target.hp = newHp; target.lives = newLives;
    target.status = eliminated ? 'eliminated' : 'active';
    target.stunTimer = 0.4;
    target.invulnUntil = Date.now() + 600;
    particles.spawn(x, y, koed ? 16 : 8, '#ff0844');
    if (eliminated) pushKillFeed(`💥 ${target.name} was defeated on landing!`);
    else if (koed) pushKillFeed(`🤕 ${target.name} was struck down on landing!`);
    if (target.id === state.selfId) { state.shakeAmount = 14; triggerDamageFlash(); }
  }
  if (hit) {
    const hitPlayer = state.match.players.get(hit.targetId);
    if (hitPlayer) applyHitToPlayer(hitPlayer, hit);
  }
});

socket.on('playerDropped', ({ id, x, y }) => {
  const target = state.match.players.get(id);
  for (const p of state.match.players.values()) {
    if (p.carrying === id) p.carrying = null;
  }
  if (target) {
    target.carriedBy = null;
    target.status = 'active';
    target.x = x; target.y = y; target.renderX = x; target.renderY = y;
  }
});

socket.on('itemSpawned', item => {
  state.match.items.set(item.id, { id: item.id, type: item.type, x: item.x, y: item.y, heldBy: null });
});

socket.on('powerupSpawned', powerup => {
  state.match.powerups.set(powerup.id, { ...powerup });
});

function applyScoreUpdate(playerId, score, kingId, kingChanged) {
  const player = state.match.players.get(playerId);
  if (player && typeof score === 'number') player.score = score;
  if (kingChanged) {
    state.match.kingId = kingId;
    const king = state.match.players.get(kingId);
    pushKillFeed(`👑 ${king ? king.name : 'Someone'} is the new Ascendant!`);
    sound.victory();
  }
}

socket.on('powerupCollected', ({ id, type, playerId, newHp, buff, buffDurationSec, buffMultiplier, score, kingId, kingChanged }) => {
  state.match.powerups.delete(id);
  const player = state.match.players.get(playerId);
  if (!player) return;
  player.hp = newHp;
  if (buff === 'speed') { player.speedBuffUntil = Date.now() + buffDurationSec * 1000; player.speedBuffMultiplier = buffMultiplier; }
  if (buff === 'damage') { player.damageBuffUntil = Date.now() + buffDurationSec * 1000; }
  sound.pickup();
  particles.spawn(player.renderX, player.renderY, 10, POWERUPS[type].color);
  pushKillFeed(`${POWERUP_ICONS[type] || ''} ${player.name} gathered ${POWERUP_NAMES[type] || type}! +${POWERUPS[type].heal} HP`);
  applyScoreUpdate(playerId, score, kingId, kingChanged);
});

socket.on('crownSpawned', crown => {
  state.match.crown = crown;
});

socket.on('crownCollected', ({ playerId, score, kingId, kingChanged }) => {
  state.match.crown = null;
  const player = state.match.players.get(playerId);
  if (player) particles.spawn(player.renderX, player.renderY, 16, CROWN.color);
  sound.pickup();
  pushKillFeed(`👑 ${player ? player.name : 'Someone'} claimed the Relic of Ascension! (+1000 Honor)`);
  applyScoreUpdate(playerId, score, kingId, kingChanged);
});

function showTaskFlash(label) {
  const el = document.getElementById('task-flash');
  document.getElementById('task-flash-text').textContent = label;
  el.classList.add('active');
  clearTimeout(showTaskFlash.hideTimer);
  showTaskFlash.hideTimer = setTimeout(() => el.classList.remove('active'), 2600);
}

function showRealmEventFlash(label) {
  const el = document.getElementById('realm-event-flash');
  document.getElementById('realm-event-flash-text').textContent = label;
  el.classList.add('active');
  clearTimeout(showRealmEventFlash.hideTimer);
  showRealmEventFlash.hideTimer = setTimeout(() => el.classList.remove('active'), 2600);
}

socket.on('ctoTaskAssigned', ({ id, label, deadlineAt }) => {
  state.match.ctoTask = { id, label, deadlineAt };
  sound.taskAlert();
  showTaskFlash(label);
  pushKillFeed(`⚔️ SACRED TRIAL: ${label}!`);
});

socket.on('ctoTaskCompleted', ({ playerId, reward, score, kingId, kingChanged }) => {
  state.match.ctoTask = null;
  const player = state.match.players.get(playerId);
  pushKillFeed(`✅ ${player ? player.name : 'Someone'} completed the Sacred Trial! +${reward} Honor`);
  if (!kingChanged) sound.pickup();
  applyScoreUpdate(playerId, score, kingId, kingChanged);
});

socket.on('ctoTaskExpired', () => {
  state.match.ctoTask = null;
  pushKillFeed('⌛ Nobody completed the Sacred Trial in time.');
});

socket.on('disasterWarning', ({ id, label, warningSec }) => {
  sound.taskAlert();
  showRealmEventFlash(`${label} incoming...`);
  pushKillFeed(`🌩️ REALM EVENT: ${label} is coming!`);
});

socket.on('disasterStarted', ({ id, durationSec, meta }) => {
  state.match.activeDisaster = { id, endsAt: Date.now() + durationSec * 1000, meta: meta || {} };
  pushKillFeed(`🌩️ ${DISASTER_LABELS[id] || id} has begun!`);
});

socket.on('disasterEnded', ({ id }) => {
  if (state.match.activeDisaster && state.match.activeDisaster.id === id) state.match.activeDisaster = null;
  pushKillFeed(`✨ ${DISASTER_LABELS[id] || id} has passed.`);
});

socket.on('disasterResolved', ({ id, targetId }) => {
  if (id === 'crystalResonance') {
    if (!targetId) {
      pushKillFeed('✨ Crystal Resonance found no Crystal Ward left to shatter.');
      return;
    }
    sound.crash();
    state.shakeAmount = Math.max(state.shakeAmount, 20);
    pushKillFeed('💥 Crystal Resonance shatters a Crystal Ward!');
  }
});

socket.on('bossWarning', ({ warningSec }) => {
  state.match.bossEvent = { phase: 'warning', endsAt: Date.now() + warningSec * 1000 };
  sound.bossWarning();
  pushKillFeed('🚨 THE ANCIENT GUARDIAN STIRS! Find shelter!');
});

socket.on('bossResolved', ({ hits }) => {
  state.match.bossEvent = { phase: 'impact', endsAt: Date.now() + 900 };
  sound.bossStomp();
  state.shakeAmount = Math.max(state.shakeAmount, 26);
  hits.forEach(hit => {
    const target = state.match.players.get(hit.targetId);
    if (!target) return;
    target.x = hit.x; target.y = hit.y;
    if (target.id === state.selfId) { target.renderX = hit.x; target.renderY = hit.y; target.vx = 0; target.vy = 0; triggerDamageFlash(); }
    target.hp = hit.newHp;
    target.lives = hit.newLives;
    target.status = hit.eliminated ? 'eliminated' : (hit.koed ? 'down' : 'active');
    target.hitFlashTimer = 0.2;
    target.stunTimer = hit.koed ? 0.6 : 0.22;
    particles.spawn(target.renderX, target.renderY, hit.koed ? 18 : 8, '#ff0844');
    pushKillFeed(hit.eliminated
      ? `💥 ${target.name} found no shelter and was defeated!`
      : `💥 ${target.name} found no shelter and was struck down!`);
  });
  if (hits.length === 0) pushKillFeed('😮‍💨 Every champion found shelter in time!');
});

socket.on('obstacleDestroyed', ({ id, x, y, w, h, kind, blastHits }) => {
  state.match.destroyedObstacles.add(id);
  sound.crash();
  state.shakeAmount = Math.max(state.shakeAmount, 14);
  const cx = x + w / 2, cy = y + h / 2;
  const color = (DESTRUCTIBLE_KINDS[kind] || {}).color || '#8b5e3c';
  particles.spawn(cx, cy, 16, color);

  (blastHits || []).forEach(hit => {
    const target = state.match.players.get(hit.targetId);
    if (!target) return;
    target.x = hit.x; target.y = hit.y;
    if (target.id === state.selfId) { target.renderX = hit.x; target.renderY = hit.y; target.vx = 0; target.vy = 0; triggerDamageFlash(); }
    target.hp = hit.newHp;
    target.lives = hit.newLives;
    target.status = hit.eliminated ? 'eliminated' : (hit.koed ? 'down' : 'active');
    target.hitFlashTimer = 0.2;
    target.stunTimer = hit.koed ? 0.6 : 0.22;
  });
});

socket.on('obstacleRespawned', ({ id }) => {
  state.match.destroyedObstacles.delete(id);
});

socket.on('playerRespawned', ({ id, x, y, hp }) => {
  const p = state.match.players.get(id);
  if (!p) return;
  p.x = x; p.y = y; p.renderX = x; p.renderY = y; p.hp = hp; p.status = 'active';
  p.invulnUntil = Date.now() + MATCH.respawnInvulnSec * 1000;
  p.speedBuffUntil = 0; p.damageBuffUntil = 0;
  if (id === state.selfId) pushKillFeed('You return to the trial!');
});

socket.on('playerLeft', ({ id }) => {
  state.match.players.delete(id);
  state.lobbyPlayers = state.lobbyPlayers.filter(p => p.id !== id);
  if (state.screen === 'lobby') renderLobby();
});

socket.on('matchEnded', ({ reason, standings, winnerId }) => {
  switchScreen('results');
  const iWon = winnerId === state.selfId;
  document.getElementById('results-title').textContent = iWon ? 'PROTECTOR OF THE REALMS!' : 'THE TRIAL HAS ENDED';
  const winner = standings.find(s => s.id === winnerId);
  const subtitle = winner ? `👑 ${winner.name} is named Protector of the Realms with ${winner.score} Honor!` : 'The trial has concluded.';
  document.getElementById('results-subtitle').textContent = subtitle;
  if (iWon) sound.victory(); else sound.defeat();

  document.getElementById('standings-table').innerHTML = standings.map((s, i) => {
    const avatar = AVATARS[s.avatarId] || AVATARS[0];
    const crownPrefix = s.id === winnerId ? '👑 ' : '';
    return `<div class="standings-row ${s.id === winnerId ? 'winner' : ''}">
      <span class="standings-rank">${i + 1}</span>
      <span class="player-dot" style="background:${avatar.color}"></span>
      <span class="standings-name">${crownPrefix}${escapeHtml(s.name)}</span>
      <span class="standings-stat">${s.score} Honor</span>
      <span class="standings-stat">${s.lives}❤</span>
      <span class="standings-stat">DMG ${s.damageDealt}</span>
    </div>`;
  }).join('');
});

// ---------------- Landing / lobby UI wiring ----------------
const avatarGrid = document.getElementById('avatar-grid');
AVATARS.forEach(a => {
  const el = document.createElement('div');
  el.className = 'avatar-choice';
  el.style.background = a.color;
  el.textContent = { tie: '👔', glasses: '🕶️', headphones: '🎧', cap: '🧢', bow: '🎀', scarf: '🧣' }[a.accessory] || '🙂';
  el.dataset.id = a.id;
  el.addEventListener('click', () => {
    state.avatarId = a.id;
    [...avatarGrid.children].forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
  });
  avatarGrid.appendChild(el);
});
avatarGrid.children[0].classList.add('selected');

function getName() {
  const name = document.getElementById('name-input').value.trim();
  return name || `Player${Math.floor(Math.random() * 1000)}`;
}

document.getElementById('quickplay-btn').addEventListener('click', () => {
  document.getElementById('landing-error').textContent = '';
  socket.emit('quickPlay', { name: getName(), avatarId: state.avatarId });
});
document.getElementById('create-btn').addEventListener('click', () => {
  document.getElementById('landing-error').textContent = '';
  socket.emit('createRoom', { name: getName(), avatarId: state.avatarId });
});
document.getElementById('join-btn').addEventListener('click', () => {
  const code = document.getElementById('join-code-input').value.trim();
  if (!code) { document.getElementById('landing-error').textContent = 'Enter a room code.'; return; }
  document.getElementById('landing-error').textContent = '';
  socket.emit('joinRoom', { code, name: getName(), avatarId: state.avatarId });
});

document.getElementById('name-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const code = document.getElementById('join-code-input').value.trim();
  if (code) document.getElementById('join-btn').click();
  else document.getElementById('quickplay-btn').click();
});
document.getElementById('join-code-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  document.getElementById('join-btn').click();
});

let guideReturnScreenId = null;
function openGuide(returnScreenId) {
  guideReturnScreenId = returnScreenId;
  if (returnScreenId) document.getElementById(returnScreenId).classList.remove('active');
  document.getElementById('guide-screen').classList.add('active');
}
function closeGuide() {
  document.getElementById('guide-screen').classList.remove('active');
  if (guideReturnScreenId) document.getElementById(guideReturnScreenId).classList.add('active');
  guideReturnScreenId = null;
}

document.getElementById('how-to-play-btn').addEventListener('click', () => openGuide('landing-screen'));
document.getElementById('lobby-how-to-play-btn').addEventListener('click', () => openGuide('lobby-screen'));
document.getElementById('arena-how-to-play-btn').addEventListener('click', () => openGuide(null));
document.getElementById('close-guide-btn').addEventListener('click', closeGuide);

document.getElementById('start-match-btn').addEventListener('click', () => {
  document.getElementById('lobby-error').textContent = '';
  socket.emit('startMatch');
});
document.getElementById('leave-lobby-btn').addEventListener('click', () => {
  socket.emit('leaveRoom');
  location.reload();
});
document.getElementById('leave-results-btn').addEventListener('click', () => {
  socket.emit('leaveRoom');
  location.reload();
});
document.getElementById('back-to-lobby-btn').addEventListener('click', () => {
  socket.emit('returnToLobby');
});
document.getElementById('copy-code-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(state.roomCode || '').catch(() => {});
});
