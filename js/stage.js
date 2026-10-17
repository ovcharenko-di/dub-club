import { audioCtx, playBuffer, stopSource, seekVideo } from './audio.js';
import { h, drawWave } from './ui.js';

/**
 * The "stage" shows a line: a video for video lines, or a waveform otherwise.
 * It can play the original, run silently alongside a recording, or play a take.
 */
export function createStage(prep) {
  const badge = h('div', { class: 'badge' }, prep.videoUrl ? '🎬 Видео' : '🔊 Аудио');
  const video = prep.videoUrl
    ? h('video', { src: prep.videoUrl, playsInline: true, preload: 'auto', muted: true })
    : null;
  // Video lines get the waveform as a strip under the picture, so the take can be laid over it too.
  const canvas = h('canvas', { class: video ? 'wave-strip' : null });
  const el = h('div', { class: 'stack' },
    h('div', { class: 'stage' }, video || canvas, badge,
      prep.text && h('div', { class: 'subtitle' }, prep.text)),
    video && canvas,
  );

  const duration = prep.end - prep.start;
  let raf = 0;
  let source = null;
  let token = 0;
  let waveBuffer = prep.buffer;
  // Mic levels of the current recording, placed on the original's time axis.
  let take = null;

  // `p` is the position on the wave; while recording, the growing take shows what is done,
  // and a highlight under it would muddy its colour, so only the playhead moves.
  const setProgress = (p, { live = false, recording = false } = {}) => {
    drawWave(canvas, waveBuffer, recording ? 0 : p, { live, take, playhead: p > 0 && p < 1 ? p : null });
  };

  function stop() {
    token++;
    cancelAnimationFrame(raf);
    stopSource(source);
    source = null;
    if (video) video.pause();
  }

  async function run({ audio, videoMuted, live = false, length = duration, level = null }) {
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
        if (level) take.push({ at: elapsed / waveBuffer.duration, level: level() });
        // The wave moves at the line's own pace even when the recording runs longer.
        setProgress(elapsed / waveBuffer.duration, { live, recording: !!level });
        if (elapsed >= length) return resolve();
        raf = requestAnimationFrame(tick);
      };
      tick();
    });
    if (my === token) {
      if (video) video.pause();
      setProgress(1, { live, recording: !!level });
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
    /** Run the visuals without sound (while the player records); `level()` is the mic level to draw over the wave. */
    playSilent: (length, level = null) => {
      waveBuffer = prep.buffer;
      take = level ? [] : null;
      return run({ audio: null, videoMuted: true, live: true, length, level });
    },
    /** Play a recorded take (over the muted video, if any). */
    playTake: (buffer) => {
      waveBuffer = buffer;
      take = null;
      return run({ audio: buffer, videoMuted: true, length: buffer.duration });
    },
  };
}
