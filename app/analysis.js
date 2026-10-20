/* Audio analysis: decoding, spectral features, neural/DSP note transcription,
   beat tracking, meter, key, chords, melody/bass extraction -> lead sheet.  Global: Analysis */
(function () {
  const SR = 22050;
  const HOP = 256;
  const FPS = SR / HOP;
  const NBANDS = 96, MINMIDI = 24;
  const tick = () => new Promise(r => setTimeout(r, 0));

  // ---------- FFT ----------
  function makeFFT(n) {
    const levels = Math.log2(n) | 0;
    const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let x = i, y = 0; for (let j = 0; j < levels; j++) { y = (y << 1) | (x & 1); x >>>= 1; } rev[i] = y; }
    const re = new Float32Array(n), im = new Float32Array(n);
    const win = new Float32Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    // returns power spectrum (n/2+1)
    function power(sig, offset, out) {
      for (let i = 0; i < n; i++) { const j = offset + i; const v = (j >= 0 && j < sig.length) ? sig[j] * win[i] : 0; re[rev[i]] = v; im[rev[i]] = 0; }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const tre = re[j + half] * cos[k] + im[j + half] * sin[k];
            const tim = -re[j + half] * sin[k] + im[j + half] * cos[k];
            re[j + half] = re[j] - tre; im[j + half] = im[j] - tim;
            re[j] += tre; im[j] += tim;
          }
        }
      }
      for (let i = 0; i <= n / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
      return out;
    }
    return { n, power };
  }

  // ---------- decoding ----------
  async function decodeFile(file) {
    const ab = await file.arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const tmp = new Ctx(2, 44100, 44100);
    return await new Promise((res, rej) => {
      const p = tmp.decodeAudioData(ab.slice(0), res, e => rej(new Error('This file could not be decoded as audio. Try WAV, MP3, M4A/AAC, OGG or FLAC.')));
      if (p && p.then) p.then(res, () => rej(new Error('This file could not be decoded as audio. Try WAV, MP3, M4A/AAC, OGG or FLAC.')));
    });
  }
  async function toMono22k(buffer, startSec = 0, endSec = null) {
    const end = Math.min(buffer.duration, endSec || buffer.duration);
    const dur = Math.max(0.5, end - startSec);
    const len = Math.ceil(dur * SR);
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new Ctx(1, len, SR);
    const src = off.createBufferSource(); src.buffer = buffer;
    src.connect(off.destination); src.start(0, startSec, dur);
    const r = await off.startRendering();
    const x = r.getChannelData(0);
    // normalise peak to 0.9
    let pk = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; }
    if (pk > 1e-6) { const g = 0.9 / pk; for (let i = 0; i < x.length; i++) x[i] *= g; }
    return x;
  }


  // ---------- spectral features (one STFT pass) ----------
  async function features(x, progress) {
    const N = 2048, fft = makeFFT(N);
    const nFrames = Math.max(1, Math.floor(x.length / HOP));
    const pw = new Float32Array(N / 2 + 1);
    const binHz = SR / N;
    const bandLo = new Int32Array(NBANDS), bandHi = new Int32Array(NBANDS);
    for (let b = 0; b < NBANDS; b++) {
      const f = 440 * Math.pow(2, (b + MINMIDI - 69) / 12);
      bandLo[b] = Math.max(1, Math.round(f * Math.pow(2, -0.5 / 12) / binHz));
      bandHi[b] = Math.min(N / 2, Math.max(bandLo[b], Math.round(f * Math.pow(2, 0.5 / 12) / binHz)));
    }
    const hfLo = Math.round(3000 / binHz), hfHi = Math.round(8000 / binHz);
    const spec = new Uint8Array(nFrames * NBANDS);
    const env = new Float32Array(nFrames), rms = new Float32Array(nFrames), hfFlux = new Float32Array(nFrames), flat = new Float32Array(nFrames);
    const chroma = new Float32Array(nFrames * 12);
    let prev = new Float32Array(NBANDS), cur = new Float32Array(NBANDS);
    let prevHF = 0;
    let lastYield = performance.now();
    for (let t = 0; t < nFrames; t++) {
      fft.power(x, t * HOP - N / 2, pw);
      let e = 0;
      for (let b = 0; b < NBANDS; b++) {
        let s = 0; for (let k = bandLo[b]; k <= bandHi[b]; k++) s += pw[k];
        s /= (bandHi[b] - bandLo[b] + 1);
        const l = Math.log10(1 + 1e3 * s);
        cur[b] = l;
        spec[t * NBANDS + b] = Math.max(0, Math.min(255, Math.round((10 * Math.log10(s + 1e-10) + 60) * 2.3)));
        if (t > 0) { const d = l - prev[b]; if (d > 0) e += d; }
        if (b + MINMIDI >= 36 && b + MINMIDI < 96) chroma[t * 12 + ((b + MINMIDI) % 12)] += l;
      }
      env[t] = e;
      // high-frequency noisiness (drums, hats, snares): spectral flatness + flux above 3 kHz
      let lg = 0, ar = 0, hfE = 0;
      for (let k = hfLo; k <= hfHi; k++) { const v = pw[k] + 1e-12; lg += Math.log(v); ar += v; hfE += v; }
      const nb = hfHi - hfLo + 1;
      flat[t] = Math.exp(lg / nb) / (ar / nb);
      const hl = Math.log10(1 + 1e4 * hfE / nb);
      hfFlux[t] = Math.max(0, hl - prevHF); prevHF = hl;
      let r = 0; const s0 = t * HOP; for (let i = 0; i < HOP && s0 + i < x.length; i++) r += x[s0 + i] * x[s0 + i];
      rms[t] = Math.sqrt(r / HOP);
      const tmp = prev; prev = cur; cur = tmp;
      if ((t & 127) === 0 && performance.now() - lastYield > 30) { progress && progress(t / nFrames); await tick(); lastYield = performance.now(); }
    }
    const w = Math.round(FPS * 0.25);
    const env2 = new Float32Array(nFrames);
    let acc = 0; const pre = [];
    for (let t = 0; t < nFrames; t++) {
      acc += env[t]; pre.push(env[t]); if (pre.length > 2 * w + 1) acc -= pre.shift();
      const mean = acc / pre.length;
      env2[Math.max(0, t - w)] = Math.max(0, env[Math.max(0, t - w)] - mean);
    }
    let sd = 0; for (let t = 0; t < nFrames; t++) sd += env2[t] * env2[t]; sd = Math.sqrt(sd / nFrames) || 1;
    for (let t = 0; t < nFrames; t++) env2[t] /= sd;
    return { nFrames, spec, env: env2, rawEnv: env, rms, chroma, hfFlux, flat };
  }

  // ---------- tempo ----------
  function autocorr(env) {
    const n = env.length;
    const minLag = Math.floor(FPS * 60 / 240), maxLag = Math.ceil(FPS * 60 / 40);
    const ac = new Float32Array(maxLag * 4 + 2);
    for (let l = minLag; l < ac.length && l < n; l++) { let s = 0; for (let t = 0; t + l < n; t++) s += env[t] * env[t + l]; ac[l] = s / (n - l); }
    return { ac, minLag, maxLag };
  }
  const prior = bpm => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 1.0, 2));
  function lagScore(A, l) { // symmetric comb: the period and its double
    const a = A.ac; const L = Math.round(l), L2 = Math.round(2 * l);
    return (a[L] || 0) + 0.5 * (a[L2] || 0);
  }
  function estimateTempo(env) {
    const A = autocorr(env);
    const cands = [];
    for (let l = A.minLag; l <= A.maxLag; l++) cands.push({ l, bpm: 60 * FPS / l, raw: lagScore(A, l), sc: prior(60 * FPS / l) * lagScore(A, l) });
    const peaks = cands.filter((c, i) => i > 0 && i < cands.length - 1 && c.sc >= cands[i - 1].sc && c.sc >= cands[i + 1].sc).sort((a, b) => b.sc - a.sc);
    if (!peaks.length) return { period: FPS * 60 / 120, bpm: 120, cands: [], A };
    const refine = c => { const i = cands.indexOf(c); let lag = c.l; if (i > 0 && i < cands.length - 1) { const a = cands[i - 1].sc, b = cands[i].sc, d2 = cands[i + 1].sc; const d = a - 2 * b + d2; if (Math.abs(d) > 1e-9) lag += 0.5 * (a - d2) / d; } return lag; };
    return { period: refine(peaks[0]), bpm: 60 * FPS / refine(peaks[0]), peaks: peaks.slice(0, 6).map(p => ({ period: refine(p), sc: p.sc })), A };
  }

  function trackBeats(env, period, tightness = 100) {
    const n = env.length;
    const sig = period / 32, half = Math.ceil(sig * 4);
    const g = []; for (let k = -half; k <= half; k++) g.push(Math.exp(-0.5 * (k / sig) ** 2));
    const local = new Float32Array(n);
    for (let t = 0; t < n; t++) { let s = 0; for (let k = -half; k <= half; k++) { const j = t + k; if (j >= 0 && j < n) s += env[j] * g[k + half]; } local[t] = s; }
    const cum = new Float32Array(n), back = new Int32Array(n).fill(-1);
    const lo = Math.round(period / 2), hi = Math.round(period * 2);
    for (let t = 0; t < n; t++) {
      let best = -Infinity, bi = -1;
      for (let p = t - hi; p <= t - lo; p++) { if (p < 0) continue; const c = cum[p] - tightness * Math.pow(Math.log((t - p) / period), 2); if (c > best) { best = c; bi = p; } }
      cum[t] = local[t] + (bi >= 0 ? best : 0); back[t] = bi;
    }
    let end = n - 1, bv = -Infinity;
    for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (cum[t] > bv) { bv = cum[t]; end = t; }
    const beats = [];
    for (let t = end; t >= 0; t = back[t]) { beats.push(t); if (back[t] < 0) break; }
    beats.reverse();
    let ls = 0; for (const b of beats) ls += local[b];
    return { times: beats.map(f => f / FPS), localMean: ls / Math.max(1, beats.length) };
  }
  function ibiStats(bt) {
    const ibis = bt.slice(1).map((t, i) => t - bt[i]);
    const med = ibis.slice().sort((a, b) => a - b)[ibis.length >> 1] || 0.5;
    const v = Math.sqrt(ibis.reduce((s, x) => s + (x - med) ** 2, 0) / Math.max(1, ibis.length)) / med;
    return { med, v };
  }

  // ---------- fallback DSP transcription ----------
  async function dspTranscribe(x, progress, sensitivity = 0.5) {
    const N = 4096, H = 512, fft = makeFFT(N), fps = SR / H;
    const nF = Math.floor(x.length / H);
    const pw = new Float32Array(N / 2 + 1), mag = new Float32Array(N / 2 + 1);
    const LO = 28, HI = 100, NP = HI - LO + 1;
    const sal = new Float32Array(nF * NP);
    const binHz = SR / N;
    let lastYield = performance.now();
    for (let t = 0; t < nF; t++) {
      fft.power(x, t * H - N / 2, pw);
      for (let k = 0; k < pw.length; k++) mag[k] = Math.sqrt(pw[k]);
      for (let p = LO; p <= HI; p++) {
        const f0 = 440 * Math.pow(2, (p - 69) / 12);
        let s = 0;
        for (let h = 1; h <= 6; h++) {
          const f = f0 * h; if (f > SR / 2 - 100) break;
          const a = Math.max(1, Math.floor(f * 0.9715 / binHz)), b = Math.ceil(f * 1.0293 / binHz);
          let m = 0; for (let k = a; k <= b; k++) if (mag[k] > m) m = mag[k];
          s += Math.pow(0.8, h - 1) * m;
        }
        sal[t * NP + (p - LO)] = s;
      }
      if ((t & 31) === 0 && performance.now() - lastYield > 30) { progress && progress(t / nF); await tick(); lastYield = performance.now(); }
    }
    let gmax = 0; for (let i = 0; i < sal.length; i++) if (sal[i] > gmax) gmax = sal[i];
    const thrRel = 0.45 - 0.25 * sensitivity, thrAbs = gmax * (0.06 - 0.04 * sensitivity);
    const active = new Uint8Array(nF * NP);
    const HARM = [12, 19, 24, 28, 31];
    for (let t = 0; t < nF; t++) {
      let fm = 0; for (let i = 0; i < NP; i++) fm = Math.max(fm, sal[t * NP + i]);
      const cand = [];
      for (let i = 1; i < NP - 1; i++) { const v = sal[t * NP + i]; if (v > thrAbs && v > fm * thrRel && v >= sal[t * NP + i - 1] && v >= sal[t * NP + i + 1]) cand.push([i, v]); }
      cand.sort((a, b) => b[1] - a[1]);
      // harmonic sieve: drop a candidate sitting on an overtone of a stronger accepted one
      const acc = [];
      for (const [i, v] of cand) {
        if (acc.length >= 6) break;
        const isHarm = acc.some(([j, w]) => HARM.includes(i - j) && v < w * (i - j === 12 ? 0.85 : 1.1));
        if (!isHarm) acc.push([i, v]);
      }
      for (const [i] of acc) active[t * NP + i] = 1;
    }
    const notes = [];
    for (let i = 0; i < NP; i++) {
      let start = -1, gap = 0, sum = 0;
      for (let t = 0; t <= nF; t++) {
        const on = t < nF && active[t * NP + i];
        const v = t < nF ? sal[t * NP + i] : 0;
        if (on) {
          if (start >= 0 && t > 1 && v > 1.8 * sal[(t - 2) * NP + i] && t - start > 4) { notes.push({ pitch: i + LO, start: start / fps, dur: (t - start) / fps, amp: Math.min(1, 2.5 * sum / (t - start) / gmax) }); start = t; sum = 0; }
          if (start < 0) { start = t; sum = 0; }
          gap = 0; sum += v;
        } else if (start >= 0) {
          gap++;
          if (gap > 2 || t === nF) { const end = t - gap + 1; if (end - start >= 3) notes.push({ pitch: i + LO, start: start / fps, dur: (end - start) / fps, amp: Math.min(1, 2.5 * sum / Math.max(1, end - start) / gmax) }); start = -1; gap = 0; }
        }
      }
    }
    return notes;
  }

  // ---------- time <-> beat mapping ----------
  function makeBeatMap(beatTimes) {
    const n = beatTimes.length;
    function toBeat(t) {
      if (t <= beatTimes[0]) { const d = beatTimes[1] - beatTimes[0]; return (t - beatTimes[0]) / d; }
      if (t >= beatTimes[n - 1]) { const d = beatTimes[n - 1] - beatTimes[n - 2]; return n - 1 + (t - beatTimes[n - 1]) / d; }
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beatTimes[m] <= t) lo = m; else hi = m; }
      return lo + (t - beatTimes[lo]) / (beatTimes[hi] - beatTimes[lo]);
    }
    function toTime(b) {
      if (b <= 0) return beatTimes[0] + b * (beatTimes[1] - beatTimes[0]);
      if (b >= n - 1) return beatTimes[n - 1] + (b - n + 1) * (beatTimes[n - 1] - beatTimes[n - 2]);
      const i = Math.floor(b); return beatTimes[i] + (b - i) * (beatTimes[i + 1] - beatTimes[i]);
    }
    return { toBeat, toTime };
  }

  // ---------- melody / bass selection (weighted DP over notes) ----------
  function noteValue(n, w) { return n.a * (0.6 + 0.4 * Math.sqrt(Math.min(n.d, 2))) * w; }
  function selectLine(notes, weightFn, opts = {}) {
    const ns = notes.map((n, i) => ({ ...n, i })).filter(n => weightFn(n) > 0).sort((a, b) => a.s - b.s || b.p - a.p);
    const L = ns.length;
    if (!L) return [];
    const W = ns.map(n => weightFn(n));
    const val = ns.map((n, k) => noteValue(n, W[k]));
    const best = new Float64Array(L), prev = new Int32Array(L).fill(-1);
    const jump = opts.jump ?? 0.03;
    let prefixBest = 0, prefixIdx = -1, pj = 0;
    for (let i = 0; i < L; i++) {
      const n = ns[i];
      while (pj < i && ns[pj].s + ns[pj].d <= n.s - 2) { if (best[pj] > prefixBest) { prefixBest = best[pj]; prefixIdx = pj; } pj++; }
      let b = prefixBest, bi = prefixIdx;
      for (let j = i - 1; j >= 0; j--) {
        const m = ns[j];
        if (m.s < n.s - 6) break;
        if (m.s >= n.s - 1e-6) continue;
        const end = m.s + m.d;
        let cost = 0;
        if (end > n.s + 1e-6) { const trunc = noteValue({ a: m.a, d: n.s - m.s }, W[j]); cost += (val[j] - trunc) * 0.9; }
        const iv = Math.abs(n.p - m.p);
        cost += jump * Math.min(10, Math.max(0, iv - 5));
        const c = best[j] - cost;
        if (c > b) { b = c; bi = j; }
      }
      best[i] = val[i] + b; prev[i] = bi;
    }
    let bi = 0; for (let i = 1; i < L; i++) if (best[i] > best[bi]) bi = i;
    const out = [];
    for (let i = bi; i >= 0; i = prev[i]) { out.push(ns[i]); if (prev[i] < 0) break; }
    out.reverse();
    for (let k = 0; k < out.length - 1; k++) if (out[k].s + out[k].d > out[k + 1].s) out[k] = { ...out[k], d: Math.max(0.25, out[k + 1].s - out[k].s) };
    return out;
  }
  // top-voice information: is a note the highest sounding at its onset, or covered by a strong note above?
  function voicing(notes) {
    const order = notes.map((n, i) => i).sort((a, b) => notes[a].s - notes[b].s);
    const active = [];
    const top = new Uint8Array(notes.length), covered = new Uint8Array(notes.length);
    for (const i of order) {
      const n = notes[i];
      for (let k = active.length - 1; k >= 0; k--) if (notes[active[k]].s + notes[active[k]].d <= n.s + 0.05) active.splice(k, 1);
      const sim = active.concat(order.filter(j => j !== i && Math.abs(notes[j].s - n.s) < 0.13 && notes[j].s >= n.s - 0.13)).filter((v, k, a) => a.indexOf(v) === k);
      let higher = false, strongHigher = false;
      for (const j of sim) { const m = notes[j]; if (m.p > n.p + 2) { higher = true; if (m.a >= 0.6 * n.a) strongHigher = true; } }
      top[i] = higher ? 0 : 1; covered[i] = strongHigher ? 1 : 0;
      active.push(i);
    }
    return { top, covered };
  }

  // ---------- quantisation ----------
  function quantizeNotes(raw, map, nBeats, opt = {}) {
    const perBeat = new Map();
    let onsetsB = raw.map(n => map.toBeat(n.start));
    const devs = [];
    onsetsB.forEach(b => { const k = Math.round(b); if (Math.abs(b - k) < 0.2) devs.push(b - k); });
    devs.sort((a, b) => a - b);
    const bias = devs.length > 8 ? Math.max(-0.12, Math.min(0.12, devs[devs.length >> 1])) : 0;
    if (Math.abs(bias) > 0.01) onsetsB = onsetsB.map(b => b - bias);
    // swing: off-beat onsets consistently late (long-short eighths)
    const offs = []; onsetsB.forEach(b => { const f = b - Math.floor(b); if (f > 0.4 && f < 0.85) offs.push(f); });
    offs.sort((a, b) => a - b);
    const medOff = offs.length ? offs[offs.length >> 1] : 0.5;
    const swingFeel = !opt.compoundBeat && offs.length >= 8 && medOff > 0.59 && medOff < 0.73 && offs.filter(f => f > 0.57 && f < 0.77).length > offs.length * 0.6;
    if (swingFeel) onsetsB = onsetsB.map(b => { const k = Math.floor(b), f = b - k; return f > 0.56 && f < 0.78 ? k + 0.5 + (f - medOff) * 0.5 : b; });
    onsetsB.forEach((b) => { const k = Math.floor(b + 0.125); if (!perBeat.has(k)) perBeat.set(k, []); perBeat.get(k).push(b - k); });
    const triplet = new Set();
    if (opt.compoundBeat) { for (const k of perBeat.keys()) triplet.add(k); }
    else if (!swingFeel) for (const [k, fr] of perBeat) {
      if (fr.length < 2) continue;
      let e16 = 0, e12 = 0;
      for (const f of fr) { e16 += Math.abs(f * 4 - Math.round(f * 4)) / 4; e12 += Math.abs(f * 3 - Math.round(f * 3)) / 3; }
      if (e12 < e16 * 0.55 && fr.some(f => Math.abs(f * 3 - Math.round(f * 3)) < 0.05 && Math.round(f * 3) % 3 !== 0)) triplet.add(k);
    }
    const q = b => { const k = Math.floor(b + 0.125); const g = triplet.has(k) ? (opt.compoundBeat ? 6 : 3) : 4; return Math.round(b * g) / g; };
    const out = [];
    raw.forEach((n, i) => {
      const s = q(onsetsB[i]);
      let eb = map.toBeat(n.start + n.dur) - bias;
      if (swingFeel) { const k = Math.floor(eb), f = eb - k; if (f > 0.56 && f < 0.78) eb = k + 0.5; }
      let e = q(eb);
      const minD = triplet.has(Math.floor(s + 0.125)) ? (opt.compoundBeat ? 1 / 6 : 1 / 3) : 0.25;
      if (e - s < minD) e = s + minD;
      if (s < -8 || s > nBeats + 8) return;
      out.push({ p: n.pitch, s: +s.toFixed(4), d: +(e - s).toFixed(4), a: n.amp, t: n.start, td: n.dur });
    });
    out.sort((a, b) => a.p - b.p || a.s - b.s);
    const merged = [];
    for (const n of out) {
      const last = merged[merged.length - 1];
      if (last && last.p === n.p && n.s < last.s + last.d - 1e-6) { last.d = Math.max(last.d, n.s + n.d - last.s); last.a = Math.max(last.a, n.a); }
      else merged.push({ ...n });
    }
    merged.sort((a, b) => a.s - b.s || a.p - b.p);
    return { notes: merged, tripletBeats: [...triplet], bias, swingFeel, swingRatio: medOff };
  }

  // ---------- chords (Viterbi over beats) ----------
  const CHORD_TYPES = ['maj', 'min', 'dom7', 'maj7', 'min7', 'dim', 'hdim7'];
  const TYPE_PEN = { maj: 0, min: 0, dom7: 0.06, maj7: 0.09, min7: 0.08, dim: 0.08, hdim7: 0.12 };
  function estimateChords(beatChroma, beatBass, key, beatsPerBar) {
    const nB = beatChroma.length;
    const states = [];
    for (let r = 0; r < 12; r++) for (const t of CHORD_TYPES) states.push({ root: r, type: t, pcs: T.CHORDS[t].iv.map(i => (i + r) % 12), w: T.CHORDS[t].iv.map((_, k) => [1, 0.9, 0.8, 0.65][k]), sev: T.CHORDS[t].iv.length === 4 ? (T.CHORDS[t].iv[3] + r) % 12 : -1 });
    states.push({ root: -1, type: 'N', pcs: [], w: [] });
    const S = states.length;
    const diat = T.scalePcs(key);
    // bass evidence pooled over the half bar (or whole bar in odd meters)
    const group = beatsPerBar % 2 === 0 ? beatsPerBar / 2 : beatsPerBar;
    const pooled = beatBass.map((_, b) => { const g0 = Math.floor(b / group) * group; const acc = new Array(12).fill(0); for (let k = g0; k < Math.min(nB, g0 + group); k++) for (let c = 0; c < 12; c++) acc[c] += beatBass[k][c] * (k === b ? 1.5 : 1); return acc; });
    const emit = new Float32Array(nB * S);
    for (let b = 0; b < nB; b++) {
      const x = beatChroma[b]; const tot = x.reduce((s, v) => s + v, 0);
      const xn = x.map(v => v / (tot + 1e-9));
      const bass = pooled[b]; const bt = bass.reduce((s, v) => s + v, 0);
      for (let s = 0; s < S; s++) {
        const st = states[s];
        if (st.type === 'N') { emit[b * S + s] = tot < 1e-3 ? 0.5 : -0.4; continue; }
        let in_ = 0, out = 0;
        for (let pc = 0; pc < 12; pc++) { const k = st.pcs.indexOf(pc); if (k >= 0) in_ += st.w[k] * xn[pc]; else out += xn[pc]; }
        let sc = in_ - 0.55 * out - TYPE_PEN[st.type];
        if (st.sev >= 0 && xn[st.sev] < 0.09) sc -= 0.12; // a seventh chord needs a real seventh
        if (bt > 0) sc += 0.28 * bass[st.root] / bt;
        const deg = diat.indexOf(st.root);
        if (deg >= 0) {
          const third = (diat[(deg + 2) % 7] - st.root + 12) % 12;
          const want = third === 4 ? ['maj', 'dom7', 'maj7'] : ['min', 'min7', 'dim', 'hdim7'];
          if (want.includes(st.type)) sc += 0.07;
        } else sc -= 0.04;
        if (st.root === (key.tonic + 7) % 12 && (st.type === 'maj' || st.type === 'dom7')) sc += 0.05;
        emit[b * S + s] = sc;
      }
    }
    const score = new Float32Array(S), nxt = new Float32Array(S);
    const back = new Int16Array(nB * S);
    for (let s = 0; s < S; s++) score[s] = emit[s];
    for (let b = 1; b < nB; b++) {
      const pos = b % beatsPerBar;
      const change = pos === 0 ? 0.07 : (beatsPerBar % 2 === 0 && pos === beatsPerBar / 2 ? 0.12 : 0.2);
      let bestS = 0; for (let s = 1; s < S; s++) if (score[s] > score[bestS]) bestS = s;
      for (let s = 0; s < S; s++) {
        let v = score[s], bk = s;
        const alt = score[bestS] - change;
        if (alt > v) { v = alt; bk = bestS; }
        nxt[s] = v + emit[b * S + s]; back[b * S + s] = bk;
      }
      score.set(nxt);
    }
    let s = 0; for (let k = 1; k < S; k++) if (score[k] > score[s]) s = k;
    const path = new Int16Array(nB);
    for (let b = nB - 1; b >= 0; b--) { path[b] = s; s = back[b * S + s]; }
    const chords = [];
    for (let b = 0; b < nB; b++) {
      const st = states[path[b]];
      const last = chords[chords.length - 1];
      if (last && last.root === st.root && last.type === st.type) last.d += 1;
      else chords.push({ s: b, d: 1, root: st.root, type: st.type });
    }
    return chords;
  }

  // ---------- meter ----------
  function meterSearch(notes, beatTimes, F) {
    const nB = beatTimes.length;
    const strength = new Float32Array(nB), bassOn = new Float32Array(nB);
    for (const n of notes) { const b = Math.round(n.s); if (Math.abs(n.s - b) < 0.12 && b >= 0 && b < nB) { strength[b] += n.a; if (n.p < 55) bassOn[b] += n.a * 2; } }
    for (let b = 0; b < nB; b++) { const f = Math.round(beatTimes[b] * FPS); let m = 0; for (let k = f - 3; k <= f + 3; k++) if (k >= 0 && k < F.env.length) m = Math.max(m, F.env[k]); strength[b] += 0.3 * m; }
    const bc = beatChromaFrom(notes, nB, F, beatTimes);
    const change = new Float32Array(nB);
    for (let b = 1; b < nB; b++) { const a = bc.chroma[b - 1], c = bc.chroma[b]; let dot = 0, na = 0, nc = 0; for (let k = 0; k < 12; k++) { dot += a[k] * c[k]; na += a[k] * a[k]; nc += c[k] * c[k]; } change[b] = 1 - dot / Math.sqrt(na * nc + 1e-12); }
    const z = arr => { const m = arr.reduce((s, v) => s + v, 0) / arr.length; const sd = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length) || 1; return arr.map(v => (v - m) / sd); };
    const zs = z(Array.from(strength)), zb = z(Array.from(bassOn)), zc = z(Array.from(change));
    const scoreFor = (m, ph) => {
      let on = 0, cnt = 0;
      for (let b = ph; b < nB; b += m) { on += zs[b] + 0.8 * zb[b] + 1.0 * zc[b]; cnt++; }
      let sc = on / Math.max(1, cnt);
      if (m === 4) { let o3 = 0, c3 = 0; for (let b = ph + 2; b < nB; b += 4) { o3 += zs[b] + 0.5 * zc[b]; c3++; } sc += 0.15 * o3 / Math.max(1, c3) + 0.04; }
      return sc;
    };
    const scores = {}; let best = { m: 4, ph: 0, sc: -Infinity };
    for (const m of [3, 4]) for (let ph = 0; ph < m; ph++) { const sc = scoreFor(m, ph); scores[m + ':' + ph] = +sc.toFixed(3); if (sc > best.sc) best = { m, ph, sc }; }
    let other = -Infinity; for (const k in scores) if (+k.split(':')[0] !== best.m) other = Math.max(other, scores[k]);
    return { best, scores, margin: best.sc - other, scoreFor, zs, zb, zc };
  }
  // within a 3-beat bar, an accent halfway through (eighth 4 of 6) signals 6/8 rather than 3/4
  function compoundCheck(notes, nB, phase) {
    const acc = new Float32Array(6);
    for (const n of notes) {
      const rel = n.s - phase; if (rel < 0) continue;
      const pos = rel % 3; const k = Math.round(pos * 2);
      if (Math.abs(pos * 2 - k) < 0.2) acc[k % 6] += n.a * (n.p < 55 ? 2 : 1);
    }
    const mid = acc[3], weak = (acc[2] + acc[4]) / 2;
    return { ratio: mid / (weak + 1e-6), acc: Array.from(acc, v => +v.toFixed(2)) };
  }

  // ---------- engine (Web Worker with WebGL/WASM, main-thread fallback) ----------
  let mainEngineP = null;
  function loadMainEngine() {
    if (window.BPEngine) return window.BPEngine.init();
    if (!mainEngineP) mainEngineP = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'lib/bp-main.js'; s.async = true;
      s.onload = () => window.BPEngine ? res() : rej(new Error('engine missing'));
      s.onerror = () => { mainEngineP = null; rej(new Error('Could not load the transcription engine')); };
      document.head.appendChild(s);
    });
    return mainEngineP.then(() => window.BPEngine.init());
  }
  function neuralTranscribe(x, toNotesOpts, onProgress, isCancelled, extra = {}) {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new Worker('lib/bp-worker.js'); } catch (e) { reject({ fallback: true, error: e }); return; }
      let settled = false, started = false;
      const finish = (fn, v) => { if (settled) return; settled = true; clearInterval(poll); try { w.terminate(); } catch (e) { } fn(v); };
      const poll = setInterval(() => { if (isCancelled && isCancelled()) finish(reject, new Error('cancelled')); }, 150);
      w.onerror = (e) => { e.preventDefault && e.preventDefault(); finish(reject, { fallback: true, error: e.message || 'worker error' }); };
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { started = true; onProgress && onProgress(0, null, m.backend); }
        else if (m.type === 'progress') onProgress && onProgress(m.p, m.eta);
        else if (m.type === 'done') finish(resolve, m);
        else if (m.type === 'error') finish(reject, { fallback: !started, error: m.message });
      };
      const audio = x.slice();
      // WebAssembly first: the WebGL backend can stall in a worker on some GPUs
      const msg = { type: 'run', audio, opts: toNotesOpts, returnFrames: !!extra.returnFrames, backends: ['wasm', 'webgl', 'cpu'] };
      if (extra.frames) { msg.frames = extra.frames; msg.onsets = extra.onsets; }
      w.postMessage(msg, [audio.buffer]);
    });
  }

  function polyphonyFromRaw(raw, dur) {
    if (!raw.length) return 0;
    const step = 0.05, n = Math.max(1, Math.floor(dur / step));
    const cnt = new Float32Array(n + 1);
    for (const r of raw) { const a = Math.max(0, Math.floor(r.start / step)), b = Math.min(n, Math.floor((r.start + r.dur) / step)); for (let k = a; k <= b; k++) cnt[k]++; }
    let s = 0, c = 0; for (let k = 0; k <= n; k++) if (cnt[k] > 0) { s += cnt[k]; c++; }
    return c ? s / c : 0;
  }
  function removeGhostHarmonics(raw) {
    const sorted = raw.slice().sort((a, b) => a.start - b.start);
    const drop = new Set();
    for (let i = 0; i < sorted.length; i++) {
      const g = sorted[i];
      for (let j = Math.max(0, i - 40); j < Math.min(sorted.length, i + 40); j++) {
        if (i === j) continue; const f = sorted[j];
        const iv = g.pitch - f.pitch;
        if (![12, 19, 24, 28, 31].includes(iv)) continue;
        if (iv === 12 && (g.pitch < 84 || g.added)) continue;
        const ov = Math.min(g.start + g.dur, f.start + f.dur) - Math.max(g.start, f.start);
        if (ov < 0.6 * g.dur) continue;
        if (g.amp < (iv === 12 ? 0.45 : 0.6) * f.amp) { drop.add(g); break; }
      }
    }
    return raw.filter(r => !drop.has(r));
  }
  function windowedKeys(notes, beatsPerBar, globalKey) {
    const win = 4 * beatsPerBar, hop = 2 * beatsPerBar;
    const last = notes.reduce((m, n) => Math.max(m, n.s + n.d), 0);
    const regions = [];
    for (let a = 0; a + win / 2 < last; a += hop) {
      const ch = new Array(12).fill(0); let tot = 0;
      for (const n of notes) { const ov = Math.min(n.s + n.d, a + win) - Math.max(n.s, a); if (ov > 0) { ch[n.p % 12] += n.a * ov; tot += ov; } }
      if (tot < 4) continue;
      const ks = T.estimateKey(ch);
      regions.push({ a, b: a + win, key: { tonic: ks[0].tonic, mode: ks[0].mode }, r: ks[0].r, margin: ks[0].r - ks[1].r, globalR: ks.find(k => k.tonic === globalKey.tonic && k.mode === globalKey.mode).r });
    }
    // sustained disagreement: two consecutive windows agree on another key that clearly beats the global key
    const mods = [];
    for (let i = 0; i + 1 < regions.length; i++) {
      const r1 = regions[i], r2 = regions[i + 1];
      const same = (k1, k2) => k1.tonic === k2.tonic && k1.mode === k2.mode;
      const strongEnd = i + 1 === regions.length - 1 && !same(r2.key, globalKey) && r2.r - r2.globalR > 0.15 && (r2.a >= r1.b - hop);
      if (strongEnd && !(same(r1.key, r2.key))) { mods.push({ key: r2.key, a: r2.a, b: r2.b }); continue; }
      if (!same(r1.key, globalKey) && same(r1.key, r2.key) && r1.r - r1.globalR > 0.08 && r2.r - r2.globalR > 0.08) {
        const lastMod = mods[mods.length - 1];
        if (lastMod && same(lastMod.key, r1.key)) { lastMod.b = r2.b; continue; }
        mods.push({ key: r1.key, a: r1.a, b: r2.b });
      }
    }
    return { regions, mods };
  }

  // ---------- main pipeline ----------
  async function analyze(buffer, opts, onStage) {
    const stage = (name, p, extra) => onStage && onStage(name, p, extra);
    const cancelled = () => !!(opts.cancelled && opts.cancelled());
    const check = () => { if (cancelled()) throw new Error('cancelled'); };
    const t0 = performance.now();
    stage('Preparing audio', 0);
    const startSec = Math.max(0, opts.startSec || 0);
    const endSec = Math.min(buffer.duration, opts.endSec || startSec + (opts.maxSec || 480));
    if (endSec - startSec < 2) throw new Error('The audio is too short to analyse (' + Math.max(0, endSec - startSec).toFixed(1) + ' s). Use a recording of at least 2 seconds.');
    const x = await toMono22k(buffer, startSec, endSec);
    check();
    stage('Measuring spectrum and onsets', 0);
    const F = await features(x, p => stage('Measuring spectrum and onsets', p));
    check();
    const dur = x.length / SR;

    // ---- notes
    let raw = null, mode = 'neural', engineNote = '', framesOut = null;
    const sens = opts.sensitivity ?? 0.5;
    const tnOpts = { onsetThresh: 0.62 - 0.3 * sens, frameThresh: 0.4 - 0.2 * sens, minNoteLen: Math.round(14 - 8 * sens) };
    if (!opts.forceDsp) {
      stage('Loading neural transcription model', 0);
      try {
        const res = await neuralTranscribe(x, tnOpts, (p, eta, be) => stage('Transcribing notes (neural network)', p, { eta, backend: be }), cancelled, { returnFrames: opts.__returnFrames, frames: opts.__frames, onsets: opts.__onsets });
        raw = res.notes; engineNote = 'Basic Pitch neural transcription (' + res.backend + ', background thread)';
        if (opts.__returnFrames) framesOut = { frames: res.frames, onsets: res.onsets };
      } catch (e) {
        if (e && e.message === 'cancelled') throw e;
        console.warn('Worker transcription failed', e);
        try {
          stage('Loading neural transcription model', 0.5);
          await loadMainEngine(); check();
          const out = await window.BPEngine.infer(x, p => stage('Transcribing notes (neural network)', p), cancelled);
          raw = window.BPEngine.toNotes(out, tnOpts);
          engineNote = 'Basic Pitch neural transcription (' + window.BPEngine.backend + ')';
        } catch (e2) { if (String(e2 && e2.message) === 'cancelled') throw e2; console.warn('Neural transcription unavailable', e2); raw = null; }
      }
    }
    check();
    if (!raw) {
      mode = 'dsp';
      stage('Transcribing notes (spectral fallback)', 0);
      raw = await dspTranscribe(x, p => stage('Transcribing notes (spectral fallback)', p), sens);
      engineNote = 'Harmonic-salience spectral transcription' + (opts.forceDsp ? ' (chosen in settings)' : ' (fallback; lower accuracy)');
    }
    check();
    raw = raw.filter(n => n.dur > 0.03 && n.pitch >= 21 && n.pitch <= 108);
    if (mode === 'neural') raw = removeGhostHarmonics(raw);
    if (raw.length < 4) {
      const err = new Error(raw.length ? 'Only ' + raw.length + ' pitched note' + (raw.length === 1 ? ' was' : 's were') + ' found. The recording may be silent, very quiet, or contain only drums or speech.' : 'No pitched notes were found. The recording may be silent, very quiet, or contain only drums or speech.');
      err.noContent = true; throw err;
    }

    // ---- tempo & beats (joint choice of tempo level and meter)
    stage('Tracking tempo and beats', 0); await tick();
    const env = Float32Array.from(F.env);
    for (const n of raw) { const f = Math.round(n.start * FPS); if (f >= 0 && f < env.length) env[f] += 1.5 * n.amp * (n.pitch < 52 ? 1.5 : 1); }
    const TI = estimateTempo(env);
    const firstNote = Math.min(...raw.map(n => n.start)), lastNote = Math.max(...raw.map(n => n.start + n.dur));
    const evalCandidate = (period) => {
      let bt = trackBeats(env, period).times;
      if (bt.length < 4) { bt = []; for (let t = 0; t < dur; t += period / FPS) bt.push(t); }
      let st = ibiStats(bt);
      if (st.v > 0.08) { const bt2 = trackBeats(env, period, 30).times; const st2 = ibiStats(bt2); if (bt2.length >= 4 && st2.v < st.v * 1.6) { bt = bt2; st = st2; } }
      const map = makeBeatMap(bt);
      const prelim = quantizeNotes(raw, map, bt.length).notes;
      const M = meterSearch(prelim, bt, F);
      return { period, beatTimes: bt, ibi: st, M, prelim };
    };
    let chosen, tempoConf = 0.5, tempoAlts = [];
    if (opts.tempoOverride || opts.tempoScale) {
      const p0 = opts.tempoOverride ? 60 * FPS / opts.tempoOverride : TI.period / opts.tempoScale;
      chosen = evalCandidate(p0); tempoConf = 1;
    } else {
      const base = TI.period;
      const rel = [1, 0.5, 2, 2 / 3, 1.5];
      const cands = [];
      for (const r of rel) {
        const p = base * r; const bpm = 60 * FPS / p; if (bpm < 40 || bpm > 230) continue;
        const ev = evalCandidate(p);
        const acS = prior(bpm) * lagScore(TI.A, p);
        const contrast = Math.max(0, ev.M.best.sc);
        cands.push({ r, bpm, ev, acS, contrast });
      }
      const maxAc = Math.max(...cands.map(c => c.acS)) || 1;
      for (const c of cands) c.total = c.acS / maxAc + 0.22 * Math.min(2.5, c.contrast) - (c.r === 1 ? 0 : 0.03);
      cands.sort((a, b) => b.total - a.total);
      chosen = cands[0].ev;
      const second = cands[1];
      tempoConf = second ? Math.max(0, Math.min(1, (cands[0].total - second.total) / Math.max(0.05, cands[0].total) * 4)) : 0.8;
      tempoAlts = cands.slice(1, 4).map(c => Math.round(c.bpm));
    }
    let beatTimes = chosen.beatTimes;
    const { med: medIbi, v: ibiVar } = chosen.ibi;
    while (beatTimes[0] > Math.min(firstNote, 0.05) + 0.02) beatTimes.unshift(beatTimes[0] - medIbi);
    while (beatTimes[beatTimes.length - 1] < dur) beatTimes.push(beatTimes[beatTimes.length - 1] + medIbi);
    let map = makeBeatMap(beatTimes);

    // ---- meter & downbeat phase
    stage('Finding meter and downbeats', 0); await tick();
    const prelim = quantizeNotes(raw, map, beatTimes.length).notes;
    const M = meterSearch(prelim, beatTimes, F);
    let beatsPerBar = opts.meterOverride || M.best.m;
    let phase = M.best.ph;
    if (opts.meterOverride) { let bp = 0, bs = -Infinity; for (let ph = 0; ph < beatsPerBar; ph++) { const s = M.scoreFor(beatsPerBar, ph); if (s > bs) { bs = s; bp = ph; } } phase = bp; }
    if (opts.downbeatShift) phase = ((phase + opts.downbeatShift) % beatsPerBar + beatsPerBar) % beatsPerBar;
    const meterConf = opts.meterOverride ? 1 : Math.max(0, Math.min(1, M.margin / 1.2));
    // compound meter (6/8) and triplet-subdivided beats (12/8 feel)
    let suggestedTs = { num: beatsPerBar, den: 4 }, compound68 = false, compoundBeat = false;
    if (!opts.meterOverride && beatsPerBar === 3) {
      const cc = compoundCheck(prelim, beatTimes.length, phase);
      if (cc.ratio > 1.6) { compound68 = true; suggestedTs = { num: 6, den: 8 }; }
    }
    const trip = quantizeNotes(raw, map, beatTimes.length);
    const multiOnsetBeats = new Set(trip.notes.filter(n => Math.abs(n.s - Math.round(n.s)) > 0.05).map(n => Math.floor(n.s + 0.125))).size;
    if (!compound68 && !trip.swingFeel && multiOnsetBeats > 6 && trip.tripletBeats.length > multiOnsetBeats * 0.6 && (beatsPerBar === 2 || beatsPerBar === 4)) {
      compoundBeat = true; suggestedTs = { num: beatsPerBar * 3, den: 8 };
    }
    if (phase > 0) { for (let k = 0; k < beatsPerBar - phase; k++) beatTimes.unshift(beatTimes[0] - medIbi); }
    while (beatTimes.length % beatsPerBar !== 0) beatTimes.push(beatTimes[beatTimes.length - 1] + medIbi);
    map = makeBeatMap(beatTimes);
    check();

    // ---- quantise
    stage('Quantising rhythm', 0); await tick();
    const Q = quantizeNotes(raw, map, beatTimes.length, { compoundBeat });
    let notes = Q.notes.filter(n => n.s >= 0 && n.s < beatTimes.length);
    const firstS = notes.length ? notes[0].s : 0;
    const dropBars = Math.floor((firstS + 0.26) / beatsPerBar);
    if (dropBars > 0 && notes.length) {
      const k = dropBars * beatsPerBar;
      beatTimes.splice(0, k);
      notes = notes.map(n => ({ ...n, s: +(n.s - k).toFixed(4) })).filter(n => n.s >= 0);
      map = makeBeatMap(beatTimes);
    }
    const lastE = notes.reduce((m, n) => Math.max(m, n.s + n.d), 0);
    const keepBeats = Math.min(beatTimes.length, Math.ceil((lastE - 0.01) / beatsPerBar) * beatsPerBar);
    if (keepBeats >= beatsPerBar && keepBeats < beatTimes.length - 1) beatTimes.splice(keepBeats + 1);
    const nBeats = Math.max(beatsPerBar, Math.min(beatTimes.length, keepBeats || beatTimes.length));
    check();

    // ---- key & harmony
    stage('Detecting key and harmony', 0); await tick();
    const B = beatChromaFrom(notes, nBeats, F, beatTimes);
    const total = new Array(12).fill(0);
    for (const n of notes) total[n.p % 12] += n.a * Math.min(n.d, 4);
    for (let b = 0; b < nBeats; b++) for (let k = 0; k < 12; k++) total[k] += 0.15 * B.audio[b][k];
    const keys = T.estimateKey(total);
    const key = opts.keyOverride ? { ...opts.keyOverride } : { tonic: keys[0].tonic, mode: keys[0].mode };
    const keyConf = Math.max(0, Math.min(1, (keys[0].r - keys[1].r) * 5));
    const KW = windowedKeys(notes, beatsPerBar, key);
    const chords = estimateChords(B.chroma, B.bass, key, beatsPerBar);

    // ---- melody & bass
    stage('Separating melody and bass', 0); await tick();
    const V = voicing(notes);
    const melW = (n) => {
      if (n.p < 48) return 0;
      let w = Math.max(0.4, Math.min(1.8, 1 + 0.03 * (n.p - 62)));
      if (V.covered[n.i]) w *= 0.3; else if (V.top[n.i]) w *= 1.35;
      return w;
    };
    const melody = selectLine(notes, melW, { jump: 0.03 });
    const melSet = new Set(melody.map(n => n.i));
    const bassW = n => (n.p > 60 || melSet.has(n.i)) ? 0 : Math.max(0.3, 1 + 0.05 * (50 - n.p));
    const bass = selectLine(notes, bassW, { jump: 0.02 });
    const bassSet = new Set(bass.map(n => n.i));
    notes.forEach((n, i) => { n.r = melSet.has(i) ? 'm' : bassSet.has(i) ? 'b' : ''; });

    // ---- energy per beat
    const energy = new Float32Array(nBeats);
    for (let b = 0; b < nBeats; b++) {
      const f0 = Math.max(0, Math.round(beatTimes[b] * FPS)), f1 = Math.min(F.rms.length, Math.round((b + 1 < nBeats ? beatTimes[b + 1] : beatTimes[b] + medIbi) * FPS));
      let s = 0, c = 0; for (let f = f0; f < f1; f++) { s += F.rms[f] ** 2; c++; }
      energy[b] = c ? 10 * Math.log10(s / c + 1e-10) : -100;
    }
    const sorted = Array.from(energy).filter(v => v > -90).sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.05)] ?? -60, hi = sorted[Math.floor(sorted.length * 0.97)] ?? 0;
    const energyN = Array.from(energy, v => +Math.max(0, Math.min(1, (v - lo) / (hi - lo + 1e-6))).toFixed(3));

    // ---- honesty: statistics and warnings
    const avgPoly = polyphonyFromRaw(raw, dur);
    const strongPeaks = []; for (let i = 1; i < F.env.length - 1; i++) if (F.env[i] > 2.5 && F.env[i] >= F.env[i - 1] && F.env[i] > F.env[i + 1]) strongPeaks.push(i);
    const hfS = Array.from(F.hfFlux).sort((a, b) => a - b); const hfMed = hfS[hfS.length >> 1] || 0, hfHi = hfS[Math.floor(hfS.length * 0.9)] || 1e-6;
    let noisy = 0;
    for (const i of strongPeaks) { let fl = 0, hf = 0; for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < F.nFrames) { fl = Math.max(fl, F.flat[k]); hf = Math.max(hf, F.hfFlux[k]); } if (fl > 0.22 && hf > Math.max(hfHi, hfMed * 3)) noisy++; }
    const percussive = strongPeaks.length >= 12 && noisy / strongPeaks.length > 0.35;
    const denseThr = mode === 'neural' ? 4.0 : 6.5;
    const warnings = [];
    if (mode === 'dsp') warnings.push(opts.forceDsp ? 'You chose the spectral method, which is less accurate than the neural model. Expect missed inner voices and octave errors.' : 'The neural transcription model could not run in this browser, so a simpler spectral method was used. Expect missed inner voices and octave errors.');
    if (avgPoly > denseThr) warnings.push('Dense texture (about ' + avgPoly.toFixed(1) + ' notes sounding at once). Inner and doubled voices are the least reliable part of the transcription, especially where instruments overlap in register.');
    if (percussive) warnings.push('Drums or other unpitched percussion detected. They help with tempo and beat tracking but are not transcribed as notes.');
    if (ibiVar > 0.08) warnings.push('The tempo fluctuates noticeably (rubato or live playing). Notes are aligned to the tracked beats, so rhythms may be simplified. Play back with the recording’s timing to compare.');
    if (!opts.tempoOverride && !opts.tempoScale && tempoConf < 0.5) warnings.push('The beat level is uncertain: the tempo could also be ' + tempoAlts.slice(0, 2).join(' or ') + ' BPM. If the arrangement feels twice as fast or slow, use Re-analyse → Beat ×2 or ÷2.');
    if (!opts.meterOverride && meterConf < 0.3) warnings.push('The meter is uncertain (' + beatsPerBar + ' beats per bar was only slightly more likely than ' + (beatsPerBar === 4 ? 3 : 4) + '). Use Re-analyse → Meter to choose it yourself.');
    if (compound68) warnings.push('The music groups its eighth notes in threes, so it is written in 6/8.');
    if (compoundBeat) warnings.push('Most beats divide into three, so it is written in ' + suggestedTs.num + '/8.');
    if (Q.swingFeel) warnings.push('Swung eighths detected (about ' + Math.round(Q.swingRatio * 100) + '/' + Math.round(100 - Q.swingRatio * 100) + '). They are written as straight eighths and played back with swing.');
    if (keyConf < 0.25) warnings.push('The key is ambiguous (modal, chromatic, or modulating). The next candidate was ' + T.keyName(keys[1]) + '.');
    for (const m of KW.mods) warnings.push('The key seems to move to ' + T.keyName(m.key) + ' around bars ' + (Math.floor(m.a / beatsPerBar) + 1) + '–' + Math.ceil(Math.min(m.b, nBeats) / beatsPerBar) + '. The arrangement keeps one key signature; chords follow the change.');
    if (startSec > 0.5 || endSec < buffer.duration - 0.5) warnings.push('Only ' + fmtTime(startSec) + '–' + fmtTime(endSec) + ' of the ' + fmtTime(buffer.duration) + ' recording was analysed.');
    if (raw.length < 25) warnings.push('Very few notes were found (' + raw.length + '). The recording may be quiet, short, or mostly unpitched.');

    // tempo reported as an average over the music, not the median gap
    const inMusic = beatTimes.filter(t => t >= firstNote - 0.1 && t <= lastNote + 0.1);
    const tempo = inMusic.length > 2 ? 60 * (inMusic.length - 1) / (inMusic[inMusic.length - 1] - inMusic[0]) : 60 / medIbi;
    const beatTicks = compoundBeat ? 720 : 480;
    stage('Done', 1);
    const result = {
      version: 3, mode, engine: engineNote, fileName: opts.fileName || 'audio', duration: buffer.duration,
      offsetSec: startSec, analysedSec: x.length / SR,
      beatTimes: beatTimes.map(t => +(t + startSec).toFixed(4)), tempo: +tempo.toFixed(1), beatsPerBar, nBeats, beatTicks, suggestedTs, swing: !!Q.swingFeel,
      key, keyCandidates: keys.slice(0, 4).map(k => ({ tonic: k.tonic, mode: k.mode, r: +k.r.toFixed(3) })), keyChanges: KW.mods.map(m => ({ key: m.key, fromBeat: m.a, toBeat: m.b })),
      notes: notes.map(n => ({ p: n.p, s: n.s, d: n.d, a: +n.a.toFixed(3), r: n.r })),
      melody: melody.map(n => ({ p: n.p, s: n.s, d: n.d, a: +n.a.toFixed(3) })),
      bass: bass.map(n => ({ p: n.p, s: n.s, d: n.d, a: +n.a.toFixed(3) })),
      chords, energy: energyN,
      raw: raw.map(n => ({ p: n.pitch, t: +(n.start + startSec).toFixed(3), d: +n.dur.toFixed(3), a: +n.amp.toFixed(3) })),
      stats: {
        notes: notes.length, melodyNotes: melody.length, bassNotes: bass.length, avgPolyphony: +avgPoly.toFixed(2),
        tempoConfidence: +tempoConf.toFixed(2), tempoAlternatives: tempoAlts, beatStability: +(1 - Math.min(1, ibiVar * 4)).toFixed(2), meterConfidence: +meterConf.toFixed(2),
        keyConfidence: +keyConf.toFixed(2), meterScores: M.scores, onsetBias: +(Q.bias || 0).toFixed(3), percussion: { strongPk: strongPeaks.length, noisy }, tripletBeats: Q.tripletBeats.length, seconds: +((performance.now() - t0) / 1000).toFixed(1),
      },
      warnings,
      spec: { fps: FPS, bands: NBANDS, minMidi: MINMIDI, frames: F.nFrames, data: F.spec, offsetSec: startSec },
    };
    if (framesOut) result.__frames = framesOut;
    return result;
  }

  function fmtTime(s) { const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }

  function beatChromaFrom(notes, nBeats, F, beatTimes) {
    const chroma = Array.from({ length: nBeats }, () => new Array(12).fill(0));
    const bass = Array.from({ length: nBeats }, () => new Array(12).fill(0));
    const audio = Array.from({ length: nBeats }, () => new Array(12).fill(0));
    for (const n of notes) {
      const b0 = Math.max(0, Math.floor(n.s)), b1 = Math.min(nBeats - 1, Math.floor(n.s + n.d - 1e-6));
      for (let b = b0; b <= b1; b++) {
        const ov = Math.min(n.s + n.d, b + 1) - Math.max(n.s, b);
        if (ov <= 0) continue;
        chroma[b][n.p % 12] += n.a * ov * (n.p < 55 ? 1.3 : 1);
        if (n.p < 57) bass[b][n.p % 12] += n.a * ov * (1 + (57 - n.p) / 12);
      }
    }
    for (let b = 0; b < nBeats; b++) {
      const t0 = beatTimes[b], t1 = b + 1 < beatTimes.length ? beatTimes[b + 1] : t0 + 0.5;
      const f0 = Math.max(0, Math.round(t0 * FPS)), f1 = Math.min(F.nFrames, Math.round(t1 * FPS));
      for (let f = f0; f < f1; f++) for (let k = 0; k < 12; k++) audio[b][k] += F.chroma[f * 12 + k];
      const mx = Math.max(...audio[b]) || 1; const mn = Math.min(...audio[b]);
      for (let k = 0; k < 12; k++) audio[b][k] = (audio[b][k] - mn) / (mx - mn + 1e-9);
      const tot = chroma[b].reduce((s, v) => s + v, 0);
      for (let k = 0; k < 12; k++) chroma[b][k] += 0.25 * audio[b][k] * Math.max(0.05, tot / 6);
    }
    return { chroma, bass, audio };
  }

  async function spectrum(buffer, startSec = 0, endSec = null) {
    const x = await toMono22k(buffer, startSec, endSec);
    const F = await features(x);
    return { fps: FPS, bands: NBANDS, minMidi: MINMIDI, frames: F.nFrames, data: F.spec, offsetSec: startSec };
  }
  window.Analysis = { decodeFile, analyze, makeBeatMap, selectLine, spectrum, SR, FPS };
})();
