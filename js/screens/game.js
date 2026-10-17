import { h, mount, toast, countdown, downloadBlob } from '../ui.js';
import { getMic, micErrorMessage, Recorder, decode, startMeter } from '../audio.js';
import { prepareLine } from '../packs.js';
import { extractFeatures, compare } from '../analysis.js';
import { judge, JUDGES } from '../judges.js';
import { createStage } from '../stage.js';
import { createReel, MAX_VOICE_LEVEL } from '../reel.js';

const EXTRA_RECORD_TIME = 1.2; // seconds on top of the line length
// Kept between games: a quiet mic stays quiet.
let voiceLevel = 1;

export function gameScreen(nav, { pack, players }) {
  // One round per line, in pack order: a game always plays the whole pack.
  const roundLines = pack.lines;
  const rounds = roundLines.length;

  const state = {
    round: 0,
    turn: 0,
    players: players.map((p) => ({ ...p, total: 0, rounds: [] })),
    // Takes are judged only after the last round, so nobody plays to the scoreboard.
    takes: [],
  };
  const refFeatures = new WeakMap();

  const header = (subtitle, player = state.players[state.turn], round = state.round) =>
    h('div', { class: 'topbar' },
      h('div', { class: 'row' },
        h('span', { class: 'pill' }, `Раунд ${round + 1}/${rounds}`),
        h('span', { class: 'pill' }, h('span', { class: 'dot', style: { background: player.color } }), player.name),
        subtitle && h('span', { class: 'pill' }, subtitle)),
      h('button', { onclick: () => { if (confirm('Выйти из игры?')) nav.menu(); } }, '✕ Выйти'));

  async function turnScreen() {
    const line = roundLines[state.round];
    const player = state.players[state.turn];
    const body = h('div', { class: 'stack' }, h('div', { class: 'card stack' },
      h('div', { class: 'spinner' }), h('p', { class: 'muted small', style: { textAlign: 'center' } }, 'Готовим реплику…')));
    let stage = null;
    let cancelRecording = null;
    mount(h('section', { class: 'screen' }, header(), body), () => {
      stage?.stop();
      cancelRecording?.();
    });

    let prep, ref;
    try {
      prep = await prepareLine(line);
      ref = refFeatures.get(prep) || (await extractFeatures(prep.buffer));
      refFeatures.set(prep, ref);
      if (ref.empty) toast('В этой реплике не слышно звука — проверьте её границы в редакторе', { error: true, ms: 6000 });
    } catch (err) {
      console.error(err);
      body.replaceChildren(h('div', { class: 'card stack' },
        h('p', null, `Не удалось загрузить реплику «${line.title}».`),
        h('p', { class: 'muted small' }, err?.message || String(err)),
        h('button', { onclick: next }, 'Пропустить')));
      return;
    }

    stage = createStage(prep);
    const meterBar = h('div');
    const meter = h('div', { class: 'meter hidden' }, meterBar);
    const listenBtn = h('button', { class: 'big', onclick: listen }, '▶ Послушать');
    const recordBtn = h('button', { class: 'rec big', onclick: perform }, '🎙 Записать');
    const doneBtn = h('button', { class: 'big hidden' }, '⏹ Готово');
    const status = h('p', { class: 'muted small' },
      `${player.name}, ваш ход! Длина реплики: ${(prep.end - prep.start).toFixed(1)} с.`);

    body.replaceChildren(
      h('div', { class: 'card stack' },
        h('h3', { class: 'line-title' }, line.title),
        line.hint && h('p', { class: 'hint' }, line.hint),
        stage.el,
        meter,
        h('div', { class: 'row' }, listenBtn, recordBtn, doneBtn),
        status));

    async function listen() {
      listenBtn.disabled = true;
      await stage.playOriginal();
      listenBtn.disabled = false;
    }

    async function perform() {
      stage.stop();
      listenBtn.disabled = recordBtn.disabled = true;
      let stream;
      try {
        stream = await getMic();
      } catch (err) {
        toast(micErrorMessage(err), { error: true });
        listenBtn.disabled = recordBtn.disabled = false;
        return;
      }
      await countdown(3);

      const recorder = new Recorder(stream);
      await recorder.start();
      const stopMeter = startMeter(stream, meterBar);
      meter.classList.remove('hidden');
      doneBtn.classList.remove('hidden');
      status.textContent = '🔴 Запись… Повторяйте!';

      const length = prep.end - prep.start + EXTRA_RECORD_TIME;
      let finishEarly;
      const early = new Promise((resolve) => { finishEarly = resolve; });
      doneBtn.onclick = () => finishEarly();
      let aborted = false;
      cancelRecording = () => { aborted = true; finishEarly(); };

      await Promise.race([stage.playSilent(length), early]);
      stage.stop();
      stopMeter();
      const blob = await recorder.stop();
      cancelRecording = null;
      if (aborted) return;

      doneBtn.classList.add('hidden');
      meter.classList.add('hidden');
      status.replaceChildren('Сохраняем дубль… ');
      try {
        const takeBuffer = await decode(blob);
        const metrics = compare(ref, await extractFeatures(takeBuffer));
        state.takes.push({ player, round: state.round, line, prep, takeBuffer, metrics });
        toast('Дубль записан. Оценки — в конце игры!');
        next();
      } catch (err) {
        console.error(err);
        toast('Не получилось обработать запись, попробуйте ещё раз.', { error: true });
        listenBtn.disabled = recordBtn.disabled = false;
        status.textContent = '';
      }
    }
  }

  // Score every take up front so the results stay correct whatever happens on the final screen.
  function judgeAll() {
    for (const take of state.takes) {
      take.verdicts = judge(take.metrics);
      take.total = Math.round(take.verdicts.reduce((sum, v) => sum + v.score, 0) * 10) / 10;
      take.player.total = Math.round((take.player.total + take.total) * 10) / 10;
      take.player.rounds.push({ title: take.line.title, score: take.total });
    }
    resultsScreen();
  }

  function next() {
    state.turn++;
    if (state.turn < state.players.length) return turnScreen();
    state.turn = 0;
    state.round++;
    if (state.round >= rounds) return judgeAll();
    if (state.players.length > 1) return intermissionScreen();
    return turnScreen();
  }

  function intermissionScreen() {
    mount(h('section', { class: 'screen' },
      h('h2', null, `Раунд ${state.round} позади`),
      h('p', { class: 'muted' }, 'Жюри держит оценки в секрете до конца игры.'),
      h('button', { class: 'primary big', onclick: turnScreen }, `Раунд ${state.round + 1} ▶`)));
  }

  function board(ranked) {
    const medals = ['🥇', '🥈', '🥉', '🎖️'];
    return h('div', { class: 'board' }, ranked.map((p, i) =>
      h('div', { class: `board-row${i === 0 ? ' winner' : ''}` },
        h('span', { class: 'place' }, medals[i]),
        h('span', null, h('span', { class: 'dot', style: { background: p.color } }), ' ', h('b', null, p.name),
          h('div', { class: 'muted small' }, p.rounds.map((r) => r.score.toFixed(1)).join(' · '))),
        h('span', { class: 'pts' }, p.total.toFixed(1)))));
  }

  // One reel for the whole table: the footage is the same, the picker chooses whose takes play over it.
  function resultsScreen() {
    const ranked = [...state.players].sort((a, b) => b.total - a.total);
    const max = rounds * 30;
    const winner = ranked[0];
    const takesOf = (player) => state.takes.filter((t) => t.player === player);
    const reel = createReel();
    const judgesEl = h('div', { class: 'judge-totals' });
    const playBtn = h('button', { class: 'primary' }, '▶ Смотреть');
    const stopBtn = h('button', { class: 'hidden', onclick: () => reel.stop() }, '⏹ Стоп');
    const downloadBtn = h('button', null, '⬇ Скачать видео');
    const status = h('p', { class: 'muted small' });
    reel.setVoiceLevel(voiceLevel);
    const levelText = h('span', { class: 'mono' });
    const showLevel = () => { levelText.textContent = `${Math.round(voiceLevel * 100)}%`; };
    const levelInput = h('input', {
      type: 'range', min: 0, max: MAX_VOICE_LEVEL, step: 0.1, value: voiceLevel,
      oninput: () => { voiceLevel = Number(levelInput.value); reel.setVoiceLevel(voiceLevel); showLevel(); },
    });
    showLevel();
    const tracks = ranked.map((p) => h('button', {
      class: 'track',
      disabled: !takesOf(p).length,
      onclick: () => pick(p),
    }, h('span', { class: 'dot', style: { background: p.color } }), h('span', { class: 'name' }, p.name),
    h('span', { class: 'pts' }, p.total.toFixed(1))));

    let current = null;
    let playing = false, recording = false;
    let run = 0;
    const setBusy = () => {
      playBtn.disabled = downloadBtn.disabled = playing;
      stopBtn.classList.toggle('hidden', !playing);
      // Switching tracks carries on from the same moment, but a recording must not be cut short.
      tracks.forEach((btn, i) => { btn.disabled = recording || !takesOf(ranked[i]).length; });
    };

    function pick(player) {
      current = player;
      tracks.forEach((btn, i) => btn.classList.toggle('selected', ranked[i] === player));
      judgesEl.replaceChildren(...JUDGES.map((j, i) => {
        const sum = takesOf(player).reduce((acc, t) => acc + t.verdicts[i].score, 0);
        return h('div', { class: 'judge-total' },
          h('span', { class: 'avatar' }, j.avatar),
          h('span', null, h('b', null, j.name), h('div', { class: 'muted small' }, j.specialty)),
          h('span', { class: 'pts' }, sum.toFixed(1)));
      }));
      if (playing) watch({ from: reel.position });
    }

    async function watch({ record = false, from = 0 } = {}) {
      const player = current;
      // reel.play() stops the previous run, which then settles; only the latest run may reset the buttons.
      const my = ++run;
      playing = true;
      recording = record;
      setBusy();
      status.textContent = record ? '⏺ Собираем видео… Не переключайте вкладку.' : '';
      try {
        const blob = await reel.play(takesOf(player), { record, from });
        if (blob) {
          const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
          downloadBlob(blob, `dub-club-${player.name.replace(/[\\/:*?"<>|]+/g, '_')}.${ext}`);
          status.textContent = `Видео сохранено (${ext.toUpperCase()}).`;
        } else if (record) {
          status.textContent = 'Запись видео остановлена.';
        }
      } catch (err) {
        console.error(err);
        toast(`Не удалось ${record ? 'собрать видео' : 'проиграть дубли'}: ${err?.message || err}`, { error: true });
        status.textContent = '';
      }
      if (my !== run) return;
      playing = recording = false;
      setBusy();
    }

    playBtn.onclick = () => watch();
    downloadBtn.onclick = () => {
      if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
        return toast('Этот браузер не умеет записывать видео. Попробуйте Chrome или Firefox.', { error: true });
      }
      watch({ record: true });
    };

    const hasTakes = state.takes.length > 0;
    mount(h('section', { class: 'screen' },
      h('div', { class: 'hero' },
        h('div', { class: 'logo' }, '🏆'),
        h('h1', null, state.players.length > 1 ? `${winner.name} побеждает!` : 'Финал'),
        h('p', { class: 'muted' }, `${winner.total.toFixed(1)} из ${max} очков`)),
      board(ranked),
      hasTakes && h('div', { class: 'card stack' },
        h('h3', null, 'Дубли'),
        h('div', { class: 'reel-layout' },
          reel.el,
          h('div', { class: 'tracks' },
            h('div', { class: 'muted small' }, 'Дорожка поверх видео'),
            tracks)),
        h('label', { class: 'voice-level' }, '🎙 Громкость голоса', levelInput, levelText),
        judgesEl,
        h('div', { class: 'row' }, playBtn, stopBtn, downloadBtn),
        status),
      h('div', { class: 'row' },
        h('button', { class: 'primary big', onclick: () => gameScreen(nav, { pack, players }) }, '↻ Ещё раз'),
        h('button', { class: 'big', onclick: nav.menu }, 'В меню'))),
    () => reel.stop());
    if (hasTakes) pick(ranked.find((p) => takesOf(p).length));
  }

  turnScreen();
}
