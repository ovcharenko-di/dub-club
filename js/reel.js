import { audioCtx, stopSource, seekVideo, Recorder } from './audio.js';
import { h, paintWave } from './ui.js';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const TAIL = 0.5; // seconds of footage kept after a stretch of lines, so late words are not cut
const MAX_GAP = 5; // longer gaps between lines of one video are cut out
const START_TIMEOUT = 3000; // ms to wait for the recorder to start
// While a line lasts, the original sound is ducked and its speech band cut, so the take is heard
// over the music and effects. Real voice removal would need source separation; this is the usual dub mix.
const DUCK_LEVEL = 0.35;
const VOICE_CUT_DB = -18;
const VOICE_FREQ = 1000; // Hz, centre of the cut; with Q 0.5 it spans roughly 250 Hz..4 kHz
const RAMP = 0.08; // s
export const MAX_VOICE_LEVEL = 4; // a quiet mic needs a boost; the limiter keeps it from clipping

/**
 * Splits takes into stretches of continuous footage. Lines of one video that follow each other
 * closely share a stretch, so the original plays on without pauses and the takes land on their lines.
 * The timeline depends only on the lines, so every player's takes fit the same one.
 */
export function buildTimeline(takes) {
  const segments = [];
  for (const take of takes) {
    const { videoUrl, start, end } = take.prep;
    const last = segments.at(-1);
    if (videoUrl && last?.videoUrl === videoUrl && start >= last.from && start - last.to <= MAX_GAP) {
      last.to = Math.max(last.to, end);
      last.takes.push(take);
    } else {
      segments.push({ videoUrl, from: start, to: end, takes: [take] });
    }
  }
  let at = 0;
  for (const seg of segments) {
    seg.at = at;
    seg.length = seg.to - seg.from + TAIL;
    at += seg.length;
    // A take plays from its line's start until the next line starts or the stretch ends.
    seg.slots = seg.takes.map((take, i) => {
      const offset = take.prep.start - seg.from;
      const next = seg.takes[i + 1];
      const until = next ? next.prep.start - seg.from : seg.length;
      return { take, offset, until: Math.min(until, offset + take.takeBuffer.duration), lineEnd: take.prep.end - seg.from };
    });
  }
  return { segments, total: at };
}

/**
 * A player's "reel": the original footage of the lines with the player's takes in place of
 * the voice; the original sound is kept, ducked under the takes. Audio lines show the take's waveform. The canvas can be recorded into a video file.
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
  let sources = [];
  let position = 0;
  let original = null;
  let voiceLevel = 1;
  let voiceGain = null; // of the current playback, so the level can change while it plays

  // Built on first use: createMediaElementSource can be called only once per element, after that
  // the element's sound goes only through the graph (and `muted` would silence it there too).
  function originalSound() {
    if (original) return original;
    const c = audioCtx();
    const source = c.createMediaElementSource(video);
    video.muted = false;
    const voice = c.createBiquadFilter();
    voice.type = 'peaking';
    voice.frequency.value = VOICE_FREQ;
    voice.Q.value = 0.5;
    voice.gain.value = 0;
    const level = c.createGain();
    source.connect(voice).connect(level);
    original = { voice, level };
    return original;
  }

  // Ducks the original sound over the lines of a stretch, on the audio clock from `t0`.
  function scheduleDucking(seg, local, t0) {
    const { voice, level } = originalSound();
    const windows = [];
    for (const { offset, lineEnd } of seg.slots) {
      const from = t0 + offset - local, to = t0 + lineEnd - local;
      if (to <= t0) continue;
      const last = windows.at(-1);
      if (last && from - last.to < RAMP * 2) last.to = Math.max(last.to, to);
      else windows.push({ from, to });
    }
    for (const [param, normal, ducked] of [[level.gain, 1, DUCK_LEVEL], [voice.gain, 0, VOICE_CUT_DB]]) {
      param.cancelScheduledValues(0);
      param.setValueAtTime(normal, t0);
      for (const { from, to } of windows) {
        param.setValueAtTime(normal, Math.max(t0, from - RAMP));
        param.linearRampToValueAtTime(ducked, Math.max(t0, from));
        param.setValueAtTime(ducked, to);
        param.linearRampToValueAtTime(normal, to + RAMP);
      }
    }
  }

  // The pending frame is left to run: it sees the new token and settles its promise.
  function stop() {
    token++;
    sources.forEach(stopSource);
    sources = [];
    video.pause();
  }

  // Runs `draw(elapsed)` every frame for `length` seconds; false if stopped meanwhile.
  function animate(my, t0, length, draw) {
    const c = audioCtx();
    return new Promise((resolve) => {
      const tick = () => {
        if (my !== token) return resolve(false);
        const elapsed = Math.min(length, Math.max(0, c.currentTime - t0));
        draw(elapsed);
        if (elapsed >= length) return resolve(true);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  /**
   * Play `takes` ({ player, line, prep, takeBuffer }) over the original footage, starting
   * `from` seconds into the reel. With `record`, resolves to the recorded video Blob
   * (null if stopped early).
   */
  async function play(takes, { record = false, from = 0 } = {}) {
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

    // Takes go through their own gain and a limiter: boosting a quiet take must not distort a loud one.
    voiceGain = c.createGain();
    voiceGain.gain.value = voiceLevel;
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    voiceGain.connect(limiter).connect(out);

    const { segments, total } = buildTimeline(takes);
    const withOriginal = segments.some((seg) => seg.videoUrl);
    if (withOriginal) originalSound().level.connect(out);
    const player = takes[0]?.player;
    from = Math.min(Math.max(0, from), total);
    const setProgress = (at) => {
      position = at;
      progress.style.width = `${Math.min(100, (at / total) * 100)}%`;
    };

    const localOf = (seg) => Math.max(0, from - seg.at);
    const draw = (seg, at) => {
      const slot = seg.slots.find((s) => at >= s.offset && at < Math.max(s.lineEnd, s.until)) || null;
      drawFrame(g, colors, { seg, slot, at, video: seg.videoUrl ? video : null, index: takes.indexOf(slot?.take), count: takes.length, player });
    };
    const seek = async (seg, local) => {
      if (!seg.videoUrl) return;
      if (video.src !== seg.videoUrl) video.src = seg.videoUrl;
      await seekVideo(video, seg.from + local);
    };
    // Keeps showing the same frame; a canvas stream emits frames only when the canvas changes.
    const hold = async (seg, at, until) => {
      for (let n = 0; my === token && !until(); n++) {
        draw(seg, at);
        g.fillStyle = `rgba(0, 0, 0, ${0.01 + (n % 2) * 0.01})`;
        g.fillRect(0, 0, 1, 1);
        await new Promise(requestAnimationFrame);
      }
      return my === token;
    };

    const playSegment = async (seg) => {
      const local = localOf(seg);
      if (seg.videoUrl) {
        try {
          await seek(seg, local);
          if (my !== token) return false;
          await video.play();
        } catch (err) {
          console.warn('Reel: cannot play video', err);
        }
        if (my !== token) return false;
      }
      // Scheduled on the audio clock in one go, so takes stay in place whatever the frame rate.
      const t0 = c.currentTime;
      if (seg.videoUrl) scheduleDucking(seg, local, t0);
      for (const { take, offset, until } of seg.slots) {
        if (until <= local) continue;
        const skip = Math.max(0, local - offset);
        const source = c.createBufferSource();
        source.buffer = take.takeBuffer;
        source.connect(voiceGain);
        source.start(t0 + Math.max(0, offset - local), skip, until - offset - skip);
        sources.push(source);
      }
      const ok = await animate(my, t0, seg.length - local, (t) => {
        draw(seg, local + t);
        setProgress(seg.at + local + t);
      });
      video.pause();
      sources.forEach(stopSource);
      sources = [];
      return ok;
    };

    const playing = segments.filter((seg) => from < seg.at + seg.length);
    let finished = true, blob = null;
    try {
      if (recorder && playing.length) {
        // A cold encoder takes a second or more to start, and the file would open with a frozen
        // frame for that long. Warm it with a throwaway recorder, then start the real one paused
        // and resume it exactly when playback begins. Meanwhile show the first frame: a canvas
        // stream may not start until a frame is drawn.
        const first = playing[0];
        const showFirst = (until) => hold(first, localOf(first), until);
        await seek(first, localOf(first)).catch((err) => console.warn('Reel: cannot seek video', err));
        const warm = new Recorder(recorder.stream, 'video', recorder.options);
        const warmed = flag(warm.start());
        const giveUp = performance.now() + START_TIMEOUT;
        finished = await showFirst(() => warmed.done || performance.now() > giveUp);
        if (!warmed.done) console.warn('Reel: recorder did not report start in time');
        await warm.stop();
        if (finished) {
          recorder.start();
          const paused = flag(new Promise((resolve) => { recorder.rec.onpause = resolve; }));
          recorder.rec.pause();
          const pauseBy = performance.now() + START_TIMEOUT;
          finished = await showFirst(() => paused.done || performance.now() > pauseBy);
          if (!paused.done) console.warn('Reel: recorder did not pause in time');
          if (recorder.rec.state === 'paused') recorder.rec.resume();
        }
      }
      for (const seg of playing) {
        if (!finished) break;
        finished = await playSegment(seg);
      }
    } finally {
      blob = await recorder?.stop();
      out.disconnect();
      if (withOriginal) original.level.disconnect(out);
    }
    if (finished) setProgress(0);
    return finished ? blob || null : null;
  }

  // Loudness of the takes, 1 = as recorded; applies at once, including to a recording in progress.
  function setVoiceLevel(level) {
    voiceLevel = level;
    voiceGain?.gain.setTargetAtTime(level, audioCtx().currentTime, 0.02);
  }

  drawBlank(g, readColors());
  // `position` is where the reel is now, in seconds: switching tracks resumes from there.
  return { el, play, stop, setVoiceLevel, get position() { return position; } };
}

// A promise's state, readable in a frame loop.
function flag(promise) {
  const state = { done: false };
  promise.then(() => { state.done = true; });
  return state;
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

function drawFrame(g, colors, { seg, slot, at, video, index, count, player }) {
  drawBlank(g, colors);
  if (video?.videoWidth) {
    const scale = Math.min(WIDTH / video.videoWidth, HEIGHT / video.videoHeight);
    const w = video.videoWidth * scale;
    const hgt = video.videoHeight * scale;
    g.fillStyle = '#000';
    g.fillRect(0, 0, WIDTH, HEIGHT);
    g.drawImage(video, (WIDTH - w) / 2, (HEIGHT - hgt) / 2, w, hgt);
  } else if (!video) {
    const { take, offset } = slot || seg.slots[0];
    paintWave(g, take.takeBuffer, Math.min(1, Math.max(0, at - offset) / take.takeBuffer.duration), {
      x: 60, y: HEIGHT * 0.25, width: WIDTH - 120, height: HEIGHT * 0.5, scale: 2,
      base: colors.wave, done: colors.waveProgress,
    });
  }

  g.textBaseline = 'middle';
  g.font = `600 28px ${colors.font}`;
  if (slot) label(g, `${index + 1}/${count} · ${slot.take.line.title}`, 24, 44, 'left', colors.text);
  if (player) label(g, player.name, WIDTH - 24, 44, 'right', player.color || colors.text);

  // The subtitle shows only while its line lasts, like the prompter on the stage.
  const text = slot && at < slot.lineEnd && slot.take.prep.text;
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
