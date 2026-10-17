let ctx = null;

export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

let micStream = null;

export async function getMic() {
  if (micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live')) return micStream;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Браузер не даёт доступ к микрофону. Откройте страницу по https или через localhost.');
  }
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
  });
  return micStream;
}

export function micErrorMessage(err) {
  if (err?.name === 'NotAllowedError') return 'Нет доступа к микрофону — разрешите его в настройках браузера.';
  if (err?.name === 'NotFoundError') return 'Микрофон не найден.';
  return err?.message || 'Не удалось включить микрофон.';
}

export function pickMime(kind) {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = kind === 'video'
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

export class Recorder {
  constructor(stream, kind = 'audio', options = {}) {
    this.stream = stream;
    this.kind = kind;
    this.options = options;
  }

  start() {
    const mimeType = pickMime(this.kind);
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, { ...this.options, ...(mimeType ? { mimeType } : {}) });
    this.started = new Promise((resolve) => { this.rec.onstart = resolve; });
    this.done = new Promise((resolve) => {
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.rec.mimeType || mimeType }));
    });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start();
    return this.started;
  }

  stop() {
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    return this.done;
  }
}

export async function decode(source) {
  const data = source instanceof Blob ? await source.arrayBuffer() : source;
  return audioCtx().decodeAudioData(data);
}

export function sliceBuffer(buffer, start = 0, end = buffer.duration) {
  const sr = buffer.sampleRate;
  const from = Math.max(0, Math.floor(start * sr));
  const to = Math.min(buffer.length, Math.ceil(end * sr));
  const length = Math.max(1, to - from);
  const out = audioCtx().createBuffer(buffer.numberOfChannels, length, sr);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.copyToChannel(buffer.getChannelData(ch).subarray(from, from + length), ch);
  }
  return out;
}

/** Play an AudioBuffer. Returns { source, startedAt, ended: Promise }. */
export function playBuffer(buffer, { destination } = {}) {
  const c = audioCtx();
  const source = c.createBufferSource();
  source.buffer = buffer;
  source.connect(destination || c.destination);
  const ended = new Promise((resolve) => { source.onended = resolve; });
  const startedAt = c.currentTime;
  source.start();
  return { source, startedAt, ended };
}

export function stopSource(source) {
  try { source?.stop(); } catch { /* already stopped */ }
}

export function beep(freq = 660, duration = 0.15) {
  const c = audioCtx();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.2, c.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + duration);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + duration + 0.02);
}

/** Drive a level meter element from a mic stream. Returns a stop function. */
export function startMeter(stream, barEl, onLevel) {
  const c = audioCtx();
  const src = c.createMediaStreamSource(stream);
  const analyser = c.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let raf = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    const rms = Math.sqrt(sum / data.length);
    barEl.style.width = `${Math.min(100, rms * 400)}%`;
    onLevel?.(rms);
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    src.disconnect();
    barEl.style.width = '0';
  };
}

export function waitEvent(target, event) {
  return new Promise((resolve) => target.addEventListener(event, resolve, { once: true }));
}

export async function seekVideo(video, time) {
  if (video.readyState < 1) await waitEvent(video, 'loadedmetadata');
  if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) return;
  const seeked = waitEvent(video, 'seeked');
  video.currentTime = time;
  await seeked;
}
