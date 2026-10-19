'use strict';

/* Glass Pool — billiards for Meta Ray-Ban Display glasses.
   Top-down table, balls with real momentum, cushions that lose some speed,
   follow, draw and side spin on the cue ball.
     Left / Right   turn the cue 1°; two quick swipes the same way jump to the next ball
     Up / Down      choose spin: none · follow · draw · left · right
     Pinch          start the stroke, pinch again to strike at that power
   Modes: 8-ball against three opponents, 9-ball, and trick shots. */

const VERSION = '1.0.0';
const { g, label, plate, banner, clamp, lerp, rand, beep, noise, store } = GK;
const TAU = Math.PI * 2, DEG = Math.PI / 180;

// Table in centimetres (inside the cushions), drawn 2.1 px per cm.
const TW = 254, TH = 127, R = 2.86, POCKET = 6.2, SIDE_POCKET = 6.6;
const S = 2.1, OX = 300 - TW * S / 2, OY = 312 - TH * S / 2;
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

let state = 'menu';       // menu | aim | power | moving | over | trick-done
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

/* -------------------------------------------------------------- drawing */

const X = (x) => OX + x * S, Y = (y) => OY + y * S;

function drawTable() {
  // Rails, felt, diamonds, pockets.
  g.fillStyle = '#4a2a18';
  g.beginPath(); g.roundRect(X(-14), Y(-14), (TW + 28) * S, (TH + 28) * S, 18); g.fill();
  g.fillStyle = '#0a3320';     // dim felt: a big bright panel is tiring on an additive display
  g.fillRect(X(-3), Y(-3), (TW + 6) * S, (TH + 6) * S);
  g.fillStyle = '#d9c38a';
  for (let i = 1; i < 8; i++) { if (i === 4) continue; g.fillRect(X(TW * i / 8) - 2, Y(-9) - 2, 4, 4); g.fillRect(X(TW * i / 8) - 2, Y(TH + 9) - 2, 4, 4); }
  for (let i = 1; i < 4; i++) { g.fillRect(X(-9) - 2, Y(TH * i / 4) - 2, 4, 4); g.fillRect(X(TW + 9) - 2, Y(TH * i / 4) - 2, 4, 4); }
  // Head string.
  g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(X(TW * 0.25), Y(0)); g.lineTo(X(TW * 0.25), Y(TH)); g.stroke();
  POCKETS.forEach(([px, py], i) => {
    g.fillStyle = '#000';
    g.beginPath(); g.arc(X(px), Y(py), (i === 1 || i === 4 ? SIDE_POCKET : POCKET) * S, 0, TAU); g.fill();
    g.strokeStyle = '#8a6a3a'; g.lineWidth = 2; g.stroke();
  });
}

function drawBall(b) {
  const x = X(b.x), y = Y(b.y), r = R * S;
  const base = ballColour(b.n);
  if (b.n > 8) {
    g.fillStyle = '#f2f2f2'; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    g.save(); g.beginPath(); g.arc(x, y, r, 0, TAU); g.clip();
    g.fillStyle = base; g.fillRect(x - r, y - r * 0.55, r * 2, r * 1.1); g.restore();
  } else {
    g.fillStyle = base; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  // The 8 is dark grey with a white rim: pure black would vanish on the glasses.
  if (b.n === 8) { g.strokeStyle = '#d0d0d0'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, r - 0.7, 0, TAU); g.stroke(); }
  if (b.n) {
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, r * 0.48, 0, TAU); g.fill();
    g.font = `700 ${Math.round(r * 0.75)}px ${GK.FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#111';
    g.fillText(String(b.n), x, y + 0.5);
  }
  g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.arc(x - r * 0.35, y - r * 0.35, r * 0.2, 0, TAU); g.fill();
}

function aimGuide() {
  // Line to the first ball in the way, the ghost ball, and where the object ball goes.
  const c = cue();
  const dx = Math.cos(aim), dy = Math.sin(aim);
  let bestT = Infinity, hitBall = null;
  for (const b of balls) {
    if (!b.on || b === c) continue;
    const fx = b.x - c.x, fy = b.y - c.y;
    const t = fx * dx + fy * dy;
    if (t <= 0) continue;
    const off2 = fx * fx + fy * fy - t * t;
    if (off2 > 4 * R * R) continue;
    const th = t - Math.sqrt(4 * R * R - off2);
    if (th < bestT) { bestT = th; hitBall = b; }
  }
  // Or a cushion.
  let wallT = Infinity;
  if (dx > 0) wallT = Math.min(wallT, (TW - R - c.x) / dx); if (dx < 0) wallT = Math.min(wallT, (R - c.x) / dx);
  if (dy > 0) wallT = Math.min(wallT, (TH - R - c.y) / dy); if (dy < 0) wallT = Math.min(wallT, (R - c.y) / dy);
  const t = Math.min(bestT, wallT);
  const ex = c.x + dx * t, ey = c.y + dy * t;
  g.setLineDash([6, 6]); g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(X(c.x), Y(c.y)); g.lineTo(X(ex), Y(ey)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = 'rgba(255,255,255,.8)';
  g.beginPath(); g.arc(X(ex), Y(ey), R * S, 0, TAU); g.stroke();
  if (hitBall && bestT <= wallT) {
    const nx = hitBall.x - ex, ny = hitBall.y - ey, nl = Math.hypot(nx, ny);
    g.strokeStyle = ballColour(hitBall.n); g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(X(hitBall.x), Y(hitBall.y)); g.lineTo(X(hitBall.x + nx / nl * 40), Y(hitBall.y + ny / nl * 40)); g.stroke();
  }
  // The cue itself.
  const back = state === 'power' ? 6 + meter.pos * 30 : 6;
  g.strokeStyle = '#d9b27a'; g.lineWidth = 5; g.lineCap = 'round';
  g.beginPath(); g.moveTo(X(c.x - dx * (R + back)), Y(c.y - dy * (R + back))); g.lineTo(X(c.x - dx * (R + back + 110)), Y(c.y - dy * (R + back + 110))); g.stroke();
  g.lineCap = 'butt';
}

function render(now) {
  g.fillStyle = '#000'; g.fillRect(0, 0, 600, 600);
  if (!balls) { balls = rack8(); }
  drawTable();
  for (const b of balls) if (b.on) drawBall(b);
  if (state === 'menu') return GK.drawMenu(menu, now, 120);
  if (state === 'aim' || state === 'power') aimGuide();
  hud(now);
  if (state === 'over') banner(now, winner === 0 ? 'YOU WIN' : 'YOU LOSE', winner === 0 ? '#4fe3a0' : '#ff6b6b', 'Pinch for the menu', [foulMsg, 'Record ' + record.won + ' – ' + record.lost]);
  if (state === 'trick-done') banner(now, winner === 0 ? 'MADE IT' : 'MISSED', winner === 0 ? '#4fe3a0' : '#ff6b6b', 'Pinch to try again', [trick.hint, 'Down: back to the menu']);
}

function hud(now) {
  // Top: whose turn, groups or the ball on.
  plate(12, 8, 576, 54, 14);
  if (mode === 'trick') {
    label(trick.name.toUpperCase(), 24, 42, 20, '#4fe3a0');
    label(trick.hint, 576, 42, 15, '#c3c7cd', 'right', 600);
  } else {
    const yourTurn = turn === 0;
    label(yourTurn ? 'YOUR SHOT' : opp.name.toUpperCase() + ' TO SHOOT', 24, 42, 20, yourTurn ? '#4fe3a0' : '#ffb35c');
    let right;
    if (mode === '9') right = 'Ball on: ' + Math.min(...live().map((b) => b.n));
    else right = groups[0] ? 'You: ' + (groups[0] === 'solid' ? 'solids' : 'stripes') : 'Open table';
    label(right, 576, 42, 16, '#e8eef6', 'right');
  }
  // Bottom: spin and power.
  plate(12, 530, 576, 58, 14);
  // Cue ball face with the spin point.
  const sx = 52, sy = 559;
  g.fillStyle = '#f2f2f2'; g.beginPath(); g.arc(sx, sy, 20, 0, TAU); g.fill();
  const off = { none: [0, 0], follow: [0, -11], draw: [0, 11], left: [-11, 0], right: [11, 0] }[SPINS[spin]];
  g.fillStyle = '#e23a3a'; g.beginPath(); g.arc(sx + off[0], sy + off[1], 5, 0, TAU); g.fill();
  label('Spin: ' + SPINS[spin], 84, 566, 16, '#e8eef6', 'left', 600);
  if (state === 'power') {
    g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(260, 548, 300, 20);
    g.fillStyle = meter.pos > 0.85 ? '#ff6b6b' : '#4fe3a0'; g.fillRect(260, 548, 300 * meter.pos, 20);
    label('Pinch to strike', 410, 543, 13, '#a9adb3', 'center');
  } else if (state === 'aim') label('Pinch to start the stroke', 410, 566, 15, '#a9adb3', 'center', 600);
  else if (state === 'ai') label(opp.name + ' is lining up…', 410, 566, 15, '#ffb35c', 'center', 600);
  if (msgT > 0) { plate(100, 250, 400, 50, 14, 'rgba(0,0,0,.8)'); label(msg, 300, 283, 20, msg.startsWith('FOUL') ? '#ff6b6b' : '#ffd34d', 'center'); }
}

/* ---------------------------------------------------------------- menu */

const MODES = ['8', '9', 'trick'];
const menu = GK.menu('GLASS POOL', '#4fe3a0', [
  { text: () => 'Game · ' + ['8-ball', '9-ball', 'Trick shots'][pick.mode], hint: 'Left / Right: game',
    left: () => (pick.mode = (pick.mode + 2) % 3), right: () => (pick.mode = (pick.mode + 1) % 3), act: () => startGame(MODES[pick.mode]) },
  { text: () => pick.mode === 2 ? 'Trick · ' + TRICKS[pick.trick].name + (record.tricks[TRICKS[pick.trick].name] ? '  ✓' : '') : 'Opponent · ' + OPPONENTS[pick.opp].name,
    hint: () => pick.mode === 2 ? TRICKS[pick.trick].hint : 'Record ' + record.won + ' – ' + record.lost,
    left: () => { if (pick.mode === 2) pick.trick = (pick.trick + TRICKS.length - 1) % TRICKS.length; else pick.opp = (pick.opp + 2) % 3; },
    right: () => { if (pick.mode === 2) pick.trick = (pick.trick + 1) % TRICKS.length; else pick.opp = (pick.opp + 1) % 3; },
    act: () => startGame(MODES[pick.mode]) },
  { text: () => 'Sound · ' + (GK.sound.on ? 'on' : 'off'), act: () => GK.setSound(!GK.sound.on) },
]);

/* --------------------------------------------------------------- input */

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
  if (state === 'menu') return GK.menuKey(menu, k);
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
  if (state === 'power' && k === 'Enter') strike(Math.max(0.05, meter.pos), spin);
};

GK.run(tick, render);
