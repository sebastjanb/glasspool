/* Glass Pool — billiards for Meta Ray-Ban Display glasses.
   WebGL table under a lamp: wooden rails, felt, leather pockets and glossy
   numbered balls that roll as they move. The camera sits low behind the cue
   ball while you aim and rises over the table while the balls run.
     Left / Right   turn the cue 1°; two quick swipes the same way jump to the next ball
     Up / Down      choose spin: none · follow · draw · left · right
     Pinch          start the stroke, pinch again to strike at that power
   Modes: 8-ball against three opponents, 9-ball, and trick shots. */

import { THREE, makeRenderer, canvasTexture, chaseCamera, frameClock } from './kit3d.js';

const VERSION = '2.0.0';
const { g, label, clamp, lerp, rand, beep, noise, store } = GK;
const TAU = Math.PI * 2, DEG = Math.PI / 180;

// Table in centimetres (inside the cushions), drawn 2.1 px per cm.
const TW = 254, TH = 127, R = 2.86, POCKET = 6.2, SIDE_POCKET = 6.6;
const ROLL_DEC = 22;            // cm/s² rolling resistance
const CUSHION = 0.74;           // speed kept off a cushion
const MAXV = 520;               // cm/s at full power

const POCKETS = [[0, 0], [TW / 2, -1.5], [TW, 0], [0, TH], [TW / 2, TH + 1.5], [TW, TH]];
const COLOURS = ['#ffffff', '#f5c518', '#2f6fe0', '#e23a3a', '#7b3fd0', '#ff8a1e', '#1f9a4a', '#a3262a', '#3a3a3a'];
const ballColour = (n) => COLOURS[n > 8 ? n - 8 : n];

const OPPONENTS = [{ name: 'Rookie', err: 2.6, power: 0.9 }, { name: 'Hustler', err: 1.2, power: 1 }, { name: 'Shark', err: 0.45, power: 1 }];
const SPINS = ['none', 'follow', 'draw', 'left', 'right'];

const TRICKS = [
  { name: 'The Bank', shots: 1, goal: [3], balls: [[0, 60, 90], [3, 190, 20]], hint: 'Bank the 3 into a corner' },
  { name: 'Follow Through', shots: 1, goal: [1, 2], balls: [[0, 40, 63], [1, 200, 63], [2, 236, 63]], hint: 'Pot both with one stroke: try follow' },
  { name: 'Screw Back', shots: 1, goal: [5], balls: [[0, 127, 63], [5, 127, 18], [9, 127, 110]], hint: 'Pot the 5, keep the cue ball out of the pocket' },
  { name: 'Kiss', shots: 1, goal: [6], balls: [[0, 60, 40], [4, 160, 50], [6, 180, 60]], hint: 'Pot the 6 off the 4' },
  { name: 'Three Rail', shots: 2, goal: [7, 8], balls: [[0, 30, 100], [7, 230, 110], [8, 127, 30], [11, 127, 100]], hint: 'Pot the 7 and the 8 in two strokes' },
];

/* ---------------------------------------------------------------- state */

let state = 'title';      // title | menu | aim | power | moving | over | trick-done
let mode, balls, turn, groups, opp, aim, spin, meter, lastSwipe, foulMsg, msg, msgT, shotInfo, potted, trick, trickShots, aiT, winner;
let pick = { mode: 0, opp: 0, trick: 0 };
const record = store.get('pool.record', { won: 0, lost: 0, tricks: {} });

function ball(n, x, y) { return { n, x, y, vx: 0, vy: 0, on: true, sx: 0, sy: 0 }; }

function rack8() {
  const out = [ball(0, TW * 0.25, TH / 2)];
  const order = [1, 9, 2, 10, 8, 3, 11, 7, 14, 4, 5, 13, 15, 6, 12];
  let k = 0;
  for (let row = 0; row < 5; row++) for (let i = 0; i <= row; i++) {
    out.push(ball(order[k++], TW * 0.72 + row * R * 1.74, TH / 2 + (i - row / 2) * R * 2.02));
  }
  return out;
}
function rack9() {
  const out = [ball(0, TW * 0.25, TH / 2)];
  const rows = [[1], [2, 3], [4, 9, 5], [6, 7], [8]];
  rows.forEach((row, r) => row.forEach((n, i) => out.push(ball(n, TW * 0.72 + r * R * 1.74, TH / 2 + (i - (row.length - 1) / 2) * R * 2.02))));
  return out;
}

function startGame(m) {
  mode = m;
  potted = [];
  groups = { 0: null, 1: null };     // 'solid' | 'stripe' for player 0 (you) and 1
  turn = 0; winner = null;
  if (m === '8') balls = rack8();
  else if (m === '9') balls = rack9();
  else {
    trick = TRICKS[pick.trick];
    balls = trick.balls.map(([n, x, y]) => ball(n, x, y));
    trickShots = 0;
  }
  opp = OPPONENTS[pick.opp];
  spin = 0;
  newTurn(true);
}

const cue = () => balls[0];
const live = () => balls.filter((b) => b.on && b.n !== 0);

function legalTargets(who) {
  const l = live();
  if (mode === '9') { const low = Math.min(...l.map((b) => b.n)); return l.filter((b) => b.n === low); }
  if (mode === 'trick') return l;
  const gp = groups[who];
  if (!gp) return l.filter((b) => b.n !== 8);
  const mine = l.filter((b) => (gp === 'solid' ? b.n < 8 : b.n > 8));
  return mine.length ? mine : l.filter((b) => b.n === 8);
}

function newTurn(first) {
  shotInfo = { first: null, potted: [], cushion: false, scratch: false };
  if (!cue().on) placeCue();
  if (mode !== 'trick' && turn === 1) { state = 'ai'; aiT = 1.2; return; }
  const t = legalTargets(0);
  const best = planShot(0, 0);
  aim = best ? best.aim : t.length ? Math.atan2(t[0].y - cue().y, t[0].x - cue().x) : 0;
  state = 'aim';
  void first;
}

function placeCue() {
  // Ball in hand, simplified: the cue ball goes on the head spot, nudged clear of others.
  const c = cue();
  c.on = true; c.vx = c.vy = 0;
  for (let k = 0; k < 40; k++) {
    c.x = TW * 0.25; c.y = TH / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * R * 2.2;
    if (!balls.some((b) => b !== c && b.on && Math.hypot(b.x - c.x, b.y - c.y) < R * 2.1)) return;
  }
}

/* -------------------------------------------------------------- physics */

function strike(power, sp) {
  const c = cue();
  const v = MAXV * power;
  c.vx = Math.cos(aim) * v; c.vy = Math.sin(aim) * v;
  c.spin = sp;                 // applied on first contact or cushion
  c.spinV = v;
  c.spinDir = aim;
  c.spun = false;
  state = 'moving';
  noise(0.06, 0.4, 3000);
  beep(180, 0.05, 'sine', 0.4);
}

function physics(dt) {
  const steps = 10, h = dt / steps;
  for (let s = 0; s < steps; s++) {
    for (const b of balls) {
      if (!b.on) continue;
      b.x += b.vx * h; b.y += b.vy * h;
      const v = Math.hypot(b.vx, b.vy);
      if (v > 0) { const nv = Math.max(0, v - ROLL_DEC * h); b.vx *= nv / v; b.vy *= nv / v; }
      // Pockets.
      for (let p = 0; p < 6; p++) {
        const [px, py] = POCKETS[p];
        const pr = p === 1 || p === 4 ? SIDE_POCKET : POCKET;
        if (Math.hypot(b.x - px, b.y - py) < pr) { pot(b); break; }
      }
      if (!b.on) continue;
      // Cushions, except across a pocket mouth.
      const nearPocket = POCKETS.some(([px, py], i) => Math.hypot(b.x - px, b.y - py) < (i === 1 || i === 4 ? SIDE_POCKET : POCKET) + R * 1.6);
      if (!nearPocket) {
        let bounced = false;
        if (b.x < R) { b.x = R; b.vx = -b.vx * CUSHION; bounced = true; }
        if (b.x > TW - R) { b.x = TW - R; b.vx = -b.vx * CUSHION; bounced = true; }
        if (b.y < R) { b.y = R; b.vy = -b.vy * CUSHION; bounced = true; }
        if (b.y > TH - R) { b.y = TH - R; b.vy = -b.vy * CUSHION; bounced = true; }
        if (bounced) {
          if (shotInfo.first) shotInfo.cushion = true;
          if (Math.hypot(b.vx, b.vy) > 40) beep(140, 0.03, 'sine', 0.2);
          // Side spin bends the rebound.
          if (b.n === 0 && (b.spin === 3 || b.spin === 4) && !b.sideUsed) {
            const turnA = (b.spin === 3 ? -1 : 1) * 0.35;
            const c = Math.cos(turnA), sn = Math.sin(turnA);
            [b.vx, b.vy] = [b.vx * c - b.vy * sn, b.vx * sn + b.vy * c];
            b.sideUsed = true;
          }
        }
      } else {
        // Inside a pocket mouth the jaws still stop a ball from leaving the table.
        b.x = clamp(b.x, -4, TW + 4); b.y = clamp(b.y, -4, TH + 4);
      }
    }
    // Ball to ball: equal masses, nearly elastic.
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (!a.on) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (!b.on) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 4 * R * R || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        const overlap = 2 * R - d;
        a.x -= nx * overlap / 2; a.y -= ny * overlap / 2; b.x += nx * overlap / 2; b.y += ny * overlap / 2;
        const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (rel <= 0) continue;
        const imp = rel * 0.97;
        a.vx -= imp * nx; a.vy -= imp * ny; b.vx += imp * nx; b.vy += imp * ny;
        if (rel > 30) beep(1800 + Math.random() * 400, 0.02, 'sine', Math.min(0.4, rel / 600));
        const cueBall = a.n === 0 ? a : b.n === 0 ? b : null;
        if (cueBall && !shotInfo.first) shotInfo.first = a.n === 0 ? b.n : a.n;
        // Follow and draw take effect once the cue ball has struck.
        if (cueBall && cueBall.spin && !cueBall.spun) {
          cueBall.spun = true;
          const k = cueBall.spin === 1 ? 0.45 : cueBall.spin === 2 ? -0.55 : 0;
          if (k) { cueBall.vx += Math.cos(cueBall.spinDir) * cueBall.spinV * k * Math.abs(rel) / cueBall.spinV; cueBall.vy += Math.sin(cueBall.spinDir) * cueBall.spinV * k * Math.abs(rel) / cueBall.spinV; }
        }
      }
    }
  }
}

function pot(b) {
  b.on = false; b.vx = b.vy = 0;
  beep(220, 0.12, 'triangle', 0.4, -100);
  if (b.n === 0) { shotInfo.scratch = true; return; }
  shotInfo.potted.push(b.n);
  potted.push(b.n);
}

const moving = () => balls.some((b) => b.on && (Math.abs(b.vx) > 0.5 || Math.abs(b.vy) > 0.5));

/* ---------------------------------------------------------------- rules */

function settle() {
  for (const b of balls) { b.vx = b.vy = 0; b.spin = 0; b.sideUsed = false; }
  const who = turn, other = 1 - turn;
  const name = who === 0 ? 'You' : opp.name;
  const info = shotInfo;
  if (mode === 'trick') {
    trickShots++;
    const done = trick.goal.every((n) => potted.includes(n)) && !info.scratch;
    if (done) {
      state = 'trick-done'; winner = 0;
      record.tricks[trick.name] = true; store.set('pool.record', record);
      return;
    }
    if (trickShots >= trick.shots || info.scratch) { state = 'trick-done'; winner = 1; return; }
    newTurn();
    return;
  }

  let foul = null;
  const legal = legalTargets(who).map((b) => b.n);
  const legalBefore = legal.concat(info.potted);    // potted this stroke still counted as targets
  if (info.scratch) foul = 'Scratch';
  else if (info.first === null) foul = 'No ball hit';
  else if (mode === '9') { const low = Math.min(...legalBefore); if (info.first !== low) foul = 'Hit the ' + info.first + ' first, not the ' + low; }
  else if (mode === '8' && groups[who]) {
    const gp = groups[who];
    const isOwn = (n) => n !== 0 && n !== 8 && (gp === 'solid' ? n < 8 : n > 8);
    // Own balls on the table before this stroke: still on, or potted by it.
    const ownBefore = balls.some((b) => isOwn(b.n) && (b.on || info.potted.includes(b.n)));
    const ok = info.first === 8 ? !ownBefore : isOwn(info.first);
    if (!ok) foul = 'Wrong ball first';
  } else if (mode === '8' && info.first === 8) foul = 'Hit the 8 first';
  if (!foul && !info.potted.length && !info.cushion) foul = 'No cushion after contact';

  // 8-ball: the 8.
  if (mode === '8' && info.potted.includes(8)) {
    const gp = groups[who];
    const cleared = gp && !balls.some((b) => b.n !== 0 && b.n !== 8 && (gp === 'solid' ? b.n < 8 : b.n > 8) && b.on);
    winner = cleared && !foul ? who : other;
    return endGame(winner === who ? name + ' sank the 8' : name + (foul ? ' fouled on the 8' : ' sank the 8 too early'));
  }
  // 9-ball: the 9 on a legal stroke wins.
  if (mode === '9' && info.potted.includes(9)) {
    if (!foul) return endGame(name + ' sank the 9', who);
    // Respot the 9 after a foul.
    const nine = balls.find((b) => b.n === 9); nine.on = true; nine.x = TW * 0.72; nine.y = TH / 2;
    potted = potted.filter((n) => n !== 9);
  }
  // Groups are decided by the first legal pot.
  if (mode === '8' && !groups[who] && !foul && info.potted.length) {
    const n = info.potted.find((x) => x !== 8);
    if (n) { groups[who] = n < 8 ? 'solid' : 'stripe'; groups[other] = n < 8 ? 'stripe' : 'solid'; say((who === 0 ? 'You take ' : opp.name + ' takes ') + (n < 8 ? 'solids' : 'stripes')); }
  }
  let keep = false;
  if (!foul && info.potted.length) {
    if (mode === '9') keep = true;
    else {
      const gp = groups[who];
      keep = info.potted.some((n) => n !== 8 && (gp === 'solid' ? n < 8 : n > 8));
    }
  }
  if (foul) { say('FOUL · ' + foul, 2.2); beep(150, 0.3, 'sawtooth', 0.3); if (cue().on) { cue().x = TW * 0.25; cue().y = TH / 2; } cue().on = false; }
  if (!keep) turn = other;
  newTurn();
}

function endGame(text, w) {
  if (w !== undefined) winner = w;
  foulMsg = text;
  if (winner === 0) record.won++; else record.lost++;
  store.set('pool.record', record);
  state = 'over';
  if (winner === 0) { beep(523, 0.2, 'triangle', 0.4); setTimeout(() => beep(784, 0.35, 'triangle', 0.4), 200); }
  else beep(200, 0.5, 'sawtooth', 0.3, -100);
}

function say(t, s = 1.8) { msg = t; msgT = s; }

/* ------------------------------------------------------------------ AI */

function pathClear(x1, y1, x2, y2, ignore) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
  for (const b of balls) {
    if (!b.on || ignore.includes(b)) continue;
    const t = clamp(((b.x - x1) * dx + (b.y - y1) * dy) / (L * L), 0, 1);
    if (Math.hypot(x1 + dx * t - b.x, y1 + dy * t - b.y) < R * 2.05) return false;
  }
  return true;
}

// Best straight pot for this player: aim angle, power and a difficulty score.
function planShot(who) {
  const c = cue();
  let best = null;
  for (const t of legalTargets(who)) {
    for (let p = 0; p < 6; p++) {
      const [px, py] = POCKETS[p];
      const tx = px - t.x, ty = py - t.y, tl = Math.hypot(tx, ty);
      const gx = t.x - tx / tl * R * 2, gy = t.y - ty / tl * R * 2;       // ghost ball
      const cx = gx - c.x, cy = gy - c.y, cl = Math.hypot(cx, cy);
      const cut = Math.acos(clamp((cx * tx + cy * ty) / (cl * tl), -1, 1));
      if (cut > 75 * DEG) continue;
      if (!pathClear(c.x, c.y, gx, gy, [c, t]) || !pathClear(t.x, t.y, px, py, [t])) continue;
      // Side pockets accept only fairly straight approaches.
      if ((p === 1 || p === 4) && Math.abs(ty / tl) < 0.5) continue;
      const score = cl + tl * 1.3 + cut / DEG * 3;
      if (!best || score < best.score) {
        const need = Math.sqrt(2 * ROLL_DEC * (tl + 30)) / Math.max(0.25, Math.cos(cut)) + Math.sqrt(2 * ROLL_DEC * cl);
        best = { aim: Math.atan2(cy, cx), power: clamp(need / MAXV * 1.15, 0.2, 1), score, target: t };
      }
    }
  }
  return best;
}

function aiShoot() {
  const plan = planShot(1);
  if (plan) {
    aim = plan.aim + rand(-1, 1) * opp.err * DEG;
    strike(plan.power * opp.power, 0);
  } else {
    // No pot on: roll into the nearest legal ball with enough pace to reach a cushion.
    const t = legalTargets(1).sort((a, b) => Math.hypot(a.x - cue().x, a.y - cue().y) - Math.hypot(b.x - cue().x, b.y - cue().y))[0];
    aim = Math.atan2(t.y - cue().y, t.x - cue().x) + rand(-1, 1) * opp.err * DEG;
    strike(0.55, 0);
  }
}

/* --------------------------------------------------------------- update */

function tick(dt) {
  msgT -= dt;
  if (state === 'ai') { aiT -= dt; if (aiT <= 0) aiShoot(); return; }
  if (state === 'power') {
    meter.t += dt;
    const p = (meter.t / 1.3) % 2;
    meter.pos = p < 1 ? p : 2 - p;
    return;
  }
  if (state === 'moving') {
    physics(dt);
    if (!moving()) settle();
  }
}

/* ------------------------------------------------------------------ scene */

// Table plan is (x along the table, y across) in centimetres; the scene puts it on (x, 0, y).
const renderer = makeRenderer();
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 1, 3000);
const chase = chaseCamera(camera);
const clock = frameClock();
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x101008, 0.45));
const lamp = new THREE.SpotLight(0xfff2d8, 9000, 600, 0.9, 0.6, 1.6);
lamp.position.set(TW / 2, 220, TH / 2);
lamp.target.position.set(TW / 2, 0, TH / 2);
scene.add(lamp, lamp.target);
const fill = new THREE.DirectionalLight(0xffffff, 0.6);
fill.position.set(-100, 200, 300);
scene.add(fill);

// Felt with a faint weave.
const feltTex = canvasTexture(256, 256, (c, w, h) => {
  c.fillStyle = '#1d6a3c'; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 4000; i++) { c.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${Math.random() * 0.05})`; c.fillRect(Math.random() * w, Math.random() * h, 1, 1); }
}, true);
feltTex.repeat.set(4, 2);
const felt = new THREE.Mesh(new THREE.PlaneGeometry(TW + 8, TH + 8), new THREE.MeshStandardMaterial({ map: feltTex, roughness: 0.95 }));
felt.rotation.x = -Math.PI / 2; felt.position.set(TW / 2, 0, TH / 2);
scene.add(felt);
// Head string.
const string = new THREE.Mesh(new THREE.PlaneGeometry(0.4, TH), new THREE.MeshBasicMaterial({ color: 0x4a9a6a, transparent: true, opacity: 0.6 }));
string.rotation.x = -Math.PI / 2; string.position.set(TW * 0.25, 0.05, TH / 2);
scene.add(string);

// Cushions (felt-coloured noses) with gaps at the pockets, then the wooden rail.
const cushMat = new THREE.MeshStandardMaterial({ color: 0x175a32, roughness: 0.9 });
const woodTex = canvasTexture(256, 32, (c, w, h) => {
  c.fillStyle = '#5a2e14'; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) { c.strokeStyle = `rgba(${Math.random() < 0.5 ? '30,12,4' : '140,80,40'},.35)`; c.lineWidth = 1 + Math.random() * 2; c.beginPath(); c.moveTo(0, Math.random() * h); c.bezierCurveTo(w / 3, Math.random() * h, w * 2 / 3, Math.random() * h, w, Math.random() * h); c.stroke(); }
}, true);
const woodMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.35, metalness: 0.1 });
const gap = 9;
for (const [x0, x1, y, horiz] of [[gap, TW / 2 - gap, -2, true], [TW / 2 + gap, TW - gap, -2, true], [gap, TW / 2 - gap, TH + 2, true], [TW / 2 + gap, TW - gap, TH + 2, true], [gap, TH - gap, -2, false], [gap, TH - gap, TW + 2, false]]) {
  const len = x1 - x0;
  const m = new THREE.Mesh(new THREE.BoxGeometry(horiz ? len : 4, 3.6, horiz ? 4 : len), cushMat);
  if (horiz) m.position.set((x0 + x1) / 2, 1.8, y); else m.position.set(y, 1.8, (x0 + x1) / 2);
  scene.add(m);
}
for (const [cx, cz, w, d] of [[TW / 2, -11, TW + 36, 14], [TW / 2, TH + 11, TW + 36, 14], [-11, TH / 2, 14, TH + 8], [TW + 11, TH / 2, 14, TH + 8]]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 6, d), woodMat); m.position.set(cx, 2.2, cz); scene.add(m);
}
// Diamonds on the rail.
const dia = new THREE.MeshBasicMaterial({ color: 0xf0e2b8 });
for (let i = 1; i < 8; i++) if (i !== 4) for (const z of [-11, TH + 11]) { const d = new THREE.Mesh(new THREE.CircleGeometry(0.9, 4), dia); d.rotation.x = -Math.PI / 2; d.position.set(TW * i / 8, 5.3, z); scene.add(d); }
for (let i = 1; i < 4; i++) for (const x of [-11, TW + 11]) { const d = new THREE.Mesh(new THREE.CircleGeometry(0.9, 4), dia); d.rotation.x = -Math.PI / 2; d.position.set(x, 5.3, TH * i / 4); scene.add(d); }
// Pockets: dark wells with leather rims.
for (const [px, py] of POCKETS) {
  const hole = new THREE.Mesh(new THREE.CircleGeometry(POCKET + 0.6, 24), new THREE.MeshBasicMaterial({ color: 0x020202 }));
  hole.rotation.x = -Math.PI / 2; hole.position.set(px, 0.08, py); scene.add(hole);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(POCKET + 1.2, 1.2, 8, 24), new THREE.MeshStandardMaterial({ color: 0x24160c, roughness: 0.5 }));
  rim.rotation.x = -Math.PI / 2; rim.position.set(px, 2.5, py); scene.add(rim);
}
// Lamp shade over the table.
const shade = new THREE.Mesh(new THREE.BoxGeometry(150, 6, 30), new THREE.MeshStandardMaterial({ color: 0x1a3a22, emissive: 0x0a1a10 }));
shade.position.set(TW / 2, 200, TH / 2); scene.add(shade);
const glowBar = new THREE.Mesh(new THREE.PlaneGeometry(146, 26), new THREE.MeshBasicMaterial({ color: 0xfff2d0 }));
glowBar.rotation.x = Math.PI / 2; glowBar.position.set(TW / 2, 196.8, TH / 2); scene.add(glowBar);

/* ------------------------------------------------------------------ balls */

function ballTexture(n) {
  return canvasTexture(256, 128, (c, w, h) => {
    const base = ballColour(n);
    if (n > 8) { c.fillStyle = '#f4f2ea'; c.fillRect(0, 0, w, h); c.fillStyle = base; c.fillRect(0, h * 0.3, w, h * 0.4); }
    else { c.fillStyle = n === 0 ? '#f4f2ea' : base; c.fillRect(0, 0, w, h); }
    if (n === 8) { c.fillStyle = '#121212'; c.fillRect(0, 0, w, h); }
    if (n) for (const u of [0.25, 0.75]) {
      c.fillStyle = '#f8f6ee'; c.beginPath(); c.ellipse(u * w, h / 2, 17, 26, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#111'; c.font = `bold ${n > 9 ? 22 : 26}px Georgia, serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(n), u * w, h / 2 + 1);
    } else { c.fillStyle = '#c8202a'; for (const u of [0.25, 0.75]) { c.beginPath(); c.arc(u * w, h / 2, 4, 0, Math.PI * 2); c.fill(); } }
  });
}
const ballGeo = new THREE.SphereGeometry(R, 28, 20);
const ballMeshes = [];
function meshForBall(b) {
  if (!ballMeshes[b.n]) {
    const m = new THREE.Mesh(ballGeo, new THREE.MeshPhysicalMaterial({ map: ballTexture(b.n), roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 }));
    m.quaternion.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, 0));
    m.last = { x: b.x, y: b.y };
    scene.add(m);
    ballMeshes[b.n] = m;
  }
  return ballMeshes[b.n];
}
const shadows = [];
const shadowTex = canvasTexture(64, 64, (c) => { const grd = c.createRadialGradient(32, 32, 4, 32, 32, 30); grd.addColorStop(0, 'rgba(0,0,0,.55)'); grd.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = grd; c.fillRect(0, 0, 64, 64); });
function shadowFor(i) {
  if (!shadows[i]) { const s = new THREE.Mesh(new THREE.PlaneGeometry(R * 3, R * 3), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })); s.rotation.x = -Math.PI / 2; scene.add(s); shadows[i] = s; }
  return shadows[i];
}

// Cue: a tapered shaft with a dark butt and a white ferrule.
const cueStick = new THREE.Group();
{
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 1.3, 145, 12), new THREE.MeshStandardMaterial({ color: 0xe8c890, roughness: 0.4 }));
  shaft.rotation.z = Math.PI / 2; shaft.position.x = -72.5; cueStick.add(shaft);
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 45, 12), new THREE.MeshStandardMaterial({ color: 0x2a140a, roughness: 0.3 }));
  butt.rotation.z = Math.PI / 2; butt.position.x = -122; cueStick.add(butt);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 2, 12), new THREE.MeshStandardMaterial({ color: 0xf6f6f6 }));
  tip.rotation.z = Math.PI / 2; tip.position.x = -1; cueStick.add(tip);
}
scene.add(cueStick);

// Aim guide: dashed line to contact, ghost ring, and the object ball's path.
const guideMat = new THREE.LineDashedMaterial({ color: 0x7fe8c8, dashSize: 2.5, gapSize: 2, transparent: true, opacity: 0.9 });
const guideGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
const guide = new THREE.Line(guideGeo, guideMat); scene.add(guide);
const ghost = new THREE.Mesh(new THREE.RingGeometry(R - 0.3, R + 0.2, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
ghost.rotation.x = -Math.PI / 2; scene.add(ghost);
const objGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
const objLine = new THREE.Line(objGeo, new THREE.LineBasicMaterial({ color: 0xffffff })); scene.add(objLine);

function contact() {
  const c = cue(), dx = Math.cos(aim), dy = Math.sin(aim);
  let bestT = Infinity, hitBall = null;
  for (const b of balls) {
    if (!b.on || b === c) continue;
    const fx = b.x - c.x, fy = b.y - c.y, t = fx * dx + fy * dy;
    if (t <= 0) continue;
    const off2 = fx * fx + fy * fy - t * t;
    if (off2 > 4 * R * R) continue;
    const th = t - Math.sqrt(4 * R * R - off2);
    if (th < bestT) { bestT = th; hitBall = b; }
  }
  let wallT = Infinity;
  if (dx > 0) wallT = Math.min(wallT, (TW - R - c.x) / dx); if (dx < 0) wallT = Math.min(wallT, (R - c.x) / dx);
  if (dy > 0) wallT = Math.min(wallT, (TH - R - c.y) / dy); if (dy < 0) wallT = Math.min(wallT, (R - c.y) / dy);
  const t = Math.min(bestT, wallT);
  return { ex: c.x + dx * t, ey: c.y + dy * t, ball: bestT <= wallT ? hitBall : null };
}

/* ----------------------------------------------------------------- render */

const want = new THREE.Vector3(), at = new THREE.Vector3(), _ax = new THREE.Vector3(), _q = new THREE.Quaternion();
let menuA = 0;

function render3d(now) {
  const dt = clock(now);
  if (!balls) balls = rack8();
  balls.forEach((b, i) => {
    const m = meshForBall(b);
    m.visible = b.on;
    const sh = shadowFor(i); sh.visible = b.on;
    if (!b.on) { m.last = { x: b.x, y: b.y }; return; }
    // Roll: turn about the axis across the direction of travel by distance / radius.
    const dx = b.x - m.last.x, dy = b.y - m.last.y, d = Math.hypot(dx, dy);
    if (d > 0.001 && d < 50) { _ax.set(dy, 0, -dx).normalize(); _q.setFromAxisAngle(_ax, d / R); m.quaternion.premultiply(_q); }
    m.last = { x: b.x, y: b.y };
    m.position.set(b.x, R, b.y);
    sh.position.set(b.x + 0.8, 0.06, b.y + 0.8);
  });
  const c = cue();
  const aiming = (state === 'aim' || state === 'power') && c.on;
  cueStick.visible = guide.visible = ghost.visible = aiming || state === 'ai';
  objLine.visible = false;
  if (cueStick.visible) {
    const pull = state === 'power' ? 4 + meter.pos * 26 : 4;
    cueStick.position.set(c.x - Math.cos(aim) * (R + pull), R + 1.2, c.y - Math.sin(aim) * (R + pull));
    cueStick.rotation.set(0, -aim, 0.06);
    const k = contact();
    guideGeo.setFromPoints([new THREE.Vector3(c.x, R * 0.4, c.y), new THREE.Vector3(k.ex, R * 0.4, k.ey)]);
    guide.computeLineDistances();
    ghost.position.set(k.ex, 0.1, k.ey);
    if (k.ball) {
      const nx = k.ball.x - k.ex, ny = k.ball.y - k.ey, nl = Math.hypot(nx, ny);
      objGeo.setFromPoints([new THREE.Vector3(k.ball.x, R * 0.4, k.ball.y), new THREE.Vector3(k.ball.x + nx / nl * 40, R * 0.4, k.ball.y + ny / nl * 40)]);
      objLine.material.color.set(ballColour(k.ball.n));
      objLine.visible = true;
    }
    guide.visible = ghost.visible = state !== 'ai';
  }
  // Camera: low behind the cue ball when you aim, high over the table while balls roll.
  if (state === 'title' || state === 'menu') {
    menuA += dt * 0.15;
    want.set(TW / 2 + Math.cos(menuA) * 210, 120, TH / 2 + Math.sin(menuA) * 170); at.set(TW / 2, 0, TH / 2);
    chase.update(want, at, dt, 2);
  } else if (aiming && turn === 0) {
    want.set(c.x - Math.cos(aim) * 62, 26, c.y - Math.sin(aim) * 62);
    at.set(c.x + Math.cos(aim) * 70, 0, c.y + Math.sin(aim) * 70);
    chase.update(want, at, dt, 7);
  } else {
    want.set(TW / 2, 230, TH / 2 + 150); at.set(TW / 2, 0, TH / 2 + 8);
    chase.update(want, at, dt, 2.5);
  }
  renderer.render(scene, camera);
}

/* -------------------------------------------------------------------- HUD */

const TEAL = '#5ee8c0';
const serif = (size, w = 700, italic = true) => `${italic ? 'italic ' : ''}${w} ${size}px Georgia, "Playfair Display", "Times New Roman", serif`;
const sans = (size, w = 700) => `${w} ${size}px "Avenir Next", "Helvetica Neue", ${GK.FONT}`;
function tt(t, x, y, font, colour = '#fff', align = 'left') { g.font = font; g.textAlign = align; g.fillStyle = colour; g.fillText(t, x, y); }

function hud(now) {
  if (mode === 'trick') {
    tt(trick.name, 26, 46, serif(26), TEAL);
    tt(trick.hint, 26, 72, sans(15, 600), '#e8eef6');
    tt('Shot ' + (trickShots + 1) + ' of ' + trick.shots, 574, 46, sans(15), '#e8eef6', 'right');
  } else {
    const yours = turn === 0;
    if (yours) { g.fillStyle = TEAL; g.beginPath(); g.moveTo(24, 30); g.lineTo(32, 37); g.lineTo(24, 44); g.fill(); }
    tt('You', 40, 46, serif(28), yours ? TEAL : '#c3c7cd');
    g.fillStyle = yours ? TEAL : 'rgba(255,255,255,.2)'; g.fillRect(24, 56, 170, 2);
    tt(opp.name, 576, 46, serif(28), yours ? '#c3c7cd' : TEAL, 'right');
    g.fillStyle = yours ? 'rgba(255,255,255,.2)' : TEAL; g.fillRect(406, 56, 170, 2);
    let sub;
    if (mode === '9') sub = 'Ball on: ' + Math.min(...live().map((b) => b.n));
    else sub = groups[0] ? (groups[0] === 'solid' ? 'Solids' : 'Stripes') : potted.length ? 'Open table' : 'To break';
    tt(sub, 24, 84, sans(17, 600), '#e8eef6');
  }
  // Spin dial.
  const sx = 70, sy = 530;
  g.strokeStyle = '#ffffff'; g.lineWidth = 2.5; g.beginPath(); g.arc(sx, sy, 34, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(sx - 44, sy); g.lineTo(sx + 44, sy); g.moveTo(sx, sy - 44); g.lineTo(sx, sy + 44); g.stroke();
  const off = { none: [0, 0], follow: [0, -20], draw: [0, 20], left: [-20, 0], right: [20, 0] }[SPINS[spin]];
  g.fillStyle = TEAL; g.beginPath(); g.arc(sx + off[0], sy + off[1], 9, 0, Math.PI * 2); g.fill();
  tt('SPIN', 130, 522, sans(16, 800), '#fff');
  tt({ none: 'Center', follow: 'Follow', draw: 'Draw', left: 'Left', right: 'Right' }[SPINS[spin]], 130, 548, sans(20, 700), '#fff');
  // Power.
  const pw = state === 'power' ? meter.pos : 0;
  tt('POWER', 450, 508, sans(16, 800), '#fff', 'right');
  tt(Math.round(pw * 100) + '%', 450, 548, serif(36), '#fff', 'right');
  for (let i = 0; i < 10; i++) { g.fillStyle = (9 - i) / 10 < pw ? (i < 2 ? '#ffffff' : TEAL) : 'rgba(255,255,255,.15)'; g.fillRect(470, 474 + i * 10, 34, 7); }
  tt(state === 'power' ? 'Pinch to shoot' : state === 'ai' ? opp.name + ' is lining up…' : '', 450, 578, sans(15, 700), TEAL, 'right');
  if (state === 'aim' && turn === 0 && shotCount < 2) {
    g.fillStyle = 'rgba(14,18,20,.88)'; g.beginPath(); g.roundRect(120, 130, 360, 84, 14); g.fill();
    tt('Swipe left or right to aim,', 300, 160, sans(16, 600), '#fff', 'center');
    tt('twice quickly to jump to a ball. Up / down', 300, 182, sans(16, 600), '#fff', 'center');
    tt('for spin. Pinch for power.', 300, 204, sans(16, 600), TEAL, 'center');
  }
  if (msgT > 0) { g.fillStyle = 'rgba(14,18,20,.88)'; g.beginPath(); g.roundRect(110, 236, 380, 50, 14); g.fill(); tt(msg, 300, 269, sans(19, 800), msg.startsWith('FOUL') ? '#ff8a8a' : '#ffd34d', 'center'); }
}
let shotCount = 0;

function panel(now, title, lines, prompt) {
  g.fillStyle = 'rgba(16,20,22,.92)'; g.beginPath(); g.roundRect(70, 190, 460, 110 + lines.length * 28, 16); g.fill();
  g.strokeStyle = TEAL; g.lineWidth = 2; g.stroke();
  tt(title, 300, 240, serif(36), '#fff', 'center');
  lines.forEach((t, i) => tt(t, 300, 274 + i * 28, sans(17, 600), '#e8eef6', 'center'));
  if (GK.blink(now)) tt(prompt, 300, 274 + lines.length * 28 + 18, sans(17, 800), TEAL, 'center');
}

const MODES = ['8', '9', 'trick'];
const MENU = () => [
  { t: '8-Ball', s: () => 'Against ' + OPPONENTS[pick.opp].name + ' · ‹ › opponent · record ' + record.won + '–' + record.lost, act: () => startGame('8'), side: (d) => (pick.opp = (pick.opp + d + 3) % 3) },
  { t: 'Trick Shots', s: () => TRICKS[pick.trick].name + (record.tricks[TRICKS[pick.trick].name] ? ' ✓' : '') + ' · ‹ › setup · ' + Object.keys(record.tricks).length + ' of ' + TRICKS.length + ' done', act: () => startGame('trick'), side: (d) => (pick.trick = (pick.trick + d + TRICKS.length) % TRICKS.length) },
  { t: '9-Ball', s: () => 'Lowest ball first, then sink the 9', act: () => startGame('9'), side: (d) => (pick.opp = (pick.opp + d + 3) % 3) },
  { t: 'Sound', s: () => (GK.sound.on ? 'On' : 'Off'), act: () => GK.setSound(!GK.sound.on), side: () => GK.setSound(!GK.sound.on) },
];
let menuI = 0;

function titleScreen() {
  g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(0, 0, 600, 600);
  tt('Billiards', 300, 250, serif(78, 900), '#fff', 'center');
  tt('8-ball · 9-ball · trick shots', 300, 292, sans(18, 600), TEAL, 'center');
  g.fillStyle = 'rgba(16,20,22,.9)'; g.beginPath(); g.roundRect(190, 400, 220, 60, 14); g.fill(); g.strokeStyle = TEAL; g.lineWidth = 2; g.stroke();
  tt('Pinch to play', 300, 438, sans(20, 800), '#fff', 'center');
}

function menuScreen() {
  g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, 600, 600);
  tt('Billiards', 30, 52, serif(30), '#fff');
  tt('MAIN MENU', 570, 48, sans(15, 800), '#e8eef6', 'right');
  MENU().forEach((it, i) => {
    const y = 84 + i * 104, on = i === menuI;
    g.fillStyle = 'rgba(22,26,28,.92)'; g.beginPath(); g.roundRect(on ? 30 : 40, y, on ? 540 : 520, 90, 14); g.fill();
    if (on) { g.strokeStyle = TEAL; g.lineWidth = 2.5; g.stroke(); }
    tt(it.t, on ? 52 : 62, y + 42, serif(28), on ? '#fff' : '#c8ccd0');
    tt(it.s(), on ? 52 : 62, y + 72, sans(14, 600), '#c3c7cd');
  });
  tt('Swipe up or down to choose, pinch to open', 300, 528, sans(15, 600), '#fff', 'center');
}

function render(now) {
  render3d(now);
  g.clearRect(0, 0, 600, 600);
  if (state === 'title') return titleScreen();
  if (state === 'menu') return menuScreen();
  hud(now);
  if (state === 'over') panel(now, winner === 0 ? 'You win' : 'You lose', [foulMsg, 'Record ' + record.won + ' – ' + record.lost], 'Pinch for the menu');
  if (state === 'trick-done') panel(now, winner === 0 ? 'Made it' : 'Missed', [trick.hint, 'Down: back to the menu'], 'Pinch to try again');
}

/* ------------------------------------------------------------------ input */

function nextBall(dir) {
  // Jump the aim to the next ball round the cue ball in that direction.
  const c = cue();
  const angles = balls.filter((b) => b.on && b !== c).map((b) => Math.atan2(b.y - c.y, b.x - c.x));
  let best = null, bd = Infinity;
  for (const a of angles) {
    let d = GK.angDiff(aim, a) * dir;
    if (d <= 0.02) d += TAU;
    if (d < bd) { bd = d; best = a; }
  }
  if (best !== null) aim = best;
}

GK.input.onKey = (k) => {
  if (state === 'title') { if (k === 'Enter') state = 'menu'; return; }
  if (state === 'menu') {
    const items = MENU();
    if (k === 'ArrowUp') menuI = (menuI + items.length - 1) % items.length;
    else if (k === 'ArrowDown') menuI = (menuI + 1) % items.length;
    else if (k === 'ArrowLeft' || k === 'ArrowRight') items[menuI].side(k === 'ArrowLeft' ? -1 : 1);
    else if (k === 'Enter') { shotCount = 0; items[menuI].act(); }
    beep(560, 0.03);
    return;
  }
  if (state === 'over') { if (k === 'Enter') state = 'menu'; return; }
  if (state === 'trick-done') { if (k === 'Enter') startGame('trick'); else if (k === 'ArrowDown') state = 'menu'; return; }
  if (state === 'aim') {
    const now = performance.now();
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const dir = k === 'ArrowLeft' ? -1 : 1;
      if (lastSwipe && lastSwipe.k === k && now - lastSwipe.t < 350) nextBall(dir);
      else aim += dir * DEG;
      lastSwipe = { k, t: now };
      beep(600, 0.02);
    } else if (k === 'ArrowUp') { spin = (spin + 1) % SPINS.length; beep(700, 0.03); }
    else if (k === 'ArrowDown') { spin = (spin + SPINS.length - 1) % SPINS.length; beep(500, 0.03); }
    else if (k === 'Enter') { meter = { t: 0, pos: 0 }; state = 'power'; }
    return;
  }
  if (state === 'power' && k === 'Enter') { shotCount++; strike(Math.max(0.05, meter.pos), spin); }
};

GK.run(tick, render);

window.pool = { get state() { return state; }, set state(x) { state = x; }, startGame, tick, planShot, aiShoot, strike, legalTargets, get balls() { return balls; }, set aim(v) { aim = v; }, get winner() { return winner; }, cue, set pick(p) { Object.assign(pick, p); } };
