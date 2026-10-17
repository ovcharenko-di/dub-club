import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { startServer, launchBrowser, openApp, addTonePack, startGame, playTurn } from './helpers.js';

let server, browser;
before(async () => { server = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); server?.close(); });

test('setup offers every pack and no round count', async () => {
  const { page, errors } = await openApp(browser, server.url);
  const id = await addTonePack(page, 'Тоны', [220]);
  await page.click('.menu-tile:has-text("Играть")');
  await page.waitForSelector('text=Новая игра');
  assert.equal(await page.locator('input[type=number]').count(), 0, 'setup must not ask for a round count');
  const options = await page.locator('select option').evaluateAll((els) => els.map((o) => o.value));
  assert.deepEqual(options, ['demo', id]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a game plays every line in pack order for each player', { timeout: 90_000 }, async () => {
  const { page, errors } = await openApp(browser, server.url);
  const id = await addTonePack(page, 'Тоны', [220, 330, 440]);
  await startGame(page, id, 2);

  const turns = [];
  for (let i = 0; i < 6; i++) turns.push(await playTurn(page));
  const titles = turns.map((t) => t.title);
  assert.deepEqual(titles.filter((_, i) => i % 2 === 0), ['Тон 1', 'Тон 2', 'Тон 3'], 'player 1 order');
  assert.deepEqual(titles.filter((_, i) => i % 2 === 1), ['Тон 1', 'Тон 2', 'Тон 3'], 'player 2 order');
  assert.deepEqual([...new Set(turns.map((t) => t.pill))], ['Раунд 1/3', 'Раунд 2/3', 'Раунд 3/3']);

  await page.waitForSelector('text=Вердикт 1/6');
  assert.deepEqual(errors, []);
  await page.close();
});

test('verdicts come after the last round and lead to the final board with reels', { timeout: 90_000 }, async () => {
  const { page, errors } = await openApp(browser, server.url);
  const id = await addTonePack(page, 'Тоны', [220]);
  await startGame(page, id, 2);
  await playTurn(page);
  await playTurn(page);

  for (let i = 1; i <= 2; i++) {
    await page.waitForSelector(`text=Вердикт ${i}/2`);
    assert.equal(await page.locator('.judge').count(), 3);
    await page.click('button.primary.big:not([disabled])', { timeout: 15_000 });
  }

  await page.waitForSelector('.board');
  assert.equal(await page.locator('.board-row').count(), 2);
  await page.locator('.board .watch').first().click();
  await page.waitForSelector('canvas.reel');
  assert.equal(await page.locator('.judge-total').count(), 3, 'per-judge totals for the player');
  // The judges' totals add up to the player's points on the board.
  const [judgeSum, boardPts] = await page.evaluate(() => {
    const sum = [...document.querySelectorAll('.judge-total .pts')].reduce((a, el) => a + Number(el.textContent), 0);
    const name = document.querySelector('.reel').closest('.card').querySelector('h3').textContent.trim();
    const row = [...document.querySelectorAll('.board-row')].find((r) => r.querySelector('b').textContent === name);
    return [sum, Number(row.querySelector('.pts').textContent)];
  });
  assert.ok(Math.abs(judgeSum - boardPts) < 0.2, `judges ${judgeSum} vs board ${boardPts}`);
  await page.click('button:has-text("Стоп")');
  await page.waitForSelector('button:has-text("Стоп")', { state: 'hidden' });

  const download = page.waitForEvent('download', { timeout: 30_000 });
  await page.click('button:has-text("Скачать видео")');
  const file = await download;
  assert.match(file.suggestedFilename(), /^dub-club-Игрок \d\.(webm|mp4)$/);
  // The file's content is checked in reel.test.js; here only the wiring to the download.
  assert.ok((await stat(await file.path())).size > 0, 'reel video is not empty');
  assert.deepEqual(errors, []);
  await page.close();
});
