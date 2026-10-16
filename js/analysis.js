// Voice analysis: pitch (YIN), loudness envelope and a DTW-based comparison
// between the reference line and a player's take.

const SR = 16000;
const WINDOW = 400;      // 25 ms
const HOP = 320;         // 20 ms → 50 frames per second
const MIN_LAG = 16;      // 1000 Hz
const MAX_LAG = 229;     // ~70 Hz
const YIN_THRESHOLD = 0.15;
const ABS_SILENCE = 0.004;

async function toMono16k(buffer) {
  const length = Math.max(1, Math.ceil(buffer.duration * SR));
  const off = new OfflineAudioContext(1, length, SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

function yinPitch(x, offset, d) {
  for (let tau = 1; tau <= MAX_LAG; tau++) {
    let sum = 0;
    for (let j = 0; j < WINDOW; j++) {
      const diff = x[offset + j] - x[offset + j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  let running = 0;
  for (let tau = 1; tau <= MAX_LAG; tau++) {
    running += d[tau];
    d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  for (let tau = MIN_LAG; tau < MAX_LAG; tau++) {
    if (d[tau] >= YIN_THRESHOLD) continue;
    while (tau + 1 < MAX_LAG && d[tau + 1] < d[tau]) tau++;
    const a = d[tau - 1], b = d[tau], c = d[tau + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? Math.max(-1, Math.min(1, (0.5 * (a - c)) / den)) : 0;
    return SR / (tau + shift);
  }
  return 0;
}

function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Extract per-frame features from an AudioBuffer.
 * Leading/trailing silence is trimmed so timing offsets don't matter.
 */
export async function extractFeatures(buffer) {
  const x = await toMono16k(buffer);
  const frames = Math.floor((x.length - WINDOW - MAX_LAG) / HOP) + 1;
  if (frames < 3) return { empty: true, peak: 0 };

  const rms = new Float32Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const off = i * HOP;
    for (let j = 0; j < WINDOW; j++) sum += x[off + j] * x[off + j];
    rms[i] = Math.sqrt(sum / WINDOW);
    if (rms[i] > peak) peak = rms[i];
  }

  const trimGate = Math.max(ABS_SILENCE, peak * 0.15);
  let first = -1, last = -1;
  for (let i = 0; i < frames; i++) {
    if (rms[i] >= trimGate) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0 || peak < ABS_SILENCE) return { empty: true, peak };
  first = Math.max(0, first - 2);
  last = Math.min(frames - 1, last + 2);

  const voiceGate = Math.max(ABS_SILENCE, peak * 0.1);
  const d = new Float32Array(MAX_LAG + 1);
  const env = [];
  const rawMidi = [];
  for (let i = first; i <= last; i++) {
    env.push(rms[i] / peak);
    let midi = NaN;
    if (rms[i] >= voiceGate) {
      const f0 = yinPitch(x, i * HOP, d);
      if (f0 > 0) midi = 69 + 12 * Math.log2(f0 / 440);
    }
    rawMidi.push(midi);
  }

  // Median smoothing over voiced neighbours removes octave glitches.
  const midi = rawMidi.map((v, i) => {
    if (Number.isNaN(v)) return v;
    const near = [];
    for (let k = Math.max(0, i - 2); k <= Math.min(rawMidi.length - 1, i + 2); k++) {
      if (!Number.isNaN(rawMidi[k])) near.push(rawMidi[k]);
    }
    return median(near);
  });

  const voiced = midi.filter((v) => !Number.isNaN(v));
  return {
    empty: false,
    env,
    midi,
    frames: env.length,
    duration: (env.length * HOP) / SR,
    peak,
    voicedFrac: voiced.length / env.length,
    medianMidi: median(voiced),
  };
}

function pearson(a, b) {
  const n = a.length;
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/**
 * Compare a take with the reference. Returns metrics in 0..1
 * (higher is better) or { silent: true } when nothing was heard.
 */
export function compare(ref, take) {
  if (take.empty || take.peak < 0.006 || take.frames < 5) return { silent: true };
  if (ref.empty) return { silent: true };

  const n = ref.frames, m = take.frames;
  const relA = ref.midi.map((v) => v - ref.medianMidi);
  const relB = take.midi.map((v) => v - take.medianMidi);

  const cost = (i, j) => {
    const va = !Number.isNaN(relA[i]), vb = !Number.isNaN(relB[j]);
    let pc = 0;
    if (va && vb) pc = Math.min(Math.abs(relA[i] - relB[j]), 12) / 6;
    else if (va !== vb) pc = 0.6;
    return 1.5 * Math.abs(ref.env[i] - take.env[j]) + pc;
  };

  const W = m + 1;
  const INF = 1e30;
  const D = new Float64Array((n + 1) * W).fill(INF);
  D[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const best = Math.min(D[(i - 1) * W + j], D[i * W + j - 1], D[(i - 1) * W + j - 1]);
      D[i * W + j] = cost(i - 1, j - 1) + best;
    }
  }

  const path = [];
  let i = n, j = m;
  for (;;) {
    path.push([i - 1, j - 1]);
    if (i === 1 && j === 1) break;
    const diag = i > 1 && j > 1 ? D[(i - 1) * W + j - 1] : INF;
    const up = i > 1 ? D[(i - 1) * W + j] : INF;
    const left = j > 1 ? D[i * W + j - 1] : INF;
    if (diag <= up && diag <= left) { i--; j--; }
    else if (up <= left) i--;
    else j--;
  }

  let semiSum = 0, semiCount = 0, agree = 0, active = 0, warp = 0;
  const envA = [], envB = [];
  for (const [a, b] of path) {
    const va = !Number.isNaN(relA[a]), vb = !Number.isNaN(relB[b]);
    if (va && vb) { semiSum += Math.min(Math.abs(relA[a] - relB[b]), 12); semiCount++; }
    if (Math.max(ref.env[a], take.env[b]) > 0.1) { active++; if (va === vb) agree++; }
    envA.push(ref.env[a]);
    envB.push(take.env[b]);
    warp += Math.abs(a / Math.max(1, n - 1) - b / Math.max(1, m - 1));
  }
  warp /= path.length;

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const voicing = active ? agree / active : 0;
  const refHasPitch = ref.voicedFrac > 0.1;

  return {
    silent: false,
    contour: refHasPitch ? (semiCount > 5 ? Math.exp(-(semiSum / semiCount) / 4) : 0.1) : voicing,
    level: Number.isFinite(ref.medianMidi) && Number.isFinite(take.medianMidi)
      ? Math.exp(-Math.abs(ref.medianMidi - take.medianMidi) / 8)
      : 0.4,
    voicing,
    envelope: clamp01(pearson(envA, envB)),
    duration: Math.exp(-2 * Math.abs(Math.log(take.duration / ref.duration))),
    warp: Math.exp(-8 * warp),
    loudness: clamp01(take.peak / 0.15),
    pitchDiff: semiCount ? semiSum / semiCount : null,
    levelDiff: take.medianMidi - ref.medianMidi,
    durationRatio: take.duration / ref.duration,
  };
}
