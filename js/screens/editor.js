import { h, mount, toast, downloadBlob } from '../ui.js';
import { Timeline } from '../timeline.js';
import { parseSubtitles, toSrt, formatTimecode } from '../subtitles.js';
import { decodeMedia, videoUrlFor, saveCustomPack, exportVideoPack, newId, storageWarning, MAX_FULL_DECODE } from '../packs.js';

const DEFAULT_CUE = 2;     // seconds, for cues created by key/button
const LONG_CUE = 20;       // warn above this

const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
const safeName = (name) => (name || 'pack').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'pack';

/**
 * Subtitle / line editor for video packs.
 * `existing` — a stored video pack to edit; omit to start from a new video.
 */
export function editorScreen(nav, existing = null) {
  const pack = existing
    ? { ...existing, cues: existing.cues.map((c) => ({ ...c })) }
    : { id: newId(), name: '', type: 'video', video: null, videoName: '', cues: [] };
  let saved = true;
  let playUntil = null;
  let raf = 0;
  let listSignature = '';
  let audioDuration = 0;

  const markDirty = () => { saved = false; };
  const sortedCues = () => [...pack.cues].sort((a, b) => a.start - b.start);
  const selected = () => pack.cues.find((c) => c.id === timeline.selectedId) || null;
  // MediaRecorder WebM files report duration = Infinity; fall back to the decoded audio length.
  const duration = () => (Number.isFinite(video.duration) ? video.duration : audioDuration);

  // ---------- Elements ----------
  const video = h('video', { playsInline: true, preload: 'auto' });
  const overlay = h('div', { class: 'subtitle hidden' });
  const timeLabel = h('span', { class: 'pill mono' }, '0:00.0');
  const playBtn = h('button', { class: 'icon', title: 'Пробел', onclick: togglePlay }, '▶');
  const canvas = h('canvas', { class: 'timeline-canvas' });
  const list = h('div', { class: 'stack' });
  const counter = h('span', { class: 'muted small' });
  const nameInput = h('input', {
    type: 'text', value: pack.name, maxLength: 60, placeholder: 'Название пака',
    oninput: () => { pack.name = nameInput.value; markDirty(); },
  });

  const videoInput = h('input', { type: 'file', accept: 'video/*', class: 'hidden', onchange: () => loadVideo(videoInput.files[0]) });
  const subsInput = h('input', {
    type: 'file', accept: '.srt,.vtt,text/vtt,application/x-subrip', class: 'hidden',
    onchange: () => importSubtitles(subsInput.files[0]),
  });

  const timeline = new Timeline(canvas, {
    getCues: () => pack.cues,
    getTime: () => video.currentTime || 0,
    getDuration: duration,
    onSeek: (t) => seek(t),
    onSelect: (id) => {
      renderList();
      list.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    onCreate: (start, end) => {
      const cue = { id: newId(), start, end, text: '' };
      pack.cues.push(cue);
      markDirty();
      return cue;
    },
    onChange: () => { markDirty(); renderList(true); },
  });

  // ---------- Playback ----------
  function seek(t) {
    playUntil = null;
    video.currentTime = Math.max(0, Math.min(duration(), t));
    timeline.dirty = true;
  }

  function togglePlay() {
    if (!video.src) return;
    playUntil = null;
    if (video.paused) video.play(); else video.pause();
  }

  function playCue(cue) {
    if (!cue) return;
    video.currentTime = cue.start;
    playUntil = cue.end;
    video.play();
  }

  function frame() {
    const t = video.currentTime || 0;
    if (playUntil != null && t >= playUntil) {
      video.pause();
      playUntil = null;
    }
    if (!video.paused) {
      timeline.follow(t);
      timeline.dirty = true;
    }
    playBtn.textContent = video.paused ? '▶' : '⏸';
    timeLabel.textContent = `${formatTimecode(t, '.').slice(3, 10)} / ${formatTimecode(duration(), '.').slice(3, 8)}`;
    const current = pack.cues.find((c) => t >= c.start && t < c.end);
    overlay.textContent = current?.text || '';
    overlay.classList.toggle('hidden', !current?.text);
    if (timeline.dirty) timeline.draw();
    raf = requestAnimationFrame(frame);
  }

  // ---------- Cue operations ----------
  function addCue(start, end) {
    const cue = { id: newId(), start, end: Math.min(duration(), end), text: '' };
    pack.cues.push(cue);
    select(cue);
    markDirty();
    renderList(true);
    return cue;
  }

  function select(cue, { focusText = false } = {}) {
    timeline.selectedId = cue?.id ?? null;
    timeline.dirty = true;
    if (cue && (cue.start < timeline.viewStart || cue.end > timeline.viewStart + timeline.viewLength)) {
      timeline.viewStart = cue.start - timeline.viewLength * 0.2;
      timeline.clampView();
    }
    renderList();
    if (focusText && cue) list.querySelector(`[data-id="${cue.id}"] textarea`)?.focus();
  }

  function markIn() {
    const t = video.currentTime;
    addCue(t, t + DEFAULT_CUE);
  }

  function markOut() {
    const cue = selected();
    const t = video.currentTime;
    if (!cue) return toast('Сначала выберите реплику или отметьте начало ([)');
    if (t <= cue.start + 0.2) return toast('Конец должен быть позже начала');
    cue.end = t;
    timeline.dirty = true;
    markDirty();
    renderList(true);
  }

  function splitAtPlayhead() {
    const t = video.currentTime;
    const cue = pack.cues.find((c) => t > c.start + 0.2 && t < c.end - 0.2);
    if (!cue) return toast('Курсор должен стоять внутри реплики');
    const rest = { id: newId(), start: t, end: cue.end, text: '' };
    cue.end = t;
    pack.cues.push(rest);
    select(rest);
    markDirty();
    renderList(true);
  }

  function removeCue(cue) {
    pack.cues = pack.cues.filter((c) => c !== cue);
    if (timeline.selectedId === cue.id) timeline.selectedId = null;
    timeline.dirty = true;
    markDirty();
    renderList(true);
  }

  function mergeWithNext(cue) {
    const cues = sortedCues();
    const next = cues[cues.indexOf(cue) + 1];
    if (!next) return;
    cue.end = Math.max(cue.end, next.end);
    cue.text = [cue.text, next.text].filter(Boolean).join('\n');
    pack.cues = pack.cues.filter((c) => c !== next);
    timeline.dirty = true;
    markDirty();
    renderList(true);
  }

  // ---------- Cue list ----------
  function renderList(force = false) {
    const cues = sortedCues();
    counter.textContent = cues.length ? `${cues.length} реплик` : '';
    const signature = cues.map((c) => c.id).join();
    if (!force && signature === listSignature) {
      // Same cues: only move the highlight, keep inputs (and focus) intact.
      for (const row of list.querySelectorAll('.cue-row')) {
        row.classList.toggle('selected', row.dataset.id === timeline.selectedId);
      }
      return;
    }
    listSignature = signature;

    if (!cues.length) {
      list.replaceChildren(h('div', { class: 'empty' },
        'Реплик пока нет. Протяните мышью по таймлайну, нажмите «[» во время просмотра или импортируйте .srt/.vtt.'));
      return;
    }
    list.replaceChildren(...cues.map((cue, i) => {
      const timeField = (key) => h('input', {
        type: 'number', step: 0.01, min: 0, value: cue[key].toFixed(2), class: 'time-input',
        onfocus: () => { if (timeline.selectedId !== cue.id) select(cue); },
        onchange: (e) => {
          const v = Math.max(0, Math.min(duration() || Infinity, Number(e.target.value) || 0));
          if (key === 'start') cue.start = Math.min(v, cue.end - 0.2);
          else cue.end = Math.max(v, cue.start + 0.2);
          timeline.dirty = true;
          markDirty();
          renderList(true);
        },
      });
      const long = cue.end - cue.start > LONG_CUE;
      return h('div', {
        class: `cue-row${cue.id === timeline.selectedId ? ' selected' : ''}`,
        'data-id': cue.id,
      },
        h('div', { class: 'cue-head' },
          h('span', { class: 'cue-num' }, `#${i + 1}`),
          timeField('start'), h('span', { class: 'muted' }, '→'), timeField('end'),
          h('span', { class: `muted small${long ? ' warn' : ''}` },
            `${(cue.end - cue.start).toFixed(1)} с${long ? ' — длинновато' : ''}`),
          h('span', { class: 'grow' }),
          h('button', { class: 'icon', title: 'Проиграть (Enter)', onclick: () => { select(cue); playCue(cue); } }, '▶'),
          h('button', { class: 'icon', title: 'Объединить со следующей', disabled: i === cues.length - 1, onclick: () => mergeWithNext(cue) }, '⤵'),
          h('button', { class: 'icon danger', title: 'Удалить', onclick: () => removeCue(cue) }, '✕')),
        h('textarea', {
          rows: 2, value: cue.text, placeholder: 'Текст реплики (субтитр)',
          onfocus: () => { if (timeline.selectedId !== cue.id) select(cue); },
          oninput: (e) => { cue.text = e.target.value; timeline.dirty = true; markDirty(); },
        }));
    }));
  }

  // ---------- Files ----------
  function loadVideo(file) {
    if (!file) return;
    pack.video = file;
    pack.videoName = file.name;
    if (!pack.name.trim()) {
      pack.name = file.name.replace(/\.[^.]+$/, '');
      nameInput.value = pack.name;
    }
    markDirty();
    showEditor();
  }

  async function importSubtitles(file) {
    subsInput.value = '';
    if (!file) return;
    let cues;
    try {
      cues = parseSubtitles(await file.text());
    } catch (err) {
      console.error(err);
      return toast('Не удалось прочитать файл субтитров', { error: true });
    }
    if (!cues.length) return toast('В файле не найдено ни одного субтитра', { error: true });
    if (pack.cues.length && confirm('Заменить существующие реплики? (Отмена — добавить к ним)')) pack.cues = [];
    const dur = duration();
    for (const c of cues) {
      if (dur && c.start >= dur) continue;
      pack.cues.push({ id: newId(), start: c.start, end: dur ? Math.min(c.end, dur) : c.end, text: c.text });
    }
    timeline.dirty = true;
    markDirty();
    renderList(true);
    toast(`Импортировано субтитров: ${cues.length}`);
  }

  function validate() {
    if (!pack.video) return toast('Сначала загрузите видео', { error: true }), false;
    if (!pack.name.trim()) return toast('Назовите пак', { error: true }), false;
    if (!pack.cues.length) return toast('Добавьте хотя бы одну реплику', { error: true }), false;
    return true;
  }

  async function save() {
    if (!validate()) return;
    pack.name = pack.name.trim();
    const result = await saveCustomPack(pack);
    saved = true;
    if (result.persisted) toast('Пак сохранён — его можно выбрать в игре');
    else toast(storageWarning(result), { error: true, ms: 9000 });
  }

  async function exportPack() {
    if (!validate()) return;
    toast('Собираем файл пака…');
    try {
      downloadBlob(await exportVideoPack(pack), `${safeName(pack.name)}.dubpack.zip`);
    } catch (err) {
      console.error(err);
      toast('Не удалось собрать файл', { error: true });
    }
  }

  function exportSrt() {
    if (!pack.cues.length) return toast('Нет реплик для экспорта', { error: true });
    downloadBlob(new Blob([toSrt(pack.cues)], { type: 'text/plain' }), `${safeName(pack.name)}.srt`);
  }

  function leave(target) {
    if (!saved && !confirm('Есть несохранённые изменения. Уйти без сохранения?')) return;
    target();
  }

  // ---------- Keyboard ----------
  function onKey(e) {
    if (isTyping(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey || !video.src) return;
    const step = e.shiftKey ? 5 : 1;
    const actions = {
      ' ': togglePlay,
      '[': markIn,
      ']': markOut,
      'х': markIn,      // same physical keys on the Russian layout
      'ъ': markOut,
      s: splitAtPlayhead,
      'ы': splitAtPlayhead,
      Enter: () => playCue(selected()),
      Delete: () => selected() && removeCue(selected()),
      Backspace: () => selected() && removeCue(selected()),
      ArrowLeft: () => seek(video.currentTime - step),
      ArrowRight: () => seek(video.currentTime + step),
    };
    const action = actions[e.key] || actions[e.key.toLowerCase()];
    if (!action) return;
    e.preventDefault();
    action();
  }

  // ---------- Layout ----------
  const editor = h('div', { class: 'stack hidden' },
    h('div', { class: 'stage editor-stage' }, video, overlay),
    h('div', { class: 'row' },
      playBtn, timeLabel,
      h('button', { title: 'Начало реплики в позиции курсора ( [ )', onclick: markIn }, '[ Начало'),
      h('button', { title: 'Конец выбранной реплики ( ] )', onclick: markOut }, 'Конец ]'),
      h('button', { title: 'Разрезать реплику по курсору (S)', onclick: splitAtPlayhead }, '✂ Разрезать'),
      h('span', { class: 'grow' }),
      h('button', { class: 'icon', title: 'Отдалить', onclick: () => timeline.setZoom(timeline.pxPerSec / 1.5) }, '−'),
      h('button', { class: 'icon', title: 'Приблизить', onclick: () => timeline.setZoom(timeline.pxPerSec * 1.5) }, '＋')),
    h('div', { class: 'timeline' }, canvas),
    h('p', { class: 'muted small' },
      'Протяните по таймлайну, чтобы создать реплику; тяните края, чтобы подвинуть границы. ',
      'Клавиши: Пробел — пауза, [ и ] — начало/конец реплики во время просмотра, S — разрезать, ',
      'Enter — проиграть выбранную, ←/→ — перемотка, колесо — прокрутка, Ctrl+колесо — масштаб.'),
    h('div', { class: 'card stack' },
      h('div', { class: 'row spread' },
        h('h3', null, 'Реплики ', counter),
        h('div', { class: 'row' },
          h('button', { onclick: () => subsInput.click() }, '📄 Импорт .srt/.vtt'),
          h('button', { onclick: () => addCue(video.currentTime, video.currentTime + DEFAULT_CUE) }, '＋ Реплика'))),
      list),
    h('div', { class: 'row' },
      h('button', { class: 'primary big', onclick: save }, '💾 Сохранить пак'),
      h('button', { onclick: exportPack }, '⬇ Файл пака (.zip)'),
      h('button', { onclick: exportSrt }, '⬇ Субтитры .srt')));

  const picker = h('div', { class: 'card stack' },
    h('p', null, 'Загрузите видео, разметьте реплики и подпишите их субтитрами. ',
      'Каждая реплика станет раундом в игре, а её текст будет подсказкой-суфлёром во время записи.'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => videoInput.click() }, '📁 Выбрать видео')));

  function showEditor() {
    picker.classList.add('hidden');
    editor.classList.remove('hidden');
    video.src = videoUrlFor(pack.video);
    video.addEventListener('loadedmetadata', () => {
      timeline.setZoom(Math.max(20, Math.min(120, timeline.width / Math.min(duration(), 30))), 0);
      timeline.dirty = true;
    }, { once: true });
    video.addEventListener('error', () => toast('Браузер не может воспроизвести это видео', { error: true }), { once: true });
    if (pack.video.size > MAX_FULL_DECODE) {
      timeline.setMessage('Видео большое — волна звука не строится, но реплики размечать можно');
      renderList(true);
      return;
    }
    decodeMedia(pack.video, { lowRate: true })
      .then((buffer) => {
        audioDuration = buffer.duration;
        timeline.setAudio(buffer);
        timeline.clampView();
      })
      .catch((err) => {
        console.error(err);
        timeline.setMessage('Волну звука построить не удалось — реплики размечать можно');
      });
    renderList(true);
  }

  mount(h('section', { class: 'screen' },
    h('div', { class: 'topbar' },
      h('h2', null, '✂️ Редактор реплик'),
      h('div', { class: 'row' },
        h('button', { onclick: () => leave(nav.packs) }, '📦 Паки'),
        h('button', { onclick: () => leave(nav.menu) }, '← Меню'))),
    h('label', null, 'Название пака', nameInput),
    picker, editor, videoInput, subsInput,
  ), () => {
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey);
    timeline.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
  });

  document.addEventListener('keydown', onKey);
  raf = requestAnimationFrame(frame);
  if (pack.video) showEditor();
}
