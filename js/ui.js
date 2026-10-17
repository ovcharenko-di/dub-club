import { beep } from './audio.js';

let leaveCurrent = null;

/** Replace the current screen. `onLeave` runs when the next screen is mounted. */
export function mount(el, onLeave) {
  if (leaveCurrent) {
    try { leaveCurrent(); } catch (err) { console.error(err); }
  }
  leaveCurrent = onLeave || null;
  document.getElementById('app').replaceChildren(el);
  window.scrollTo(0, 0);
}

/** Tiny hyperscript helper: h('button', { class: 'primary', onclick }, 'Text'). */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function toast(message, { error = false, ms = 3500 } = {}) {
  const el = h('div', { class: `toast${error ? ' error' : ''}`, role: 'status' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function countdown(from = 3) {
  const overlay = h('div', { class: 'countdown' });
  document.body.append(overlay);
  try {
    for (let n = from; n > 0; n--) {
      overlay.replaceChildren(h('span', null, n));
      beep(660, 0.12);
      await sleep(800);
    }
    overlay.replaceChildren(h('span', null, '🎙️'));
    beep(990, 0.2);
    await sleep(350);
  } finally {
    overlay.remove();
  }
}

export function formatTime(sec) {
  if (!Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return m ? `${m}:${s}` : `${s.replace(/^0(?=\d)/, '')} с`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const peaksCache = new WeakMap();

function peaksFor(buffer, columns) {
  let byWidth = peaksCache.get(buffer);
  if (!byWidth) peaksCache.set(buffer, (byWidth = new Map()));
  if (byWidth.has(columns)) return byWidth.get(columns);
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / columns));
  const peaks = new Float32Array(columns);
  let max = 1e-6;
  for (let c = 0; c < columns; c++) {
    let peak = 0;
    const end = Math.min(data.length, (c + 1) * step);
    for (let i = c * step; i < end; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    peaks[c] = peak;
    if (peak > max) max = peak;
  }
  for (let c = 0; c < columns; c++) peaks[c] /= max;
  byWidth.set(columns, peaks);
  return peaks;
}

/** Draw a waveform with the part before `progress` (0..1) highlighted. */
export function drawWave(canvas, buffer, progress = 0, { live = false } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, width, height);
  if (!buffer) return;
  const css = getComputedStyle(document.documentElement);
  const done = live ? css.getPropertyValue('--accent-2').trim() : css.getPropertyValue('--wave-progress').trim();
  paintWave(g, buffer, progress, { x: 0, y: 0, width, height, scale: dpr, base: css.getPropertyValue('--wave').trim(), done });
}

/** Paint waveform bars into a rectangle of an existing 2D context. */
export function paintWave(g, buffer, progress, { x, y, width, height, scale = 1, base, done }) {
  const bar = Math.max(2, Math.round(3 * scale));
  const gap = Math.max(1, Math.round(2 * scale));
  const columns = Math.floor(width / (bar + gap));
  const peaks = peaksFor(buffer, columns);
  const mid = y + height / 2;
  for (let c = 0; c < columns; c++) {
    const amp = Math.max(0.03, peaks[c]) * (height * 0.42);
    g.fillStyle = c / columns < progress ? done : base;
    g.fillRect(x + c * (bar + gap), mid - amp, bar, amp * 2);
  }
}
