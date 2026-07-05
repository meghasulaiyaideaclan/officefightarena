import {
  ARENA, ROOM, MATCH, PLAYER, COMBAT, ITEM_TYPES, DESKS, AVATARS,
  clamp, normalizeAngleDiff
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
  if (name === 'arena' && isTouchDevice()) mobileActions.style.display = 'flex';
  else mobileActions.style.display = 'none';
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
    projectiles: new Map()
  },
  shakeAmount: 0,
  lastPunchAt: 0,
  lastKickAt: 0
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
  if (k === 'j') doPunch();
  if (k === 'k') doKick();
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
  if (me.holding) {
    sound.throwSfx();
    me.holding = null;
    me.holdingType = null;
    socket.emit('throwItem', { angle: me.angle });
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

function drawDesk(d) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.roundRect(d.x + 8, d.y + 12, d.w, d.h, 12); ctx.fill();
  ctx.fillStyle = '#2f2347';
  ctx.strokeStyle = '#4b3b70';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.roundRect(d.x, d.y, d.w, d.h, 12); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#171124';
  ctx.fillRect(d.x + 15, d.y + 8, 30, 6);
  ctx.fillStyle = '#7a4ff0';
  ctx.fillRect(d.x + 18, d.y + 20, 24, 4);
  ctx.restore();
}

function drawItemIcon(type, ctx) {
  const spec = ITEM_TYPES[type];
  if (type === 'stapler') {
    ctx.fillStyle = spec.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(-14, -6, 28, 12, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.fillRect(-10, -1, 20, 2);
  } else if (type === 'keyboard') {
    ctx.fillStyle = spec.color; ctx.strokeStyle = '#7a4ff0'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(-16, -9, 32, 18, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7a4ff0';
    for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) ctx.fillRect(-13 + c * 6, -5 + r * 7, 3, 3);
  } else if (type === 'chair') {
    ctx.fillStyle = spec.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#2d3436'; ctx.fillRect(-7, -7, 14, 14);
  }
}

function drawGroundItem(item) {
  ctx.save();
  const floatY = Math.sin(performance.now() / 300 + item.x) * 3;
  ctx.translate(item.x, item.y + floatY);
  drawItemIcon(item.type, ctx);
  ctx.restore();
}

function drawProjectile(proj) {
  ctx.save();
  ctx.translate(proj.renderX, proj.renderY);
  ctx.rotate(performance.now() / 60);
  drawItemIcon(proj.itemType, ctx);
  ctx.restore();
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

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath(); ctx.arc(p.renderX, p.renderY + 12, PLAYER.radius, 0, Math.PI * 2); ctx.fill();

  ctx.translate(p.renderX, p.renderY);
  ctx.globalAlpha = eliminated ? 0.25 : (down ? 0.55 : 1);

  if (Date.now() < p.invulnUntil) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,242,254,0.6)';
    ctx.shadowColor = '#00f2fe'; ctx.shadowBlur = 12; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, PLAYER.radius * 1.4, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.rotate(p.renderAngle);

  ctx.fillStyle = avatar.color;
  ctx.strokeStyle = p.hitFlashTimer > 0 ? '#fff' : '#fff';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, PLAYER.radius * 0.92, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  if (p.hitFlashTimer > 0) {
    ctx.globalAlpha = (p.hitFlashTimer / 0.2) * 0.6;
    ctx.fillStyle = '#ff0844';
    ctx.beginPath(); ctx.arc(0, 0, PLAYER.radius * 0.92, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = eliminated ? 0.25 : (down ? 0.55 : 1);
  }

  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(9, -6, 2.4, 0, Math.PI * 2); ctx.arc(9, 6, 2.4, 0, Math.PI * 2); ctx.fill();

  drawAccessory(avatar.accessory);

  if (p.attackAnim && p.attackAnim.timer > 0) {
    const t = p.attackAnim.timer;
    ctx.globalAlpha = Math.min(1, t * 4);
    ctx.fillStyle = p.attackAnim.type === 'punch' ? 'rgba(0,242,254,0.7)' : 'rgba(255,8,68,0.7)';
    const dist = p.attackAnim.type === 'punch' ? COMBAT.punch.range * 0.6 : COMBAT.kick.range * 0.6;
    ctx.beginPath(); ctx.arc(dist, 0, p.attackAnim.type === 'punch' ? 10 : 14, 0, Math.PI * 2); ctx.fill();
  }

  if (p.holding && p.holdingType) {
    ctx.save();
    ctx.translate(PLAYER.radius + 10, 0);
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
  } else {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(p.name, 0, -PLAYER.radius - 22);

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

  ctx.fillStyle = '#1b1429';
  ctx.fillRect(0, 0, ARENA.width, ARENA.height);
  ctx.strokeStyle = '#251c36'; ctx.lineWidth = 2;
  const grid = 80;
  for (let x = 0; x <= ARENA.width; x += grid) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ARENA.height); ctx.stroke(); }
  for (let y = 0; y <= ARENA.height; y += grid) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ARENA.width, y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(122, 79, 240, 0.4)'; ctx.lineWidth = 10;
  ctx.strokeRect(0, 0, ARENA.width, ARENA.height);

  DESKS.forEach(drawDesk);
  state.match.items.forEach(item => { if (!item.heldBy) drawGroundItem(item); });
  state.match.projectiles.forEach(drawProjectile);
  particles.draw(ctx);
  state.match.players.forEach(p => { if (p.status !== 'eliminated' || true) drawPlayer(p); });

  ctx.restore();
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
    if (leaderboardTimer <= 0) { leaderboardTimer = 0.4; renderLeaderboard(); }
    updateHudTimer();
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

    if (p.id === state.selfId) {
      if (p.status === 'active' && p.stunTimer <= 0) {
        const mv = getMovementVector();
        const speed = PLAYER.speed;
        p.vx += mv.x * speed * 10 * dt;
        p.vy += mv.y * speed * 10 * dt;
        p.vx *= 0.85; p.vy *= 0.85;
        p.x += p.vx * dt; p.y += p.vy * dt;

        p.x = clamp(p.x, PLAYER.radius, ARENA.width - PLAYER.radius);
        p.y = clamp(p.y, PLAYER.radius, ARENA.height - PLAYER.radius);
        for (const d of DESKS) resolveDeskCollision(p, d);

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
  document.getElementById('hud-timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;

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

function renderLeaderboard() {
  const rows = [...state.match.players.values()]
    .sort((a, b) => (b.lives - a.lives) || (b.hp - a.hp));
  leaderboardEl.innerHTML = `<span class="hud-label">STANDINGS</span>` + rows.map(p => {
    const avatar = AVATARS[p.avatarId] || AVATARS[0];
    const status = p.status === 'eliminated' ? ' (out)' : '';
    return `<div class="leaderboard-row">
      <span class="player-dot" style="background:${avatar.color}"></span>
      <span class="leaderboard-name">${escapeHtml(p.name)}${status}</span>
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
    pushKillFeed(`💥 ${attackerName} eliminated ${target.name}!`);
    sound.ko();
  } else if (hit.koed) {
    pushKillFeed(`🤕 ${attackerName} knocked out ${target.name}!`);
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
  el.textContent = remaining;
  sound.click();
  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0) { clearInterval(interval); return; }
    el.textContent = remaining;
    sound.click();
  }, 1000);
});

socket.on('matchStarted', data => {
  state.match.endAt = data.endAt;
  state.match.players.clear();
  state.match.items.clear();
  state.match.projectiles.clear();

  data.players.forEach(sp => {
    const avatar = AVATARS[sp.avatarId] || AVATARS[0];
    state.match.players.set(sp.id, {
      id: sp.id, name: sp.name, avatarId: sp.avatarId, color: avatar.color,
      x: sp.x, y: sp.y, renderX: sp.x, renderY: sp.y, angle: sp.angle, renderAngle: sp.angle,
      vx: 0, vy: 0, hp: sp.hp, lives: sp.lives, status: sp.status, holding: sp.holding, holdingType: null,
      attackAnim: null, hitFlashTimer: 0, stunTimer: 0, invulnUntil: Date.now() + MATCH.respawnInvulnSec * 1000,
      moving: false
    });
  });
  data.items.forEach(it => state.match.items.set(it.id, { ...it }));

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

socket.on('itemSpawned', item => {
  state.match.items.set(item.id, { id: item.id, type: item.type, x: item.x, y: item.y, heldBy: null });
});

socket.on('playerRespawned', ({ id, x, y, hp }) => {
  const p = state.match.players.get(id);
  if (!p) return;
  p.x = x; p.y = y; p.renderX = x; p.renderY = y; p.hp = hp; p.status = 'active';
  p.invulnUntil = Date.now() + MATCH.respawnInvulnSec * 1000;
  if (id === state.selfId) pushKillFeed('You respawned!');
});

socket.on('playerLeft', ({ id }) => {
  state.match.players.delete(id);
  state.lobbyPlayers = state.lobbyPlayers.filter(p => p.id !== id);
  if (state.screen === 'lobby') renderLobby();
});

socket.on('matchEnded', ({ reason, standings, winnerId }) => {
  switchScreen('results');
  const iWon = winnerId === state.selfId;
  document.getElementById('results-title').textContent = iWon ? 'VICTORY!' : 'MATCH OVER';
  const winner = standings.find(s => s.id === winnerId);
  document.getElementById('results-subtitle').textContent = winner
    ? `${winner.name} wins${reason === 'time' ? ' on the clock' : ' by knockout'}!`
    : 'The match has ended.';
  if (iWon) sound.victory(); else sound.defeat();

  document.getElementById('standings-table').innerHTML = standings.map((s, i) => {
    const avatar = AVATARS[s.avatarId] || AVATARS[0];
    return `<div class="standings-row ${s.id === winnerId ? 'winner' : ''}">
      <span class="standings-rank">${i + 1}</span>
      <span class="player-dot" style="background:${avatar.color}"></span>
      <span class="standings-name">${escapeHtml(s.name)}</span>
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
