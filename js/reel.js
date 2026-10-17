import { audioCtx, stopSource, seekVideo, Recorder } from './audio.js';
import { h, paintWave } from './ui.js';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const CARD_TIME = 1.2; // seconds of title card before each take

/**
 * A player's "reel": all their takes glued into one continuous clip on a canvas.
 * Video lines show the muted original footage under the take's audio, audio lines
 * show the take's waveform. The same canvas can be recorded into a video file.
 */
export function createReel() {
  const canvas = h('canvas', { class: 'reel', width: WIDTH, height: HEIGHT });
  const g = canvas.getContext('2d');
  const video = h('video', { playsInline: true, preload: 'auto', muted: true });
  const progress = h('div');
  const el = h('div', { class: 'stack' },
    h('div', { class: 'stage' }, canvas),
    h('div', { class: 'progress' }, progress));

  let token = 0;
  let source = null;

  // The pending frame is left to run: it sees the new token and settles its promise.
  function stop() {
    token++;
    stopSource(source);
    source = null;
    video.pause();
  }

  async function loadVideo(prep) {
    if (!prep.videoUrl) return;
    if (video.src !== prep.videoUrl) video.src = prep.videoUrl;
    await seekVideo(video, prep.start);
  }

  // Runs `draw(elapsed)` every frame for `length` seconds; false if stopped meanwhile.
  function animate(my, length, draw) {
    const c = audioCtx();
    const t0 = c.currentTime;
    return new Promise((resolve) => {
      const tick = () => {
        if (my !== token) return resolve(false);
        const elapsed = Math.min(length, c.currentTime - t0);
        draw(elapsed);
        if (elapsed >= length) return resolve(true);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  /**
   * Play `takes` ({ player, line, prep, takeBuffer, total }) back to back.
   * With `record`, resolves to the recorded video Blob (null if stopped early).
   */
  async function play(takes, { record = false } = {}) {
    stop();
    const my = ++token;
    const c = audioCtx();
    const colors = readColors();
    const out = c.createGain();
    out.connect(c.destination);
    let recorder = null;
    if (record) {
      const dest = c.createMediaStreamDestination();
      out.connect(dest);
      const stream = canvas.captureStream(FPS);
      for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
      recorder = new Recorder(stream, 'video', { videoBitsPerSecond: 4_000_000 });
    }

    const lengths = takes.map((t) => CARD_TIME + t.takeBuffer.duration);
    const total = lengths.reduce((a, b) => a + b, 0);
    let before = 0;
    const setProgress = (elapsed) => { progress.style.width = `${Math.min(100, ((before + elapsed) / total) * 100)}%`; };

    const playAll = async () => {
      for (const [i, take] of takes.entries()) {
        const { prep, takeBuffer } = take;
        const ready = loadVideo(prep).catch((err) => console.warn('Reel: cannot seek video', err));
        if (!(await animate(my, CARD_TIME, (t) => { drawCard(g, colors, take, i, takes.length); setProgress(t); }))) return false;
        await ready;
        if (my !== token) return false;
        before += CARD_TIME;

        if (prep.videoUrl) {
          try { await video.play(); } catch (err) { console.warn(err); }
        }
        source = c.createBufferSource();
        source.buffer = takeBuffer;
        source.connect(out);
        source.start();
        const ok = await animate(my, takeBuffer.duration, (t) => {
          if (prep.videoUrl && video.currentTime >= prep.end) video.pause();
          drawTake(g, colors, take, i, takes.length, prep.videoUrl ? video : null, t / takeBuffer.duration);
          setProgress(t);
        });
        video.pause();
        stopSource(source);
        source = null;
        if (!ok) return false;
        before += takeBuffer.duration;
      }
      return true;
    };

    let finished = false, blob = null;
    try {
      // Not awaited: a canvas stream may not start until a frame is drawn, and the first card draws it.
      recorder?.start();
      finished = await playAll();
    } finally {
      blob = await recorder?.stop();
      out.disconnect();
    }
    if (finished) setProgress(0);
    return finished ? blob || null : null;
  }

  drawBlank(g, readColors());
  return { el, play, stop };
}

function readColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    bg: v('--bg'), text: v('--text'), muted: v('--muted'), accent: v('--accent'),
    wave: v('--wave'), waveProgress: v('--wave-progress'),
    font: getComputedStyle(document.body).fontFamily,
  };
}

function drawBlank(g, colors) {
  g.fillStyle = colors.bg;
  g.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawCard(g, colors, take, index, count) {
  drawBlank(g, colors);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = colors.muted;
  g.font = `600 36px ${colors.font}`;
  g.fillText(`${take.player.name} · реплика ${index + 1} из ${count}`, WIDTH / 2, HEIGHT / 2 - 90);
  g.fillStyle = colors.text;
  g.font = `800 64px ${colors.font}`;
  g.fillText(take.line.title, WIDTH / 2, HEIGHT / 2, WIDTH - 120);
  g.fillStyle = colors.accent;
  g.font = `800 48px ${colors.font}`;
  g.fillText(`${take.total.toFixed(1)} / 30`, WIDTH / 2, HEIGHT / 2 + 100);
}

function drawTake(g, colors, take, index, count, video, progress) {
  drawBlank(g, colors);
  if (video?.videoWidth) {
    const scale = Math.min(WIDTH / video.videoWidth, HEIGHT / video.videoHeight);
    const w = video.videoWidth * scale;
    const hgt = video.videoHeight * scale;
    g.fillStyle = '#000';
    g.fillRect(0, 0, WIDTH, HEIGHT);
    g.drawImage(video, (WIDTH - w) / 2, (HEIGHT - hgt) / 2, w, hgt);
  } else if (!video) {
    paintWave(g, take.takeBuffer, progress, {
      x: 60, y: HEIGHT * 0.25, width: WIDTH - 120, height: HEIGHT * 0.5, scale: 2,
      base: colors.wave, done: colors.waveProgress,
    });
  }

  g.textBaseline = 'middle';
  g.font = `600 28px ${colors.font}`;
  label(g, `${index + 1}/${count} · ${take.line.title}`, 24, 44, 'left', colors.text);
  label(g, take.player.name, WIDTH - 24, 44, 'right', take.player.color || colors.text);

  const text = take.prep.text;
  if (text) {
    g.font = `600 36px ${colors.font}`;
    const lines = text.split('\n');
    lines.forEach((line, i) => label(g, line, WIDTH / 2, HEIGHT - 50 - (lines.length - 1 - i) * 52, 'center', '#fff'));
  }
}

// Text on a dark plate, like the prompter subtitle on the stage.
function label(g, text, x, y, align, color) {
  const pad = 14;
  const w = Math.min(g.measureText(text).width, WIDTH - 80);
  const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  g.fillStyle = 'rgba(0, 0, 0, 0.72)';
  g.fillRect(left - pad, y - 24, w + pad * 2, 48);
  g.fillStyle = color;
  g.textAlign = align;
  g.fillText(text, x, y, WIDTH - 80);
}
