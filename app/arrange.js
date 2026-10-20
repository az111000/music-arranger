/* Arrangement engine: lead sheet (beats) -> working lead (ticks) -> piano / orchestral parts.
   Every part is generated deterministically from the lead + settings, so a single part can be
   regenerated without touching the others.  Global: Arranger */
(function () {
  const PPQ = T.PPQ;
  let NID = 1;
  const nid = () => 'n' + (NID++).toString(36) + Math.random().toString(36).slice(2, 5);

  // ------------------------------------------------------------------ lead in ticks
  function buildLead(an, st) {
    const ts = T.timeSig(st.ts.num, st.ts.den);
    const obpb = an.beatsPerBar;
    const bt0 = an.beatTicks || PPQ;                       // ticks per analysed beat (480, or 720 for compound beats)
    const identity = ts.barTicks === obpb * bt0;
    const g = st.meterMode === 'rebar' ? 1 : Math.max(1, Math.round(obpb / ts.beatsPerBar));
    const nbpob = g * ts.beatsPerBar;                      // new beats per original bar
    const swingMap = f => f < 0.5 ? f * (4 / 3) : 2 / 3 + (f - 0.5) * (2 / 3);
    const swingInv = f => f < 2 / 3 ? f * 0.75 : 0.5 + (f - 2 / 3) * 1.5;
    const grid = ts.compound ? ts.beatTicks / 6 : (st.meterMode === 'rebar' ? 40 : 120);
    function W(b) { // analysed beat -> tick
      if (identity) return Math.round(b * bt0);
      let nb;
      if (st.meterMode === 'rebar') nb = b;
      else { const bar = Math.floor(b / obpb + 1e-9), inBar = b - bar * obpb; nb = bar * nbpob + inBar * nbpob / obpb; }
      const whole = Math.floor(nb + 1e-9), f = nb - whole;
      const tk = ts.compound ? (whole + swingMap(f)) * ts.beatTicks : nb * ts.beatTicks;
      return Math.round(tk / grid) * grid;
    }
    function Winv(t) { // tick -> analysed beat
      if (identity) return t / bt0;
      let nb;
      if (ts.compound) { const whole = Math.floor(t / ts.beatTicks + 1e-9); nb = whole + swingInv(t / ts.beatTicks - whole); }
      else nb = t / ts.beatTicks;
      if (st.meterMode === 'rebar') return nb;
      const bar = Math.floor(nb / nbpob + 1e-9), inBar = nb - bar * nbpob;
      return bar * obpb + inBar * obpb / nbpob;
    }
    const fromKey = an.key, toKey = st.key || an.key;
    const mp = p => T.mapPitch(p, fromKey, toKey);
    const minD = ts.compound ? ts.beatTicks / 6 : 120;
    const mapNotes = (arr) => {
      const out = [];
      for (const n of arr) { const s = W(n.s), e = W(n.s + n.d); out.push({ p: mp(n.p), s, d: Math.max(minD, e - s), a: n.a, r: n.r || '' }); }
      out.sort((a, b) => a.s - b.s || b.p - a.p);
      return out;
    };
    let melody = mapNotes(an.melody);
    const mel2 = [];
    for (const n of melody) {
      const last = mel2[mel2.length - 1];
      if (last && last.s === n.s) { if (n.a * n.d > last.a * last.d) mel2[mel2.length - 1] = n; continue; }
      if (last && last.s + last.d > n.s) last.d = Math.max(minD / 2, n.s - last.s);
      mel2.push(n);
    }
    melody = mel2;
    const bass = mapNotes(an.bass);
    for (let i = 0; i < bass.length - 1; i++) if (bass[i].s + bass[i].d > bass[i + 1].s) bass[i].d = Math.max(60, bass[i + 1].s - bass[i].s);
    const notes = mapNotes(an.notes);
    const chords = an.chords.map(c => { const s = W(c.s), e = W(c.s + c.d); return { s, d: Math.max(1, e - s), ...T.mapChord({ root: c.root, type: c.type }, fromKey, toKey) }; }).filter(c => c.d > 0);
    const totalTicksRaw = W(an.nBeats);
    const nBars = Math.max(1, Math.ceil(totalTicksRaw / ts.barTicks));
    const L0 = { chords, key: toKey, totalTicks: nBars * ts.barTicks };
    // harmonic minor: raise the subtonic to a leading tone over dominant harmony
    if (fromKey.mode === 'major' && toKey.mode === 'minor') {
      const sub = (toKey.tonic + 10) % 12, dom = (toKey.tonic + 7) % 12;
      for (const arr of [melody, bass, notes]) for (const n of arr) if (((n.p % 12) + 12) % 12 === sub) { const c = chordAt(L0, n.s); if (c && c.root === dom) n.p += 1; }
    }
    const barE = new Array(nBars).fill(0), barC = new Array(nBars).fill(0);
    an.energy.forEach((e, b) => { const bar = Math.floor(W(b + 0.5) / ts.barTicks); if (bar >= 0 && bar < nBars) { barE[bar] += e; barC[bar]++; } });
    for (let i = 0; i < nBars; i++) barE[i] = barC[i] ? barE[i] / barC[i] : (i ? barE[i - 1] : 0.5);
    const lastTick = Math.max(0, ...notes.map(n => n.s + n.d));
    const usedBars = Math.max(1, Math.min(nBars, Math.ceil(lastTick / ts.barTicks)));
    return { ts, key: toKey, fromKey, identity, W, Winv, minD, beatTicks0: bt0, melody, bass, notes, chords, nBars: usedBars, totalTicks: usedBars * ts.barTicks, barEnergy: barE.slice(0, usedBars) };
  }

  // ------------------------------------------------------------------ dynamics & phrases
  const VEL_RANGE = { follow: [46, 106], expanded: [34, 118], compressed: [60, 90], gentle: [36, 80], powerful: [78, 120] };
  function phrasePlan(L, st) {
    const n = L.nBars;
    const phraseLen = st.phraseBars || (L.ts.beatsPerBar >= 4 || L.ts.compound ? 4 : 8);
    const phrases = [];
    for (let b = 0; b < n; b += phraseLen) phrases.push({ a: b, b: Math.min(n, b + phraseLen) });
    const pe = phrases.map(p => { let s = 0; for (let i = p.a; i < p.b; i++) s += L.barEnergy[i]; return s / (p.b - p.a); });
    const ranks = pe.map(v => pe.filter(x => x < v).length / Math.max(1, pe.length - 1));
    const curve = { follow: e => e, expanded: e => e * e * (3 - 2 * e), compressed: e => 0.3 + 0.4 * e, gentle: e => 0.08 + 0.42 * e, powerful: e => 0.55 + 0.45 * e }[st.dynamics || 'follow'] || (e => e);
    phrases.forEach((p, i) => {
      const raw = 0.55 * pe[i] + 0.45 * ranks[i];
      p.raw = raw;
      const lv = curve(raw);
      p.energy = lv;
      p.level = lv < 0.3 ? 0 : lv < 0.52 ? 1 : lv < 0.75 ? 2 : 3;
      if (st.dynamics === 'gentle') p.level = Math.min(p.level, 1);
      if (st.dynamics === 'powerful') p.level = Math.max(p.level, 2);
      if (st.dynamics === 'compressed') p.level = Math.max(1, Math.min(2, p.level));
      p.idx = i; p.letter = String.fromCharCode(65 + (i % 26));
    });
    const barLevel = new Array(n), barPhrase = new Array(n), barVel = new Array(n);
    phrases.forEach(p => { for (let i = p.a; i < p.b; i++) { barLevel[i] = p.level; barPhrase[i] = p; } });
    const [vlo, vhi] = VEL_RANGE[st.dynamics] || VEL_RANGE.follow;
    const rawVel = [];
    for (let i = 0; i < n; i++) rawVel.push(Math.max(0, Math.min(1, 0.5 * L.barEnergy[i] + 0.5 * barPhrase[i].raw)));
    for (let i = 0; i < n; i++) { // smooth across neighbouring bars so dynamics move in phrases, not every bar
      const a = rawVel[Math.max(0, i - 1)], b = rawVel[i], c = rawVel[Math.min(n - 1, i + 1)];
      barVel[i] = vlo + (vhi - vlo) * (0.25 * a + 0.5 * b + 0.25 * c);
    }
    return { phrases, barLevel, barPhrase, barVel, phraseLen };
  }

  // ------------------------------------------------------------------ queries on the lead
  function chordAt(L, t) {
    const cs = L.chords; let lo = 0, hi = cs.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].s <= t) { k = m; lo = m + 1; } else hi = m - 1; }
    for (let j = k; j >= 0; j--) if (cs[j].type !== 'N') return cs[j];
    for (let j = k + 1; j < cs.length; j++) if (cs[j].type !== 'N') return cs[j];
    return { root: L.key.tonic, type: L.key.mode === 'minor' ? 'min' : 'maj', s: 0, d: L.totalTicks };
  }
  function lineAt(line, t, lookback = PPQ * 2) {
    let best = null;
    for (const n of line) { if (n.s > t) break; if (n.s + n.d > t || t - (n.s + n.d) < lookback) best = n; }
    return best;
  }
  function soundingAt(line, t) { for (const n of line) { if (n.s > t) break; if (n.s <= t && n.s + n.d > t) return n; } return null; }
  function chordSpans(L, half) {
    const out = []; const bt = L.ts.barTicks;
    const cuts = new Set([0, L.totalTicks]);
    for (let b = 0; b <= L.nBars; b++) { cuts.add(b * bt); if (half && L.ts.beatsPerBar % 2 === 0) cuts.add(b * bt + bt / 2); }
    for (const c of L.chords) if (c.s >= 0 && c.s < L.totalTicks) cuts.add(c.s);
    const arr = [...cuts].filter(x => x >= 0 && x <= L.totalTicks).sort((a, b) => a - b);
    for (let i = 0; i < arr.length - 1; i++) { const s = arr[i], e = arr[i + 1]; if (e - s < 60) continue; out.push({ s, e, chord: chordAt(L, s), bar: Math.floor(s / bt) }); }
    return out;
  }
  function enrich(chord, style, L, level) { // level 0 none, 1 sevenths, 2 sevenths + colour
    if (!level) return chord;
    const c = { ...chord };
    const dom = (L.key.tonic + 7) % 12;
    const rich = style === 'jazz' || style === 'romantic' || style === 'cinematic' || level >= 2;
    if (c.type === 'maj') c.type = c.root === dom ? 'dom7' : (rich ? 'maj7' : 'maj');
    else if (c.type === 'min') c.type = rich ? 'min7' : 'min';
    else if (c.type === 'dim') c.type = 'hdim7';
    return c;
  }
  const pcsOf = (c, add9) => { const p = T.chordPcs(c); if (add9) p.push((c.root + 2) % 12); return p; };
  function tonesIn(pcs, lo, hi) { const out = []; for (let p = lo; p <= hi; p++) if (pcs.includes(((p % 12) + 12) % 12)) out.push(p); return out; }
  function nearestTone(pcs, target, lo, hi) { let best = null, bd = 1e9; for (const p of tonesIn(pcs, lo, hi)) { const d = Math.abs(p - target); if (d < bd) { bd = d; best = p; } } return best; }
  function bassPitchAt(L, t, span, useOriginal, lo = 36, hi = 52) {
    if (useOriginal) { const b = L.bass.find(n => n.s <= t + 30 && n.s + n.d > t); if (b) return T.fitRange(b.p, [lo, hi]); }
    return T.fitRange(span.chord.root + 36, [lo, hi]);
  }
  const thirdOf = c => (c.root + T.CHORDS[c.type].iv[1]) % 12;

  // choose n chord tones in [lo,hi] below `top`, voice-led from prev; `present` = pitch classes already sounding elsewhere
  function voice(pcs, n, lo, hi, prev, top, present, chord) {
    const cand = tonesIn(pcs, lo, Math.min(hi, top - 1)).slice(-14);
    if (cand.length === 0) return [];
    if (cand.length <= n) return cand.slice();
    let best = null, bs = 1e9;
    const third = chord ? thirdOf(chord) : -1;
    const pres = new Set(present || []);
    const combo = (start, acc) => {
      if (acc.length === n) {
        let sc = 0;
        if (prev && prev.length === n) for (let i = 0; i < n; i++) sc += Math.abs(acc[i] - prev[i]);
        else sc += Math.abs(acc[n - 1] - (top - 5)) * 0.6;
        const pcsU = new Set(acc.map(p => p % 12));
        sc += (n - pcsU.size) * 3;
        if (third >= 0 && !pcsU.has(third) && !pres.has(third)) sc += 6;
        for (const pc of pcsU) if (pres.has(pc) && pc !== chord?.root) sc += 0.8; // avoid doubling what others play
        for (let i = 1; i < n; i++) { const gap = acc[i] - acc[i - 1]; if (gap > 9) sc += (gap - 9) * 0.8; if (gap < 3) sc += 1.5; }
        if (top - acc[n - 1] > 9) sc += (top - acc[n - 1] - 9) * 0.5;
        if (sc < bs) { bs = sc; best = acc.slice(); }
        return;
      }
      for (let i = start; i < cand.length; i++) { acc.push(cand[i]); combo(i + 1, acc); acc.pop(); }
    };
    combo(0, []);
    return best || cand.slice(-n);
  }

  function fitLine(notes, range, prefer = 0) {
    if (!notes.length) return notes;
    let bestK = 0, bestSc = -1e9;
    for (let k = -3; k <= 3; k++) {
      let inR = 0, mid = 0;
      for (const n of notes) { const p = n.p + 12 * k; if (p >= range[0] && p <= range[1]) inR++; mid += Math.abs(p - (range[0] + range[1]) / 2); }
      const sc = inR * 10 - mid / notes.length * 0.3 - Math.abs(k - prefer) * 2;
      if (sc > bestSc) { bestSc = sc; bestK = k; }
    }
    return notes.map(n => ({ ...n, p: T.fitRange(n.p + 12 * bestK, range) }));
  }
  // keep an intentional octave shift if most of the line fits; fold only the outliers
  function fitShifted(notes, range) {
    if (!notes.length) return notes;
    const inR = notes.filter(n => n.p >= range[0] && n.p <= range[1]).length;
    if (inR >= notes.length * 0.6) return notes.map(n => ({ ...n, p: T.fitRange(n.p, range) }));
    return fitLine(notes, range, 0);
  }

  // ------------------------------------------------------------------ articulation & velocity
  const ART = { legato: 1.0, natural: 0.9, detached: 0.72, staccato: 0.42 };
  function articulate(notes, phrasing) {
    const f = ART[phrasing] ?? 0.9;
    const byStart = notes.slice().sort((a, b) => a.s - b.s);
    for (let i = 0; i < byStart.length; i++) {
      const n = byStart[i];
      let next = null; for (let j = i + 1; j < byStart.length; j++) if (byStart[j].s > n.s) { next = byStart[j]; break; }
      if (phrasing === 'legato' && next && next.s - (n.s + n.d) < PPQ / 2 && next.s > n.s) n.d = next.s - n.s;
      else if (f < 1) n.d = Math.max(60, Math.round(n.d * (n.d <= PPQ ? f : (f + 1) / 2)));
    }
    return notes;
  }
  function applyVel(notes, P, L, offset, st, rnd) {
    const bt = L.ts.barTicks;
    for (const n of notes) {
      const bar = Math.max(0, Math.min(L.nBars - 1, Math.floor(n.s / bt)));
      let v = P.barVel[bar] + offset;
      if (st.expressive !== false) {
        const ph = P.barPhrase[bar]; const pos = (n.s - ph.a * bt) / ((ph.b - ph.a) * bt);
        v *= 0.92 + 0.12 * Math.sin(Math.PI * Math.min(1, pos * 1.15));
        const inBar = (n.s % bt) / L.ts.beatTicks;
        if (Math.abs(inBar) < 1e-6) v += 3; else if (Math.abs(inBar - Math.round(inBar)) > 1e-6) v -= 3;
      }
      v += (rnd() - 0.5) * 6;
      n.v = Math.max(18, Math.min(124, Math.round(v)));
    }
    return notes;
  }
  const mk = (p, s, d, extra) => ({ id: nid(), p: Math.round(p), s: Math.round(s), d: Math.max(30, Math.round(d)), v: 80, ...extra });

  function handLimit(notes, maxN, maxSpan, keepTop) {
    const groups = new Map();
    for (const n of notes) { const k = n.s; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
    const out = [];
    for (const [, g] of groups) {
      g.sort((a, b) => (a.mel ? -1 : 0) - (b.mel ? -1 : 0) || (keepTop ? b.p - a.p : a.p - b.p));
      const anchor = g[0].p; const seen = new Set(); let kept = 0;
      for (const n of g) { if (seen.has(n.p)) continue; if (kept >= maxN || Math.abs(n.p - anchor) > maxSpan) continue; seen.add(n.p); kept++; out.push(n); }
    }
    return out.sort((a, b) => a.s - b.s || a.p - b.p);
  }
  function dedupe(notes) {
    notes.sort((a, b) => a.p - b.p || a.s - b.s);
    const out = [];
    for (const n of notes) { const l = out[out.length - 1]; if (l && l.p === n.p && n.s < l.s + l.d) { if (n.s === l.s) { l.d = Math.max(l.d, n.d); if (n.mel) l.mel = 1; continue; } l.d = n.s - l.s; } out.push(n); }
    return out.filter(n => n.d >= 30).sort((a, b) => a.s - b.s || a.p - b.p);
  }

  // ------------------------------------------------------------------ fidelity tiers
  function tierOf(fid) { const f = fid / 100; return f >= 0.85 ? 'literal' : f >= 0.6 ? 'close' : f >= 0.35 ? 'balanced' : f >= 0.15 ? 'free' : 'reimagined'; }
  const ENRICH = { literal: 0, close: 0, balanced: 0, free: 1, reimagined: 2 };
  const variantOf = (st, id, n) => (((st.seed || 0) + ((st.partSeeds && st.partSeeds[id]) || 0)) % n + n) % n;

  // ------------------------------------------------------------------ PIANO
  const PIANO_STYLES = ['classical', 'romantic', 'pop', 'jazz', 'baroque', 'minimalist'];

  function pianoMelody(L, P) {
    const bt = L.ts.barTicks; const mel = [];
    for (const ph of P.phrases) { const seg = L.melody.filter(n => n.s >= ph.a * bt && n.s < ph.b * bt); mel.push(...fitLine(seg, [57, 93]).map(n => mk(n.p, n.s, n.d, { mel: 1 }))); }
    return mel;
  }

  function pianoRH(L, st, P, rnd, lh) {
    const tier = tierOf(st.fidelity), style = st.style, enr = ENRICH[tier];
    const bt = L.ts.barTicks, beat = L.ts.beatTicks;
    const mel = pianoMelody(L, P);
    const out = mel.slice();
    const melAt = t => lineAt(mel, t, beat);
    const variant = variantOf(st, 'rh', 3);
    if (tier === 'literal' || tier === 'close') {
      const perOnset = new Map();
      for (const n of L.notes) {
        if (n.r === 'm' || n.r === 'b' || n.p < 58) continue;
        const m = soundingAt(mel, n.s) || melAt(n.s); if (m && n.p >= m.p) continue;
        if (m && m.p - n.p > 13) continue;
        const k = perOnset.get(n.s) || 0; if (tier === 'close' && k >= 2) continue; perOnset.set(n.s, k + 1);
        out.push(mk(n.p, n.s, n.d));
      }
    }
    if (tier !== 'literal') {
      const spans = chordSpans(L, true);
      for (const sp of spans) {
        const lvl = Math.min(3, P.barLevel[sp.bar] + (tier === 'reimagined' ? 1 : 0));
        const ch = enrich(sp.chord, style, L, enr);
        const pcs = pcsOf(ch, enr >= 2 && (style === 'jazz' || style === 'romantic' || style === 'pop'));
        const m = melAt(sp.s);
        const top = m ? m.p : 74;
        if (tier === 'close') continue; // transcription supplies the inner voices
        if (style === 'classical' || style === 'baroque') {
          if (style === 'baroque' && enr === 0) continue;
          for (const n of mel) {
            if (n.s < sp.s || n.s >= sp.e || n.d < beat * 0.9) continue;
            if ((n.s % bt) % (bt / (L.ts.beatsPerBar % 2 ? L.ts.beatsPerBar : 2)) !== 0 && variant !== 2) continue;
            const c = tonesIn(pcs, n.p - (variant === 1 ? 5 : 9), n.p - 3).pop();
            if (c) out.push(mk(c, n.s, n.d));
          }
        } else if (style === 'romantic') {
          if (variant === 1) { // repeated chords on the beats under the melody
            let prev = null;
            for (let t = sp.s; t < sp.e; t += beat) {
              const mm = soundingAt(mel, t) || melAt(t); const tp = mm ? mm.p : top;
              const v = voice(pcs, lvl >= 2 ? 3 : 2, Math.max(55, tp - 12), tp - 2, prev, tp, null, ch); prev = v;
              v.forEach(p => out.push(mk(p, t, Math.min(beat, sp.e - t) * 0.9)));
            }
          } else for (const n of mel) {
            if (n.s < sp.s || n.s >= sp.e || n.d < beat * 0.9) continue;
            if ((lvl >= 3 || (variant === 2 && lvl >= 2)) && n.p - 12 >= 55) out.push(mk(n.p - 12, n.s, n.d)); // octave melody
            const v = voice(pcs, variant === 2 ? 1 : lvl >= 2 ? 2 : 1, Math.max(55, n.p - 11), n.p - 2, null, n.p, null, ch);
            v.forEach(p => out.push(mk(p, n.s, n.d)));
          }
        } else if (style === 'pop') {
          const steps = [lvl >= 2 ? beat : beat * 2, beat, beat * 2][variant];
          let prev = null;
          for (let t = sp.s; t < sp.e; t += steps) {
            const tt = variant === 2 && t > sp.s ? t + beat / 2 : t; if (tt >= sp.e) break;
            const mm = soundingAt(mel, tt) || melAt(tt); const tp = mm ? mm.p : top;
            const v = voice(pcs, lvl >= 1 ? 3 : 2, Math.max(55, tp - 12), 79, prev, tp, null, ch); prev = v;
            v.forEach(p => out.push(mk(p, tt, Math.min(steps, sp.e - tt) * 0.95)));
          }
          if (enr >= 2 && lvl >= 2) for (const n of mel) if (n.s >= sp.s && n.s < sp.e && n.p - 12 >= 57) out.push(mk(n.p - 12, n.s, n.d));
        } else if (style === 'jazz') {
          const pc2 = pcsOf({ ...ch, type: ch.type === 'maj' ? 'maj7' : ch.type === 'min' ? 'min7' : ch.type }, true).filter(pc => pc !== ch.root);
          const v = voice(pc2, 3, Math.max(55, top - 13), 77, null, top, null, ch);
          const t = sp.s + (variant !== 0 && rnd() < 0.4 && sp.e - sp.s > beat * 2 ? -beat / 2 : 0);
          v.forEach(p => out.push(mk(p, Math.max(0, t), Math.min(beat * (variant === 2 ? 0.9 : 1.5), sp.e - sp.s))));
        } else if (style === 'minimalist') {
          const v = voice(pcs, 2, 60, 79, null, top, null, ch);
          if (variant === 1) { let k = 0; for (let t = sp.s; t < sp.e; t += beat / 2, k++) out.push(mk(v[k % v.length] ?? top - 5, t, beat / 2)); }
          else v.forEach(p => out.push(mk(p, sp.s, sp.e - sp.s)));
        }
      }
    }
    return separateHands(handLimit(dedupe(out), 4, 13, true), lh, mel);
  }

  // keep right-hand harmony between the left hand and the melody, within reach of the melody
  function separateHands(rh, lh, mel) {
    if (!lh) return rh;
    const lhSorted = lh.slice().sort((a, b) => a.s - b.s);
    const lhTopAt = (s, e) => { let top = -1; for (const n of lhSorted) { if (n.s >= e) break; if (n.s + n.d > s) top = Math.max(top, n.p); } return top; };
    const out = [];
    for (const n of rh) {
      if (n.mel) { out.push(n); continue; }
      const m = soundingAt(mel, n.s) || lineAt(mel, n.s, PPQ);
      let p = n.p;
      const lt = lhTopAt(n.s, n.s + n.d);
      while (m && m.p - p > 12) p += 12;
      if (lt >= 0 && p <= lt) p += 12;
      if (m && p >= m.p) continue;
      if (m && m.p - p > 13) continue;
      out.push({ ...n, p });
    }
    return dedupe(out);
  }

  function pianoLH(L, st, P, rnd, opts = {}) {
    const tier = tierOf(st.fidelity), style = st.style, enr = ENRICH[tier];
    const bt = L.ts.barTicks, beat = L.ts.beatTicks, compound = L.ts.compound;
    const out = [];
    if (tier === 'literal') {
      for (const n of L.bass) out.push(mk(T.fitRange(n.p, [24, 60]), n.s, n.d));
      for (const n of L.notes) { if (n.r === 'm' || n.r === 'b' || n.p >= 58 || n.p < 28) continue; out.push(mk(n.p, n.s, n.d)); }
      for (let b = 0; b < L.nBars; b++) {
        const has = out.some(n => n.s >= b * bt && n.s < (b + 1) * bt);
        const anyMel = L.melody.some(n => n.s >= b * bt && n.s < (b + 1) * bt);
        if (!has && anyMel) { const c = chordAt(L, b * bt); out.push(mk(T.fitRange(c.root + 36, [36, 50]), b * bt, bt)); }
      }
      return handLimit(dedupe(out), 4, 14, false);
    }
    const useOrig = tier === 'close' || tier === 'balanced';
    const spans = chordSpans(L, false);
    const eighth = compound ? beat / 3 : beat / 2;
    const variant = opts.variant ?? variantOf(st, 'lh', 3);
    let prevV = null;
    const levelBoost = tier === 'reimagined' ? 1 : tier === 'close' ? -1 : 0;
    for (const sp of spans) {
      const lvl = Math.max(0, Math.min(3, P.barLevel[sp.bar] + levelBoost));
      const ch = enrich(sp.chord, style, L, enr);
      const pcs = pcsOf(ch);
      const len = sp.e - sp.s;
      const bp = bassPitchAt(L, sp.s, sp, useOrig, 36, 50);
      const third = thirdOf(ch), fifth = (ch.root + T.CHORDS[ch.type].iv[2]) % 12;
      const above = (pc, base) => { let p = base + ((pc - base) % 12 + 12) % 12; if (p === base) p += 12; return p; };
      const R = bp, F5 = above(fifth, bp), T3 = above(third, bp), O = bp + 12, T10 = above(third, bp + 12);
      const pattern = (seq, step, durMul = 1) => { let i = 0; for (let t = sp.s; t < sp.e - 1; t += step, i++) out.push(mk(seq[i % seq.length], t, Math.min(step * durMul, sp.e - t))); };
      if (lvl === 0 && style !== 'minimalist' && style !== 'baroque') { out.push(mk(R, sp.s, len)); if (len >= beat * 2) out.push(mk(F5, sp.s, len)); continue; }
      if (len < beat * 0.99) { out.push(mk(R, sp.s, len)); continue; }
      switch (style) {
        case 'classical':
          if (L.ts.beatsPerBar === 3 && !compound) {
            if (variant === 1) pattern([R, F5, T3 + (T3 < R + 3 ? 12 : 0), F5, O, F5], eighth);
            else if (variant === 2) pattern([R, T3 + (T3 < R + 3 ? 12 : 0), F5], beat, 0.95);
            else { out.push(mk(R, sp.s, beat)); for (let t = sp.s + beat; t < sp.e; t += beat) [T3, F5].forEach(p => out.push(mk(p + (p < 48 ? 12 : 0), t, beat * 0.8))); }
          }
          else if (compound && variant === 2) { for (let t = sp.s; t < sp.e; t += beat) { out.push(mk(R, t, eighth)); [T3 + (T3 < R + 3 ? 12 : 0), F5].forEach(p => { out.push(mk(p, t + eighth, eighth * 0.9)); out.push(mk(p, t + eighth * 2, eighth * 0.9)); }); } }
          else if (variant === 0) pattern([R, F5, T3 + (T3 < R + 3 ? 12 : 0), F5], eighth);
          else if (variant === 1) pattern([R, T3 + (T3 < R + 3 ? 12 : 0), F5, O], eighth);
          else { out.push(mk(R, sp.s, Math.min(len, beat))); for (let t = sp.s + beat; t < sp.e; t += beat) [T3, F5].forEach(p => out.push(mk(p + (p < 48 ? 12 : 0), t, beat * 0.7))); }
          break;
        case 'romantic':
          if (compound) pattern([[R, F5, T10, O, T10, F5], [R, O, T10, O, F5, O], [R, F5, O, T10, O, F5]][variant], eighth);
          else if (variant === 1 || st.tempo < 84) pattern([R, F5, O, T10, O, F5], beat / 3);
          else if (variant === 2) { out.push(mk(R, sp.s, len)); out.push(mk(R + 12, sp.s, len)); for (let t = sp.s + beat; t < sp.e; t += beat) [F5 + 12, T10].forEach(p => out.push(mk(p, t, beat * 0.8))); }
          else pattern([R, F5, O, T10, O, F5, O, F5], eighth);
          break;
        case 'pop':
          if (compound) { if (variant === 1) pattern([R, F5], beat, 0.95); else if (variant === 2) pattern([R, O, F5, O, T10, O], eighth); else pattern([R, F5, O], eighth); }
          else if (variant === 1) { for (let t = sp.s; t < sp.e; t += beat) out.push(mk(((t - sp.s) / beat) % 2 ? F5 : R, t, beat * 0.9)); }
          else if (variant === 2) { out.push(mk(R, sp.s, beat * 1.5)); if (len > beat * 1.5) out.push(mk(R, sp.s + beat * 1.5, Math.min(beat * 1.5, len - beat * 1.5))); if (len > beat * 3) out.push(mk(F5, sp.s + beat * 3, len - beat * 3)); }
          else { out.push(mk(R, sp.s, Math.min(len, beat * 1.5))); for (let t = sp.s + beat * 1.5; t < sp.e; t += beat) out.push(mk(((t - sp.s) / beat) % 2 > 1 ? F5 : O, t, Math.min(beat, sp.e - t) * 0.95)); }
          if (lvl >= 3 && R - 12 >= 28) out.push(mk(R - 12, sp.s, Math.min(len, beat * 2)));
          break;
        case 'jazz': {
          const pc2 = pcsOf({ ...ch, type: ch.type === 'maj' ? 'maj7' : ch.type === 'min' ? 'min7' : ch.type });
          const shell = voice(pc2.filter(pc => pc !== ch.root), 2, 50, 62, prevV, 64, null, ch); prevV = shell;
          if (variant === 1) { // Charleston: beat 1 and the "and" of 2
            shell.concat([R]).forEach(p => out.push(mk(p, sp.s, beat * 1.2)));
            if (len > beat * 1.5) shell.forEach(p => out.push(mk(p, sp.s + beat * 1.5, Math.min(beat, len - beat * 1.5))));
          } else if (variant === 2) { // walking quarters
            const scale = T.scalePcs(L.key); let p = R;
            for (let t = sp.s; t < sp.e; t += beat) { out.push(mk(p, t, beat * 0.9)); const opts2 = tonesIn(pcs, p - 5, p + 7).filter(x => x !== p); p = opts2.length ? opts2[Math.floor(rnd() * opts2.length)] : p + 2; while (!scale.includes(((p % 12) + 12) % 12) && !pcs.includes(((p % 12) + 12) % 12)) p++; p = T.fitRange(p, [33, 55]); }
          } else {
            let k = 0;
            for (let t = sp.s; t < sp.e; t += beat, k++) { const strong = ((t % bt) / beat) % 2 === 0; if (strong) out.push(mk(k % 4 === 2 ? F5 : R, t, beat * 0.9)); else shell.forEach(p => out.push(mk(p, t, beat * 0.6))); }
          }
          break;
        }
        case 'baroque': {
          const next = spans[spans.indexOf(sp) + 1];
          const target = next ? bassPitchAt(L, next.s, next, useOrig, 36, 50) : R;
          const scale = T.scalePcs(L.key);
          const step = compound ? eighth : ((lvl >= 2 || variant === 1) ? eighth : beat);
          const nSteps = Math.max(1, Math.round(len / step));
          let p = R;
          for (let i = 0; i < nSteps; i++) {
            const t = sp.s + i * step;
            out.push(mk(p, t, step * 0.92));
            const remaining = nSteps - i - 1;
            if (remaining <= 0) break;
            const dir = Math.sign(target - p) || (rnd() < 0.5 ? 1 : -1);
            if (remaining <= Math.abs(target - p) / 2 || remaining <= 2) { let q = p + dir; while (!scale.includes(((q % 12) + 12) % 12)) q += dir; p = q; }
            else { const o2 = tonesIn(pcs, p - 7, p + 7).filter(x => x !== p); p = o2.length ? o2[Math.floor(rnd() * o2.length)] : p; }
            p = T.fitRange(p, [33, 55]);
          }
          break;
        }
        case 'minimalist':
          pattern([[R, F5, O, F5], [R, F5, R, F5, O, F5, R, F5].map((p, i) => i % 4 === 3 ? p + 12 : p), [R, O, F5 + 12, O]][variant], eighth);
          break;
        default:
          out.push(mk(R, sp.s, len));
      }
    }
    return handLimit(dedupe(out), 4, 16, false);
  }

  // ------------------------------------------------------------------ ORCHESTRA
  const ENSEMBLES = {
    full: ['fl', 'ob', 'cl', 'bn', 'hn', 'tp', 'tb', 'tu', 'timp', 'perc', 'hp', 'v1', 'v2', 'va', 'vc', 'cb'],
    chamber: ['fl', 'ob', 'cl', 'bn', 'hn', 'v1', 'v2', 'va', 'vc', 'cb'],
    strings: ['v1', 'v2', 'va', 'vc', 'cb'],
    winds: ['fl', 'ob', 'cl', 'hn', 'bn'],
  };
  const PARTS = {
    fl: { inst: 'flute', name: 'Flute' }, ob: { inst: 'oboe', name: 'Oboe' }, cl: { inst: 'clarinet', name: 'Clarinet' }, bn: { inst: 'bassoon', name: 'Bassoon' },
    hn: { inst: 'horn', name: 'Horns' }, tp: { inst: 'trumpet', name: 'Trumpet' }, tb: { inst: 'trombone', name: 'Trombones' }, tu: { inst: 'tuba', name: 'Tuba' },
    timp: { inst: 'timpani', name: 'Timpani' }, perc: { inst: 'percussion', name: 'Percussion' }, hp: { inst: 'harp', name: 'Harp' }, gl: { inst: 'glockenspiel', name: 'Glockenspiel' },
    v1: { inst: 'violin', name: 'Violin I' }, v2: { inst: 'violin', name: 'Violin II' }, va: { inst: 'viola', name: 'Viola' }, vc: { inst: 'cello', name: 'Cello' }, cb: { inst: 'contrabass', name: 'Contrabass' },
  };
  const ORCH_STYLES = ['classical', 'romantic', 'cinematic', 'baroque', 'light', 'epic'];

  function orchPlan(L, st, P, parts) {
    const style = st.style; const has = id => parts.includes(id);
    const plan = {}; parts.forEach(id => plan[id] = new Array(L.nBars).fill('rest'));
    const solos = {
      classical: ['v1', 'ob', 'v1', 'fl'], romantic: ['v1', 'cl', 'hn', 'v1'], cinematic: ['v1', 'hn', 'v1', 'fl'],
      baroque: ['v1', 'ob', 'v1', 'fl'], light: ['fl', 'ob', 'cl', 'v1'], epic: ['hn', 'v1', 'hn', 'v1'],
    }[style] || ['v1', 'ob'];
    const rot = st.seed || 0;
    const winds = st.ensemble === 'winds';
    for (let b = 0; b < L.nBars; b++) {
      const lv = P.barLevel[b], ph = P.barPhrase[b].idx;
      const set = (id, role) => { if (has(id) && plan[id][b] === 'rest') plan[id][b] = role; };
      let soloList = solos.filter(has); if (!soloList.length) soloList = parts.filter(id => ['v1', 'fl', 'ob', 'cl', 'hn', 'v2', 'va'].includes(id));
      const lead = soloList[(ph + rot) % soloList.length] || parts[0];
      if (lv === 0) set(lead, 'mel');
      else if (lv === 1) { set(lead, 'mel'); if (lead !== 'v1') set('v1', 'mel'); else if (style !== 'classical') set(has('fl') ? 'fl' : 'ob', 'mel8va'); }
      else if (lv === 2) { set('v1', 'mel'); set('fl', 'mel8va'); set('ob', 'mel'); if (style === 'epic' || style === 'cinematic') set('hn', 'mel8vb'); else set('v2', 'mel8vb'); }
      else { set('v1', 'mel'); set('v2', 'mel8vb'); set('fl', 'mel8va'); set('ob', 'mel'); set('tp', 'mel'); if (style === 'epic') set('hn', 'mel8vb'); }
      if (!has('v1')) { const w = ['fl', 'ob', 'cl'].filter(has); set(w[(ph + rot) % Math.max(1, w.length)] || parts[0], 'mel'); }
      if (lv >= 1 && ['romantic', 'cinematic', 'classical'].includes(style)) {
        if (lv >= 2 && has('hn')) set('hn', 'counter');
        else if (has('vc') && has('cb') && style !== 'classical') set('vc', 'counter');
        else if (lv >= 2) set('cl', 'counter');
      }
      if (style === 'baroque') set('v2', 'counter');
      set('vc', 'bass'); set('cb', plan.vc && plan.vc[b] === 'counter' ? 'bass' : 'bass8vb');
      if (lv >= 2 || !has('vc')) set('bn', 'bass');
      if (lv >= 3) set('tu', 'bass8vb');
      set('v2', 'harmA'); set('va', 'harmT');
      if (lv >= 1) { if (style === 'classical' || style === 'light' || style === 'baroque') set('cl', 'harmA'); else set('hn', winds ? 'pad1' : 'pad2'); }
      if (lv >= 2) { set('cl', 'harmA'); set('hn', winds ? 'pad1' : 'pad2'); set('bn', 'harmT'); }
      if (lv >= 3) { set('tb', 'chord3'); set('tp', 'pad1'); }
      if (!has('v2') && !has('va')) { set('cl', 'harmA'); set('hn', winds ? 'pad1' : 'pad2'); set('bn', 'harmT'); }
      if (has('hp')) {
        if (style === 'baroque') { if (lv >= 1) set('hp', 'strum'); }
        else if (lv <= 1 && ['romantic', 'cinematic', 'light', 'classical'].includes(style)) set('hp', 'arp');
        else if (lv >= 2) set('hp', 'strum');
      }
      if (lv >= 2 && style !== 'baroque' && style !== 'light') set('timp', 'timp');
      if (style === 'baroque' && lv >= 3) set('timp', 'timp');
      if ((lv >= 3 && style !== 'baroque') || (style === 'epic' && lv >= 2) || (style === 'light' && lv >= 1)) set('perc', 'perc');
      if (has('gl') && lv >= 1) set('gl', 'mel8va');
    }
    return plan;
  }

  const TEX_VARIANTS = {
    classical: [['sustain', 'sustain', 'pulse8', 'pulse8'], ['sustain', 'pulse4', 'pulse4', 'pulse8']],
    romantic: [['sustain', 'sustain', 'sustain', 'pulse8'], ['sustain', 'sustain', 'pulse4', 'pulse8']],
    cinematic: [['sustain', 'ostinato', 'ostinato', 'ostinato'], ['sustain', 'sustain', 'ostinato', 'pulse8']],
    baroque: [['pulse4', 'pulse4', 'pulse4', 'pulse4'], ['pulse4', 'pulse4', 'pulse8', 'pulse8']],
    light: [['pizz', 'pizz', 'pizz', 'pizz'], ['pizz', 'pizz', 'pulse4', 'pizz']],
    epic: [['sustain', 'sustain', 'pulse8', 'pulse8'], ['sustain', 'ostinato', 'pulse8', 'pulse8']],
  };
  function texture(st, lv, role, id, instKey) {
    const style = st.style;
    if (role === 'harmA' || role === 'harmT') { const tv = TEX_VARIANTS[style] || TEX_VARIANTS.classical; const t = tv[variantOf(st, id, tv.length)][lv]; return t === 'pizz' && instKey && !['violin', 'viola', 'cello', 'contrabass', 'pizzicato', 'strings', 'harp'].includes(instKey) ? 'pulse4' : t; }
    if (role === 'bass' || role === 'bass8vb') {
      if (style === 'baroque') return 'walk';
      if (style === 'epic' && lv >= 2) return 'pulse8';
      if (style === 'light') return 'pizz';
      if (style === 'classical' && lv >= 2) return 'pulse4';
      if (style === 'cinematic' && lv >= 3) return 'pulse8';
      return 'sustain';
    }
    return 'sustain';
  }

  function skeleton(L, st, enr) {
    const spans = chordSpans(L, false);
    let pA = null, pH = null, pT = null;
    for (const sp of spans) {
      const ch = enrich(sp.chord, st.style, L, enr);
      sp.ch = ch;
      const pcs = pcsOf(ch);
      const m = lineAt(L.melody, sp.s, PPQ * 4);
      const top = m ? Math.max(62, Math.min(84, m.p)) : 76;
      const bassN = L.bass.find(n => n.s <= sp.s + 30 && n.s + n.d > sp.s);
      const present = [m ? m.p % 12 : -1, bassN ? bassN.p % 12 : ch.root];
      const at = voice(pcs, 2, 50, 77, pA, top, present, ch); pA = at;
      sp.alto = at[1] ?? at[0]; sp.tenor = at[0];
      sp.horns = voice(pcs, 2, 53, 70, pH, 72, present, ch); pH = sp.horns;
      sp.tbs = voice(pcs, 3, 45, 65, pT, 67, null, ch); pT = sp.tbs;
    }
    return spans;
  }

  function counterLine(L, spans, range, rnd) {
    const out = []; let prev = null;
    const scale = T.scalePcs(L.key);
    for (let i = 0; i < spans.length; i++) {
      const sp = spans[i]; const pcs = pcsOf(sp.ch || sp.chord);
      const m = lineAt(L.melody, sp.s, PPQ);
      let cands = tonesIn(pcs, range[0], range[1]);
      if (!cands.length) continue;
      const start = prev ?? (range[0] + range[1]) / 2;
      const mPrev = lineAt(L.melody, sp.s - 1, PPQ);
      cands = cands.map(p => ({ p, sc: Math.abs(p - start) + (m && (p % 12) === (m.p % 12) ? 4 : 0) + (prev != null && p === prev ? 1.5 : 0) - (m && prev != null && mPrev && Math.sign(p - prev) === -Math.sign(m.p - mPrev.p) ? 0.8 : 0) + rnd() * 0.6 }));
      cands.sort((a, b) => a.sc - b.sc);
      const p = cands[0].p;
      const len = sp.e - sp.s;
      if (prev != null && Math.abs(p - prev) >= 3 && Math.abs(p - prev) <= 4 && out.length) {
        const last = out[out.length - 1];
        const dir = Math.sign(p - prev); let q = prev + dir; while (!scale.includes(((q % 12) + 12) % 12)) q += dir;
        if (q !== p && last.d >= L.ts.beatTicks * 2) { const h = Math.round(last.d / 2 / 120) * 120; last.d = h; out.push(mk(q, last.s + h, sp.s - last.s - h, { cnt: 1 })); }
      }
      out.push(mk(p, sp.s, len, { cnt: 1 }));
      prev = p;
    }
    const merged = [];
    for (const n of out) { const l = merged[merged.length - 1]; if (l && l.p === n.p && l.s + l.d === n.s && n.d + l.d <= L.ts.barTicks * 2) l.d += n.d; else merged.push(n); }
    return merged;
  }

  // the chord third must sound somewhere: the first active harmony role takes it when nothing else does
  const HARM_ORDER = ['harmA', 'harmT', 'pad1', 'pad2', 'chord3'];
  function rolePitches(sp, role) {
    if (role === 'harmA') return [sp.alto]; if (role === 'harmT') return [sp.tenor];
    if (role === 'pad1') return [sp.horns[1] ?? sp.alto]; if (role === 'pad2') return [sp.horns[1] ?? sp.horns[0], sp.horns[0]];
    if (role === 'chord3') return sp.tbs || [];
    return [];
  }
  function thirdNeed(L, plan, sp, role) {
    const ch = sp.ch || sp.chord; if (!T.CHORDS[ch.type]) return null;
    const th = thirdOf(ch);
    let cov = 0; for (const n of L.melody) { if (n.s >= sp.e) break; if (n.p % 12 === th) cov += Math.max(0, Math.min(sp.e, n.s + n.d) - Math.max(sp.s, n.s)); }
    if (cov >= (sp.e - sp.s) * 0.6) return null;
    const active = new Set(); for (const k in plan) { const r = plan[k] && plan[k][sp.bar]; if (r) active.add(r); }
    for (const r of active) if (rolePitches(sp, r).some(p => p != null && p % 12 === th)) return null;
    const primary = HARM_ORDER.find(r => active.has(r));
    return role === primary ? th : null;
  }
  function withThird(L, plan, role, fn) {
    return sp => { const v = fn(sp); if (v == null) return v; const th = thirdNeed(L, plan, sp, role); if (th == null) return v; return nearestTone([th], v - 1, v - 8, v + 4) ?? v; };
  }

  function genPart(L, st, P, id, plan, skel, rnd, instKey) {
    const inst = T.INSTR[instKey];
    const range = inst.range;
    const bt = L.ts.barTicks, beat = L.ts.beatTicks, compound = L.ts.compound;
    const eighth = compound ? beat / 3 : beat / 2;
    const style = st.style, tier = tierOf(st.fidelity);
    const roles = plan[id] || [];
    const out = [];
    // segments of consecutive bars with the same role AND the same orchestration level
    const segs = [];
    for (let b = 0; b < L.nBars; b++) { const r = roles[b] || 'rest', lv = P.barLevel[b]; const l = segs[segs.length - 1]; if (l && l.role === r && l.lv === lv && l.b === b) l.b = b + 1; else segs.push({ role: r, lv, a: b, b: b + 1 }); }
    const inSeg = (t, sg) => t >= sg.a * bt && t < sg.b * bt;
    const writeTex = (pitchFn, sg, tex, extra) => {
      for (const sp of skel) {
        if (sp.e <= sg.a * bt || sp.s >= sg.b * bt) continue;
        const s = Math.max(sp.s, sg.a * bt), e = Math.min(sp.e, sg.b * bt);
        const p0 = pitchFn(sp); if (p0 == null) continue;
        const p = T.fitRange(p0, range);
        if (tex === 'sustain') out.push(mk(p, s, e - s));
        else if (tex === 'pulse8') for (let t = s; t < e; t += eighth) out.push(mk(p, t, Math.min(eighth, e - t) * 0.8));
        else if (tex === 'pulse4' || tex === 'walk') for (let t = s; t < e; t += beat) out.push(mk(p, t, Math.min(beat, e - t) * 0.88));
        else if (tex === 'pizz') for (let t = s; t < e; t += beat) { const ib = ((t % bt) / beat) | 0; if (extra === 'bass' ? ib % 2 === 0 || L.ts.beatsPerBar === 3 && ib === 0 : ib > 0 || L.ts.beatsPerBar === 2) out.push(mk(p, t, Math.min(beat * 0.35, e - t))); }
        else if (tex === 'ostinato') { const alt = nearestTone(pcsOf(sp.ch || sp.chord), p - 4, range[0], p - 1) ?? p; let k = 0; for (let t = s; t < e; t += eighth, k++) out.push(mk(k % 2 ? alt : p, t, Math.min(eighth, e - t) * 0.85)); }
      }
    };
    const polyOK = (inst.poly || 1) >= 2;
    for (const sg of segs) {
      const lv = sg.lv, r = sg.role;
      if (r === 'rest') continue;
      if (r === 'mel' || r === 'mel8va' || r === 'mel8vb') {
        const seg = L.melody.filter(n => inSeg(n.s, sg));
        const shift = r === 'mel8va' ? 12 : r === 'mel8vb' ? -12 : 0;
        let base = fitLine(seg, [60, 91]).map(n => ({ ...n, p: n.p + shift }));
        base = shift ? fitShifted(base, range) : fitLine(base, range, 0);
        base.forEach(n => out.push(mk(n.p, n.s, n.d, { mel: 1 })));
      } else if (r === 'counter') {
        const sk = skel.filter(sp => sp.s >= sg.a * bt && sp.s < sg.b * bt);
        const cr = instKey === 'cello' ? [43, 60] : instKey === 'horn' ? [53, 70] : instKey === 'bassoon' ? [43, 62] : [Math.max(range[0], 60), Math.min(range[1], 79)];
        counterLine(L, sk, [Math.max(range[0], cr[0]), Math.min(range[1], cr[1])], rnd).forEach(n => out.push(n));
      } else if (r === 'bass' || r === 'bass8vb') {
        const tex = texture(st, lv, r, id, instKey);
        const useOrig = (tier === 'literal' || tier === 'close' || tier === 'balanced') && tex === 'sustain';
        if (useOrig) {
          const seg = L.bass.filter(n => inSeg(n.s, sg));
          for (const n of seg) { let p = T.fitRange(n.p, [36, 55]); if (r === 'bass8vb') p -= 12; out.push(mk(T.fitRange(p, range), n.s, n.d)); }
          for (const sp of skel) { if (!inSeg(sp.s, sg)) continue; if (!seg.some(n => n.s < sp.e && n.s + n.d > sp.s)) { let p = T.fitRange(sp.chord.root + 36, [36, 52]); if (r === 'bass8vb') p -= 12; out.push(mk(T.fitRange(p, range), sp.s, sp.e - sp.s)); } }
        } else if (tex === 'walk') {
          // one shared walking line so cellos and basses double each other
          const walk = pianoLH(L, { ...st, style: 'baroque', fidelity: Math.max(36, Math.min(80, st.fidelity)) }, P, T.rng(T.hash('walk:' + (st.seed || 0))), { variant: 0 }).filter(n => inSeg(n.s, sg));
          walk.forEach(n => out.push(mk(T.fitRange(n.p - (r === 'bass8vb' ? 12 : 0), range), n.s, n.d)));
        } else {
          writeTex(sp => { const b = L.bass.find(n => n.s <= sp.s + 30 && n.s + n.d > sp.s); let p = T.fitRange(((tier === 'balanced' || tier === 'close') && b ? b.p : sp.chord.root + 36), [36, 52]); return r === 'bass8vb' ? p - 12 : p; }, sg, tex, 'bass');
        }
      } else if (r === 'harmA' || r === 'harmT') {
        const tex = texture(st, lv, r, id, instKey);
        if (tier === 'literal' || tier === 'close') {
          const band = r === 'harmA' ? [60, 79] : [48, 66];
          const orig = [];
          for (const n of L.notes) if (inSeg(n.s, sg) && n.r === '' && n.p >= band[0] && n.p <= band[1]) orig.push(mk(T.fitRange(n.p, range), n.s, n.d));
          out.push(...orig);
          // fill the gaps the transcription leaves with the voice-led harmony
          const before = out.length; writeTex(withThird(L, plan, r, sp => r === 'harmA' ? sp.alto : sp.tenor), sg, tex);
          const added = out.splice(before);
          for (const q of added) if (!orig.some(o => o.s < q.s + q.d && o.s + o.d > q.s)) out.push(q);
        } else writeTex(withThird(L, plan, r, sp => r === 'harmA' ? sp.alto : sp.tenor), sg, tex);
      } else if (r === 'pad1') {
        writeTex(withThird(L, plan, 'pad1', sp => sp.horns[1] ?? sp.alto), sg, style === 'epic' ? 'pulse4' : 'sustain');
      } else if (r === 'pad2') {
        writeTex(withThird(L, plan, 'pad2', sp => sp.horns[1] ?? sp.horns[0]), sg, 'sustain');
        if (polyOK) writeTex(sp => sp.horns.length > 1 ? sp.horns[0] : null, sg, 'sustain');
      } else if (r === 'chord3') {
        const n = Math.min(3, inst.poly || 1);
        for (let k = 3 - n; k < 3; k++) writeTex(sp => sp.tbs[k], sg, style === 'epic' ? 'pulse4' : 'sustain');
      } else if (r === 'arp' || r === 'strum') {
        for (const sp of skel) {
          if (!inSeg(sp.s, sg)) continue;
          const pcs = pcsOf(sp.ch || sp.chord);
          const lo = Math.max(range[0], 36), base = T.fitRange(sp.chord.root + 36, [lo, lo + 11]);
          const tones = tonesIn(pcs, base, Math.min(range[1], base + 26));
          if (!tones.length) continue;
          if (r === 'strum') { const n = Math.min(polyOK ? 5 : 1, tones.length); tones.slice(0, n).forEach(p => out.push(mk(p, sp.s, Math.min(beat * 2, sp.e - sp.s)))); continue; }
          const seq = tones.concat(tones.slice(1, -1).reverse());
          let k = 0; for (let t = sp.s; t < sp.e; t += eighth, k++) out.push(mk(seq[k % seq.length], t, Math.min(eighth, sp.e - t)));
        }
      } else if (r === 'timp') {
        const ton = T.fitRange(L.key.tonic + 36, [40, 52]), dom = T.fitRange(L.key.tonic + 43, [36, 50]);
        for (let b = sg.a; b < sg.b; b++) {
          const ch = chordAt(L, b * bt);
          const pc = ch.root; const p = pc === L.key.tonic ? ton : pc === (L.key.tonic + 7) % 12 ? dom : ((T.chordPcs(ch).includes(L.key.tonic)) ? ton : (T.chordPcs(ch).includes((L.key.tonic + 7) % 12) ? dom : null));
          const ph = P.barPhrase[b];
          if (p != null && (b === ph.a || lv >= 3 || b % 2 === 0)) out.push(mk(p, b * bt, beat * 0.9));
          if (lv >= 3 && b === ph.b - 1) { for (let t = b * bt + bt - beat * 2; t < (b + 1) * bt; t += beat / 4) out.push(mk(dom, t, beat / 4 * 0.9, { roll: 1 })); }
          if (style === 'epic' && p != null) out.push(mk(p, b * bt + beat * (L.ts.beatsPerBar >= 4 ? 2 : 1), beat * 0.8));
        }
      } else if (r === 'perc') {
        for (let b = sg.a; b < sg.b; b++) {
          const ph = P.barPhrase[b];
          if (style === 'light') { if (b === ph.a) out.push(mk(81, b * bt, beat)); continue; }
          if (b === ph.a) out.push(mk(49, b * bt, beat * 2));
          out.push(mk(36, b * bt, beat));
          if (style === 'epic' || style === 'cinematic') {
            for (let t = b * bt; t < (b + 1) * bt; t += eighth) { const ib = (t - b * bt) / eighth; if (ib % 2 === 1 || (lv >= 3 && ib % 4 === 3)) out.push(mk(38, t, eighth * 0.8)); }
            if (L.ts.beatsPerBar >= 4) out.push(mk(36, b * bt + beat * 2, beat));
          }
          if (lv >= 3 && b === ph.b - 1) for (let t = b * bt + bt - beat; t < (b + 1) * bt; t += beat / 4) out.push(mk(38, t, beat / 4 * 0.8));
        }
      }
    }
    // clip every note to the end of its own segment, then fold into the instrument's range
    const segEnd = new Array(L.nBars); for (const sg of segs) for (let b = sg.a; b < sg.b; b++) segEnd[b] = sg.b * bt;
    for (const n of out) { const b = Math.min(L.nBars - 1, Math.floor(n.s / bt)); n.d = Math.max(30, Math.min(n.d, segEnd[b] - n.s)); if (!inst.drums) n.p = T.fitRange(n.p, range); }
    let notes = dedupe(out);
    if ((inst.poly || 1) < 2) notes = monophonic(notes);
    articulate(notes.filter(n => n.mel || n.cnt), st.phrasing);
    if (style === 'light' && ['violin', 'viola', 'cello', 'contrabass', 'pizzicato'].includes(instKey)) notes.forEach(n => { if (!n.mel) n.d = Math.min(n.d, beat * 0.4); });
    return notes;
  }
  // a single wind/brass player: keep the most important note at each onset and stop it before the next
  function monophonic(notes) {
    const groups = new Map(); for (const n of notes) { if (!groups.has(n.s)) groups.set(n.s, []); groups.get(n.s).push(n); }
    const out = [...groups.values()].map(g => g.sort((a, b) => (b.mel ? 1 : 0) - (a.mel ? 1 : 0) || (b.cnt ? 1 : 0) - (a.cnt ? 1 : 0) || b.p - a.p)[0]).sort((a, b) => a.s - b.s);
    for (let i = 0; i < out.length - 1; i++) if (out[i].s + out[i].d > out[i + 1].s) out[i].d = Math.max(30, out[i + 1].s - out[i].s);
    return out;
  }

  const ROLE_OFFSET = { mel: 8, mel8va: 2, mel8vb: 0, counter: 0, bass: -2, bass8vb: -4, harmA: -10, harmT: -10, pad1: -10, pad2: -10, chord3: -6, arp: -12, strum: -6, timp: 0, perc: -6 };

  // ------------------------------------------------------------------ public API
  const COLORS = {
    rh: 'c-teal', lh: 'c-indigo', fl: 'c-green', ob: 'c-olive', cl: 'c-lime', bn: 'c-moss', hn: 'c-amber', tp: 'c-gold', tb: 'c-orange', tu: 'c-rust',
    timp: 'c-slate', perc: 'c-stone', hp: 'c-pink', gl: 'c-pink', v1: 'c-blue', v2: 'c-sky', va: 'c-violet', vc: 'c-plum', cb: 'c-navy',
  };
  function newTrack(id, name, inst, extra) { return { id, name, inst, notes: [], mute: false, solo: false, vol: 0.8, pan: 0, locked: false, edited: false, color: COLORS[id] || 'c-stone', ...extra }; }
  function defaultPan(id) { return { v1: -0.35, v2: -0.15, va: 0.15, vc: 0.3, cb: 0.4, fl: -0.2, ob: 0.1, cl: -0.1, bn: 0.2, hn: -0.3, tp: 0.2, tb: 0.35, tu: 0.4, timp: 0.05, perc: 0, hp: -0.45, gl: 0.25, rh: 0.1, lh: -0.1 }[id] || 0; }
  const partInst = (st, id) => (st.style === 'light' && ['v2', 'va', 'vc', 'cb'].includes(id)) ? 'pizzicato' : PARTS[id]?.inst;

  function context(an, st) {
    const L = buildLead(an, st), P = phrasePlan(L, st);
    const parts = ENSEMBLES[st.ensemble] || ENSEMBLES.full;
    return { L, P, parts, plan: st.mode === 'orchestra' ? orchPlan(L, st, P, parts) : null, skel: st.mode === 'orchestra' ? skeleton(L, st, ENRICH[tierOf(st.fidelity)]) : null };
  }

  function generate(an, st, id, ctx) {
    ctx = ctx || context(an, st);
    const { L, P } = ctx;
    const partSeed = (st.partSeeds && st.partSeeds[id]) || 0;
    const rnd = T.rng(T.hash(id + ':' + st.style + ':' + (st.seed || 0) + ':' + partSeed));
    let notes;
    if (st.mode === 'piano') {
      const lh = pianoLH(L, st, P, T.rng(T.hash('lh:' + st.style + ':' + (st.seed || 0) + ':' + ((st.partSeeds && st.partSeeds.lh) || 0))));
      if (id === 'rh') { notes = pianoRH(L, st, P, rnd, lh); applyVel(notes, P, L, 6, st, rnd); }
      else { notes = lh; applyVel(notes, P, L, -8, st, rnd); }
      articulate(id === 'rh' ? notes.filter(n => n.mel) : notes, st.phrasing);
      return notes;
    }
    const instKey = ctx.instKey || partInst(st, id) || 'violin';
    notes = genPart(L, st, P, id, ctx.plan, ctx.skel, rnd, instKey);
    const bt = L.ts.barTicks;
    for (const n of notes) { const bar = Math.max(0, Math.min(L.nBars - 1, Math.floor(n.s / bt))); n._off = ROLE_OFFSET[ctx.plan[id]?.[bar] || 'harmA'] ?? 0; }
    const groups = {}; notes.forEach(n => { (groups[n._off] = groups[n._off] || []).push(n); });
    for (const off in groups) applyVel(groups[off], P, L, +off, st, rnd);
    return notes;
  }

  function build(an, st) {
    const ctx = context(an, st);
    const tracks = [];
    if (st.mode === 'piano') {
      tracks.push(newTrack('rh', 'Piano · right hand', 'piano', { staff: 'rh', pan: 0.1, vol: 0.85 }));
      tracks.push(newTrack('lh', 'Piano · left hand', 'piano', { staff: 'lh', pan: -0.1, vol: 0.8 }));
      for (const t of tracks) t.notes = clean(generate(an, st, t.id, ctx));
    } else {
      for (const id of ctx.parts) {
        const instKey = partInst(st, id);
        const t = newTrack(id, PARTS[id].name + (instKey === 'pizzicato' ? ' (pizz.)' : ''), instKey, { pan: defaultPan(id), vol: id === 'perc' ? 0.6 : id === 'timp' ? 0.7 : 0.8 });
        t.notes = clean(generate(an, st, id, { ...ctx, instKey }));
        tracks.push(t);
      }
    }
    return { L: ctx.L, P: ctx.P, tracks };
  }
  function clean(notes) { return notes.filter(n => n.d > 0 && n.s >= 0).map(n => ({ id: n.id || nid(), p: Math.max(0, Math.min(127, n.p)), s: n.s, d: n.d, v: n.v || 80 })); }

  const ROLES = ['mel', 'mel8va', 'mel8vb', 'counter', 'harmA', 'harmT', 'pad1', 'pad2', 'chord3', 'arp', 'strum', 'bass', 'bass8vb', 'timp', 'perc', 'rest'];
  function rolesFor(instKey) {
    const inst = T.INSTR[instKey]; if (!inst) return [];
    if (inst.drums) return ['perc', 'rest'];
    const r = ROLES.filter(x => x !== 'perc');
    return instKey === 'timpani' ? ['timp', 'bass', 'rest'] : r.filter(x => x !== 'timp' || instKey === 'timpani');
  }
  function generateRole(an, st, role, instKey, opts = {}) {
    const inst = T.INSTR[instKey];
    if (inst.drums) role = 'perc'; else if (role === 'perc') role = 'harmA';
    const L = buildLead(an, st), P = phrasePlan(L, st);
    const rnd = T.rng(T.hash(role + instKey + (opts.seed || 0)));
    const plan = { x: new Array(L.nBars).fill(role) };
    if (opts.fromBar != null) for (let b = 0; b < L.nBars; b++) if (b < opts.fromBar || b > opts.toBar) plan.x[b] = 'rest';
    const skel = skeleton(L, st, ENRICH[tierOf(st.fidelity)]);
    const notes = genPart(L, { ...st, style: opts.style || st.style }, P, 'x', plan, skel, rnd, instKey);
    applyVel(notes, P, L, ROLE_OFFSET[role] ?? 0, st, rnd);
    const a = opts.fromBar != null ? opts.fromBar * L.ts.barTicks : 0, b = opts.toBar != null ? (opts.toBar + 1) * L.ts.barTicks : L.totalTicks;
    return clean(notes.filter(n => n.s >= a && n.s < b).map(n => ({ ...n, d: Math.min(n.d, b - n.s) })));
  }

  function transposeNotes(notes, fromKey, toKey, range) {
    return notes.map(n => ({ ...n, p: range ? T.fitRange(T.mapPitch(n.p, fromKey, toKey), range) : T.mapPitch(n.p, fromKey, toKey) }));
  }
  // locked parts across a meter change: tick -> analysed beat (exact inverse) -> new tick.
  // Notes remember where they came from, so going back to an earlier meter is lossless.
  function remapMeter(notes, an, oldSt, newSt) {
    const Lo = buildLead(an, oldSt), Ln = buildLead(an, newSt);
    return (notes.map(n => {
      let b0, b1;
      if (n.ob != null && n.ms === n.s && n.md === n.d) { b0 = n.ob; b1 = n.ob + n.od; }
      else { b0 = Lo.Winv(n.s); b1 = Lo.Winv(n.s + n.d); }
      const s = Ln.W(b0), e = Ln.W(b1);
      const d = e - s >= 30 ? e - s : Ln.minD;
      return { ...n, s, d, ob: b0, od: b1 - b0, ms: s, md: d };
    })).sort((a, b) => a.s - b.s || a.p - b.p);
  }

  window.Arranger = { build, generate, generateRole, context, buildLead, phrasePlan, chordAt, chordSpans, transposeNotes, remapMeter, newTrack, defaultPan, clean, nid, partInst, rolesFor, tierOf, PARTS, ENSEMBLES, PIANO_STYLES, ORCH_STYLES, COLORS, ROLES };
})();
