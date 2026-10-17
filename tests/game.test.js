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

  await page.waitForSelector('.board');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the take is drawn over the original wave while recording', { timeout: 60_000 }, async () => {
  const { page, errors } = await openApp(browser, server.url);
  const id = await addTonePack(page, 'Тоны', [220], 1.5);
  await startGame(page, id, 1);
  await page.waitForSelector('.line-title');
  const takePixels = () => page.evaluate(() => {
    // Read a copy: repeated getImageData on the live canvas makes Chrome warn in the console.
    const canvas = document.querySelector('.stage canvas');
    const copy = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height });
    const g = copy.getContext('2d');
    g.drawImage(canvas, 0, 0);
    const { data } = g.getImageData(0, 0, copy.width, copy.height);
    let n = 0;
    // --wave-take is teal: green well above red, unlike the original's violet.
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i + 1] > data[i] + 40) n++;
    return n;
  });
  assert.equal(await takePixels(), 0, 'no take before recording');
  await page.click('button.rec');
  await page.waitForSelector('button:has-text("Готово"):not(.hidden)');
  let early = 0;
  for (let i = 0; i < 50 && !early; i++) {
    early = await takePixels();
    if (!early) await page.waitForTimeout(100);
  }
  assert.ok(early > 0, 'take appears while recording');
  // The take grows with the recording.
  await page.waitForTimeout(600);
  assert.ok(await takePixels() > early, 'take keeps growing');
  await page.click('button:has-text("Готово")');
  await page.waitForSelector('.board');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the last take leads straight to the final board', { timeout: 60_000 }, async () => {
  const { page, errors } = await openApp(browser, server.url);
  const id = await addTonePack(page, 'Тоны', [220]);
  await startGame(page, id, 2);
  await playTurn(page);
  await playTurn(page);

  await page.waitForSelector('.board');
  assert.equal(await page.locator('text=/Вердикт/').count(), 0, 'no per-take verdict screens');
  assert.equal(await page.locator('.board-row').count(), 2);
  assert.equal(await page.locator('canvas.reel').count(), 1, 'one reel for all players');
  // A quiet mic can be boosted right on the final screen.
  await page.locator('.voice-level input[type=range]').fill('2.5');
  assert.equal((await page.textContent('.voice-level .mono')).trim(), '250%');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the track picker switches whose takes play over the reel', { timeout: 60_000 }, async () => {
  const { page, errors } = await openApp(browser, server.url);
  const id = await addTonePack(page, 'Тоны', [220]);
  await startGame(page, id, 2);
  await playTurn(page);
  await playTurn(page);
  await page.waitForSelector('.board');

  const tracks = page.locator('.tracks .track');
  assert.equal(await tracks.count(), 2);
  // The winner's track is picked first, and the judges' totals add up to the picked player's points.
  const check = async (index) => {
    assert.equal(await page.locator('.tracks .track.selected').count(), 1);
    assert.equal(await tracks.nth(index).evaluate((el) => el.classList.contains('selected')), true);
    const [judgeSum, pts] = await page.evaluate(() => [
      [...document.querySelectorAll('.judge-total .pts')].reduce((a, el) => a + Number(el.textContent), 0),
      Number(document.querySelector('.tracks .track.selected .pts').textContent),
    ]);
    assert.equal(await page.locator('.judge-total').count(), 3);
    assert.ok(Math.abs(judgeSum - pts) < 0.2, `judges ${judgeSum} vs picked ${pts}`);
  };
  await check(0);

  await page.click('button:has-text("Смотреть")');
  await page.waitForSelector('button:has-text("Стоп"):not(.hidden)');
  // Switching mid-playback keeps playing, now with the other player's takes.
  await tracks.nth(1).click();
  await check(1);
  assert.equal(await page.locator('button:has-text("Стоп"):not(.hidden)').count(), 1, 'still playing after the switch');
  await page.click('button:has-text("Стоп")');
  await page.waitForSelector('button:has-text("Стоп")', { state: 'hidden' });
  assert.deepEqual(errors, []);
  await page.close();
});

test('the reel of the picked player downloads as a video', { timeout: 60_000 }, async () => {
  const { page, errors } = await openApp(browser, server.url);
  const id = await addTonePack(page, 'Тоны', [220]);
  await startGame(page, id, 2);
  await playTurn(page);
  await playTurn(page);
  await page.waitForSelector('.board');

  const tracks = page.locator('.tracks .track');
  await tracks.nth(1).click();
  const name = (await tracks.nth(1).locator('.name').textContent()).trim();
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await page.click('button:has-text("Скачать видео")');
  assert.equal(await tracks.first().isDisabled(), true, 'no track switching while recording');
  const file = await download;
  assert.equal(file.suggestedFilename().replace(/\.(webm|mp4)$/, ''), `dub-club-${name}`);
  // The file's content is checked in reel.test.js; here only the wiring to the download.
  assert.ok((await stat(await file.path())).size > 0, 'reel video is not empty');
  assert.equal(await tracks.first().isDisabled(), false, 'tracks are available again');
  assert.deepEqual(errors, []);
  await page.close();
});
