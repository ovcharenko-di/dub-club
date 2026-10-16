import { h, mount, toast, countdown, downloadBlob } from '../ui.js';
import {
  audioCtx, getMic, micErrorMessage, Recorder, decode, sliceBuffer, playBuffer, stopSource,
  startMeter, seekVideo, pickMime,
} from '../audio.js';

// One <video> element for the whole app: createMediaElementSource can only be
// called once per element, and we need its audio routed through a gain node.
let shared = null;
function sharedVideo() {
  if (shared) return shared;
  const video = h('video', { playsInline: true, controls: true, preload: 'auto' });
  const c = audioCtx();
  const source = c.createMediaElementSource(video);
  const gain = c.createGain();
  source.connect(gain).connect(c.destination);
  shared = { video, gain };
  return shared;
}

export function dubScreen(nav) {
  const { video, gain } = sharedVideo();
  const state = { url: null, name: 'video', start: 0, end: 0, voice: null, voiceBlob: null, busy: false };
  let stopFn = null;

  const fileInput = h('input', { type: 'file', accept: 'video/*', class: 'hidden', onchange: () => load(fileInput.files[0]) });
  const startInput = h('input', { type: 'number', min: 0, step: 0.1, value: 0, onchange: () => setRange() });
  const endInput = h('input', { type: 'number', min: 0, step: 0.1, value: 0, onchange: () => setRange() });
  const bgInput = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: 0.15 });
  const meterBar = h('div');
  const meter = h('div', { class: 'meter hidden' }, meterBar);
  const progressBar = h('div');
  const status = h('p', { class: 'muted small' });

  const recordBtn = h('button', { class: 'rec big', onclick: record }, '🎙 Записать дубляж');
  const stopBtn = h('button', { class: 'big hidden', onclick: () => stopFn?.() }, '⏹ Стоп');
  const previewBtn = h('button', { onclick: preview }, '▶ Просмотр');
  const exportBtn = h('button', { class: 'primary', onclick: exportVideo }, '⬇ Скачать видео');
  const voiceBtn = h('button', { onclick: () => downloadBlob(state.voiceBlob, `dub-club-voice-${Date.now()}.${extFor(state.voiceBlob)}`) }, '⬇ Только голос');

  const editor = h('div', { class: 'stack hidden' },
    h('div', { class: 'stage' }, video),
    h('div', { class: 'progress' }, progressBar),
    meter,
    h('div', { class: 'row' },
      h('label', null, 'Начало, с', startInput),
      h('label', null, 'Конец, с', endInput),
      h('label', { class: 'grow' }, 'Громкость оригинала', bgInput)),
    h('div', { class: 'row' }, recordBtn, stopBtn),
    h('div', { class: 'row result hidden' }, previewBtn, exportBtn, voiceBtn),
    status);
  const resultRow = editor.querySelector('.result');

  function extFor(blob) {
    return blob?.type.includes('mp4') ? 'm4a' : blob?.type.includes('ogg') ? 'ogg' : 'webm';
  }

  function setBusy(busy) {
    state.busy = busy;
    video.controls = !busy;
    for (const el of [recordBtn, previewBtn, exportBtn, voiceBtn, startInput, endInput, fileInput]) el.disabled = busy;
  }

  async function load(file) {
    if (!file) return;
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = URL.createObjectURL(file);
    state.name = file.name.replace(/\.[^.]+$/, '');
    state.voice = state.voiceBlob = null;
    resultRow.classList.add('hidden');
    video.src = state.url;
    gain.gain.value = 1;
    try {
      await seekVideo(video, 0);
    } catch {
      return toast('Не удалось открыть видео', { error: true });
    }
    state.start = 0;
    state.end = video.duration;
    startInput.value = '0';
    endInput.value = video.duration.toFixed(1);
    startInput.max = endInput.max = video.duration;
    editor.classList.remove('hidden');
    status.textContent = 'Выберите отрезок и жмите «Записать». Совет: наденьте наушники, чтобы оригинал не попал в микрофон.';
  }

  function setRange() {
    const dur = video.duration || 0;
    state.start = Math.max(0, Math.min(dur - 0.5, Number(startInput.value) || 0));
    state.end = Math.max(state.start + 0.5, Math.min(dur, Number(endInput.value) || dur));
    startInput.value = state.start.toFixed(1);
    endInput.value = state.end.toFixed(1);
    seekVideo(video, state.start);
  }

  /** Play the selected segment; resolves when it ends or stopFn() is called. */
  async function playSegment(onStart) {
    await seekVideo(video, state.start);
    gain.gain.value = Number(bgInput.value);
    let resolveStop;
    const stopped = new Promise((resolve) => { resolveStop = resolve; });
    stopFn = resolveStop;
    stopBtn.classList.remove('hidden');
    await video.play();
    const extra = await onStart?.();
    let raf = 0;
    const tick = () => {
      const p = (video.currentTime - state.start) / (state.end - state.start);
      progressBar.style.width = `${Math.min(100, p * 100)}%`;
      if (video.currentTime >= state.end || video.ended) return resolveStop();
      raf = requestAnimationFrame(tick);
    };
    tick();
    await stopped;
    cancelAnimationFrame(raf);
    video.pause();
    stopFn = null;
    stopBtn.classList.add('hidden');
    gain.gain.value = 1;
    return extra;
  }

  async function record() {
    let stream;
    try {
      stream = await getMic();
    } catch (err) {
      return toast(micErrorMessage(err), { error: true });
    }
    setBusy(true);
    await countdown(3);
    const recorder = new Recorder(stream);
    await recorder.start();
    const recStarted = performance.now();
    const stopMeter = startMeter(stream, meterBar);
    meter.classList.remove('hidden');
    status.textContent = '🔴 Запись…';
    let videoStarted = recStarted;
    await playSegment(() => { videoStarted = performance.now(); });
    stopMeter();
    meter.classList.add('hidden');
    const blob = await recorder.stop();
    try {
      const raw = await decode(blob);
      const offset = Math.max(0, (videoStarted - recStarted) / 1000);
      state.voice = sliceBuffer(raw, offset, raw.duration);
      state.voiceBlob = blob;
      resultRow.classList.remove('hidden');
      status.textContent = 'Готово! Посмотрите результат или перезапишите.';
    } catch (err) {
      console.error(err);
      toast('Не удалось обработать запись', { error: true });
      status.textContent = '';
    }
    setBusy(false);
  }

  async function preview() {
    if (!state.voice) return;
    setBusy(true);
    let voice = null;
    await playSegment(() => { voice = playBuffer(state.voice).source; });
    stopSource(voice);
    setBusy(false);
  }

  async function exportVideo() {
    if (!state.voice) return;
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
      return toast('Этот браузер не умеет записывать видео. Попробуйте Chrome или Firefox.', { error: true });
    }
    setBusy(true);
    status.textContent = '⏺ Собираем видео… Не переключайте вкладку.';
    const c = audioCtx();
    const canvas = h('canvas', { width: video.videoWidth || 1280, height: video.videoHeight || 720 });
    const g = canvas.getContext('2d');
    const dest = c.createMediaStreamDestination();
    gain.connect(dest);
    const voiceGain = c.createGain();
    voiceGain.connect(dest);
    voiceGain.connect(c.destination);

    const stream = canvas.captureStream(30);
    for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
    const recorder = new Recorder(stream, 'video', { videoBitsPerSecond: 5_000_000 });

    let raf = 0;
    let voice = null;
    const draw = () => {
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      raf = requestAnimationFrame(draw);
    };
    await seekVideo(video, state.start);
    draw();
    await recorder.start();
    await playSegment(() => {
      voice = c.createBufferSource();
      voice.buffer = state.voice;
      voice.connect(voiceGain);
      voice.start();
    });
    cancelAnimationFrame(raf);
    stopSource(voice);
    const blob = await recorder.stop();
    gain.disconnect(dest);
    voiceGain.disconnect();
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    downloadBlob(blob, `dub-club-${state.name}.${ext}`);
    status.textContent = `Видео сохранено (${ext.toUpperCase()}).`;
    setBusy(false);
  }

  mount(h('section', { class: 'screen' },
    h('div', { class: 'topbar' }, h('h2', null, '🎬 Режим дубляжа'), h('button', { onclick: nav.menu }, '← Меню')),
    h('div', { class: 'card stack' },
      h('p', null, 'Загрузите видео, выберите отрезок и озвучьте его своим голосом. ',
        'Оригинальный звук можно приглушить или оставить фоном. Результат скачивается как видеофайл.'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => fileInput.click() }, '📁 Выбрать видео'), fileInput),
      editor),
  ), () => {
    stopFn?.();
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (state.url) URL.revokeObjectURL(state.url);
  });
  if (!pickMime('video')) status.textContent = 'Внимание: запись видео может не поддерживаться этим браузером.';
}
