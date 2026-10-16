import { h, mount, toast } from '../ui.js';
import { allPacks } from '../packs.js';

export const PLAYER_COLORS = ['#ffcc33', '#ff4fa3', '#3ee6c4', '#8f7dff'];
const DEFAULT_NAMES = ['Игрок 1', 'Игрок 2', 'Игрок 3', 'Игрок 4'];

let remembered = { packId: 'demo', count: 2, names: [...DEFAULT_NAMES], rounds: 3 };

export async function setupScreen(nav) {
  const packs = await allPacks();
  const playable = packs.filter((p) => p.lines.length > 0);
  if (!playable.some((p) => p.id === remembered.packId)) remembered.packId = 'demo';

  const packSelect = h('select', {
    onchange: () => { remembered.packId = packSelect.value; },
  }, playable.map((p) => h('option', { value: p.id, selected: p.id === remembered.packId },
    `${p.name} (${p.lines.length})`)));

  const rounds = h('input', {
    type: 'number', min: 1, max: 20, value: remembered.rounds,
    onchange: () => { remembered.rounds = Math.max(1, Math.min(20, Number(rounds.value) || 1)); rounds.value = remembered.rounds; },
  });

  const playersBox = h('div', { class: 'stack' });
  const countButtons = h('div', { class: 'row' });

  function renderPlayers() {
    countButtons.replaceChildren(...[1, 2, 3, 4].map((n) =>
      h('button', {
        class: n === remembered.count ? 'selected' : '',
        onclick: () => { remembered.count = n; renderPlayers(); },
      }, n)));
    playersBox.replaceChildren(...Array.from({ length: remembered.count }, (_, i) =>
      h('div', { class: 'player-input' },
        h('span', { class: 'dot', style: { background: PLAYER_COLORS[i] } }),
        h('input', {
          type: 'text', value: remembered.names[i], maxLength: 20,
          oninput: (e) => { remembered.names[i] = e.target.value; },
        }))));
  }
  renderPlayers();

  function start() {
    const pack = playable.find((p) => p.id === packSelect.value);
    if (!pack) return toast('Выберите пак', { error: true });
    const players = Array.from({ length: remembered.count }, (_, i) => ({
      name: remembered.names[i].trim() || DEFAULT_NAMES[i],
      color: PLAYER_COLORS[i],
    }));
    nav.game({ pack, players, rounds: remembered.rounds });
  }

  mount(h('section', { class: 'screen' },
    h('div', { class: 'topbar' }, h('h2', null, '🏆 Новая игра'), h('button', { onclick: nav.menu }, '← Меню')),
    h('div', { class: 'card stack' },
      h('label', null, 'Пак реплик', packSelect),
      h('label', null, 'Раунды', rounds),
      h('div', { class: 'stack' }, h('span', { class: 'muted small' }, 'Игроки'), countButtons, playersBox),
    ),
    h('button', { class: 'primary big', onclick: start }, 'Начать ▶'),
  ));
}
