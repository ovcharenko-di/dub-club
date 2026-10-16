import { decode, sliceBuffer } from './audio.js';

// ---------- Built-in demo pack: synthesized "voice tricks" ----------

const VOWELS = { a: [800, 1200], o: [500, 900], u: [350, 700], i: [300, 2300], e: [450, 1900] };

// Each syllable: v = vowel, d = duration (s), f = pitch points (Hz), gap = pause after, vib = vibrato (cents).
const s = (v, d, f, extra = {}) => ({ v, d, f: Array.isArray(f) ? f : [f], ...extra });

const DEMO_LINES = [
  { title: 'Удивлённое «Ооо!»', hint: 'Протяните «о-о-о» с подъёмом вверх.', syllables: [s('o', 1.1, [170, 200, 330])] },
  { title: 'Вопрос «А?»', hint: 'Короткое переспрашивающее «а?» с подъёмом.', syllables: [s('a', 0.45, [180, 300])] },
  {
    title: 'Злодейский смех',
    hint: '«Ха-ха-ха-ха-ха… хааа», каждый слог ниже предыдущего.',
    syllables: [
      s('a', 0.18, [300, 290], { gap: 0.07 }), s('a', 0.18, [270, 260], { gap: 0.07 }),
      s('a', 0.18, [240, 230], { gap: 0.07 }), s('a', 0.18, [215, 205], { gap: 0.07 }),
      s('a', 0.6, [190, 120], { vib: 30 }),
    ],
  },
  { title: 'Сирена', hint: '«У-у-у-у» вверх-вниз, как скорая помощь.', syllables: [s('u', 2.4, [300, 560, 300, 560, 300])] },
  {
    title: 'Робот «Бип-буп-бип»',
    hint: 'Ровно, без интонации: высокий — низкий — высокий.',
    syllables: [s('i', 0.18, 440, { gap: 0.12 }), s('u', 0.18, 330, { gap: 0.12 }), s('i', 0.25, 440)],
  },
  { title: 'Зевок', hint: '«А-а-а-оу…» — вверх и медленно вниз.', syllables: [s('a', 0.6, [200, 360]), s('o', 1.0, [360, 150])] },
  {
    title: 'Ля-ля-ля',
    hint: 'Пропойте мелодию: до-ре-ми-до.',
    syllables: [
      s('a', 0.3, 262, { gap: 0.06 }), s('a', 0.3, 294, { gap: 0.06 }),
      s('a', 0.3, 330, { gap: 0.06 }), s('a', 0.5, 262, { vib: 25 }),
    ],
  },
  { title: 'Грустное «Эээх»', hint: 'Тяжёлый вздох сверху вниз.', syllables: [s('e', 1.2, [230, 140], { vib: 15 })] },
  {
    title: 'Оперное «Ааа!»',
    hint: 'Длинная нота с вибрато, в конце — вверх.',
    syllables: [s('a', 1.4, [330, 330, 330, 440], { vib: 60 })],
  },
];

async function synthesize(syllables) {
  const sr = 44100;
  const total = 0.1 + syllables.reduce((t, x) => t + x.d + (x.gap || 0), 0) + 0.2;
  const off = new OfflineAudioContext(1, Math.ceil(total * sr), sr);

  const osc = off.createOscillator();
  osc.type = 'sawtooth';
  const lfo = off.createOscillator();
  lfo.frequency.value = 5.5;
  const lfoDepth = off.createGain();
  lfoDepth.gain.value = 0;
  lfo.connect(lfoDepth).connect(osc.detune);

  const amp = off.createGain();
  amp.gain.value = 0;
  const f1 = off.createBiquadFilter();
  f1.type = 'bandpass';
  f1.Q.value = 5;
  const f2 = off.createBiquadFilter();
  f2.type = 'bandpass';
  f2.Q.value = 8;
  const f2Gain = off.createGain();
  f2Gain.gain.value = 0.5;
  const out = off.createGain();

  osc.connect(amp);
  amp.connect(f1).connect(out);
  amp.connect(f2).connect(f2Gain).connect(out);
  out.connect(off.destination);

  let t = 0.1;
  for (const syl of syllables) {
    const pts = syl.f;
    osc.frequency.setValueAtTime(pts[0], t);
    const seg = syl.d / Math.max(1, pts.length - 1);
    for (let k = 1; k < pts.length; k++) osc.frequency.linearRampToValueAtTime(pts[k], t + seg * k);
    const [F1, F2] = VOWELS[syl.v];
    f1.frequency.setValueAtTime(F1, t);
    f2.frequency.setValueAtTime(F2, t);
    lfoDepth.gain.setValueAtTime(syl.vib || 0, t);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(1, t + 0.03);
    amp.gain.setValueAtTime(1, t + syl.d - 0.06);
    amp.gain.linearRampToValueAtTime(0, t + syl.d);
    t += syl.d + (syl.gap || 0);
  }
  osc.start(0);
  lfo.start(0);

  const rendered = await off.startRendering();
  const data = rendered.getChannelData(0);
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] *= 0.8 / peak;
  return rendered;
}

export const DEMO_PACK = {
  id: 'demo',
  name: 'Демо: голосовые трюки',
  builtin: true,
  lines: DEMO_LINES.map((line, i) => ({ id: `demo-${i}`, kind: 'synth', ...line })),
};

// ---------- Preparing lines for playback & analysis ----------

const prepared = new WeakMap();
const decodedBlobs = new WeakMap();
const videoUrls = new WeakMap();

/**
 * Decode the audio track of a (possibly long) media file once per Blob.
 * Video soundtracks are decoded at 16 kHz: they're only used for analysis
 * and waveforms (the video element plays the real sound), and it keeps memory low.
 */
export function decodeMedia(blob, { lowRate = false } = {}) {
  let cached = decodedBlobs.get(blob);
  if (!cached) {
    cached = lowRate
      ? blob.arrayBuffer().then((data) => new OfflineAudioContext(1, 1, 16000).decodeAudioData(data))
      : decode(blob);
    cached.catch(() => decodedBlobs.delete(blob));
    decodedBlobs.set(blob, cached);
  }
  return cached;
}

export function videoUrlFor(blob) {
  if (!videoUrls.has(blob)) videoUrls.set(blob, URL.createObjectURL(blob));
  return videoUrls.get(blob);
}

/** Returns { buffer, videoUrl, start, end, text } for a line (cached per line object). */
export async function prepareLine(line) {
  if (prepared.has(line)) return prepared.get(line);
  let result;
  if (line.kind === 'synth') {
    const buffer = await synthesize(line.syllables);
    result = { buffer, videoUrl: null, start: 0, end: buffer.duration };
  } else {
    const isVideo = line.kind === 'video';
    const full = await decodeMedia(line.blob, { lowRate: isVideo });
    const start = line.start || 0;
    const end = Math.min(full.duration, line.end || full.duration);
    result = {
      buffer: sliceBuffer(full, start, end),
      videoUrl: isVideo ? videoUrlFor(line.blob) : null,
      start,
      end,
    };
  }
  result.text = line.text || '';
  prepared.set(line, result);
  return result;
}

export function forgetPrepared(line) {
  prepared.delete(line);
}

// ---------- Custom packs in IndexedDB ----------

const DB_NAME = 'dub-club';
const STORE = 'packs';
const memoryFallback = new Map();

function openDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('IndexedDB недоступна'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req?.result); };
    // A quota failure aborts the transaction without an error event.
    tx.onabort = () => { db.close(); reject(tx.error || new DOMException('Transaction aborted', 'AbortError')); };
  });
}

function serializable(pack) {
  if (pack.type === 'video') {
    const { id, name, type, video, videoName, cues } = pack;
    return { id, name, type, video, videoName, cues: cues.map(({ id, start, end, text }) => ({ id, start, end, text })) };
  }
  return {
    id: pack.id,
    name: pack.name,
    lines: pack.lines.map(({ id, title, hint, kind, blob, start, end, duration }) => ({
      id, title, hint, kind, blob, start, end, duration,
    })),
  };
}

/** Video packs store one video + cues; the game wants a flat list of lines. */
function withLines(pack) {
  if (pack.type !== 'video') return pack;
  const lines = [...pack.cues]
    .sort((a, b) => a.start - b.start)
    .map((cue, i) => ({
      id: cue.id, kind: 'video', blob: pack.video, start: cue.start, end: cue.end,
      text: cue.text, title: `Реплика ${i + 1}`,
    }));
  return { ...pack, lines };
}

export async function listCustomPacks() {
  let stored = [];
  try {
    stored = (await withStore('readonly', (s) => s.getAll())) || [];
  } catch (err) {
    console.warn('Could not read stored packs:', err);
  }
  // Packs that failed to persist still live in memory for this session.
  const byId = new Map(stored.map((p) => [p.id, p]));
  for (const p of memoryFallback.values()) byId.set(p.id, p);
  return [...byId.values()].map(withLines);
}

/**
 * Save a pack. Returns { persisted: true } when it reached IndexedDB, or
 * { persisted: false, reason } when it is only kept until the page reloads.
 */
export async function saveCustomPack(pack) {
  const data = serializable(pack);
  try {
    navigator.storage?.persist?.().catch(() => {});
    await withStore('readwrite', (s) => s.put(data));
    memoryFallback.delete(data.id);
    return { persisted: true };
  } catch (err) {
    console.warn('Pack kept only for this session:', err);
    memoryFallback.set(data.id, data);
    const quota = err?.name === 'QuotaExceededError' || /quota/i.test(err?.message || '');
    return {
      persisted: false,
      reason: quota
        ? 'Браузеру не хватило места для видео (часто так бывает в режиме инкогнито).'
        : 'Браузер не дал сохранить данные.',
    };
  }
}

export function storageWarning(result) {
  return `${result.reason} Пак доступен до перезагрузки страницы — скачайте файл пака, чтобы не потерять его.`;
}

export async function deleteCustomPack(id) {
  memoryFallback.delete(id);
  try { await withStore('readwrite', (s) => s.delete(id)); } catch { /* ignore */ }
}

export async function allPacks() {
  return [DEMO_PACK, ...(await listCustomPacks())];
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ---------- Pack files (export / import) ----------

const PACK_FORMAT = 'dub-club-pack';

export async function exportVideoPack(pack) {
  const { createZip } = await import('./zip.js');
  const { toSrt } = await import('./subtitles.js');
  const ext = (pack.videoName?.match(/\.[a-z0-9]+$/i)?.[0] || extForMime(pack.video.type)).toLowerCase();
  const videoFile = `video${ext}`;
  const cues = [...pack.cues].sort((a, b) => a.start - b.start);
  const manifest = {
    format: PACK_FORMAT,
    version: 1,
    name: pack.name,
    video: videoFile,
    videoType: pack.video.type,
    cues: cues.map(({ start, end, text }) => ({ start, end, text })),
  };
  return createZip([
    { name: 'pack.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'subtitles.srt', data: toSrt(cues) },
    { name: videoFile, data: pack.video },
  ]);
}

function extForMime(type) {
  if (type.includes('webm')) return '.webm';
  if (type.includes('ogg')) return '.ogv';
  if (type.includes('quicktime')) return '.mov';
  return '.mp4';
}

/** Import a pack .zip, save it and return the stored pack. */
export async function importVideoPack(file) {
  const { readZip } = await import('./zip.js');
  const files = await readZip(file);
  const manifestBlob = files.get('pack.json');
  if (!manifestBlob) throw new Error('В архиве нет pack.json — это не пак Dub Club.');
  const manifest = JSON.parse(await manifestBlob.text());
  if (manifest.format !== PACK_FORMAT) throw new Error('Неизвестный формат пака.');
  const videoBlob = files.get(manifest.video);
  if (!videoBlob) throw new Error('В архиве нет видео.');
  const pack = {
    id: newId(),
    name: manifest.name || file.name.replace(/\.[^.]+$/, ''),
    type: 'video',
    video: new Blob([videoBlob], { type: manifest.videoType || 'video/mp4' }),
    videoName: manifest.video,
    cues: (manifest.cues || [])
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
      .map((c) => ({ id: newId(), start: c.start, end: c.end, text: String(c.text || '') })),
  };
  pack.saveResult = await saveCustomPack(pack);
  return pack;
}
