import { h, mount, toast, countdown, sleep, shuffle } from '../ui.js';
import { getMic, micErrorMessage, Recorder, decode, startMeter } from '../audio.js';
import { prepareLine } from '../packs.js';
import { extractFeatures, compare } from '../analysis.js';
import { judge } from '../judges.js';
import { createStage } from '../stage.js';

const EXTRA_RECORD_TIME = 1.2; // seconds on top of the line length

export function gameScreen(nav, { pack, players, rounds }) {
  // Pick lines for every round, reshuffling whenever the pack runs out.
  const roundLines = [];
  let pool = [];
  for (let r = 0; r < rounds; r++) {
    if (!pool.length) pool = shuffle(pack.lines);
    roundLines.push(pool.pop());
  }

  const state = {
    round: 0,
    turn: 0,
    players: players.map((p) => ({ ...p, total: 0, rounds: [] })),
  };
  const refFeatures = new WeakMap();

  const header = (subtitle) => {
    const player = state.players[state.turn];
    return h('div', { class: 'topbar' },
      h('div', { class: 'row' },
        h('span', { class: 'pill' }, `Раунд ${state.round + 1}/${rounds}`),
        h('span', { class: 'pill' }, h('span', { class: 'dot', style: { background: player.color } }), player.name),
        subtitle && h('span', { class: 'pill' }, subtitle)),
      h('button', { onclick: () => { if (confirm('Выйти из игры?')) nav.menu(); } }, '✕ Выйти'));
  };

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
      status.replaceChildren('Жюри совещается… ');
      try {
        const takeBuffer = await decode(blob);
        const metrics = compare(ref, await extractFeatures(takeBuffer));
        verdictScreen({ line, prep, takeBuffer, metrics });
      } catch (err) {
        console.error(err);
        toast('Не получилось обработать запись, попробуйте ещё раз.', { error: true });
        listenBtn.disabled = recordBtn.disabled = false;
        status.textContent = '';
      }
    }
  }

  function verdictScreen({ line, prep, takeBuffer, metrics }) {
    const player = state.players[state.turn];
    const verdicts = judge(metrics);
    const total = Math.round(verdicts.reduce((sum, v) => sum + v.score, 0) * 10) / 10;
    player.total = Math.round((player.total + total) * 10) / 10;
    player.rounds.push({ title: line.title, score: total });

    const stage = createStage(prep);
    const cards = verdicts.map((v) => {
      const scoreEl = h('div', { class: 'score' }, '?');
      const commentEl = h('div', { class: 'comment' });
      const el = h('div', { class: 'card judge' },
        h('div', { class: 'avatar' }, v.judge.avatar),
        h('div', { class: 'name' }, v.judge.name),
        h('div', { class: 'spec' }, v.judge.specialty),
        scoreEl, commentEl);
      return { v, el, scoreEl, commentEl };
    });
    const totalEl = h('div', { class: 'total hidden' }, 'Итого за раунд: ', h('b', null, total.toFixed(1)), ' / 30');
    const nextBtn = h('button', { class: 'primary big', disabled: true, onclick: next }, 'Дальше →');
    let alive = true;

    mount(h('section', { class: 'screen' },
      header('Вердикт'),
      h('div', { class: 'judges' }, cards.map((c) => c.el)),
      totalEl,
      h('div', { class: 'card stack' },
        h('h3', null, 'Сравнить'),
        stage.el,
        h('div', { class: 'row' },
          h('button', { onclick: () => stage.playOriginal() }, '▶ Оригинал'),
          h('button', { onclick: () => stage.playTake(takeBuffer) }, '▶ Ваш дубль'))),
      h('div', { class: 'row' }, nextBtn),
    ), () => { alive = false; stage.stop(); });

    (async () => {
      for (const c of cards) {
        await sleep(650);
        if (!alive) return;
        c.el.classList.add('revealed');
        await countUp(c.scoreEl, c.v.score);
        c.commentEl.textContent = `«${c.v.comment}»`;
      }
      await sleep(300);
      totalEl.classList.remove('hidden');
      nextBtn.disabled = false;
    })();
  }

  async function countUp(el, target) {
    const steps = 14;
    for (let i = 1; i <= steps; i++) {
      el.textContent = ((target * i) / steps).toFixed(1);
      await sleep(35);
    }
  }

  function next() {
    state.turn++;
    if (state.turn < state.players.length) return turnScreen();
    state.turn = 0;
    state.round++;
    if (state.round >= rounds) return resultsScreen();
    if (state.players.length > 1) return boardScreen();
    return turnScreen();
  }

  function board() {
    const ranked = [...state.players].sort((a, b) => b.total - a.total);
    const medals = ['🥇', '🥈', '🥉', '🎖️'];
    return h('div', { class: 'board' }, ranked.map((p, i) =>
      h('div', { class: `board-row${i === 0 ? ' winner' : ''}` },
        h('span', { class: 'place' }, medals[i]),
        h('span', null, h('span', { class: 'dot', style: { background: p.color } }), ' ', h('b', null, p.name),
          h('div', { class: 'muted small' }, p.rounds.map((r) => r.score.toFixed(1)).join(' · '))),
        h('span', { class: 'pts' }, p.total.toFixed(1)))));
  }

  function boardScreen() {
    mount(h('section', { class: 'screen' },
      h('h2', null, `Табло после раунда ${state.round}`),
      board(),
      h('button', { class: 'primary big', onclick: turnScreen }, `Раунд ${state.round + 1} ▶`)));
  }

  function resultsScreen() {
    const ranked = [...state.players].sort((a, b) => b.total - a.total);
    const max = rounds * 30;
    const winner = ranked[0];
    mount(h('section', { class: 'screen' },
      h('div', { class: 'hero' },
        h('div', { class: 'logo' }, '🏆'),
        h('h1', null, state.players.length > 1 ? `${winner.name} побеждает!` : 'Финал'),
        h('p', { class: 'muted' }, `${winner.total.toFixed(1)} из ${max} очков`)),
      board(),
      h('div', { class: 'row' },
        h('button', { class: 'primary big', onclick: () => gameScreen(nav, { pack, players, rounds }) }, '↻ Ещё раз'),
        h('button', { class: 'big', onclick: nav.menu }, 'В меню'))));
  }

  turnScreen();
}
