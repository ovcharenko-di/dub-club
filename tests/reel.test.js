import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, openApp } from './helpers.js';

let server, browser;
before(async () => { server = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); server?.close(); });

// Puts a reel on the page with `window.makeTake(seconds, { video })` to build takes from tones.
async function openReel() {
  const { page, errors } = await openApp(browser, server.url);
  await page.evaluate(async () => {
    const { createReel } = await import('/js/reel.js');
    const { audioCtx } = await import('/js/audio.js');
    const tone = (seconds) => {
      const c = audioCtx();
      const buf = c.createBuffer(1, Math.round(c.sampleRate * seconds), c.sampleRate);
      buf.getChannelData(0).forEach((_, i, d) => { d[i] = Math.sin(i / 8) * 0.3; });
      return buf;
    };
    window.makeTake = (seconds, prep = {}) => ({
      player: { name: 'Игрок 1', color: '#ff4fa3' },
      line: { title: 'Тон' },
      prep: { buffer: tone(seconds), videoUrl: null, start: 0, end: seconds, text: 'Субтитр', ...prep },
      takeBuffer: tone(seconds),
      total: 12.5,
    });
    window.reel = createReel();
    document.body.append(window.reel.el);
  });
  return { page, errors };
}

const progress = (page) => page.evaluate(() => parseFloat(window.reel.el.querySelector('.progress > div').style.width) || 0);

test('a reel plays all takes back to back', async () => {
  const { page, errors } = await openReel();
  const { result, ms } = await page.evaluate(async () => {
    const t0 = performance.now();
    const result = await window.reel.play([window.makeTake(0.3), window.makeTake(0.3)]);
    return { result, ms: performance.now() - t0 };
  });
  assert.equal(result, null, 'plain playback returns no file');
  // Two title cards (1.2 s each) plus two 0.3 s takes.
  assert.ok(ms > 2900 && ms < 5000, `played for ${ms} ms`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('stop ends playback at once and a new play restarts it', async () => {
  const { page, errors } = await openReel();
  await page.evaluate(() => { window.first = window.reel.play([window.makeTake(5)]); });
  await page.waitForFunction(() => parseFloat(window.reel.el.querySelector('.progress > div').style.width) > 0);
  const stoppedIn = await page.evaluate(async () => {
    const t0 = performance.now();
    window.reel.stop();
    await window.first;
    return performance.now() - t0;
  });
  assert.ok(stoppedIn < 500, `stop took ${stoppedIn} ms`);
  await page.evaluate(() => { window.second = window.reel.play([window.makeTake(5)]); });
  await page.waitForTimeout(300);
  assert.ok(await progress(page) > 0, 'second playback runs');
  await page.evaluate(() => window.reel.stop());
  assert.deepEqual(errors, []);
  await page.close();
});

test('recording a reel yields a video file; stopping it yields nothing', async () => {
  const { page, errors } = await openReel();
  // Check content, not file size: under CPU load the canvas yields fewer frames and the file
  // shrinks, but the audio track runs in real time and keeps its length.
  const { type, seconds, width, height, stopped } = await page.evaluate(async () => {
    const { decode } = await import('/js/audio.js');
    // Name the failing step: this test has been flaky when test files run in parallel.
    const step = async (name, fn) => {
      try { return await fn(); } catch (err) { throw new Error(`${name}: ${err?.name} ${err?.message ?? err}`); }
    };
    const blob = await step('record', () => window.reel.play([window.makeTake(0.5)], { record: true }));
    const pending = window.reel.play([window.makeTake(5)], { record: true });
    setTimeout(() => window.reel.stop(), 300);
    const video = document.createElement('video');
    video.src = URL.createObjectURL(blob);
    await step('load video', () => new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(video.error);
    }));
    const seconds = await step('decode audio', async () => (await decode(blob)).duration);
    return { type: blob.type, seconds, width: video.videoWidth, height: video.videoHeight, stopped: await pending };
  });
  assert.match(type, /^video\//);
  // A 1.2 s title card plus the 0.5 s take.
  assert.ok(seconds > 1.4 && seconds < 2.5, `audio track lasts ${seconds} s`);
  assert.deepEqual([width, height], [1280, 720]);
  assert.equal(stopped, null);
  assert.deepEqual(errors, []);
  await page.close();
});

test('video takes draw the original footage under the overlays', async () => {
  const { page, errors } = await openReel();
  const colorful = await page.evaluate(async () => {
    // A 2 s solid magenta clip, recorded right in the page.
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const g = canvas.getContext('2d');
    const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const timer = setInterval(() => { g.fillStyle = '#ff00ff'; g.fillRect(0, 0, 320, 180); }, 33);
    rec.start();
    await new Promise((r) => setTimeout(r, 2000));
    rec.stop();
    await new Promise((r) => { rec.onstop = r; });
    clearInterval(timer);
    const videoUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));

    const done = window.reel.play([window.makeTake(1, { videoUrl, start: 0.2, end: 1.2 })]);
    await new Promise((r) => setTimeout(r, 1700)); // past the title card
    const px = window.reel.el.querySelector('canvas').getContext('2d').getImageData(640, 360, 1, 1).data;
    window.reel.stop();
    await done;
    return px[0] > 200 && px[1] < 60 && px[2] > 200;
  });
  assert.ok(colorful, 'the middle of the frame shows the video');
  assert.deepEqual(errors, []);
  await page.close();
});
