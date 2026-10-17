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
    const { createReel, buildTimeline } = await import('/js/reel.js');
    window.buildTimeline = buildTimeline;
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
    });
    window.reel = createReel();
    document.body.append(window.reel.el);
  });
  return { page, errors };
}

const progress = (page) => page.evaluate(() => parseFloat(window.reel.el.querySelector('.progress > div').style.width) || 0);

test('lines of one video share a stretch of footage, far ones are cut apart', async () => {
  const { page, errors } = await openReel();
  const segments = await page.evaluate(() => {
    const take = (start, end, seconds) => window.makeTake(seconds, { videoUrl: 'blob:v', start, end });
    const { segments } = window.buildTimeline([take(0.2, 1.2, 2), take(1.5, 2.5, 1), take(20, 21, 1)]);
    return segments.map((s) => ({ from: s.from, to: s.to, slots: s.slots.map((x) => [x.offset, x.until]) }));
  });
  const round = (n) => Math.round(n * 100) / 100;
  assert.deepEqual(segments.map((s) => [s.from, s.to]), [[0.2, 2.5], [20, 21]]);
  // Each take starts on its line; a long take stops where the next line starts.
  assert.deepEqual(segments[0].slots.map((x) => x.map(round)), [[0, 1.3], [1.3, 2.3]]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a reel plays the lines without pauses between them', async () => {
  const { page, errors } = await openReel();
  const { result, ms } = await page.evaluate(async () => {
    const t0 = performance.now();
    const result = await window.reel.play([window.makeTake(0.3), window.makeTake(0.3)]);
    return { result, ms: performance.now() - t0 };
  });
  assert.equal(result, null, 'plain playback returns no file');
  // Two 0.3 s lines, each followed by a 0.5 s tail; no title cards.
  assert.ok(ms > 1400 && ms < 2800, `played for ${ms} ms`);
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

test('a reel can start from a given moment', async () => {
  const { page, errors } = await openReel();
  const { ms, position } = await page.evaluate(async () => {
    const t0 = performance.now();
    const done = window.reel.play([window.makeTake(0.3), window.makeTake(0.3)], { from: 1 });
    await new Promise((r) => setTimeout(r, 200));
    const position = window.reel.position;
    await done;
    return { ms: performance.now() - t0, position };
  });
  // 1.6 s in total, started 1 s in.
  assert.ok(ms > 450 && ms < 1300, `played for ${ms} ms`);
  assert.ok(position >= 1 && position < 1.6, `position ${position}`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('recording a reel yields a video file; stopping it yields nothing', async () => {
  const { page, errors } = await openReel();
  // Check content, not file size: under CPU load the canvas yields fewer frames and the file shrinks.
  const { type, seconds, audio, width, height, stopped } = await page.evaluate(async () => {
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
    // WebM from MediaRecorder reports duration Infinity until seeked to the end.
    const seconds = await step('measure video', () => new Promise((resolve) => {
      video.onseeked = () => resolve(video.duration);
      video.currentTime = 1e6;
    }));
    const audio = await step('decode audio', async () => (await decode(blob)).duration);
    return { type: blob.type, seconds, audio, width: video.videoWidth, height: video.videoHeight, stopped: await pending };
  });
  assert.match(type, /^video\//);
  // The 0.5 s take plus a 0.5 s tail, after the first frame held while the encoder starts
  // (up to ~1.5 s for the first recording in a page). The audio track ends with the last sound,
  // so the length is taken from the video track.
  assert.ok(seconds > 0.9 && seconds < 3.2, `video track lasts ${seconds} s`);
  assert.ok(audio > 0.3, `audio track lasts ${audio} s`);
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
    await new Promise((r) => setTimeout(r, 600));
    const px = window.reel.el.querySelector('canvas').getContext('2d').getImageData(640, 360, 1, 1).data;
    window.reel.stop();
    await done;
    return px[0] > 200 && px[1] < 60 && px[2] > 200;
  });
  assert.ok(colorful, 'the middle of the frame shows the video');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the original sound stays and is ducked while a line lasts', { timeout: 60_000 }, async () => {
  const { page, errors } = await openReel();
  const rms = await page.evaluate(async () => {
    const { audioCtx, decode } = await import('/js/audio.js');
    // A 3.5 s clip whose sound is a steady 1 kHz tone, recorded right in the page.
    const c = audioCtx();
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const g = canvas.getContext('2d');
    const osc = c.createOscillator();
    osc.frequency.value = 1000;
    const dest = c.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const stream = canvas.captureStream(30);
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    let n = 0;
    const timer = setInterval(() => { g.fillStyle = n++ % 2 ? '#00ff00' : '#00fe00'; g.fillRect(0, 0, 320, 180); }, 33);
    rec.start();
    await new Promise((r) => setTimeout(r, 3500));
    rec.stop();
    await new Promise((r) => { rec.onstop = r; });
    clearInterval(timer);
    osc.stop();
    const videoUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));

    // Silent takes, so whatever is heard is the original. Lines at 0.2–0.4 s and 1.4–2.4 s.
    const silent = (take) => ({ ...take, takeBuffer: c.createBuffer(1, take.takeBuffer.length, take.takeBuffer.sampleRate) });
    const blob = await window.reel.play([
      silent(window.makeTake(0.2, { videoUrl, start: 0.2, end: 0.4 })),
      silent(window.makeTake(1, { videoUrl, start: 1.4, end: 2.4 })),
    ], { record: true });
    const buf = await decode(blob);
    const data = buf.getChannelData(0);
    const step = Math.round(buf.sampleRate * 0.05);
    const out = [];
    for (let i = 0; i + step <= data.length; i += step) {
      let sum = 0;
      for (let j = i; j < i + step; j++) sum += data[j] * data[j];
      out.push(Math.sqrt(sum / step));
    }
    return out;
  });
  // Loud between the lines, then a quiet stretch as long as the 1 s line, then loud again.
  const loud = Math.max(...rms);
  assert.ok(loud > 0.05, `the original is heard (peak RMS ${loud})`);
  const first = rms.findIndex((v) => v > loud * 0.5);
  const quietFrom = rms.findIndex((v, i) => i > first && v < loud * 0.3);
  const quietTo = rms.findIndex((v, i) => i > quietFrom && v > loud * 0.5);
  const quiet = (quietTo - quietFrom) * 0.05;
  assert.ok(first >= 0 && quietFrom > first && quietTo > quietFrom, `RMS: ${rms.map((v) => v.toFixed(2)).join(' ')}`);
  assert.ok(quiet > 0.7 && quiet < 1.4, `ducked for ${quiet} s; RMS: ${rms.map((v) => v.toFixed(2)).join(' ')}`);
  assert.deepEqual(errors, []);
  await page.close();
});
