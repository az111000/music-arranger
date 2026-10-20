/* Notation & export: ABC (rendered with abcjs), MusicXML, Standard MIDI File, ZIP packaging.  Global: Notation */
(function () {
  const PPQ = T.PPQ, U = 120; // sixteenth note
  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  // ---------- spelling
  function keySpelling(key) {
    const flats = T.flatKey(key.tonic, key.mode);
    const majTonic = key.mode === 'minor' ? (key.tonic + 3) % 12 : key.tonic;
    const tonicName = T.pcName(majTonic, flats);
    const li = LETTERS.indexOf(tonicName[0]);
    const sig = {};
    T.MAJOR.forEach((iv, k) => {
      const pc = (majTonic + iv) % 12, L = LETTERS[(li + k) % 7];
      let alt = pc - LETTER_PC[L]; if (alt > 6) alt -= 12; if (alt < -6) alt += 12;
      sig[L] = alt;
    });
    const map = {};
    for (const L of LETTERS) map[(LETTER_PC[L] + sig[L] + 12) % 12] = [L, sig[L]];
    for (let pc = 0; pc < 12; pc++) {
      if (map[pc]) continue;
      if (key.mode === 'minor' && pc === (key.tonic + 11) % 12) { const sevL = map[(key.tonic + 10) % 12]; if (sevL) { map[pc] = [sevL[0], sevL[1] + 1]; continue; } }
      const nat = LETTERS.find(L => LETTER_PC[L] === pc);
      if (nat) { map[pc] = [nat, 0]; continue; } // a chromatic natural keeps its own letter (F natural, not E#)
      if (flats) { const up = LETTERS.find(L => LETTER_PC[L] === (pc + 1) % 12); map[pc] = [up, -1]; }
      else { const dn = LETTERS.find(L => LETTER_PC[L] === (pc + 11) % 12); map[pc] = [dn, 1]; }
    }
    const fifths = Object.values(sig).reduce((s, a) => s + a, 0);
    return { sig, map, fifths };
  }
  function spell(p, ks) { const [L, alt] = ks.map[((p % 12) + 12) % 12]; const oct = Math.floor((p - alt) / 12) - 1; return { L, alt, oct }; }

  // ---------- measure slicing shared by ABC and MusicXML
  // events: { dur (sixteenths), slots (triplet eighths, if in a triplet group), tup: 'start'|'stop'|'mid'|null, pitches:[{p,tie,stop}] | null }
  const NOTATABLE = [16, 12, 8, 6, 4, 3, 2, 1];
  function splitDur(pos, len, ts) {
    const out = []; const beatU = ts.beatTicks / U; const barU = ts.barTicks / U;
    while (len > 0) {
      let max = len;
      if (pos % beatU !== 0) max = Math.min(max, beatU - (pos % beatU));
      else if (ts.num === 4 && ts.den === 4 && pos !== 0 && pos < 8 && pos + max > 8) max = 8 - pos;
      if (pos + max > barU) max = barU - pos;
      const d = NOTATABLE.find(x => x <= max) || 1;
      out.push(d); pos += d; len -= d;
    }
    return out;
  }
  function measureEvents(notes, bar, ts, writtenShift = 0, opts = {}) {
    const a0 = bar * ts.barTicks, a1 = a0 + ts.barTicks;
    const tripletOK = !ts.compound && ts.den === 4;
    const beat = ts.beatTicks;
    // decide per beat whether it is a triplet beat
    const trip = new Set();
    if (tripletOK) {
      const pts = [];
      for (const n of notes) { if (n.s < a0 || n.s >= a1) continue; pts.push(n.s); } // onsets only: articulation shortens note ends
      for (let k = 0; k < ts.beatsPerBar; k++) {
        const b0 = a0 + k * beat; let t3 = 0, t4 = 0;
        for (const t of pts) { if (t <= b0 || t >= b0 + beat) continue; const r = t - b0; if (Math.abs(r - 160) <= 10 || Math.abs(r - 320) <= 10) t3++; else if (r % 120 === 0) t4++; }
        if (t3 > 0 && t3 >= t4) trip.add(k);
      }
    }
    const q = t => { if (t <= a0) return a0; if (t >= a1) return a1; const k = Math.min(ts.beatsPerBar - 1, Math.floor((t - a0) / beat)); const g = trip.has(k) ? 160 : U; const b0 = a0 + k * beat; return Math.min(a1, b0 + Math.round((t - b0) / g) * g); };
    const act = [];
    for (const n of notes) {
      if (n.s + n.d <= a0 - 1 || n.s >= a1) continue;
      const s = n.s < a0 ? a0 : q(n.s), e0 = n.s + n.d >= a1 ? a1 : q(n.s + n.d);
      const e = Math.max(e0, s + (trip.has(Math.floor((s - a0) / beat)) ? 160 : U));
      act.push({ p: n.p + writtenShift, s, e: Math.min(e, a1), cont: n.s + n.d > a1 + 1 && !opts.lastBar, v: n.v });
    }
    const cuts = new Set([a0, a1]); for (let k = 1; k < ts.beatsPerBar; k++) if (trip.has(k) || trip.has(k - 1)) cuts.add(a0 + k * beat);
    act.forEach(n => { cuts.add(n.s); cuts.add(n.e); });
    const pts = [...cuts].filter(t => t >= a0 && t <= a1).sort((x, y) => x - y);
    const raw = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const s = pts[i], e = pts[i + 1];
      const snd = act.filter(n => n.s <= s && n.e > s);
      const ps = [...new Map(snd.map(n => [n.p, n])).values()].sort((x, y) => x.p - y.p);
      raw.push({ s, e, pitches: ps.length ? ps.map(n => ({ p: n.p, tie: n.e > e || (n.e === e && n.cont), v: n.v })) : null });
    }
    const merged = [];
    for (const r of raw) { const l = merged[merged.length - 1]; if (l && !l.pitches && !r.pitches && !trip.has(Math.floor((r.s - a0) / beat)) && !trip.has(Math.floor((l.s - a0) / beat))) l.e = r.e; else merged.push(r); }
    const out = [];
    for (const r of merged) {
      const k = Math.floor((r.s - a0) / beat);
      if (trip.has(k)) {
        const slots = Math.max(1, Math.round((r.e - r.s) / 160));
        out.push({ s: r.s, beat: k, dur: slots * 4 / 3, slots, pitches: r.pitches, triplet: true });
        continue;
      }
      const parts = splitDur((r.s - a0) / U, Math.round((r.e - r.s) / U), ts);
      let s = r.s;
      parts.forEach((d, j) => {
        const last = j === parts.length - 1;
        out.push({ s, beat: k, dur: d, pitches: r.pitches ? r.pitches.map(x => ({ p: x.p, tie: last ? x.tie : true, v: x.v })) : null });
        s += d * U;
      });
    }
    // a whole triplet beat with a single event is just a quarter note
    const byBeat = new Map(); out.forEach(e => { if (e.triplet) { if (!byBeat.has(e.beat)) byBeat.set(e.beat, []); byBeat.get(e.beat).push(e); } });
    for (const [, g] of byBeat) {
      if (g.length === 1 && g[0].slots === 3) { g[0].triplet = false; g[0].dur = 4; continue; }
      g.forEach((e, i) => { e.tup = g.length === 1 ? 'single' : i === 0 ? 'start' : i === g.length - 1 ? 'stop' : 'mid'; e.tupCount = g.length; });
    }
    return out;
  }
  // tie-stop flags across bars for one staff
  function withStops(evsByBar) {
    let open = new Set();
    for (const evs of evsByBar) for (const e of evs) {
      if (e.pitches) { for (const p of e.pitches) p.stop = open.has(p.p); open = new Set(e.pitches.filter(p => p.tie).map(p => p.p)); }
      else open = new Set();
    }
    return evsByBar;
  }
  function dynMark(v) { return v < 44 ? 'pp' : v < 57 ? 'p' : v < 70 ? 'mp' : v < 85 ? 'mf' : v < 101 ? 'f' : 'ff'; }
  function tempoWord(bpm) { return bpm < 60 ? 'Largo' : bpm < 76 ? 'Adagio' : bpm < 108 ? 'Andante' : bpm < 120 ? 'Moderato' : bpm < 156 ? 'Allegro' : bpm < 176 ? 'Vivace' : 'Presto'; }
  const beatTempo = (st, ts) => ts.compound ? st.tempo / 1.5 : (ts.den === 8 ? st.tempo * 2 : st.tempo);

  // dynamics per staff by phrase: one mark where the level changes
  function phraseDynamics(notes, phrases, ts, nBars) {
    const marks = {};
    let last = null;
    for (const ph of (phrases && phrases.length ? phrases : [{ a: 0, b: nBars }])) {
      const ns = notes.filter(n => n.s >= ph.a * ts.barTicks && n.s < ph.b * ts.barTicks);
      if (!ns.length) continue;
      const dm = dynMark(ns.reduce((s, n) => s + n.v, 0) / ns.length);
      if (dm !== last) { const first = Math.floor(Math.min(...ns.map(n => n.s)) / ts.barTicks); marks[first] = dm; last = dm; }
    }
    return marks;
  }

  // ---------- staves (one per track, harp split onto a grand staff)
  const SHORT = { 'Violin I': 'Vln. I', 'Violin II': 'Vln. II', Viola: 'Vla.', Cello: 'Vc.', Contrabass: 'Cb.', Flute: 'Fl.', Oboe: 'Ob.', Clarinet: 'Cl.', Bassoon: 'Bsn.', Horns: 'Hn.', Horn: 'Hn.', Trumpet: 'Tpt.', Trombones: 'Tbn.', Trombone: 'Tbn.', Tuba: 'Tba.', Timpani: 'Timp.', Percussion: 'Perc.', Harp: 'Hp.', Glockenspiel: 'Glk.', Piano: 'Pno.' };
  function clefFor(t, inst, notes) {
    if (t.staff === 'rh') return 'treble'; if (t.staff === 'lh') return 'bass';
    if (inst.drums) return 'perc';
    if (t.id === 'va' || t.inst === 'viola') return 'alto';
    if (['cello', 'contrabass', 'bassoon', 'trombone', 'tuba', 'timpani'].includes(t.inst)) return 'bass';
    if (!notes.length) return inst.clef === 'alto' ? 'alto' : inst.clef || 'treble';
    const ps = notes.map(n => n.p).sort((a, b) => a - b); const med = ps[ps.length >> 1];
    if (['pizzicato', 'strings'].includes(t.inst)) return med >= 60 ? 'treble' : med >= 50 ? 'alto' : 'bass';
    if (med < 55 && !inst.writtenOctave) return 'bass';
    return 'treble';
  }
  function staves(project) {
    const out = [];
    const pianoMode = project.st.mode === 'piano';
    for (const t of project.tracks) {
      if (t.hidden) continue;
      const inst = T.INSTR[t.inst] || T.INSTR.piano;
      const base = { track: t, name: t.name.replace(/"/g, ''), shift: inst.writtenOctave || 0, drums: !!inst.drums, family: inst.family, inst: t.inst };
      const sname = SHORT[t.name.replace(/ \(pizz\.\)/, '')] || (t.name.length > 6 ? t.name.slice(0, 5) + '.' : t.name);
      const sid = t.id.replace(/[^a-zA-Z0-9]/g, '') || 'v';
      if (pianoMode && (t.id === 'rh' || t.id === 'lh')) { out.push({ ...base, notes: t.notes, id: sid, clef: clefFor(t, inst, t.notes), part: 'piano', group: 'brace', sname: '' }); continue; }
      if ((t.inst === 'harp' || t.inst === 'piano') && t.notes.length && t.notes.some(n => n.p >= 60) && t.notes.some(n => n.p < 57)) {
        const up = t.notes.filter(n => n.p >= 60), lo = t.notes.filter(n => n.p < 60);
        out.push({ ...base, notes: up, id: sid + 'a', clef: 'treble', part: t.id, group: 'brace', sname });
        out.push({ ...base, notes: lo, id: sid + 'b', clef: 'bass', part: t.id, group: 'brace', sname, second: true });
        continue;
      }
      out.push({ ...base, notes: t.notes, id: sid, clef: clefFor(t, inst, t.notes), part: t.id, group: null, sname });
    }
    return out;
  }

  // ---------- ABC
  function abcPitch(p, ks, state) {
    const { L, alt, oct } = spell(p, ks);
    const k = L + oct;
    const cur = state[k] ?? ks.sig[L];
    let acc = '';
    if (cur !== alt) { acc = alt === 0 ? '=' : alt === 1 ? '^' : alt === -1 ? '_' : alt === 2 ? '^^' : '__'; state[k] = alt; }
    let s = oct >= 5 ? L.toLowerCase() : L;
    if (oct >= 6) s += "'".repeat(oct - 5); else if (oct <= 3) s += ','.repeat(4 - oct);
    return acc + s;
  }
  const DRUM_ABC = { 35: 'F', 36: 'F', 38: 'c', 40: 'c', 42: 'g', 46: 'g', 49: 'a', 57: 'a', 51: 'f', 59: 'f', 81: 'e', 80: 'e' };
  function abcKey(key) { const ks = keySpelling(key); const [L, a] = ks.map[key.tonic]; return L + (a === 1 ? '#' : a === -1 ? 'b' : '') + (key.mode === 'minor' ? 'm' : ''); }
  const fmtDur = d => (d === 1 ? '' : String(d));

  function toABC(project, opts = {}) {
    const { L: lead, st } = project;
    const ts = lead.ts, ks = keySpelling(lead.key);
    let sv = staves(project);
    if (opts.only) sv = sv.filter(s => opts.only.includes(s.track.id));
    const barFrom = Math.max(0, opts.fromBar || 0), barTo = Math.min(lead.nBars, opts.toBar ?? lead.nBars);
    const mpl = opts.measuresPerLine || 4;
    const L = [];
    L.push('X:1');
    L.push('T:' + (project.title || 'Arrangement').replace(/\n/g, ' '));
    if (opts.subtitle) L.push('T:' + opts.subtitle);
    L.push('C:' + (opts.composerLine || 'Arranged in Partitura Studio'));
    L.push('M:' + ts.num + '/' + ts.den);
    L.push('L:1/16');
    const qUnit = ts.compound ? '3/8' : (ts.den === 8 ? '1/8' : '1/4');
    if (barFrom === 0) L.push('Q:"' + tempoWord(beatTempo(st, ts)) + (st.swing ? ' (swing)' : '') + '" ' + qUnit + '=' + Math.round(beatTempo(st, ts)));
    L.push('%%partsbox 1');
    L.push('%%barnumbers 1');
    if (sv.length > 1) {
      const items = []; let i = 0;
      while (i < sv.length) {
        const s = sv[i];
        if (s.group === 'brace') { const g = []; while (i < sv.length && sv[i].group === 'brace' && sv[i].part === s.part) g.push(sv[i++].id); items.push({ fam: s.family, str: '{' + g.join(' | ') + '}' }); continue; }
        items.push({ fam: s.family, str: s.id }); i++;
      }
      const groups = []; let cur = null;
      for (const it of items) { if (!cur || cur.f !== it.fam) { cur = { f: it.fam, ids: [] }; groups.push(cur); } cur.ids.push(it.str); }
      L.push('%%score ' + groups.map(g => (g.f === 'percussion' || g.f === 'keys' || g.ids.length === 1) ? g.ids.join(' ') : '[' + g.ids.join(' ') + ']').join(' '));
    }
    L.push('K:' + abcKey(lead.key));
    const pianoMode = project.st.mode === 'piano';
    for (const s of sv) {
      const nm = s.second ? '' : (pianoMode && s.part === 'piano' ? (s.id === sv.find(x => x.part === 'piano')?.id ? 'Piano' : '') : s.name);
      const snm = s.second ? '' : (pianoMode && s.part === 'piano' ? '' : s.sname);
      L.push('V:' + s.id + ' clef=' + (s.drums ? 'perc stafflines=1' : s.clef) + ' name="' + nm + '" snm="' + snm + '"');
    }
    const chordsOn = opts.chords !== false;
    const flats = T.flatKey(lead.key.tonic, lead.key.mode);
    const rehearsal = {}; (project.P?.phrases || []).forEach(p => { if ((project.P.phrases.length > 1)) rehearsal[p.a] = p.letter || String.fromCharCode(65 + p.idx); });
    const dyn = new Map(sv.map(s => [s.id, s.drums ? {} : phraseDynamics(s.notes, project.P?.phrases, ts, lead.nBars)]));
    const evCache = new Map(sv.map(s => [s.id, []]));
    for (let l0 = barFrom; l0 < barTo; l0 += mpl) {
      sv.forEach((s, si) => {
        let line = '[V:' + s.id + '] ';
        if (s.drums && l0 === barFrom) line += '[K:none clef=perc] ';
        for (let b = l0; b < Math.min(barTo, l0 + mpl); b++) {
          const state = {};
          const evs = measureEvents(s.notes, b, ts, s.shift, { lastBar: b === lead.nBars - 1 });
          let first = true, prevBeat = -1, inTup = false;
          if (si === 0 && rehearsal[b]) line += '[P:' + rehearsal[b] + '] ';
          for (const e of evs) {
            let pre = '';
            if (e.beat !== prevBeat && prevBeat >= 0 && !inTup) line += ' ';
            prevBeat = e.beat;
            if (first && dyn.get(s.id)[b] && e.pitches) { pre += '!' + dyn.get(s.id)[b] + '!'; }
            if (chordsOn && si === 0) {
              const ch = lead.chords.find(c => c.s === e.s && c.type !== 'N');
              if (ch) pre += '"' + T.chordName(ch, flats).replace('#', '♯').replace(/^([A-G])b/, '$1♭') + '"';
            }
            if (e.triplet && (e.tup === 'start' || e.tup === 'single')) { line += '(3:2:' + e.tupCount + ' '; inTup = true; }
            const d = e.triplet ? 2 * e.slots : e.dur;
            if (!e.pitches) line += pre + 'z' + fmtDur(d);
            else {
              const ps = s.drums ? [...new Set(e.pitches.map(x => DRUM_ABC[x.p] || 'c'))].map(x => ({ str: x, tie: false })) : e.pitches.map(x => ({ str: abcPitch(x.p, ks, state), tie: x.tie }));
              if (ps.length > 1) line += pre + '[' + ps.map(x => x.str + (x.tie ? '-' : '')).join('') + ']' + fmtDur(d);
              else line += pre + ps[0].str + fmtDur(d) + (ps[0].tie ? '-' : ''); // a tie on a single note follows its length
            }
            if (!e.triplet && e.dur >= 4) line += ' ';
            if (e.triplet && (e.tup === 'stop' || e.tup === 'single')) { inTup = false; line += ' '; }
            first = false;
          }
          line += (b === lead.nBars - 1 ? ' |]' : ' |') + ' ';
        }
        L.push(line.replace(/ {2,}/g, ' '));
      });
    }
    return L.join('\n');
  }

  // ---------- MusicXML
  const DIV = 12; // divisions per quarter: sixteenth = 3, triplet eighth = 4
  const TYPE = { 16: ['whole', 0], 12: ['half', 1], 8: ['half', 0], 6: ['quarter', 1], 4: ['quarter', 0], 3: ['eighth', 1], 2: ['eighth', 0], 1: ['16th', 0] };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const TRANSPOSING = { clarinet: { chromatic: -2, diatonic: -1, name: 'in B♭' }, trumpet: { chromatic: -2, diatonic: -1, name: 'in B♭' }, horn: { chromatic: -7, diatonic: -4, name: 'in F' } };
  const KIND = { maj: 'major', min: 'minor', dom7: 'dominant', maj7: 'major-seventh', min7: 'minor-seventh', dim: 'diminished', hdim7: 'half-diminished', aug: 'augmented', sus4: 'suspended-fourth' };
  function toMusicXML(project, opts = {}) {
    const { L: lead, st } = project; const ts = lead.ts;
    const sv = staves(project);
    const concertKS = keySpelling(lead.key);
    const parts = [];
    for (const s of sv) { let p = parts.find(x => x.key === s.part); if (!p) { p = { key: s.part, staves: [], name: s.part === 'piano' ? 'Piano' : s.name, inst: s.inst, drums: s.drums }; parts.push(p); } p.staves.push(s); }
    // MIDI channels by program (percussion on channel 10)
    const progCh = new Map(); let nextCh = 1;
    parts.forEach((p, i) => {
      p.id = 'P' + (i + 1);
      p.program = (T.INSTR[p.inst]?.gm ?? 0) + 1;
      if (p.drums) p.channel = 10;
      else { if (!progCh.has(p.program)) { progCh.set(p.program, nextCh); nextCh = nextCh === 9 ? 11 : nextCh + 1; if (nextCh > 16) nextCh = 1; } p.channel = progCh.get(p.program); }
      p.tr = opts.concert ? null : TRANSPOSING[p.inst] || null;
    });
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="3.1">\n';
    x += '<work><work-title>' + esc(project.title || 'Arrangement') + '</work-title></work>\n<identification><creator type="arranger">Partitura Studio</creator><encoding><software>Partitura Studio</software></encoding></identification>\n<part-list>\n';
    let famOpen = null;
    const famOf = p => p.key === 'piano' ? 'keys' : T.INSTR[p.inst]?.family;
    parts.forEach((p, i) => {
      const f = famOf(p);
      if (famOpen && famOpen !== f) { x += `<part-group type="stop" number="1"/>\n`; famOpen = null; }
      const sameNext = parts.filter(q => famOf(q) === f).length > 1 && f !== 'keys' && f !== 'percussion';
      if (!famOpen && sameNext) { x += `<part-group type="start" number="1"><group-symbol>bracket</group-symbol><group-barline>yes</group-barline></part-group>\n`; famOpen = f; }
      x += `<score-part id="${p.id}"><part-name>${esc(p.name)}${p.tr ? ' ' + esc(p.tr.name) : ''}</part-name><part-abbreviation>${esc(p.staves[0].sname || '')}</part-abbreviation><score-instrument id="${p.id}-I1"><instrument-name>${esc(p.name)}</instrument-name></score-instrument><midi-instrument id="${p.id}-I1"><midi-channel>${p.channel}</midi-channel><midi-program>${p.program}</midi-program></midi-instrument></score-part>\n`;
    });
    if (famOpen) x += `<part-group type="stop" number="1"/>\n`;
    x += '</part-list>\n';
    const clefXML = (c, n) => { const m = { treble: ['G', 2], bass: ['F', 4], alto: ['C', 3], perc: ['percussion', null] }[c] || ['G', 2]; return `<clef${n ? ` number="${n}"` : ''}><sign>${m[0]}</sign>${m[1] ? `<line>${m[1]}</line>` : ''}</clef>`; };
    const rehearsal = {}; (project.P?.phrases || []).forEach(p => { if ((project.P.phrases.length > 1)) rehearsal[p.a] = p.letter || String.fromCharCode(65 + p.idx); });
    const flats = T.flatKey(lead.key.tonic, lead.key.mode);
    parts.forEach((part, pi) => {
      const tr = part.tr;
      const wKey = tr ? { tonic: ((lead.key.tonic - tr.chromatic) % 12 + 12) % 12, mode: lead.key.mode } : lead.key;
      const ks = keySpelling(wKey);
      const written = tr ? -tr.chromatic : 0;
      x += `<part id="${part.id}">\n`;
      const evsBy = part.staves.map(s => withStops(Array.from({ length: lead.nBars }, (_, b) => measureEvents(s.notes, b, ts, s.shift + written, { lastBar: b === lead.nBars - 1 }))));
      const dyn = part.staves.map(s => s.drums ? {} : phraseDynamics(s.notes, project.P?.phrases, ts, lead.nBars));
      for (let b = 0; b < lead.nBars; b++) {
        x += `<measure number="${b + 1}">`;
        if (b === 0) {
          x += `<attributes><divisions>${DIV}</divisions>${part.drums ? '<key><fifths>0</fifths></key>' : `<key><fifths>${ks.fifths}</fifths><mode>${lead.key.mode}</mode></key>`}<time><beats>${ts.num}</beats><beat-type>${ts.den}</beat-type></time>`;
          if (part.staves.length > 1) x += `<staves>${part.staves.length}</staves>`;
          part.staves.forEach((s, k) => { x += clefXML(s.drums ? 'perc' : s.clef, part.staves.length > 1 ? k + 1 : 0); });
          const sh = part.staves[0].shift;
          if (tr || sh) x += `<transpose><diatonic>${tr ? tr.diatonic : 0}</diatonic><chromatic>${tr ? tr.chromatic : 0}</chromatic>${sh ? `<octave-change>${-sh / 12}</octave-change>` : ''}</transpose>`;
          x += '</attributes>';
          if (pi === 0) x += `<direction placement="above"><direction-type><words font-weight="bold">${tempoWord(beatTempo(st, ts))}${st.swing ? ' (swing)' : ''}</words></direction-type><sound tempo="${Math.round(st.tempo)}"/></direction>`;
        }
        if (pi === 0 && rehearsal[b]) x += `<direction placement="above"><direction-type><rehearsal enclosure="square">${rehearsal[b]}</rehearsal></direction-type></direction>`;
        part.staves.forEach((s, k) => {
          if (k > 0) x += `<backup><duration>${ts.barTicks / PPQ * DIV}</duration></backup>`;
          const evs = evsBy[k][b];
          if (dyn[k][b]) x += `<direction placement="below"><direction-type><dynamics><${dyn[k][b]}/></dynamics></direction-type>${part.staves.length > 1 ? `<staff>${k + 1}</staff>` : ''}</direction>`;
          const staffTag = part.staves.length > 1 ? `<staff>${k + 1}</staff>` : '';
          const voiceN = k === 0 ? 1 : 5;
          const whole = evs.length === 1 && !evs[0].pitches;
          for (const e of evs) {
            if (pi === 0 && k === 0) {
              const ch = lead.chords.find(c => c.s === e.s && c.type !== 'N');
              if (ch) { const rs = spell(ch.root + 60, concertKS); x += `<harmony><root><root-step>${rs.L}</root-step>${rs.alt ? `<root-alter>${rs.alt}</root-alter>` : ''}</root><kind text="${esc(T.CHORDS[ch.type].sym)}">${KIND[ch.type] || 'major'}</kind></harmony>`; }
            }
            const dur = e.triplet ? e.slots * 4 : e.dur * 3;
            const [type, dot] = e.triplet ? (e.slots === 2 ? ['quarter', 0] : ['eighth', 0]) : (TYPE[e.dur] || ['16th', 0]);
            const tm = e.triplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : '';
            const tupN = e.triplet && (e.tup === 'start' || e.tup === 'single') ? '<tuplet type="start" bracket="yes"/>' : '';
            const tupE = e.triplet && (e.tup === 'stop' || e.tup === 'single') ? '<tuplet type="stop"/>' : '';
            if (!e.pitches) { x += `<note><rest${whole ? ' measure="yes"' : ''}/><duration>${dur}</duration><voice>${voiceN}</voice>${whole ? '' : `<type>${type}</type>${dot ? '<dot/>' : ''}`}${tm}${staffTag}${tupN || tupE ? `<notations>${tupN}${tupE}</notations>` : ''}</note>`; continue; }
            e.pitches.forEach((pp, i) => {
              let pitchXML;
              if (s.drums) pitchXML = `<unpitched><display-step>${pp.p === 36 || pp.p === 35 ? 'F' : pp.p === 38 ? 'C' : 'G'}</display-step><display-octave>${pp.p === 36 || pp.p === 35 ? 4 : 5}</display-octave></unpitched>`;
              else { const sp = spell(pp.p, ks); pitchXML = `<pitch><step>${sp.L}</step>${sp.alt ? `<alter>${sp.alt}</alter>` : ''}<octave>${sp.oct}</octave></pitch>`; }
              const ties = (pp.stop ? '<tie type="stop"/>' : '') + (pp.tie ? '<tie type="start"/>' : '');
              const tied = (pp.stop ? '<tied type="stop"/>' : '') + (pp.tie ? '<tied type="start"/>' : '');
              const nots = tied + (i === 0 ? tupN + tupE : '');
              x += `<note>${i > 0 ? '<chord/>' : ''}${pitchXML}<duration>${dur}</duration>${ties}<voice>${voiceN}</voice><type>${type}</type>${dot ? '<dot/>' : ''}${tm}${staffTag}${nots ? `<notations>${nots}</notations>` : ''}</note>`;
            });
          }
        });
        x += '</measure>\n';
      }
      x += '</part>\n';
    });
    x += '</score-partwise>\n';
    return x;
  }

  // ---------- MIDI
  function vlq(n) { n = Math.max(0, Math.round(n)); const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; }
  function toMIDI(project, an) {
    const { L: lead, st } = project; const ts = lead.ts;
    const str = s => Array.from(unescape(encodeURIComponent(s))).map(c => c.charCodeAt(0));
    const meta = (type, bytes) => [0xff, type, ...vlq(bytes.length), ...bytes];
    const tempoEv = us => meta(0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255]);
    const t0 = [];
    t0.push({ tick: 0, bytes: meta(0x03, str(project.title || 'Arrangement')) });
    t0.push({ tick: 0, bytes: meta(0x58, [ts.num, Math.log2(ts.den), ts.compound ? 36 : 24, 8]) });
    const ks = keySpelling(lead.key); t0.push({ tick: 0, bytes: meta(0x59, [(ks.fifths + 256) % 256, lead.key.mode === 'minor' ? 1 : 0]) });
    let shift = 0;
    const original = st.timing === 'original' && lead.identity && an && an.beatTimes;
    if (original) {
      const bt = an.beatTimes, bTicks = an.beatTicks || PPQ;
      const lead0 = bt[0];
      if (lead0 > 0.05) { // a silent lead-in bar lasting exactly as long as the recording's intro, so bar 1 lines up with the audio
        shift = ts.barTicks;
        t0.push({ tick: 0, bytes: tempoEv(Math.round(lead0 / (ts.barTicks / PPQ) * 1e6)) });
        t0.push({ tick: 0, bytes: meta(0x01, str('Lead-in: matches the start of the original recording')) });
      }
      for (let b = 0; b < bt.length - 1; b++) { const us = Math.round((bt[b + 1] - bt[b]) * 1e6 * PPQ / bTicks); t0.push({ tick: shift + b * bTicks, bytes: tempoEv(us) }); }
    } else t0.push({ tick: 0, bytes: tempoEv(Math.round(60e6 / st.tempo)) });
    const tracks = [t0];
    const sw = t => (st.swing && !ts.compound && t % PPQ === PPQ / 2) ? t + PPQ / 6 : t;
    // channels: one per program; beyond 15 programs, a second MIDI port
    const progSlot = new Map(); let slots = 0;
    for (const t of project.tracks) {
      const inst = T.INSTR[t.inst] || T.INSTR.piano;
      let chan, port = 0;
      if (inst.drums) chan = 9;
      else {
        if (!progSlot.has(inst.gm)) progSlot.set(inst.gm, slots++);
        const sIdx = progSlot.get(inst.gm); const c = sIdx % 15; chan = c >= 9 ? c + 1 : c; port = Math.floor(sIdx / 15);
      }
      const evs = [];
      evs.push({ tick: 0, bytes: meta(0x03, str(t.name.replace(/·/g, '-'))) });
      if (port) evs.push({ tick: 0, bytes: meta(0x21, [port]) });
      if (!inst.drums) evs.push({ tick: 0, bytes: [0xc0 | chan, inst.gm & 127] });
      evs.push({ tick: 0, bytes: [0xb0 | chan, 7, Math.max(0, Math.min(127, Math.round((Number.isFinite(t.vol) ? t.vol : 0.8) * 127)))] });
      evs.push({ tick: 0, bytes: [0xb0 | chan, 10, Math.max(0, Math.min(127, Math.round(64 + (Number.isFinite(t.pan) ? t.pan : 0) * 63)))] });
      for (const n of t.notes) {
        if (!Number.isFinite(n.s) || !Number.isFinite(n.d) || !Number.isFinite(n.p)) continue;
        const p = Math.max(0, Math.min(127, Math.round(n.p))), v = Math.max(1, Math.min(127, Math.round(n.v || 80)));
        const s = sw(n.s) + shift; const e = Math.max(s + 20, sw(n.s + n.d) + shift);
        evs.push({ tick: s, bytes: [0x90 | chan, p, v], on: 1 });
        evs.push({ tick: e, bytes: [0x80 | chan, p, 0], on: 0 });
      }
      tracks.push(evs);
    }
    const chunks = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (PPQ >> 8) & 255, PPQ & 255];
    for (const evs of tracks) {
      evs.sort((a, b) => a.tick - b.tick || (a.on ?? -1) - (b.on ?? -1));
      const data = []; let prev = 0;
      for (const e of evs) { data.push(...vlq(e.tick - prev), ...e.bytes); prev = Math.max(prev, e.tick); }
      data.push(0, 0xff, 0x2f, 0);
      chunks.push(0x4d, 0x54, 0x72, 0x6b, (data.length >>> 24) & 255, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255, ...data);
    }
    return new Uint8Array(chunks);
  }

  // ---------- ZIP (store)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function zip(files) {
    const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
    const d = new Date(); const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data; const name = enc.encode(f.name); const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  window.Notation = { toABC, toMusicXML, toMIDI, zip, keySpelling, spell, measureEvents, dynMark, tempoWord, beatTempo, abcKey, staves };
})();
