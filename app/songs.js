/* Music Arranger — songs from a name instead of a recording.
   A small library of public-domain tunes written out by hand (melody + chord symbols in ABC),
   plus a converter that turns any ABC tune into the same "analysis" object a recording produces,
   so the arranger, editor, score and exports work unchanged.  Global: Songs */
(function () {
  // Every tune here is traditional or long out of copyright. Melodies + chord symbols only;
  // the arranger supplies the harmony, bass and orchestration.
  const LIBRARY = [
    { id: 'twinkle', title: 'Twinkle, Twinkle, Little Star', composer: 'Traditional (French melody, 1761)', aliases: ['twinkle twinkle', 'twinkle', 'little star', 'ah vous dirai-je maman', 'abc song', 'alphabet song', 'baa baa black sheep'],
      abc: `M:4/4\nL:1/4\nQ:1/4=100\nK:C\n"C"C C G G|"F"A A "C"G2|"F"F F "C"E E|"G7"D D "C"C2|\n"C"G G "F"F F|"C"E E "G"D2|"C"G G "F"F F|"C"E E "G"D2|\n"C"C C G G|"F"A A "C"G2|"F"F F "C"E E|"G7"D D "C"C2|]` },
    { id: 'mary', title: 'Mary Had a Little Lamb', composer: 'Traditional (American, 1830)', aliases: ['mary had a little lamb', 'little lamb'],
      abc: `M:4/4\nL:1/4\nQ:1/4=108\nK:C\n"C"E D C D|"C"E E E2|"G"D D D2|"C"E G G2|\n"C"E D C D|"C"E E E E|"G7"D D E D|"C"C4|]` },
    { id: 'ode', title: 'Ode to Joy', composer: 'Ludwig van Beethoven (Symphony No. 9, 1824)', aliases: ['ode to joy', 'ode an die freude', 'beethoven 9', 'beethoven ninth', 'symphony 9', 'joyful joyful'],
      abc: `M:4/4\nL:1/4\nQ:1/4=104\nK:D\n"D"F F G A|"A"A G F E|"D"D D E F|"A"F3/2 E/ E2|\n"D"F F G A|"A"A G F E|"D"D D E F|"A"E3/2 "D"D/ D2|\n"A"E E "D"F D|"A"E F/G/ "D"F D|"A"E F/G/ "Bm"F "E"E|"A"D E A,2|\n"D"F F G A|"A"A G F E|"D"D D E F|"A"E3/2 "D"D/ D2|]` },
    { id: 'frere', title: 'Frère Jacques', composer: 'Traditional (French)', aliases: ['frere jacques', 'frère jacques', 'are you sleeping', 'brother john', 'bruder jakob'],
      abc: `M:4/4\nL:1/4\nQ:1/4=110\nK:C\n"C"C D E C|"C"C D E C|"C"E F G2|"C"E F G2|\n"C"G/A/G/F/ E C|"C"G/A/G/F/ E C|"C"C "G"G, "C"C2|"C"C "G"G, "C"C2|]` },
    { id: 'birthday', title: 'Happy Birthday to You', composer: 'Mildred & Patty Hill (melody 1893; public domain)', aliases: ['happy birthday', 'birthday song', 'good morning to all'],
      abc: `M:3/4\nL:1/8\nQ:1/4=100\nK:G\nD>D|"G"E2 D2 G2|"D"F4 D>D|"D"E2 D2 A2|"G"G4 D>D|\n"G"d2 B2 G2|"C"F2 E2 c>c|"G"B2 G2 "D"A2|"G"G4|]` },
    { id: 'greensleeves', title: 'Greensleeves', composer: 'Traditional (English, 16th century)', aliases: ['greensleeves', 'what child is this'],
      abc: `M:6/8\nL:1/8\nQ:3/8=58\nK:Am\nA|"Am"c2 d "C"e>fe|"G"d2 B "Em"G>AB|"Am"c2 A "F"A>^GA|"E"B2 ^G E2 A|\n"Am"c2 d "C"e>fe|"G"d2 B "Em"G>AB|"Am"c>BA "E"^G>^FG|"Am"A6|\n"C"g3 g>fe|"G"d2 B "Em"G>AB|"Am"c2 A "F"A>^GA|"E"B2 ^G E3|\n"C"g3 g>fe|"G"d2 B "Em"G>AB|"Am"c>BA "E"^G>^FG|"Am"A6|]` },
    { id: 'jingle', title: 'Jingle Bells', composer: 'James Lord Pierpont (1857)', aliases: ['jingle bells', 'one horse open sleigh'],
      abc: `M:4/4\nL:1/4\nQ:1/4=120\nK:G\n"G"B B B2|"G"B B B2|"G"B d G3/2 A/|"G"B4|\n"C"c c c3/2 c/|"G"c B B B/B/|"A7"B A A B|"D7"A2 d2|\n"G"B B B2|"G"B B B2|"G"B d G3/2 A/|"G"B4|\n"C"c c c c|"G"c B B B/B/|"D7"d d c A|"G"G4|]` },
    { id: 'silentnight', title: 'Silent Night', composer: 'Franz Xaver Gruber (1818)', aliases: ['silent night', 'stille nacht', 'holy night'],
      abc: `M:6/8\nL:1/8\nQ:3/8=52\nK:C\n"C"G>AG E3|"C"G>AG E3|"G7"d2 d B3|"C"c2 c G3|\n"F"A2 A c>BA|"C"G>AG E3|"F"A2 A c>BA|"C"G>AG E3|\n"G7"d2 d f>dB|"C"c3 e3|"C"c>GE "G7"G>FD|"C"C6|]` },
    { id: 'rowboat', title: 'Row, Row, Row Your Boat', composer: 'Traditional (American, 1852)', aliases: ['row row row your boat', 'row your boat', 'row row'],
      abc: `M:6/8\nL:1/8\nQ:3/8=66\nK:C\n"C"C3 C3|"C"C2 D E3|"C"E2 D E2 F|"C"G6|\n"C"c c c G G G|"C"E E E C C C|"G7"G2 F E2 D|"C"C6|]` },
    { id: 'london', title: 'London Bridge Is Falling Down', composer: 'Traditional (English)', aliases: ['london bridge', 'london bridge is falling down', 'my fair lady nursery'],
      abc: `M:4/4\nL:1/4\nQ:1/4=112\nK:C\n"C"G3/2 A/ G F|"C"E F G2|"G7"D E F2|"C"E F G2|\n"C"G3/2 A/ G F|"C"E F G2|"G7"D2 G2|"C"E C2 z|]` },
    { id: 'amazinggrace', title: 'Amazing Grace', composer: 'Hymn tune "New Britain" (1829), words John Newton', aliases: ['amazing grace', 'new britain'],
      abc: `M:3/4\nL:1/4\nQ:1/4=80\nK:G\nD|"G"G2 B/G/|"G7"B2 A|"C"G2 E|"G"D2 D|"G"G2 B/G/|"G"B2 A|"D"d3-|"D"d2 B|\n"G"d2 B/G/|"G7"B2 A|"C"G2 E|"G"D2 D|"G"G2 B/G/|"D"B2 A|"G"G3-|"G"G2|]` },
    { id: 'yankee', title: 'Yankee Doodle', composer: 'Traditional (American, 18th century)', aliases: ['yankee doodle', 'yankee doodle dandy'],
      abc: `M:4/4\nL:1/8\nQ:1/4=120\nK:G\n"G"G G A B "D"G B A D|"G"G G A B "G"G2 "D"F2|"G"G G A B "C"c B A G|"D"F D E F "G"G2 G2|]` },
    { id: 'minuetg', title: 'Minuet in G', composer: 'Christian Petzold (c. 1725, from the Anna Magdalena Bach notebook)', aliases: ['minuet in g', 'bach minuet', 'minuet', 'petzold minuet', 'lovers concerto'],
      abc: `M:3/4\nL:1/4\nQ:1/4=120\nK:G\n"G"d G/A/B/c/|"G"d G G|"C"e c/d/e/f/|"G"g G G|"C"c d/c/B/A/|"G"B c/B/A/G/|"D"F G/A/B/G/|"D"A3|\n"G"d G/A/B/c/|"G"d G G|"C"e c/d/e/f/|"G"g G G|"C"c d/c/B/A/|"G"B c/B/A/G/|"D"A B/A/G/F/|"G"G3|]` },
    { id: 'furelise', title: 'Für Elise (opening)', composer: 'Ludwig van Beethoven (1810)', aliases: ['fur elise', 'für elise', 'fuer elise', 'beethoven fur elise'],
      abc: `M:6/8\nL:1/16\nQ:3/8=60\nK:Am\ne^d|e^de B=dc "Am"A2 zCEA|"E"B2 zE^GB "Am"c2 zEe^d|e^de B=dc "Am"A2 zCEA|"E"B2 zEcB "Am"A4|]` },
    { id: 'hotcross', title: 'Hot Cross Buns', composer: 'Traditional (English)', aliases: ['hot cross buns'],
      abc: `M:4/4\nL:1/4\nQ:1/4=100\nK:G\n"G"B A G2|"G"B A G2|"G"G/G/G/G/ "D"A/A/A/A/|"D"B A "G"G2|]` },
  ];

  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  function match(q) {
    const n = norm(q); if (!n) return null;
    let best = null, bs = 0;
    for (const s of LIBRARY) {
      for (const a of [s.title, ...s.aliases].map(norm)) {
        let sc = 0;
        if (n === a) sc = 3; else if (n.includes(a) && a.length >= 6) sc = 2 + a.length / 100; else if (a.includes(n) && n.length >= 6) sc = 1.5 + n.length / 100;
        if (sc > bs) { bs = sc; best = s; }
      }
    }
    return best;
  }

  // ---------- chord symbols
  const ROOT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function parseChord(name) {
    const s = String(name || '').replace(/♭/g, 'b').replace(/♯/g, '#').replace(/\s+/g, '').replace(/^\(|\)$/g, '');
    const m = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/.exec(s);
    if (!m) return null;
    const root = (ROOT[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? 11 : 0)) % 12;
    const q = m[3];
    let type = 'maj';
    if (/^(m7b5|ø|min7b5|-7b5)/.test(q)) type = 'hdim7';
    else if (/^(dim|°|o)/.test(q)) type = 'dim';
    else if (/^(aug|\+)/.test(q)) type = 'aug';
    else if (/^(maj|M|Δ|ma)7?/.test(q) && /7|9|Δ|M/.test(q)) type = 'maj7';
    else if (/^(m|min|-)(7|9|11)/.test(q)) type = 'min7';
    else if (/^(m|min|-)/.test(q) && !/^maj/.test(q)) type = 'min';
    else if (/^sus/.test(q)) type = 'sus4';
    else if (/^(7|9|11|13)/.test(q)) type = 'dom7';
    const bass = m[4] ? (ROOT[m[4]] + (m[5] === '#' ? 1 : m[5] === 'b' ? 11 : 0)) % 12 : null;
    return { root, type, bass };
  }

  // ---------- harmonise a melody when the tune carries no chord symbols
  function harmonize(melody, key, bpb, nBars) {
    const sc = T.scalePcs(key);
    const minor = key.mode === 'minor';
    const degs = minor ? [['min', 0], ['dim', 1], ['maj', 2], ['min', 3], ['maj', 4], ['maj', 5], ['maj', 6]] : [['maj', 0], ['min', 1], ['min', 2], ['maj', 3], ['maj', 4], ['min', 5], ['dim', 6]];
    const cands = degs.map(([type, d]) => {
      let root = sc[d];
      if (minor && d === 4) type = 'maj'; // major dominant in minor
      return { root, type, deg: d };
    });
    const prior = [1.0, 0.25, 0.2, 0.7, 0.85, 0.45, 0.05];
    const out = [];
    const half = bpb >= 4 ? bpb / 2 : bpb;
    const spans = [];
    for (let b = 0; b < nBars * bpb; b += half) spans.push([b, b + half]);
    let prev = null;
    for (const [a, e] of spans) {
      const w = new Array(12).fill(0);
      for (const n of melody) { const o = Math.min(e, n.s + n.d) - Math.max(a, n.s); if (o > 0) w[n.p % 12] += o * (Math.abs(n.s - a) < 0.01 ? 1.6 : 1); }
      let best = cands[0], bs = -1e9;
      for (const c of cands) {
        const pcs = T.chordPcs(c);
        let sc2 = 0; for (let pc = 0; pc < 12; pc++) sc2 += pcs.includes(pc) ? w[pc] : -0.6 * w[pc];
        sc2 += prior[c.deg] * 0.8 + (prev && prev.root === c.root ? 0.15 : 0);
        if (a === spans[spans.length - 1][0] && c.deg === 0) sc2 += 1.5; // end on the tonic
        if (sc2 > bs) { bs = sc2; best = c; }
      }
      const l = out[out.length - 1];
      if (l && l.root === best.root && l.type === best.type) l.d += e - a; else out.push({ s: a, d: e - a, root: best.root, type: best.type });
      prev = best;
    }
    return out;
  }

  // ---------- ABC tune -> analysis object
  function keyFromSig(sig, melody) {
    const root = sig && sig.root && ROOT[sig.root[0]] != null ? (ROOT[sig.root[0]] + (sig.acc === 'sharp' || sig.acc === '#' ? 1 : sig.acc === 'flat' || sig.acc === 'b' ? 11 : 0)) % 12 : null;
    const mode = String(sig && sig.mode || '').toLowerCase();
    if (root != null && sig.root !== 'none' && sig.root !== 'HP' && sig.root !== 'Hp') return { tonic: root, mode: /^(m|min|aeo|dor|phr|loc)/.test(mode) && !/^mix/.test(mode) ? 'minor' : 'major' };
    const ch = new Array(12).fill(0); for (const n of melody) ch[n.p % 12] += n.d;
    const k = T.estimateKey(ch)[0]; return { tonic: k.tonic, mode: k.mode };
  }
  function fromABC(abcText, meta = {}) {
    if (!window.ABCJS || !ABCJS.parseOnly) throw new Error('the notation engine is not loaded');
    let abc = String(abcText || '').replace(/\r/g, '').trim();
    if (!/^X:/m.test(abc)) abc = 'X:1\n' + abc;
    if (!/^T:/m.test(abc)) abc = abc.replace(/^(X:.*)$/m, '$1\nT:' + (meta.title || 'Tune').replace(/\n/g, ' '));
    if (!/^K:/m.test(abc)) throw new Error('the tune has no key line (K:)');
    const tune = ABCJS.parseOnly(abc)[0];
    if (!tune || !tune.lines || !tune.lines.length) throw new Error('the tune could not be read');
    const warnings = [];
    const mf = tune.getMeterFraction ? tune.getMeterFraction() : { num: 4, den: 4 };
    let num = +mf.num || 4, den = +mf.den || 4;
    // beat unit (in whole notes), beats per bar and the time signature we can show
    let bw = 0.25, bpb = num, compound = false, ts;
    if (den === 8 && num % 3 === 0) { compound = true; bw = 3 / 8; bpb = num / 3; }
    else if (den === 2) { bw = 0.25; bpb = num * 2; }
    else if (den === 4) { bw = 0.25; bpb = num; }
    else if (den === 8) { bw = 0.25; bpb = Math.max(2, Math.round(num / 2)); warnings.push(num + '/8 is not supported here, so the tune is written in ' + bpb + '/4.'); }
    else { bw = 0.25; bpb = 4; }
    const barW = (num / den);              // real bar length in whole notes (for the pickup)
    if (!compound && bpb > 5) { const nb = bpb % 3 === 0 ? 3 : 4; warnings.push(num + '/' + den + ' is written as ' + nb + '/4 here.'); bpb = nb; }
    if (compound && bpb === 1) bpb = 2;     // 3/8 tunes become 6/8
    ts = compound ? { num: bpb * 3, den: 8 } : { num: bpb, den: 4 };

    // tempo
    let secPerWhole;
    const hasQ = !!(tune.metaText && tune.metaText.tempo);
    if (hasQ && tune.millisecondsPerMeasure) secPerWhole = tune.millisecondsPerMeasure() / 1000 / (num / den);
    if (!secPerWhole || !isFinite(secPerWhole) || secPerWhole <= 0) secPerWhole = compound ? 60 / 66 / bw : 60 / 100 / bw;
    let beatSec = secPerWhole * bw;
    if (beatSec < 60 / 260 || beatSec > 60 / 30) beatSec = Math.max(60 / 260, Math.min(60 / 30, beatSec));

    // pickup: the first bar shorter than a full bar is an anacrusis
    const v0 = tune.lines.find(l => l.staff)?.staff[0]?.voices[0] || [];
    let first = 0, seenNote = false;
    for (const el of v0) {
      if (el.el_type === 'bar') { if (seenNote) break; else continue; }
      if (el.el_type === 'note' && el.duration) { first += el.duration * (el.tripletMultiplier || 1); seenNote = true; }
    }
    const offset = first > 1e-6 && first < barW - 1e-6 ? barW - first : 0;

    // notes, with repeats and endings expanded by abcjs
    const audio = tune.setUpAudio({ chordsOff: true });
    const tracks = (audio && audio.tracks || []).map(tr => tr.filter(e => e.cmd === 'note' && isFinite(e.pitch) && e.duration > 0));
    if (!tracks.length || !tracks[0].length) throw new Error('the tune has no notes');
    const toB = w => (w + offset) / bw;
    const melody = [];
    for (const e of tracks[0]) melody.push({ p: Math.round(e.pitch), s: +toB(e.start).toFixed(4), d: +(e.duration / bw).toFixed(4), a: 0.7, _c: e.startChar });
    melody.sort((a, b) => a.s - b.s || b.p - a.p);
    const melTop = []; for (const n of melody) { const l = melTop[melTop.length - 1]; if (l && Math.abs(l.s - n.s) < 1e-3) continue; melTop.push(n); }
    const extra = [];
    for (const tr of tracks.slice(1)) for (const e of tr) extra.push({ p: Math.round(e.pitch), s: +toB(e.start).toFixed(4), d: +(e.duration / bw).toFixed(4), a: 0.45 });
    for (const n of melody) if (!melTop.includes(n)) extra.push({ p: n.p, s: n.s, d: n.d, a: 0.45 });

    const endBeat = Math.max(...melTop.map(n => n.s + n.d), ...extra.map(n => n.s + n.d));
    const nBars = Math.max(1, Math.ceil(endBeat / bpb - 1e-6));
    const nBeats = nBars * bpb;
    const key = meta.key || keyFromSig(tune.getKeySignature ? tune.getKeySignature() : null, melTop);

    // chord symbols: map each symbol (by its position in the text) to the times it sounds
    const els = [];
    for (const l of tune.lines) if (l.staff && l.staff[0] && l.staff[0].voices[0]) for (const el of l.staff[0].voices[0]) els.push(el);
    const timesByChar = new Map();
    for (const e of tracks[0]) { if (!timesByChar.has(e.startChar)) timesByChar.set(e.startChar, []); const arr = timesByChar.get(e.startChar); const tb = toB(e.start); if (!arr.some(x => Math.abs(x - tb) < 1e-3)) arr.push(tb); }
    const chordEv = [];
    for (let i = 0; i < els.length; i++) {
      const el = els[i]; if (el.el_type !== 'note' || !el.chord) continue;
      const sym = el.chord.find(c => (!c.position || c.position === 'default') && parseChord(c.name));
      const pc = sym && parseChord(sym.name); if (!pc) continue;
      let times = timesByChar.get(el.startChar);
      if (!times) { // a symbol over a rest: count back from the next sounding note
        let back = 0, j = i;
        for (; j < els.length; j++) { const x = els[j]; if (x.el_type === 'note' && !x.rest && timesByChar.has(x.startChar)) break; if (x.el_type === 'note' && x.duration) back += x.duration; }
        if (j < els.length) times = timesByChar.get(els[j].startChar).map(t => t - back / bw);
      }
      for (const t of times || []) chordEv.push({ t: Math.max(0, t), ...pc });
    }
    chordEv.sort((a, b) => a.t - b.t);
    let chords = [];
    for (const c of chordEv) { const l = chords[chords.length - 1]; if (l && Math.abs(l.s - c.t) < 1e-3) { Object.assign(l, { root: c.root, type: c.type, bass: c.bass }); continue; } if (l && l.root === c.root && l.type === c.type && l.bass === c.bass) continue; chords.push({ s: +c.t.toFixed(4), root: c.root, type: c.type, bass: c.bass }); }
    chords.forEach((c, i) => { c.d = +((i + 1 < chords.length ? chords[i + 1].s : nBeats) - c.s).toFixed(4); });
    chords = chords.filter(c => c.d > 0.01);
    let harmonised = false;
    if (chords.length < Math.max(1, nBars / 8)) { chords = harmonize(melTop, key, bpb, nBars); harmonised = true; warnings.push('The tune came without chord symbols, so the harmony was chosen to fit the melody.'); }
    else if (chords[0].s > 0.01) chords[0] = { ...chords[0], d: chords[0].d + chords[0].s, s: 0 };

    // bass line: chord root (or slash bass) on each chord and each new bar
    const bass = []; let prevB = null;
    for (const c of chords) {
      const pc = c.bass != null ? c.bass : c.root;
      for (let s = c.s; s < c.s + c.d - 1e-3;) {
        const barEnd = (Math.floor(s / bpb + 1e-6) + 1) * bpb;
        const e = Math.min(c.s + c.d, barEnd);
        let p = 36 + pc; if (p > 50) p -= 12;
        if (prevB != null) { if (p - prevB > 7 && p - 12 >= 31) p -= 12; else if (prevB - p > 7 && p + 12 <= 52) p += 12; }
        bass.push({ p, s: +s.toFixed(4), d: +(e - s).toFixed(4), a: 0.6 }); prevB = p; s = e;
      }
    }
    // a soft middle-register chord under the tune, so "faithful" settings have harmony to keep
    const inner = [];
    for (const c of chords) {
      const pcs = T.chordPcs(c);
      for (let s = c.s; s < c.s + c.d - 1e-3;) {
        const barEnd = (Math.floor(s / bpb + 1e-6) + 1) * bpb, e = Math.min(c.s + c.d, barEnd);
        const m = melTop.find(n => n.s <= s + 1e-3 && n.s + n.d > s) || melTop.find(n => n.s >= s);
        const top = m ? Math.min(69, m.p - 3) : 67;
        const tones = []; for (let p = top; p >= 50 && tones.length < 3; p--) if (pcs.includes(p % 12) && !tones.some(q => q % 12 === p % 12)) tones.push(p);
        for (const p of tones) inner.push({ p, s: +s.toFixed(4), d: +(e - s).toFixed(4), a: 0.35 });
        s = e;
      }
    }
    // dynamics: higher, busier bars sound louder; the last phrase lifts a little
    const barPitch = new Array(nBars).fill(0), barCount = new Array(nBars).fill(0);
    for (const n of melTop) { const b = Math.min(nBars - 1, Math.floor(n.s / bpb)); barPitch[b] += n.p; barCount[b]++; }
    const mp = barPitch.map((v, i) => barCount[i] ? v / barCount[i] : null);
    const valid = mp.filter(v => v != null); const lo = Math.min(...valid), hi = Math.max(...valid);
    const maxC = Math.max(1, ...barCount);
    const energy = [];
    for (let b = 0; b < nBeats; b++) {
      const bar = Math.floor(b / bpb), pitchN = mp[bar] == null ? 0.4 : (mp[bar] - lo) / Math.max(1, hi - lo);
      const arc = Math.sin(Math.PI * Math.min(1, (bar + 0.5) / nBars)) * 0.15;
      energy.push(+Math.max(0.05, Math.min(1, 0.3 + 0.35 * pitchN + 0.15 * barCount[bar] / maxC + arc + (nBars >= 8 && bar >= nBars * 0.75 ? 0.08 : 0))).toFixed(3));
    }
    const beatTimes = Array.from({ length: nBeats + 1 }, (_, i) => +(i * beatSec).toFixed(4));
    const clean = arr => arr.map(n => ({ p: n.p, s: n.s, d: Math.max(0.05, n.d), a: n.a }));
    const melOut = clean(melTop), bassOut = clean(bass);
    const notes = [...melOut.map(n => ({ ...n, r: 'm' })), ...bassOut.map(n => ({ ...n, r: 'b' })), ...clean([...extra, ...inner]).map(n => ({ ...n, r: '' }))].sort((a, b) => a.s - b.s || b.p - a.p);
    const dur = nBeats * beatSec;
    const origin = meta.origin || 'library';
    if (offset > 0) warnings.push("The tune starts with a pickup, so bar 1 holds just the pickup notes.");
    if (tune.warnings && tune.warnings.length) warnings.push('The notation had ' + tune.warnings.length + ' small problem' + (tune.warnings.length === 1 ? '' : 's') + ' that were corrected automatically; check the first bars against the tune you know.');
    return {
      version: 3, mode: 'score', engine: meta.engine || 'Written-out melody and chord symbols', fileName: meta.title || 'Tune',
      duration: dur, offsetSec: 0, analysedSec: dur, beatTimes, tempo: +(60 / beatSec).toFixed(1), beatsPerBar: bpb, nBeats,
      beatTicks: compound ? 720 : 480, suggestedTs: ts, swing: false, key, keyCandidates: [{ ...key, r: 1 }], keyChanges: [],
      notes, melody: melOut, bass: bassOut, chords: chords.map(c => ({ s: c.s, d: c.d, root: c.root, type: c.type })), energy, raw: [...melOut, ...bassOut].map(n => ({ p: n.p, t: +(n.s * beatSec).toFixed(3), d: +(n.d * beatSec).toFixed(3), a: n.a })),
      stats: { notes: notes.length, melodyNotes: melOut.length, bassNotes: bassOut.length, avgPolyphony: +((notes.reduce((s, n) => s + n.d, 0)) / Math.max(1, nBeats)).toFixed(2), tempoConfidence: 1, tempoAlternatives: [], beatStability: 1, meterConfidence: 1, keyConfidence: 1, harmonised },
      warnings: [...(meta.warnings || []), ...warnings],
      source: { kind: origin, title: meta.title || '', composer: meta.composer || '', abc, query: meta.query || '' },
    };
  }

  window.Songs = { LIBRARY, match, fromABC, parseChord, harmonize, norm };
})();
