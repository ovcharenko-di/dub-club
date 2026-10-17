import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, openApp } from './helpers.js';

let server, browser;
before(async () => { server = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); server?.close(); });

for (const tile of ['Играть', 'Дубляж', 'Редактор', 'Паки реплик']) {
  test(`menu tile «${tile}» opens its screen without errors`, async () => {
    const { page, errors } = await openApp(browser, server.url);
    await page.click(`.menu-tile:has-text("${tile}")`);
    await page.waitForFunction(() => document.querySelector('section.screen') && !document.querySelector('.menu-grid'));
    await page.waitForTimeout(300);
    assert.deepEqual(errors, []);
    await page.close();
  });
}
