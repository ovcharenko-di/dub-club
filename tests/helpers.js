import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Fake mic emits a periodic tone, which is enough to play a full round.
const CHROMIUM_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

// Static server for the repo root on a random port: ES modules need http://, not file://.
export async function startServer() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(ROOT, path.endsWith('/') ? path + 'index.html' : path));
    if (!file.startsWith(normalize(ROOT))) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

// Some installs ship only full Chromium without chrome-headless-shell; fall back to it.
export async function launchBrowser() {
  try {
    return await chromium.launch({ args: CHROMIUM_ARGS });
  } catch (err) {
    if (!/Executable doesn't exist/.test(err.message)) throw err;
    return chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
  }
}

// A page that records every console error/warning and uncaught exception.
export async function openApp(browser, url) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`);
  });
  await page.goto(url);
  return { page, errors };
}

// Save a pack of short audio lines (sine tones as WAV) into the app's IndexedDB; returns its id.
export async function addTonePack(page, name, freqs, seconds = 0.4) {
  return page.evaluate(async ({ name, freqs, seconds }) => {
    const { saveCustomPack, newId } = await import('/js/packs.js');
    const wav = (freq) => {
      const sr = 16000;
      const n = Math.round(sr * seconds);
      const view = new DataView(new ArrayBuffer(44 + n * 2));
      const str = (at, s) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
      str(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      str(36, 'data'); view.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.sin((2 * Math.PI * freq * i) / sr) * 12000, true);
      return new Blob([view], { type: 'audio/wav' });
    };
    const id = newId();
    const lines = freqs.map((f, i) => ({ id: newId(), title: `Тон ${i + 1}`, hint: '', kind: 'audio', blob: wav(f), start: 0, end: seconds, duration: seconds }));
    const result = await saveCustomPack({ id, name, lines });
    if (!result.persisted) throw new Error(`pack not saved: ${result.reason}`);
    return id;
  }, { name, freqs, seconds });
}

// From the menu, start a game with the given pack and number of players.
export async function startGame(page, packId, players) {
  await page.click('.menu-tile:has-text("Играть")');
  await page.waitForSelector('text=Новая игра');
  await page.selectOption('select', packId);
  await page.click(`.row button:text-is("${players}")`);
  await page.click('text=Начать ▶');
}

// Record one take (stopping early with «Готово»); returns the line title. Passes intermissions.
export async function playTurn(page) {
  const intermission = page.locator('button.primary.big:has-text("Раунд")');
  await page.waitForSelector('.line-title, button.primary.big:has-text("Раунд")');
  if (await intermission.count()) await intermission.click();
  await page.waitForSelector('.line-title');
  const title = await page.textContent('.line-title');
  const pill = await page.textContent('.topbar .pill');
  // mount() replaces the screen, so the tagged title disappears once the take is saved.
  await page.evaluate(() => { document.querySelector('.line-title').dataset.done = '1'; });
  await page.click('button.rec');
  await page.waitForSelector('button:has-text("Готово"):not(.hidden)');
  await page.waitForTimeout(500);
  await page.click('button:has-text("Готово")');
  await page.waitForFunction(() => !document.querySelector('.line-title[data-done]'));
  return { title, pill };
}
