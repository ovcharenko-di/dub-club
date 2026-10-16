import { h, mount } from '../ui.js';

export function menuScreen(nav) {
  const tile = (emoji, title, desc, onclick) =>
    h('button', { class: 'menu-tile', onclick },
      h('span', { class: 'emoji' }, emoji),
      h('span', { class: 'title' }, title),
      h('span', { class: 'desc' }, desc));

  mount(h('section', { class: 'screen' },
    h('div', { class: 'hero' },
      h('div', { class: 'logo' }, '🎙️'),
      h('h1', null, 'Dub ', h('span', null, 'Club')),
      h('p', { class: 'muted' }, 'Послушай реплику. Повтори её в микрофон. Получи вердикт жюри.'),
    ),
    h('div', { class: 'menu-grid' },
      tile('🏆', 'Играть', 'От 1 до 4 игроков по очереди у одного микрофона. Кто ближе к оригиналу — тот и звезда.', nav.setup),
      tile('🎬', 'Дубляж', 'Загрузи видео, переозвучь его своим голосом и скачай результат.', nav.dub),
      tile('✂️', 'Редактор', 'Загрузи видео, нарежь реплики и добавь субтитры — получится пак для игры.', () => nav.editor()),
      tile('📦', 'Паки реплик', 'Создай свой пак из аудио или видео, либо запиши реплики сам.', nav.packs),
    ),
    h('div', { class: 'card small muted' },
      h('b', null, 'Как играть. '),
      'Нажми «Послушать», чтобы услышать оригинал (можно сколько угодно раз). ',
      'Затем «Записать»: после отсчёта повтори реплику как можно точнее. ',
      'Жюри оценит интонацию, ритм и подачу. Совет: играйте в наушниках.',
    ),
  ));
}
