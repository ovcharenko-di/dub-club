// Canvas timeline: waveform, cue blocks, playhead. Supports creating cues by
// dragging on empty space, moving/resizing cues, seeking, zoom and scroll.

const EDGE_PX = 7;
const MIN_CUE = 0.2;
const RULER_H = 18;

export class Timeline {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ getCues, getTime, getDuration, onSeek, onSelect, onCreate, onChange }} hooks
   */
  constructor(canvas, hooks) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.pxPerSec = 80;
    this.viewStart = 0;
    this.peaks = null;        // Float32Array of per-10ms peaks (0..1)
    this.peaksRate = 100;
    this.selectedId = null;
    this.drag = null;
    this.dirty = true;

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.resizeObserver = new ResizeObserver(() => { this.dirty = true; });
    this.resizeObserver.observe(canvas);
  }

  destroy() {
    this.resizeObserver.disconnect();
  }

  setAudio(buffer) {
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.round(buffer.sampleRate / this.peaksRate));
    const peaks = new Float32Array(Math.ceil(data.length / step));
    let max = 1e-6;
    for (let i = 0; i < peaks.length; i++) {
      let p = 0;
      const end = Math.min(data.length, (i + 1) * step);
      for (let j = i * step; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > p) p = v;
      }
      peaks[i] = p;
      if (p > max) max = p;
    }
    for (let i = 0; i < peaks.length; i++) peaks[i] = Math.sqrt(peaks[i] / max);
    this.peaks = peaks;
    this.dirty = true;
  }

  setMessage(text) {
    this.message = text;
    this.dirty = true;
  }

  get width() { return this.canvas.clientWidth; }
  get viewLength() { return this.width / this.pxPerSec; }

  timeAt(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    return this.viewStart + (clientX - rect.left) / this.pxPerSec;
  }

  xOf(time) { return (time - this.viewStart) * this.pxPerSec; }

  clampView() {
    const maxStart = Math.max(0, this.hooks.getDuration() - this.viewLength);
    this.viewStart = Math.max(0, Math.min(maxStart, this.viewStart));
    this.dirty = true;
  }

  setZoom(pxPerSec, anchorTime = this.hooks.getTime()) {
    const anchorX = this.xOf(anchorTime);
    this.pxPerSec = Math.max(5, Math.min(600, pxPerSec));
    this.viewStart = anchorTime - anchorX / this.pxPerSec;
    this.clampView();
  }

  /** Keep the playhead visible (page forward while playing). */
  follow(time) {
    if (time < this.viewStart || time > this.viewStart + this.viewLength * 0.95) {
      this.viewStart = time - this.viewLength * 0.1;
      this.clampView();
    }
  }

  hitTest(clientX) {
    const t = this.timeAt(clientX);
    const tol = EDGE_PX / this.pxPerSec;
    const cues = this.hooks.getCues();
    // Prefer the selected cue when cues overlap.
    const ordered = [...cues].sort((a, b) => (a.id === this.selectedId ? -1 : b.id === this.selectedId ? 1 : 0));
    for (const cue of ordered) {
      if (Math.abs(t - cue.start) <= tol) return { cue, mode: 'start' };
      if (Math.abs(t - cue.end) <= tol) return { cue, mode: 'end' };
    }
    for (const cue of ordered) {
      if (t > cue.start && t < cue.end) return { cue, mode: 'move' };
    }
    return null;
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const t = this.timeAt(e.clientX);
    const hit = this.hitTest(e.clientX);
    if (hit) {
      this.selectedId = hit.cue.id;
      this.hooks.onSelect(hit.cue.id);
      this.drag = { mode: hit.mode, cue: hit.cue, t0: t, start: hit.cue.start, end: hit.cue.end, moved: false };
    } else {
      this.drag = { mode: 'create', t0: t, x0: e.clientX, cue: null };
    }
    this.dirty = true;
  }

  onPointerMove(e) {
    if (!this.drag) {
      const hit = this.hitTest(e.clientX);
      this.canvas.style.cursor = !hit ? 'crosshair' : hit.mode === 'move' ? 'grab' : 'ew-resize';
      return;
    }
    const d = this.drag;
    const dur = this.hooks.getDuration();
    const t = Math.max(0, Math.min(dur, this.timeAt(e.clientX)));
    if (d.mode === 'create') {
      if (!d.cue && Math.abs(e.clientX - d.x0) < 6) return;
      const start = Math.min(d.t0, t), end = Math.max(d.t0, t);
      if (!d.cue) {
        d.cue = this.hooks.onCreate(start, Math.max(end, start + MIN_CUE));
        this.selectedId = d.cue.id;
      } else {
        d.cue.start = start;
        d.cue.end = Math.max(end, start + MIN_CUE);
      }
    } else if (d.mode === 'move') {
      const len = d.end - d.start;
      const start = Math.max(0, Math.min(dur - len, d.start + (t - d.t0)));
      d.cue.start = start;
      d.cue.end = start + len;
    } else if (d.mode === 'start') {
      d.cue.start = Math.max(0, Math.min(t, d.cue.end - MIN_CUE));
    } else if (d.mode === 'end') {
      d.cue.end = Math.min(dur, Math.max(t, d.cue.start + MIN_CUE));
    }
    d.moved = true;
    this.dirty = true;
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.mode === 'create' && !d.cue) {
      this.hooks.onSeek(Math.max(0, this.timeAt(e.clientX)));
    } else if (!d.moved && d.cue) {
      this.hooks.onSeek(d.cue.start);
    } else if (d.cue) {
      this.hooks.onChange(d.cue);
    }
    this.dirty = true;
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.setZoom(this.pxPerSec * Math.exp(-e.deltaY * 0.002), this.timeAt(e.clientX));
    } else {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.viewStart += delta / this.pxPerSec;
      this.clampView();
    }
  }

  draw() {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim();

    g.fillStyle = '#0a0716';
    g.fillRect(0, 0, cw, ch);

    // Ruler
    const tickStep = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300].find((s) => s * this.pxPerSec >= 60) || 600;
    g.fillStyle = color('--muted');
    g.strokeStyle = color('--line');
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'top';
    const firstTick = Math.floor(this.viewStart / tickStep) * tickStep;
    for (let t = firstTick; t < this.viewStart + this.viewLength + tickStep; t += tickStep) {
      const x = Math.round(this.xOf(t)) + 0.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ch); g.stroke();
      const m = Math.floor(t / 60), s = t - m * 60;
      const label = tickStep < 1 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.round(s)).padStart(2, '0')}`;
      g.fillText(label, x + 3, 3);
    }

    // Waveform
    const top = RULER_H, waveH = ch - RULER_H;
    const mid = top + waveH / 2;
    if (this.peaks) {
      g.fillStyle = color('--wave');
      g.globalAlpha = 0.7;
      for (let x = 0; x < cw; x += 2) {
        const a = Math.floor((this.viewStart + x / this.pxPerSec) * this.peaksRate);
        const b = Math.max(a + 1, Math.floor((this.viewStart + (x + 2) / this.pxPerSec) * this.peaksRate));
        let p = 0;
        for (let i = Math.max(0, a); i < Math.min(this.peaks.length, b); i++) if (this.peaks[i] > p) p = this.peaks[i];
        const amp = Math.max(0.5, p * waveH * 0.45);
        g.fillRect(x, mid - amp, 1.5, amp * 2);
      }
      g.globalAlpha = 1;
    } else {
      g.fillStyle = color('--muted');
      g.fillText(this.message || 'Загрузка звуковой дорожки…', 8, mid - 6);
    }

    // Cues
    const accent = color('--accent'), accent3 = color('--accent-3');
    g.textBaseline = 'middle';
    g.font = '12px system-ui, sans-serif';
    for (const cue of this.hooks.getCues()) {
      const x0 = this.xOf(cue.start), x1 = this.xOf(cue.end);
      if (x1 < 0 || x0 > cw) continue;
      const selected = cue.id === this.selectedId;
      g.fillStyle = selected ? accent : accent3;
      g.globalAlpha = selected ? 0.35 : 0.2;
      g.fillRect(x0, top, x1 - x0, waveH);
      g.globalAlpha = 1;
      g.fillRect(x0, top, 2, waveH);
      g.fillRect(x1 - 2, top, 2, waveH);
      g.save();
      g.beginPath(); g.rect(x0 + 4, top, Math.max(0, x1 - x0 - 8), waveH); g.clip();
      g.fillStyle = '#fff';
      g.fillText((cue.text || '…').replace(/\s+/g, ' '), x0 + 6, top + 12);
      g.restore();
    }

    // Playhead
    const px = this.xOf(this.hooks.getTime());
    g.fillStyle = color('--accent-2');
    g.fillRect(Math.round(px) - 1, 0, 2, ch);
    this.dirty = false;
  }
}
