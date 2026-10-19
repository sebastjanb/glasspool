/* Glass kit 3D — shared WebGL helpers for the Glass games built on three.js.
   Copied into each 3D game's site/ by GlassArcade/scaffold.py; edit it here only.
   The game draws its scene on <canvas id="gl"> and its HUD on the kit's 2D
   canvas above it. Keep scenes light: one renderer, pixel ratio 1, fog, few
   lights, instancing for repeats. Black stays transparent on the glasses. */

import * as THREE from './three.module.min.js';

export { THREE };

export function makeRenderer(clear = 0x000000) {
  const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('gl'), antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(600, 600, false);
  renderer.setClearColor(clear, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

// A texture painted with Canvas 2D.
export function canvasTexture(w, h, draw, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Soft round glow for additive sprites (engine flames, lamps, explosions).
let glowTex = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  glowTex = canvasTexture(64, 64, (c) => {
    const grd = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = grd; c.fillRect(0, 0, 64, 64);
  });
  return glowTex;
}
export function glowSprite(colour, size) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: colour, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.scale.set(size, size, 1);
  return s;
}

// Points on a far sphere; move the group with the camera so they never get closer.
export function starfield(n = 900, radius = 700, colour = 0xdfe8ff, size = 1.6, upperOnly = false) {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const e = upperOnly ? Math.asin(Math.random() * 0.95 + 0.02) : Math.asin(Math.random() * 2 - 1);
    pos.set([Math.cos(a) * Math.cos(e) * radius, Math.sin(e) * radius, Math.sin(a) * Math.cos(e) * radius], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ color: colour, size, sizeAttenuation: false, fog: false }));
}

/* ------------------------------------------------------------- tracks */

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return p1.map((_, k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
}

// Closed track from control points [x, z] or [x, z, y], resampled every `step` m.
// Each sample: x, y, z, h (heading: 0 = +z, growing toward +x, which is to the left),
// k (curvature, + = bends left), bank (roll toward the inside of bends).
export function buildTrack(ctrl, step = 2, bankScale = 0) {
  const n = ctrl.length, raw = [];
  const c3 = ctrl.map((p) => [p[0], p[1], p[2] || 0]);
  for (let i = 0; i < n; i++) {
    const p0 = c3[(i - 1 + n) % n], p1 = c3[i], p2 = c3[(i + 1) % n], p3 = c3[(i + 2) % n];
    for (let k = 0; k < 40; k++) raw.push(catmull(p0, p1, p2, p3, k / 40));
  }
  const pts = [];
  let carry = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i], b = raw[(i + 1) % raw.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = carry;
    while (d < l) { const f = d / l; pts.push({ x: a[0] + (b[0] - a[0]) * f, z: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f }); d += step; }
    carry = d - l;
  }
  const N = pts.length;
  for (let i = 0; i < N; i++) {
    const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
    pts[i].h = Math.atan2(b.x - a.x, b.z - a.z);
  }
  const raw2 = [];
  for (let i = 0; i < N; i++) raw2.push(GK.angDiff(pts[(i - 3 + N) % N].h, pts[(i + 3) % N].h) / (6 * step));
  for (let i = 0; i < N; i++) {
    let s = 0; for (let j = -5; j <= 5; j++) s += raw2[(i + j + N) % N];
    pts[i].k = s / 11;
    pts[i].bank = Math.max(-0.45, Math.min(0.45, pts[i].k * bankScale));
  }
  return { pts, N, step, len: N * step };
}

export const leftOf = (h) => ({ x: Math.cos(h), z: -Math.sin(h) });

// Interpolated sample at distance s (wraps round the loop).
export function along(T, s) {
  const L = T.len, u = ((s % L) + L) % L / T.step;
  const i = Math.floor(u) % T.N, j = (i + 1) % T.N, f = u - Math.floor(u);
  const a = T.pts[i], b = T.pts[j];
  const lerp = (p, q) => p + (q - p) * f;
  return { x: lerp(a.x, b.x), y: lerp(a.y, b.y), z: lerp(a.z, b.z), h: a.h + GK.angDiff(a.h, b.h) * f, k: lerp(a.k, b.k), bank: lerp(a.bank, b.bank), i };
}

// World position at distance s and sideways offset (m, + = left), on the banked surface.
export function trackPoint(T, s, off, up = 0) {
  const p = along(T, s), l = leftOf(p.h);
  const c = Math.cos(p.bank), sn = Math.sin(p.bank);
  return { x: p.x + l.x * off * c, y: p.y + off * sn + up, z: p.z + l.z * off * c, h: p.h, bank: p.bank, k: p.k };
}

// A strip along the track between two offsets (m, + = left) at given heights.
// uvScale: metres per texture repeat along the track (0 = no UVs).
export function trackStrip(T, offA, offB, upA = 0, upB = 0, uvScale = 0, every = 1) {
  const pos = [], uv = [], idx = [];
  let row = 0;
  for (let i = 0; i <= T.N; i += every) {
    const s = i * T.step;
    const a = trackPoint(T, s, offA, upA), b = trackPoint(T, s, offB, upB);
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    if (uvScale) uv.push(0, s / uvScale, 1, s / uvScale);
    if (row > 0) { const r = row * 2; idx.push(r - 2, r - 1, r, r - 1, r + 1, r); }
    row++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (uvScale) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// Matrix that places an object on the track at s, off, facing along it.
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
export function trackMatrix(T, s, off, up = 0, yaw = 0, scale = 1) {
  const p = trackPoint(T, s, off, up);
  _e.set(0, p.h + yaw, 0, 'YXZ'); _e.z = -p.bank;
  _q.setFromEuler(_e);
  return _m.compose(_v.set(p.x, p.y, p.z), _q, _s.set(scale, scale, scale));
}

/* --------------------------------------------------------------- camera */

// Smoothed chase camera: call with the wanted position and look point each frame.
export function chaseCamera(camera) {
  const pos = new THREE.Vector3(), look = new THREE.Vector3();
  let init = false;
  return {
    update(want, at, dt, stiffness = 6, roll = 0) {
      const k = init ? Math.min(1, dt * stiffness) : 1;
      pos.lerp(want, k); look.lerp(at, k); init = true;
      camera.position.copy(pos);
      camera.up.set(Math.sin(roll), Math.cos(roll), 0);
      camera.lookAt(look);
    },
    reset() { init = false; },
  };
}

// Frame time from rAF timestamps, clamped.
export function frameClock() {
  let last = 0;
  return (now) => { const dt = Math.max(0, Math.min(0.1, (now - (last || now)) / 1000)); last = Math.max(last, now); return dt; };
}

// Bold italic HUD text in the style of racing overlays.
export function hudText(g, t, x, y, size, align = 'left', colour = '#fff', italic = true, weight = 800) {
  g.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${GK.FONT}`;
  g.textAlign = align; g.fillStyle = colour; g.fillText(t, x, y);
}
