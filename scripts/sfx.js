// sfx.js — gate sound effects, synthesized with the Web Audio API (no audio
// files, nothing to license). Sfx.play(name) respects settings.soundEffects.
//   hell   portcullis slam + low drone (Hell gate appears)
//   chime  soft bell (reflection wait is over)
//   grind  iron gate grinding open (Going through, ~5 s)
//   heaven rising choir chord (walking away)
//   deny   short low buzz (paste blocked)

(function (root) {
  'use strict';

  let ctx = null;
  let enabled = true;
  const ready = (async () => {
    try {
      const { settings } = await chrome.storage.local.get(['settings']);
      enabled = !settings || settings.soundEffects !== false;
    } catch {}
  })();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) enabled = !changes.settings.newValue || changes.settings.newValue.soundEffects !== false;
    });
  } catch {}

  function audio() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function master(a, gain) {
    const g = a.createGain();
    g.gain.value = gain;
    const comp = a.createDynamicsCompressor();
    g.connect(comp).connect(a.destination);
    return g;
  }

  function noiseBuffer(a, seconds, brown) {
    const len = Math.floor(a.sampleRate * seconds);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return buf;
  }

  // Exponential envelope on a gain param.
  function env(param, t, attack, peak, release) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + release);
  }

  function tone(a, out, { type = 'sine', freq, to, t, attack = 0.01, peak = 0.3, release = 1 }) {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + release);
    env(g.gain, t, attack, peak, release);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + attack + release + 0.05);
  }

  function noise(a, out, { t, dur, filter = 'lowpass', freq = 400, q = 1, attack = 0.005, peak = 0.5, brown = false }) {
    const src = a.createBufferSource();
    src.buffer = noiseBuffer(a, dur + attack + 0.1, brown);
    const f = a.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = a.createGain();
    env(g.gain, t, attack, peak, dur);
    src.connect(f).connect(g).connect(out);
    src.start(t);
    return { src, filter: f, gain: g };
  }

  const SOUNDS = {
    hell(a) {
      const out = master(a, 0.55);
      const t = a.currentTime + 0.55; // lands with the portcullis
      tone(a, out, { freq: 90, to: 38, t, attack: 0.005, peak: 0.9, release: 0.9 });
      noise(a, out, { t, dur: 0.35, freq: 900, peak: 0.6 });
      noise(a, out, { t: t + 0.02, dur: 0.5, filter: 'bandpass', freq: 2400, q: 6, peak: 0.25 }); // iron clank
      tone(a, out, { type: 'sawtooth', freq: 46, t: t + 0.1, attack: 0.6, peak: 0.12, release: 2.6 });
      tone(a, out, { type: 'sawtooth', freq: 46.7, t: t + 0.1, attack: 0.6, peak: 0.1, release: 2.6 });
    },
    chime(a) {
      const out = master(a, 0.35);
      const t = a.currentTime + 0.02;
      for (const [f, d] of [[659.25, 0], [987.77, 0.14]]) {
        tone(a, out, { freq: f, t: t + d, attack: 0.008, peak: 0.35, release: 1.8 });
        tone(a, out, { freq: f * 2.76, t: t + d, attack: 0.005, peak: 0.06, release: 0.6 }); // bell partial
      }
    },
    grind(a) {
      const out = master(a, 0.5);
      const t = a.currentTime + 0.02;
      const dur = 4.8;
      const n = noise(a, out, { t, dur, freq: 260, q: 4, attack: 0.6, peak: 0.7, brown: true });
      // Uneven stutter: the gate catches as it drags.
      const lfo = a.createOscillator();
      const lfoGain = a.createGain();
      lfo.type = 'square';
      lfo.frequency.setValueAtTime(7, t);
      lfo.frequency.linearRampToValueAtTime(3, t + dur);
      lfoGain.gain.value = 120;
      lfo.connect(lfoGain).connect(n.filter.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.6);
      tone(a, out, { type: 'sawtooth', freq: 52, to: 40, t, attack: 0.8, peak: 0.08, release: dur });
      // The clunk as it comes to rest.
      tone(a, out, { freq: 70, to: 40, t: t + dur, attack: 0.005, peak: 0.6, release: 0.6 });
      noise(a, out, { t: t + dur, dur: 0.25, freq: 700, peak: 0.4 });
    },
    heaven(a) {
      const out = master(a, 0.3);
      const t = a.currentTime + 0.05;
      for (const f of [261.63, 329.63, 392, 523.25]) {
        tone(a, out, { type: 'triangle', freq: f, t, attack: 0.7, peak: 0.16, release: 2.6 });
        tone(a, out, { freq: f * 1.003, t, attack: 0.9, peak: 0.1, release: 2.6 });
      }
      [1046.5, 1318.5, 1568, 2093].forEach((f, i) => {
        tone(a, out, { freq: f, t: t + 0.35 + i * 0.16, attack: 0.01, peak: 0.08, release: 1.4 });
      });
    },
    deny(a) {
      const out = master(a, 0.25);
      const t = a.currentTime + 0.01;
      tone(a, out, { type: 'square', freq: 110, t, attack: 0.005, peak: 0.2, release: 0.12 });
      tone(a, out, { type: 'square', freq: 98, t: t + 0.16, attack: 0.005, peak: 0.2, release: 0.16 });
    }
  };

  async function play(name, opts) {
    const force = opts && opts.force;
    await ready;
    if (!enabled && !force) return;
    const fn = SOUNDS[name];
    const a = fn && audio();
    if (!a) return;
    try { fn(a); } catch (err) { console.warn('[GatesOfHeavenAndHell] Sound failed:', err); }
  }

  root.Sfx = { play };
})(typeof self !== 'undefined' ? self : this);
