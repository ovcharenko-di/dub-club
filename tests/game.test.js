import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, openApp } from './helpers.js';

let server, browser;
before(async () => { server = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); server?.close(); });

test('a game plays every demo line in pack order for each player', { timeout: 240_000 }, async () => {
  const { page, errors } = await openApp(browser, server.url);
  const expected = await page.evaluate(async () => {
    const { allPacks } = await import('/js/packs.js');
    return (await allPacks()).find((p) => p.id === 'demo').lines.map((l) => l.title);
  });

  await page.click('.menu-tile:has-text("Играть")');
  await page.waitForSelector('text=Новая игра');
  assert.equal(await page.locator('input[type=number]').count(), 0, 'setup must not ask for a round count');
  await page.click('.row button:text-is("2")');
  await page.click('text=Начать ▶');

  const played = [];
  const pills = [];
  let intermissions = 0;
  for (let turn = 0; turn < expected.length * 2; turn++) {
    const intermission = page.locator('button.primary.big:has-text("Раунд")');
    await page.waitForSelector('.line-title, button.primary.big:has-text("Раунд")');
    if (await intermission.count()) { intermissions++; await intermission.click(); }
    await page.waitForSelector('.line-title');
    played.push(await page.textContent('.line-title'));
    pills.push(await page.textContent('.topbar .pill'));

    // mount() replaces the screen, so the tagged title disappears once the take is saved.
    await page.evaluate(() => { document.querySelector('.line-title').dataset.done = '1'; });
    await page.click('button.rec');
    await page.waitForSelector('button:has-text("Готово"):not(.hidden)');
    await page.waitForTimeout(600);
    await page.click('button:has-text("Готово")');
    await page.waitForFunction(() => !document.querySelector('.line-title[data-done]'));
  }

  assert.deepEqual(played.filter((_, i) => i % 2 === 0), expected, 'player 1 order');
  assert.deepEqual(played.filter((_, i) => i % 2 === 1), expected, 'player 2 order');
  assert.deepEqual([...new Set(pills)], expected.map((_, i) => `Раунд ${i + 1}/${expected.length}`));
  assert.equal(intermissions, expected.length - 1);

  await page.waitForSelector(`text=Вердикт 1/${expected.length * 2}`);
  assert.deepEqual(errors, []);
});
