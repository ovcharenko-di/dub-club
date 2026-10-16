// The judging panel. Each judge cares about a different aspect of the take.

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export const JUDGES = [
  {
    id: 'pitch',
    name: 'Маэстро Тон',
    avatar: '🎼',
    specialty: 'интонация и высота',
    rate: (m) => 0.65 * m.contour + 0.35 * m.level,
    comments: {
      high: ['Божественная мелодия! Я плачу.', 'Каждая нота на своём месте. Браво!', 'Вы точно не оригинал?'],
      mid: ['Мелодия угадывается… местами.', 'Неплохо, но интонация гуляет.', 'Слышу старание. И пару фальшивых нот.'],
      low: ['Это была другая песня?', 'Мои уши требуют компенсации.', 'Интонация ушла в отпуск без вас.'],
    },
    hint: (m) => {
      if (m.levelDiff > 4) return 'Возьмите пониже.';
      if (m.levelDiff < -4) return 'Возьмите повыше.';
      return null;
    },
  },
  {
    id: 'rhythm',
    name: 'Мадам Тайминг',
    avatar: '⏱️',
    specialty: 'ритм и темп',
    rate: (m) => 0.35 * m.duration + 0.3 * m.warp + 0.35 * m.envelope,
    comments: {
      high: ['Как швейцарские часы!', 'Попадание в каждый слог. Обожаю.', 'Ритм — безупречен.'],
      mid: ['Почти в такт. Почти.', 'Немного торопимся, дорогуша.', 'Темп плавает, но держится на плаву.'],
      low: ['Вы и оригинал жили в разных часовых поясах.', 'Ритм? Не встречала.', 'Метроном подал в отставку.'],
    },
    hint: (m) => {
      if (m.durationRatio > 1.3) return 'Слишком медленно.';
      if (m.durationRatio < 0.75) return 'Слишком быстро.';
      return null;
    },
  },
  {
    id: 'vibe',
    name: 'Дядя Вайб',
    avatar: '🕶️',
    specialty: 'подача и харизма',
    rate: (m) => clamp01(
      0.3 * m.voicing + 0.25 * m.loudness + 0.25 * m.envelope + 0.2 * m.contour + (Math.random() - 0.5) * 0.15,
    ),
    comments: {
      high: ['Это огонь! 🔥', 'Вот это энергия, я в деле!', 'Мурашки. Просто мурашки.'],
      mid: ['Нормально так. Добавь драйва!', 'Чувствую вайб, но слабенький.', 'Неплохо, но где страсть?'],
      low: ['Скучновато, бро.', 'Громче! Смелее! Безумнее!', 'Ты как будто стесняешься.'],
    },
    hint: (m) => (m.loudness < 0.3 ? 'Ближе к микрофону!' : null),
  },
];

const SILENT = [
  'Мы ничего не услышали. Микрофон включён?',
  'Тишина — тоже искусство, но не сегодня.',
  'Это была пантомима?',
];

export function toTen(score) {
  return Math.round(Math.max(1, Math.min(10, 10 * Math.pow(clamp01(score), 0.85))) * 10) / 10;
}

/** Returns [{ judge, score (0..10), comment }]. */
export function judge(metrics) {
  return JUDGES.map((j) => {
    if (metrics.refSilent) return { judge: j, score: 0, comment: 'В оригинале этой реплики тишина — сравнивать не с чем. Проверьте её границы в редакторе.' };
    if (metrics.silent) return { judge: j, score: 0, comment: pick(SILENT) };
    const score = toTen(j.rate(metrics));
    const tier = score >= 7.5 ? 'high' : score >= 4.5 ? 'mid' : 'low';
    const hint = tier !== 'high' ? j.hint(metrics) : null;
    return { judge: j, score, comment: [pick(j.comments[tier]), hint].filter(Boolean).join(' ') };
  });
}
