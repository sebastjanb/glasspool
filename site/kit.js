'use strict';

/* Glass kit — shared base for the Glass games on Meta Ray-Ban Display glasses.
   Copied into each game's site/ by GlassArcade/sync-kit.sh; edit it here only.

   Platform: fixed 600×600 additive display (black is transparent), input is
   ArrowUp/Down/Left/Right from swipes and Enter from a pinch, Back leaves the
   app through browser history (no history entries are ever pushed).
   Head motion comes from DeviceOrientationEvent and needs a permission that can
   only be asked from a gesture, so games call GK.askHead() from a pinch. */

const GK = (() => {
  const canvas = document.getElementById('game');
  const g = canvas.getContext('2d');
  const W = 600, H = 600;
  const TAU = Math.PI * 2;

  /* ------------------------------------------------------------ storage */

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage may be gone */ }
    },
  };

  /* -------------------------------------------------------------- input */

  // Pinch arrives as Enter. Whether the glasses report how long a pinch is
  // held is not documented, so holds are measured: once a pinch has lasted
  // longer than HOLD_SEEN the device clearly reports holds and games may use
  // them; until then games treat each pinch as a tap.
  const HOLD_SEEN = 0.22;
  const input = {
    held: {},             // key -> seconds it has been down, while down
    pinch: false,         // Enter is down
    holdsWork: store.get('gk.holdsWork', false),
    onKey: null,          // (key, event) on key down, no repeats
    onKeyUp: null,        // (key, secondsHeld)
  };
  const KEYS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Enter: 1, ' ': 1 };
  const downAt = {};

  document.addEventListener('keydown', (e) => {
    if (!KEYS[e.key]) return;
    e.preventDefault();
    const k = e.key === ' ' ? 'Enter' : e.key;
    unlockAudio();
    if (e.repeat || downAt[k] !== undefined) return;
    downAt[k] = performance.now();
    input.held[k] = 0;
    if (k === 'Enter') input.pinch = true;
    if (input.onKey) input.onKey(k, e);
  });
  document.addEventListener('keyup', (e) => {
    if (!KEYS[e.key]) return;
    const k = e.key === ' ' ? 'Enter' : e.key;
    if (downAt[k] === undefined) return;
    const secs = (performance.now() - downAt[k]) / 1000;
    delete downAt[k];
    delete input.held[k];
    if (k === 'Enter') {
      input.pinch = false;
      if (secs > HOLD_SEEN && !input.holdsWork) { input.holdsWork = true; store.set('gk.holdsWork', true); }
    }
    if (input.onKeyUp) input.onKeyUp(k, secs);
  });
  // A key whose keyup never arrives (focus lost) must not stay down forever.
  window.addEventListener('blur', () => {
    for (const k of Object.keys(downAt)) delete downAt[k];
    input.held = {};
    input.pinch = false;
  });

  /* --------------------------------------------------------------- head */

  // yaw: turn left/right in degrees, relative to the centre (right positive)
  // pitch: look up/down (up positive); roll: tilt the head (right ear down positive)
  // heading: absolute compass reading 0–360 when the device gives one.
  const head = {
    state: 'off',          // off | asking | on | denied | none
    yaw: 0, pitch: 0, roll: 0, heading: 0,
    invert: store.get('gk.headInvert', false),
    last: 0,               // time of the last reading
    raw: null,
  };
  let centre = null;
  const wrap = (a) => ((a + 540) % 360) - 180;

  function onOrientation(e) {
    if (e.alpha === null && e.beta === null) return;
    const raw = { a: e.alpha || 0, b: e.beta || 0, c: e.gamma || 0 };
    head.raw = raw;
    if (!centre) centre = raw;
    const sign = head.invert ? -1 : 1;
    // Meta's docs read alpha as the heading itself (not the W3C 360 − alpha).
    head.heading = raw.a;
    head.yaw = sign * wrap(raw.a - centre.a);
    head.pitch = wrap(raw.b - centre.b);
    head.roll = sign * wrap(raw.c - centre.c);
    head.last = performance.now();
    head.state = 'on';
  }

  function startHead() {
    window.addEventListener('deviceorientation', onOrientation);
    head.state = 'on';
    head.last = 0;
  }

  // Must run inside a key handler: the glasses only ask from a gesture.
  function askHead() {
    if (head.state === 'on' || head.state === 'asking') return Promise.resolve(head.state);
    if (typeof DeviceOrientationEvent === 'undefined') { head.state = 'none'; return Promise.resolve('none'); }
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      head.state = 'asking';
      return DeviceOrientationEvent.requestPermission()
        .then((s) => { if (s === 'granted') startHead(); else head.state = 'denied'; return head.state; })
        .catch(() => { head.state = 'denied'; return 'denied'; });
    }
    startHead();
    return Promise.resolve('on');
  }

  const headLive = () => head.state === 'on' && performance.now() - head.last < 1000;
  function recentre() { centre = head.raw; head.yaw = head.pitch = head.roll = 0; }
  function setInvert(v) { head.invert = v; store.set('gk.headInvert', v); }

  /* -------------------------------------------------------------- sound */

  // Small synthesised effects. The audio context can only start after a gesture.
  let ac = null, master = null;
  const sound = { on: store.get('gk.sound', true) };
  function unlockAudio() {
    if (ac || !sound.on) return;
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      master = ac.createGain();
      master.gain.value = 0.25;
      master.connect(ac.destination);
    } catch (e) { ac = null; }
  }
  function beep(freq, dur = 0.08, type = 'square', vol = 0.5, slide = 0) {
    if (!ac || !sound.on) return;
    const t = ac.currentTime;
    const o = ac.createOscillator(), v = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    v.gain.setValueAtTime(vol, t);
    v.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(v); v.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur = 0.2, vol = 0.4, freq = 900) {
    if (!ac || !sound.on) return;
    const t = ac.currentTime;
    const n = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), v = ac.createGain();
    s.buffer = buf; f.type = 'lowpass'; f.frequency.value = freq; v.gain.value = vol;
    s.connect(f); f.connect(v); v.connect(master);
    s.start(t);
  }
  function setSound(on) { sound.on = on; store.set('gk.sound', on); if (!on && ac) { ac.close(); ac = null; } }

  /* ------------------------------------------------------------ drawing */

  const FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';
  function label(text, x, y, size = 20, colour = '#f4f4f4', align = 'left', weight = 700) {
    g.font = `${weight} ${size}px ${FONT}`;
    g.textAlign = align;
    g.textBaseline = 'alphabetic';
    g.fillStyle = colour;
    g.fillText(text, x, y);
  }
  function plate(x, y, w, h, r = 14, fill = 'rgba(0,0,0,.6)') {
    g.fillStyle = fill;
    g.beginPath(); g.roundRect(x, y, w, h, r); g.fill();
  }
  function blink(now, period = 600) { return Math.floor(now / period) % 2 === 0; }

  // A panel in the middle with a title, a blinking prompt and grey hint lines.
  function banner(now, title, colour, prompt, hints = []) {
    const h = 136 + hints.length * 24;
    const y = 300 - h / 2;
    plate(70, y, 460, h, 24, 'rgba(0,0,0,.86)');
    label(title, 300, y + 58, 38, colour, 'center');
    if (prompt && blink(now)) label(prompt, 300, y + 106, 22, '#f4f4f4', 'center');
    hints.forEach((t, i) => label(t, 300, y + 146 + i * 24, 17, '#a9adb3', 'center', 600));
  }

  // A vertical menu: Up/Down move, Left/Right change a value, Enter picks.
  // items: { text: string | () => string, hint?: string | () => string, act?(), left?(), right?(), locked? }
  function menu(title, colour, items) {
    return { title, colour, items, i: 0 };
  }
  function menuKey(m, k) {
    const it = m.items[m.i];
    if (k === 'ArrowUp') { m.i = (m.i + m.items.length - 1) % m.items.length; beep(520, 0.03); }
    else if (k === 'ArrowDown') { m.i = (m.i + 1) % m.items.length; beep(520, 0.03); }
    else if (k === 'ArrowLeft' && it.left) { it.left(); beep(420, 0.03); }
    else if (k === 'ArrowRight' && it.right) { it.right(); beep(620, 0.03); }
    else if (k === 'Enter' && it.act && !it.locked) { beep(780, 0.06); it.act(); }
  }
  function drawMenu(m, now, top = 120) {
    const rows = m.items.length;
    const rowH = Math.min(54, Math.floor(380 / rows));
    const h = 92 + rows * rowH;
    const y0 = Math.max(16, Math.min(top, 590 - h));
    plate(60, y0, 480, h, 24, 'rgba(0,0,0,.84)');
    label(m.title, 300, y0 + 52, 32, m.colour, 'center');
    m.items.forEach((it, i) => {
      const y = y0 + 76 + i * rowH;
      const on = i === m.i;
      if (on) {
        g.strokeStyle = m.colour; g.lineWidth = 3;
        g.beginPath(); g.roundRect(80, y, 440, rowH - 8, 12); g.stroke();
      }
      const text = typeof it.text === 'function' ? it.text() : it.text;
      const arrows = on && (it.left || it.right);
      label((arrows ? '‹  ' : '') + text + (arrows ? '  ›' : ''), 300, y + rowH / 2 + 4, Math.min(22, rowH * 0.45),
        it.locked ? '#5d6168' : on ? '#ffffff' : '#c3c7cd', 'center');
    });
    let hint = m.items[m.i].hint;
    if (typeof hint === 'function') hint = hint();
    if (hint) label(hint, 300, y0 + h - 14, 15, '#a9adb3', 'center', 600);
  }

  /* --------------------------------------------------------------- math */

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  // Seeded generator for worlds and daily runs that must repeat exactly.
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const angDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
  function fmtTime(s) {
    if (!isFinite(s)) return '--:--.-';
    const m = Math.floor(s / 60), r = s - m * 60;
    return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
  }
  function today() {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  /* --------------------------------------------------------------- loop */

  const loop = { onTick: null, onRender: null, onHidden: null, fps: 0 };
  let last = 0, frames = 0, fpsAt = 0;
  function frame(now) {
    // A long gap (hidden app, slow frame) must not throw things through walls.
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    // Ask for the next frame first: one bad frame must never stop the game for good.
    requestAnimationFrame(frame);
    for (const k in input.held) input.held[k] += dt;
    try {
      if (loop.onTick) loop.onTick(dt, now);
      if (loop.onRender) loop.onRender(now);
    } catch (e) {
      loop.errors = (loop.errors || 0) + 1;
      if (loop.errors < 5) console.error(e);
    }
    frames++;
    if (now - fpsAt > 1000) { loop.fps = frames; frames = 0; fpsAt = now; }
  }
  function run(tick, render) {
    loop.onTick = tick;
    loop.onRender = render;
    requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && loop.onHidden) loop.onHidden();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
  canvas.focus();

  return {
    canvas, g, W, H, TAU, store, input, head, askHead, headLive, recentre, setInvert,
    sound, beep, noise, setSound, label, plate, blink, banner, menu, menuKey, drawMenu,
    clamp, lerp, rand, pick, rng, angDiff, fmtTime, today, run, loop, FONT,
  };
})();
