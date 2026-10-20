/* Playback engine: sampled instruments (FluidR3 GM, MIT), synthesized percussion, hall reverb,
   look-ahead scheduler with loop + original-audio overlay, offline mixdown.  Global: Player */
(function () {
  const PPQ = T.PPQ;
  let ctx = null, master = null, comp = null, revIn = null, origGain = null, clickGain = null;
  let manifest = null; const samples = {}; const loading = {};
  const busses = new Map();
  let noiseBuf = null;

  function makeIR(c, secs = 2.4, decay = 2.8) {
    const len = Math.floor(c.sampleRate * secs); const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); let lp = 0; for (let i = 0; i < len; i++) { const t = i / len; lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4; d[i] = lp * Math.pow(1 - t, decay) * (i < c.sampleRate * 0.012 ? i / (c.sampleRate * 0.012) : 1); } }
    return ir;
  }
  function makeNoise(c) { const b = c.createBuffer(1, c.sampleRate, c.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; }

  // A "graph" = destination chain on a given context (live or offline)
  function makeGraph(c) {
    const g = { c };
    g.comp = c.createDynamicsCompressor(); g.comp.threshold.value = -16; g.comp.ratio.value = 3; g.comp.attack.value = 0.01; g.comp.release.value = 0.25;
    // brick-wall style limiter after the bus compressor so dense tutti passages never clip
    g.limit = c.createDynamicsCompressor(); g.limit.threshold.value = -3; g.limit.knee.value = 0; g.limit.ratio.value = 20; g.limit.attack.value = 0.002; g.limit.release.value = 0.12;
    g.master = c.createGain(); g.master.gain.value = 0.8;
    g.sum = c.createGain(); g.sum.gain.value = 1;
    g.master.connect(g.sum); g.sum.connect(g.comp); g.comp.connect(g.limit); g.limit.connect(c.destination);
    const conv = c.createConvolver(); conv.buffer = makeIR(c);
    g.revIn = c.createGain(); g.revIn.gain.value = 1; const revOut = c.createGain(); revOut.gain.value = 0.55;
    g.revIn.connect(conv); conv.connect(revOut); revOut.connect(g.comp);
    g.noise = makeNoise(c);
    g.busses = new Map();
    return g;
  }
  let live = null;
  async function ensure() {
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      ctx = new C({ latencyHint: 'interactive' });
      live = makeGraph(ctx);
      origGain = ctx.createGain(); origGain.gain.value = 0.7; origGain.connect(live.comp);
      clickGain = ctx.createGain(); clickGain.gain.value = 0.5; clickGain.connect(live.master);
    }
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { } }
    return ctx;
  }

  function bus(g, track) {
    let b = g.busses.get(track.id);
    if (!b) {
      const gain = g.c.createGain(), pan = g.c.createStereoPanner ? g.c.createStereoPanner() : null, send = g.c.createGain();
      if (pan) { gain.connect(pan); pan.connect(g.master); pan.connect(send); } else { gain.connect(g.master); gain.connect(send); }
      send.connect(g.revIn);
      b = { gain, pan, send }; g.busses.set(track.id, b);
    }
    const fam = T.INSTR[track.inst]?.family;
    b.send.gain.value = fam === 'strings' ? 0.42 : fam === 'brass' ? 0.36 : fam === 'woodwinds' ? 0.36 : fam === 'percussion' ? 0.3 : 0.24;
    return b;
  }

  async function loadManifest() {
    if (manifest) return manifest;
    const r = await fetch('samples/manifest.json'); manifest = await r.json(); return manifest;
  }
  function loadInstrument(instKey) {
    const inst = T.INSTR[instKey]; if (!inst || !inst.sample) return Promise.resolve(null);
    const key = inst.sample;
    if (samples[key]) return Promise.resolve(samples[key]);
    if (loading[key]) return loading[key];
    loading[key] = (async () => {
      await ensure(); const m = await loadManifest(); const info = m[key];
      const ab = await (await fetch(info.file)).arrayBuffer();
      const buf = await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
      // find codec delay: first sample above 5% of slot-0 peak
      const d = buf.getChannelData(0); const slotN = Math.floor(info.slot * buf.sampleRate);
      let pk = 0; for (let i = 0; i < Math.min(d.length, slotN); i++) pk = Math.max(pk, Math.abs(d[i]));
      let first = 0; for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.05 * pk) { first = i; break; }
      const delay = Math.max(0, first / buf.sampleRate - info.mark);
      samples[key] = { buffer: buf, notes: info.notes, slot: info.slot, loop: info.loop, delay, valid: info.valid || info.notes.map(() => true), tune: info.tune || info.notes.map(() => 0) };
      return samples[key];
    })().catch(e => { delete loading[key]; console.warn('sample load failed', key, e); return null; });
    return loading[key];
  }
  async function loadFor(tracks) { await Promise.all([...new Set(tracks.map(t => t.inst))].map(loadInstrument)); }
  const isLoaded = instKey => { const s = T.INSTR[instKey]?.sample; return !s || !!samples[s]; };

  // ---- voices
  function velGain(v) { return Math.pow(Math.max(1, v) / 127, 1.45) * 1.15; }
  function voice(g, instKey, p, v, when, dur, dest) {
    const inst = T.INSTR[instKey]; const c = g.c;
    if (!inst) return;
    if (inst.drums) return drum(g, p, v, when, dest);
    const smp = samples[inst.sample];
    if (!smp) return synthVoice(g, inst, p, v, when, dur, dest);
    let best = 0, bd = 1e9; smp.notes.forEach((n, i) => { if (!smp.valid[i]) return; const dd = Math.abs(n - p) + (n > p ? 0.01 : 0); if (dd < bd) { bd = dd; best = i; } });
    const rate = Math.pow(2, (p - smp.notes[best] - (smp.tune[best] || 0) / 100) / 12);
    const off = smp.delay + best * smp.slot;
    const src = c.createBufferSource(); src.buffer = smp.buffer; src.playbackRate.value = rate;
    const env = c.createGain(); const peak = inst.gain * velGain(v);
    const att = inst.att || 0.01, rel = inst.rel || 0.15;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(peak, when + att);
    let node = src;
    if (instKey === 'piano' || instKey === 'harp') {
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400 + 9000 * Math.pow(v / 127, 1.6) + (p - 40) * 40; f.Q.value = 0.3;
      src.connect(f); node = f;
    }
    node.connect(env); env.connect(dest);
    const sustained = !!smp.loop;
    let end;
    if (sustained) {
      src.loop = true; src.loopStart = off + smp.loop[0]; src.loopEnd = off + smp.loop[1];
      const hold = Math.max(att + 0.02, dur);
      env.gain.setValueAtTime(peak, when + Math.min(hold, att + 0.001));
      env.gain.setTargetAtTime(0, when + hold, rel / 3);
      end = when + hold + rel * 3;
    } else {
      const natural = (smp.slot - 0.12) / rate;
      const hold = Math.min(natural, Math.max(0.05, dur));
      env.gain.setTargetAtTime(0, when + hold, (instKey === 'piano' ? 0.09 : rel) / 2.5);
      end = Math.min(when + natural, when + hold + rel * 3);
    }
    src.start(when, off);
    src.stop(end + 0.05);
  }
  function synthVoice(g, inst, p, v, when, dur, dest) {
    const c = g.c; const o = c.createOscillator(); const e = c.createGain();
    o.type = inst.family === 'brass' ? 'sawtooth' : inst.family === 'strings' ? 'sawtooth' : 'triangle';
    o.frequency.value = 440 * Math.pow(2, (p - 69) / 12);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2400;
    const pk = 0.18 * velGain(v);
    e.gain.setValueAtTime(0, when); e.gain.linearRampToValueAtTime(pk, when + 0.02); e.gain.setTargetAtTime(0, when + Math.max(0.05, dur), 0.08);
    o.connect(f); f.connect(e); e.connect(dest); o.start(when); o.stop(when + dur + 0.6);
  }
  function drum(g, p, v, when, dest) {
    const c = g.c; const amp = velGain(v);
    const noise = (filterType, freq, q, decay, gain) => {
      const s = c.createBufferSource(); s.buffer = g.noise; const f = c.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
      const e = c.createGain(); e.gain.setValueAtTime(gain * amp, when); e.gain.exponentialRampToValueAtTime(0.0008, when + decay);
      s.connect(f); f.connect(e); e.connect(dest); s.start(when, Math.random() * 0.5); s.stop(when + decay + 0.05);
    };
    const tone = (type, f0, f1, decay, gain) => {
      const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, when); if (f1) o.frequency.exponentialRampToValueAtTime(f1, when + decay * 0.5);
      const e = c.createGain(); e.gain.setValueAtTime(gain * amp, when); e.gain.exponentialRampToValueAtTime(0.0008, when + decay);
      o.connect(e); e.connect(dest); o.start(when); o.stop(when + decay + 0.05);
    };
    if (p === 35 || p === 36) { tone('sine', 95, 38, 1.1, 1.3); noise('lowpass', 300, 0.7, 0.25, 0.35); }
    else if (p === 38 || p === 40) { noise('bandpass', 2400, 0.8, 0.22, 0.6); tone('triangle', 210, 160, 0.1, 0.35); }
    else if (p === 49 || p === 57) { noise('highpass', 4500, 0.4, 2.6, 0.32); noise('bandpass', 7800, 1.2, 1.4, 0.18); }
    else if (p === 51 || p === 59) { noise('bandpass', 6200, 2, 1.8, 0.16); }
    else if (p === 81 || p === 80) { tone('sine', 4180, 0, 1.7, 0.08); tone('sine', 6250, 0, 1.1, 0.05); }
    else { noise('highpass', 7000, 0.6, p === 46 ? 0.35 : 0.06, 0.2); }
  }

  // ---- timing
  function makeClock(st, an, L) {
    if (st.timing === 'original' && L && L.identity && an && an.beatTimes) {
      const bm = Analysis.makeBeatMap(an.beatTimes);
      const bt = an.beatTicks || PPQ;
      return { tickToSec: t => bm.toTime(t / bt), secToTick: s => bm.toBeat(s) * bt, original: true };
    }
    const spt = 60 / (st.tempo * PPQ);
    return { tickToSec: t => t * spt, secToTick: s => s / spt, original: false };
  }
  function swingTick(t, st) {
    if (!st.swing) return t;
    const beat = PPQ; const r = t % beat;
    if (r === beat / 2) return t + beat / 6;
    return t;
  }

  // ---- transport
  const tr = {
    playing: false, segs: [], events: [], idx: 0, scheduledTo: 0, timer: null, loop: null, tracks: [], st: null, clock: null,
    origSrc: null, origBuf: null, origOn: false, click: false, onEnd: null, endTick: 0,
  };

  function buildEvents(tracks) {
    const ev = [];
    for (const t of tracks) for (const n of t.notes) ev.push({ s: n.s, n, t });
    ev.sort((a, b) => a.s - b.s);
    return ev;
  }
  function audible(t, tracks) { const anySolo = tracks.some(x => x.solo); return anySolo ? t.solo : !t.mute; }
  const autoGain = n => Math.min(1, 2.6 / Math.sqrt(Math.max(1, n)));
  function applyMix(tracks) {
    if (!live) return;
    const anySolo = tracks.some(x => x.solo);
    const active = tracks.filter(t => (anySolo ? t.solo : !t.mute) && t.notes.length).length;
    live.sum.gain.setTargetAtTime(autoGain(active), ctx.currentTime, 0.05);
    for (const t of tracks) {
      const b = bus(live, t); const on = anySolo ? t.solo : !t.mute;
      b.gain.gain.setTargetAtTime(on ? t.vol : 0, ctx.currentTime, 0.02);
      if (b.pan) b.pan.pan.setTargetAtTime(t.pan || 0, ctx.currentTime, 0.02);
    }
  }
  function currentTick() {
    if (!tr.playing || !tr.segs.length) return tr.pos || 0;
    const now = ctx.currentTime;
    let seg = tr.segs[0]; for (const s of tr.segs) if (s.c0 <= now) seg = s;
    return Math.max(seg.t0, tr.clock.secToTick(tr.clock.tickToSec(seg.t0) + (now - seg.c0)));
  }
  function startOriginal(seg) {
    stopOriginal();
    if (!tr.origOn || !tr.origBuf || !tr.clock.original) return;
    const src = ctx.createBufferSource(); src.buffer = tr.origBuf; src.connect(origGain);
    let offset = tr.clock.tickToSec(seg.t0); let when = seg.c0;
    if (offset < 0) { when -= offset; offset = 0; }
    if (offset < tr.origBuf.duration) src.start(when, offset);
    tr.origSrc = src;
  }
  function stopOriginal() { if (tr.origSrc) { try { tr.origSrc.stop(); } catch (e) { } tr.origSrc = null; } }

  function schedule() {
    const ahead = 0.18, now = ctx.currentTime;
    let seg = tr.segs[tr.segs.length - 1];
    const horizonSec = now + ahead;
    const segEndTick = tr.loop ? tr.loop.b : tr.endTick;
    const toTick = Math.min(segEndTick, tr.clock.secToTick(tr.clock.tickToSec(seg.t0) + (horizonSec - seg.c0)));
    while (tr.idx < tr.events.length && tr.events[tr.idx].s < toTick) {
      const e = tr.events[tr.idx++];
      if (e.s < seg.t0) continue;
      if (!audible(e.t, tr.tracks)) continue;
      const s = swingTick(e.s, tr.st);
      const when = seg.c0 + tr.clock.tickToSec(s) - tr.clock.tickToSec(seg.t0);
      const endT = Math.min(e.s + e.n.d, tr.loop ? tr.loop.b : 1e12);
      const dur = tr.clock.tickToSec(endT) - tr.clock.tickToSec(e.s);
      if (when < now - 0.05) continue;
      voice(live, e.t.inst, e.n.p, e.n.v, Math.max(now, when), Math.max(0.03, dur), bus(live, e.t).gain);
    }
    // metronome
    if (tr.click) {
      const beatT = tr.st && tr.lead ? tr.lead.ts.beatTicks : PPQ, barT = tr.lead ? tr.lead.ts.barTicks : PPQ * 4;
      let k = Math.ceil(Math.max(tr.clickTo ?? seg.t0, seg.t0) / beatT) * beatT;
      for (; k < toTick; k += beatT) {
        const when = seg.c0 + tr.clock.tickToSec(k) - tr.clock.tickToSec(seg.t0);
        if (when >= now - 0.01) { const o = ctx.createOscillator(); const e = ctx.createGain(); o.frequency.value = k % barT === 0 ? 1760 : 1175; e.gain.setValueAtTime(0.0001, when); e.gain.exponentialRampToValueAtTime(0.5, when + 0.002); e.gain.exponentialRampToValueAtTime(0.0001, when + 0.05); o.connect(e); e.connect(clickGain); o.start(when); o.stop(when + 0.06); }
      }
      tr.clickTo = toTick;
    }
    if (toTick >= segEndTick - 1e-6) {
      const endSec = seg.c0 + tr.clock.tickToSec(segEndTick) - tr.clock.tickToSec(seg.t0);
      if (tr.loop) {
        const nseg = { t0: tr.loop.a, c0: endSec };
        tr.segs.push(nseg); if (tr.segs.length > 8) tr.segs.shift();
        tr.idx = lowerBound(tr.events, tr.loop.a); tr.clickTo = tr.loop.a;
        if (tr.origOn) setTimeout(() => { if (tr.playing) startOriginal(nseg); }, Math.max(0, (endSec - ctx.currentTime) * 1000 - 30));
      } else if (endSec <= now + 0.01) {
        stop(); tr.pos = tr.endTick; tr.onEnd && tr.onEnd();
      }
    }
  }
  function lowerBound(ev, t) { let lo = 0, hi = ev.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].s < t) lo = m + 1; else hi = m; } return lo; }

  async function play(opts) {
    await ensure();
    stop(true);
    Object.assign(tr, { tracks: opts.tracks, st: opts.st, lead: opts.L, loop: opts.loop || null, origOn: !!opts.original, click: !!opts.click, onEnd: opts.onEnd, endTick: opts.endTick });
    tr.clock = makeClock(opts.st, opts.an, opts.L);
    applyMix(tr.tracks);
    tr.events = buildEvents(tr.tracks);
    let t0 = opts.from || 0;
    if (tr.loop && (t0 < tr.loop.a || t0 >= tr.loop.b)) t0 = tr.loop.a;
    if (t0 >= tr.endTick) t0 = 0;
    tr.idx = lowerBound(tr.events, t0);
    // let notes already sounding at t0 start too
    const c0 = ctx.currentTime + 0.08;
    tr.segs = [{ t0, c0 }]; tr.clickTo = t0;
    for (const e of tr.events) { if (e.s >= t0) break; if (e.s + e.n.d > t0 + 60 && audible(e.t, tr.tracks)) voice(live, e.t.inst, e.n.p, Math.round(e.n.v * 0.85), c0, tr.clock.tickToSec(e.s + e.n.d) - tr.clock.tickToSec(t0), bus(live, e.t).gain); }
    tr.playing = true;
    startOriginal(tr.segs[0]);
    schedule();
    tr.timer = setInterval(schedule, 25);
  }
  function refresh(tracks, st, L, an) {
    if (!tr.playing) return;
    tr.tracks = tracks; tr.st = st; tr.lead = L;
    const tick = currentTick();
    tr.events = buildEvents(tracks);
    tr.idx = lowerBound(tr.events, Math.max(tick, tr.clock.secToTick(tr.clock.tickToSec(tr.segs[tr.segs.length - 1].t0) + (ctx.currentTime + 0.18 - tr.segs[tr.segs.length - 1].c0))));
    applyMix(tracks);
  }
  function stop(silent) {
    if (tr.timer) clearInterval(tr.timer); tr.timer = null;
    if (tr.playing) tr.pos = currentTick();
    tr.playing = false;
    stopOriginal();
    if (live && !silent) {
      // fade everything quickly
      live.master.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
      const g = live.master.gain; setTimeout(() => { g.cancelScheduledValues(ctx.currentTime); g.setValueAtTime(tr.masterVol ?? 0.8, ctx.currentTime); }, 160);
      // disconnect old busses so scheduled notes stop
      for (const [, b] of live.busses) { try { b.gain.disconnect(); } catch (e) { } }
      live.busses.clear();
    } else if (live) {
      for (const [, b] of live.busses) { try { b.gain.disconnect(); } catch (e) { } }
      live.busses.clear();
    }
  }
  async function preview(instKey, p, v = 90, dur = 0.5, track) {
    await ensure(); await loadInstrument(instKey);
    const dest = live.master;
    voice(live, instKey, p, v, ctx.currentTime + 0.01, dur, dest);
  }
  function setMaster(v) { tr.masterVol = v; if (live) live.master.gain.setTargetAtTime(v, ctx.currentTime, 0.02); }
  function setOriginalBuffer(buf) { tr.origBuf = buf; }
  function setOriginalVol(v) { if (origGain) origGain.gain.setTargetAtTime(v, ctx.currentTime, 0.03); tr.origVol = v; }
  function playOriginalSnippet(fromSec, dur) {
    if (!tr.origBuf) return; ensure().then(() => { stopOriginal(); const s = ctx.createBufferSource(); s.buffer = tr.origBuf; s.connect(origGain); s.start(ctx.currentTime + 0.02, Math.max(0, fromSec), dur); tr.origSrc = s; });
  }

  // ---- offline mixdown -> WAV bytes
  async function renderMix(tracks, st, L, an, onProgress) {
    await loadFor(tracks);
    const clock = makeClock(st, an, L);
    const endTick = L.totalTicks;
    const t0s = clock.tickToSec(0);
    const dur = clock.tickToSec(endTick) - t0s + 3;
    const sr = 44100;
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const oc = new OC(2, Math.ceil(dur * sr), sr);
    const g = makeGraph(oc);
    const anySolo = tracks.some(t => t.solo);
    g.sum.gain.value = autoGain(tracks.filter(t => (anySolo ? t.solo : !t.mute) && t.notes.length).length);
    for (const t of tracks) {
      if (anySolo ? !t.solo : t.mute) continue;
      const b = bus(g, t); b.gain.gain.value = t.vol; if (b.pan) b.pan.pan.value = t.pan || 0;
      for (const n of t.notes) {
        const s = swingTick(n.s, st);
        voice(g, t.inst, n.p, n.v, 0.05 + clock.tickToSec(s) - t0s, clock.tickToSec(n.s + n.d) - clock.tickToSec(n.s), b.gain);
      }
    }
    onProgress && onProgress(0.3);
    const buf = await oc.startRendering();
    onProgress && onProgress(0.9);
    return encodeWav(buf);
  }
  function encodeWav(buf) {
    const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); ws(8, 'WAVE'); ws(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
    out.setUint16(22, ch, true); out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
    ws(36, 'data'); out.setUint32(40, len * ch * 2, true);
    const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    let pk = 0; for (const d of data) for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(d[i]));
    const gain = pk > 0.98 ? 0.98 / pk : 1;
    let o = 44; for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i] * gain)); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
    return new Uint8Array(out.buffer);
  }

  window.Player = {
    ensure, loadInstrument, loadFor, isLoaded, play, stop, refresh, preview, currentTick, applyMix: tracks => applyMix(tracks),
    setMaster, setOriginalBuffer, setOriginalVol, playOriginalSnippet, renderMix, makeClock,
    get playing() { return tr.playing; }, get pos() { return tr.pos || 0; }, set pos(v) { tr.pos = v; },
    setClick(on) { tr.click = on; }, setOriginalOn(on) { tr.origOn = on; if (!on) stopOriginal(); else if (tr.playing) startOriginal({ t0: currentTick(), c0: ctx.currentTime }); },
    setLoop(l) { tr.loop = l; }, get ctx() { return ctx; },
  };
})();
