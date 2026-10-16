// SRT / WebVTT parsing and SRT writing.

const TIME_RE = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/;

function parseTime(text) {
  const m = TIME_RE.exec(text.trim());
  if (!m) return NaN;
  const [, hh = '0', mm, ss, ms = '0'] = m;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000;
}

function cleanText(lines) {
  return lines
    .join('\n')
    .replace(/\{\\[^}]*\}/g, '')   // ASS-style tags like {\an8}
    .replace(/<[^>]+>/g, '')        // <i>, <b>, <v Speaker>, ...
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .trim();
}

/** Parse .srt or .vtt text into [{ start, end, text }] sorted by start. */
export function parseSubtitles(source) {
  const blocks = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [left, right] = lines[timeIdx].split('-->');
    const start = parseTime(left);
    const end = parseTime(right.trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    cues.push({ start, end, text: cleanText(lines.slice(timeIdx + 1)) });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function formatTimecode(sec, sep = ',') {
  const total = Math.max(0, Math.round(sec * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const hrs = Math.floor(total / 3600000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(hrs)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

export function toSrt(cues) {
  return [...cues]
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${formatTimecode(c.start)} --> ${formatTimecode(c.end)}\n${c.text || ''}\n`)
    .join('\n');
}
