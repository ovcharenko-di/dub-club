import { audioCtx, playBuffer, stopSource, seekVideo } from './audio.js';
import { h, drawWave } from './ui.js';

/**
 * The "stage" shows a line: a video for video lines, or a waveform otherwise.
 * It can play the original, run silently alongside a recording, or play a take.
 */
export function createStage(prep) {
  const badge = h('div', { class: 'badge' }, prep.videoUrl ? '🎬 Видео' : '🔊 Аудио');
  const canvas = h('canvas');
  const video = prep.videoUrl
    ? h('video', { src: prep.videoUrl, playsInline: true, preload: 'auto', muted: true })
    : null;
  const progress = h('div');
  const el = h('div', { class: 'stack' },
    h('div', { class: 'stage' }, video || canvas, badge),
    h('div', { class: 'progress' }, progress),
  );

  const duration = prep.end - prep.start;
  let raf = 0;
  let source = null;
  let token = 0;
  let waveBuffer = prep.buffer;

  const setProgress = (p, live = false) => {
    progress.style.width = `${Math.min(100, p * 100)}%`;
    if (!video) drawWave(canvas, waveBuffer, p, { live });
  };

  function stop() {
    token++;
    cancelAnimationFrame(raf);
    stopSource(source);
    source = null;
    if (video) video.pause();
  }

  async function run({ audio, videoMuted, live = false, length = duration }) {
    stop();
    const my = ++token;
    if (video) {
      video.muted = videoMuted;
      await seekVideo(video, prep.start);
      if (my !== token) return;
      try { await video.play(); } catch (err) { console.warn(err); }
    }
    const c = audioCtx();
    let t0 = c.currentTime;
    if (audio) ({ source, startedAt: t0 } = playBuffer(audio));
    await new Promise((resolve) => {
      const tick = () => {
        if (my !== token) return resolve();
        const elapsed = c.currentTime - t0;
        if (video && video.currentTime >= prep.end) video.pause();
        setProgress(elapsed / length, live);
        if (elapsed >= length) return resolve();
        raf = requestAnimationFrame(tick);
      };
      tick();
    });
    if (my === token) {
      if (video) video.pause();
      setProgress(1, live);
    }
  }

  requestAnimationFrame(() => setProgress(0));
  if (video) video.addEventListener('loadedmetadata', () => seekVideo(video, prep.start), { once: true });

  return {
    el,
    stop,
    /** Play the reference with sound. */
    playOriginal: () => {
      waveBuffer = prep.buffer;
      return run({ audio: video ? null : prep.buffer, videoMuted: false });
    },
    /** Run the visuals without sound (while the player records). */
    playSilent: (length) => {
      waveBuffer = prep.buffer;
      return run({ audio: null, videoMuted: true, live: true, length });
    },
    /** Play a recorded take (over the muted video, if any). */
    playTake: (buffer) => {
      waveBuffer = buffer;
      return run({ audio: buffer, videoMuted: true, length: buffer.duration });
    },
  };
}
