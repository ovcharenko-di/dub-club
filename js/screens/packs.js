import { h, mount, toast } from '../ui.js';
import { decode, getMic, micErrorMessage, Recorder, playBuffer, stopSource } from '../audio.js';
import { DEMO_PACK, listCustomPacks, saveCustomPack, deleteCustomPack, prepareLine, forgetPrepared, newId } from '../packs.js';

const MAX_LINE = 20; // seconds

export async function packsScreen(nav) {
  const packs = await listCustomPacks();

  const item = (pack, actions) => h('div', { class: 'card pack-item' },
    h('div', null,
      h('h3', null, pack.name),
      h('div', { class: 'muted small' }, `${pack.lines.length} реплик${pack.builtin ? ' · встроенный' : ''}`)),
    h('div', { class: 'row' }, actions));

  mount(h('section', { class: 'screen' },
    h('div', { class: 'topbar' }, h('h2', null, '📦 Паки реплик'), h('button', { onclick: nav.menu }, '← Меню')),
    h('p', { class: 'muted' },
      'Пак — это набор реплик для игры. Добавьте аудио- или видеофайлы (отрывки из фильмов, мультиков, мемов) ',
      'или запишите реплики сами — тогда друзья будут пародировать вас. Паки хранятся только в этом браузере.'),
    h('button', { class: 'primary', onclick: () => editPack(nav, { id: newId(), name: 'Мой пак', lines: [] }, true) },
      '＋ Новый пак'),
    item(DEMO_PACK, []),
    packs.map((pack) => item(pack, [
      h('button', { onclick: () => editPack(nav, pack, false) }, '✎ Изменить'),
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm(`Удалить пак «${pack.name}»?`)) return;
          await deleteCustomPack(pack.id);
          packsScreen(nav);
        },
      }, '🗑'),
    ])),
  ));
}

function editPack(nav, original, isNew) {
  const pack = { ...original, lines: original.lines.map((l) => ({ ...l })) };
  let preview = null;
  let recorder = null;

  const nameInput = h('input', { type: 'text', value: pack.name, maxLength: 60, oninput: (e) => { pack.name = e.target.value; } });
  const list = h('div', { class: 'stack' });
  const fileInput = h('input', {
    type: 'file', accept: 'audio/*,video/*', multiple: true, class: 'hidden',
    onchange: async () => {
      for (const file of fileInput.files) await addFile(file);
      fileInput.value = '';
    },
  });
  const recBtn = h('button', { onclick: toggleRecord }, '🎙 Записать реплику');

  async function addFile(file) {
    try {
      const buffer = await decode(file);
      pack.lines.push({
        id: newId(),
        title: file.name.replace(/\.[^.]+$/, ''),
        kind: file.type.startsWith('video') ? 'video' : 'audio',
        blob: file,
        start: 0,
        end: Math.min(buffer.duration, MAX_LINE),
        duration: buffer.duration,
      });
      render();
    } catch (err) {
      console.error(err);
      toast(`Не удалось прочитать звук из «${file.name}»`, { error: true });
    }
  }

  async function toggleRecord() {
    if (recorder) {
      recBtn.disabled = true;
      const blob = await recorder.stop();
      recorder = null;
      recBtn.disabled = false;
      recBtn.textContent = '🎙 Записать реплику';
      recBtn.className = '';
      try {
        const buffer = await decode(blob);
        pack.lines.push({
          id: newId(), title: `Реплика ${pack.lines.length + 1}`, kind: 'audio', blob,
          start: 0, end: Math.min(buffer.duration, MAX_LINE), duration: buffer.duration,
        });
        render();
      } catch (err) {
        console.error(err);
        toast('Запись не удалась', { error: true });
      }
      return;
    }
    try {
      recorder = new Recorder(await getMic());
      await recorder.start();
      recBtn.textContent = '⏹ Остановить запись';
      recBtn.className = 'rec';
    } catch (err) {
      recorder = null;
      toast(micErrorMessage(err), { error: true });
    }
  }

  function render() {
    if (!pack.lines.length) {
      list.replaceChildren(h('div', { class: 'empty' }, 'Пока пусто. Добавьте файлы или запишите реплику.'));
      return;
    }
    list.replaceChildren(...pack.lines.map((line, index) => {
      const numberField = (label, key) => h('label', null, label, h('input', {
        type: 'number', min: 0, max: line.duration, step: 0.1, value: Number(line[key]).toFixed(1),
        onchange: (e) => {
          let v = Math.max(0, Math.min(line.duration, Number(e.target.value) || 0));
          if (key === 'start') v = Math.min(v, line.end - 0.3);
          else v = Math.max(v, line.start + 0.3);
          line[key] = Math.round(v * 10) / 10;
          e.target.value = line[key].toFixed(1);
          if (line.end - line.start > MAX_LINE) toast(`Лучше не длиннее ${MAX_LINE} секунд`);
          forgetPrepared(line);
        },
      }));
      return h('div', { class: 'line-row' },
        h('label', { class: 'title-field' }, `${line.kind === 'video' ? '🎬' : '🔊'} Название`,
          h('input', { type: 'text', value: line.title, oninput: (e) => { line.title = e.target.value; } })),
        numberField('Начало, с', 'start'),
        numberField('Конец, с', 'end'),
        h('button', { class: 'icon', title: 'Прослушать', onclick: () => listen(line) }, '▶'),
        h('button', {
          class: 'icon danger', title: 'Удалить',
          onclick: () => { forgetPrepared(line); pack.lines.splice(index, 1); render(); },
        }, '✕'));
    }));
  }

  async function listen(line) {
    stopSource(preview);
    try {
      const prep = await prepareLine(line);
      preview = playBuffer(prep.buffer).source;
    } catch (err) {
      console.error(err);
      toast('Не удалось воспроизвести', { error: true });
    }
  }

  async function save() {
    if (!pack.name.trim()) return toast('Назовите пак', { error: true });
    if (!pack.lines.length) return toast('Добавьте хотя бы одну реплику', { error: true });
    await saveCustomPack(pack);
    toast('Пак сохранён');
    packsScreen(nav);
  }

  render();
  mount(h('section', { class: 'screen' },
    h('div', { class: 'topbar' },
      h('h2', null, isNew ? 'Новый пак' : 'Редактирование'),
      h('button', { onclick: () => packsScreen(nav) }, '← Назад')),
    h('div', { class: 'card stack' },
      h('label', null, 'Название пака', nameInput),
      h('div', { class: 'row' },
        h('button', { onclick: () => fileInput.click() }, '📁 Добавить файлы'), recBtn, fileInput),
      h('p', { class: 'muted small' },
        'Для каждой реплики выберите отрезок (начало и конец) — лучше короткий, 2–8 секунд.'),
      list),
    h('button', { class: 'primary big', onclick: save }, '💾 Сохранить'),
  ), () => {
    stopSource(preview);
    recorder?.stop();
  });
}
