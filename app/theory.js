/* Music theory helpers: pitch names, keys, chords, instruments. Global: T */
(function () {
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const PPQ = 480;
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const MINOR = [0, 2, 3, 5, 7, 8, 10];
  // Krumhansl-Kessler key profiles
  const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  const CHORDS = {
    maj: { iv: [0, 4, 7], sym: '' },
    min: { iv: [0, 3, 7], sym: 'm' },
    dim: { iv: [0, 3, 6], sym: 'dim' },
    aug: { iv: [0, 4, 8], sym: '+' },
    sus4: { iv: [0, 5, 7], sym: 'sus4' },
    dom7: { iv: [0, 4, 7, 10], sym: '7' },
    maj7: { iv: [0, 4, 7, 11], sym: 'maj7' },
    min7: { iv: [0, 3, 7, 10], sym: 'm7' },
    hdim7: { iv: [0, 3, 6, 10], sym: 'm7b5' },
  };

  function flatKey(tonic, mode) {
    const maj = mode === 'minor' ? (tonic + 3) % 12 : tonic;
    return [5, 10, 3, 8, 1, 6].includes(maj);
  }
  function pcName(pc, flats) { return (flats ? FLAT : SHARP)[((pc % 12) + 12) % 12]; }
  function pitchName(p, flats) { return pcName(p, flats) + (Math.floor(p / 12) - 1); }
  function parsePitch(s) {
    if (typeof s === 'number') return s;
    const m = /^\s*([A-Ga-g])([#b♯♭x]*)(-?\d+)\s*$/.exec(String(s));
    if (!m) return null;
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
    let acc = 0;
    for (const ch of m[2]) acc += (ch === '#' || ch === '♯') ? 1 : (ch === 'x' ? 2 : -1);
    return (parseInt(m[3], 10) + 1) * 12 + base + acc;
  }
  function keyName(k) { return pcName(k.tonic, flatKey(k.tonic, k.mode)) + (k.mode === 'minor' ? ' minor' : ' major'); }
  function scalePcs(k) { return (k.mode === 'minor' ? MINOR : MAJOR).map(i => (i + k.tonic) % 12); }
  function chordPcs(c) { return CHORDS[c.type].iv.map(i => (i + c.root) % 12); }
  function chordName(c, flats) { if (!c || c.type === 'N') return 'N.C.'; return pcName(c.root, flats) + CHORDS[c.type].sym; }

  // Key estimation from a 12-bin chroma. Returns ranked candidates.
  function estimateKey(chroma) {
    const corr = (a, b) => {
      const ma = a.reduce((s, x) => s + x, 0) / 12, mb = b.reduce((s, x) => s + x, 0) / 12;
      let n = 0, da = 0, db = 0;
      for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
      return n / Math.sqrt(da * db + 1e-12);
    };
    const res = [];
    for (let t = 0; t < 12; t++) {
      const rot = i => chroma[(i + t) % 12];
      const c = Array.from({ length: 12 }, (_, i) => rot(i));
      res.push({ tonic: t, mode: 'major', r: corr(c, KK_MAJ) });
      res.push({ tonic: t, mode: 'minor', r: corr(c, KK_MIN) });
    }
    res.sort((a, b) => b.r - a.r);
    return res;
  }

  // Map a pitch from one key to another (transpose + optional mode change by scale degree)
  function mapPitch(p, from, to) {
    let shift = ((to.tonic - from.tonic) % 12 + 12) % 12;
    if (shift > 6) shift -= 12;
    let q = p + shift;
    if (from.mode !== to.mode) {
      const deg = (((q - to.tonic) % 12) + 12) % 12;
      if (from.mode === 'major' && to.mode === 'minor') { if (deg === 4 || deg === 9 || deg === 11) q -= 1; }
      else if (from.mode === 'minor' && to.mode === 'major') { if (deg === 3 || deg === 8 || deg === 10) q += 1; }
    }
    return q;
  }
  function mapChord(c, from, to) {
    if (!c || c.type === 'N') return c;
    const root = ((mapPitch(c.root + 60, from, to)) % 12 + 12) % 12;
    let type = c.type;
    if (from.mode !== to.mode) {
      // re-derive quality from the target scale for diatonic chords
      const sc = scalePcs(to);
      const deg = sc.indexOf(root);
      if (deg >= 0 && ['maj', 'min', 'dim'].includes(type)) {
        const third = (sc[(deg + 2) % 7] - root + 12) % 12, fifth = (sc[(deg + 4) % 7] - root + 12) % 12;
        type = third === 4 ? (fifth === 8 ? 'aug' : 'maj') : (fifth === 6 ? 'dim' : 'min');
      } else if (deg >= 0 && ['maj7', 'min7', 'dom7', 'hdim7'].includes(type)) {
        const third = (sc[(deg + 2) % 7] - root + 12) % 12, fifth = (sc[(deg + 4) % 7] - root + 12) % 12, sev = (sc[(deg + 6) % 7] - root + 12) % 12;
        type = third === 4 ? (sev === 11 ? 'maj7' : 'dom7') : (fifth === 6 ? 'hdim7' : 'min7');
      }
    }
    // harmonic minor: the dominant stays major (V / V7) so the leading tone survives
    if (to.mode === 'minor' && root === (to.tonic + 7) % 12 && (c.type === 'maj' || c.type === 'dom7')) type = c.type;
    return { ...c, root, type };
  }

  // Instruments. range = practical sounding range. gm = General MIDI program.
  const INSTR = {
    piano: { name: 'Piano', poly: 10, sample: 'acoustic_grand_piano', range: [21, 108], gm: 0, family: 'keys', clef: 'treble', att: 0.002, rel: 0.12, gain: 0.9 },
    violin: { name: 'Violin', poly: 2, sample: 'violin', range: [55, 100], gm: 40, family: 'strings', clef: 'treble', att: 0.05, rel: 0.18, gain: 0.85 },
    viola: { name: 'Viola', poly: 2, sample: 'viola', range: [48, 88], gm: 41, family: 'strings', clef: 'alto', att: 0.05, rel: 0.18, gain: 0.85 },
    cello: { name: 'Cello', poly: 2, sample: 'cello', range: [36, 76], gm: 42, family: 'strings', clef: 'bass', att: 0.05, rel: 0.2, gain: 0.9 },
    contrabass: { name: 'Contrabass', poly: 1, sample: 'contrabass', range: [28, 60], gm: 43, family: 'strings', clef: 'bass', att: 0.06, rel: 0.22, gain: 0.9, writtenOctave: 12 },
    strings: { name: 'String Section', poly: 4, sample: 'string_ensemble_1', range: [36, 96], gm: 48, family: 'strings', clef: 'treble', att: 0.12, rel: 0.3, gain: 0.7 },
    pizzicato: { name: 'Pizzicato Strings', poly: 3, sample: 'pizzicato_strings', range: [28, 96], gm: 45, family: 'strings', clef: 'treble', att: 0.002, rel: 0.1, gain: 0.95 },
    flute: { name: 'Flute', poly: 1, sample: 'flute', range: [60, 96], gm: 73, family: 'woodwinds', clef: 'treble', att: 0.03, rel: 0.12, gain: 0.8 },
    oboe: { name: 'Oboe', poly: 1, sample: 'oboe', range: [58, 91], gm: 68, family: 'woodwinds', clef: 'treble', att: 0.03, rel: 0.1, gain: 0.75 },
    clarinet: { name: 'Clarinet', poly: 1, sample: 'clarinet', range: [50, 91], gm: 71, family: 'woodwinds', clef: 'treble', att: 0.03, rel: 0.1, gain: 0.8 },
    bassoon: { name: 'Bassoon', poly: 1, sample: 'bassoon', range: [34, 75], gm: 70, family: 'woodwinds', clef: 'bass', att: 0.03, rel: 0.1, gain: 0.85 },
    horn: { name: 'Horn', poly: 2, sample: 'french_horn', range: [34, 77], gm: 60, family: 'brass', clef: 'treble', att: 0.05, rel: 0.18, gain: 0.75 },
    trumpet: { name: 'Trumpet', poly: 1, sample: 'trumpet', range: [54, 84], gm: 56, family: 'brass', clef: 'treble', att: 0.02, rel: 0.1, gain: 0.7 },
    trombone: { name: 'Trombone', poly: 3, sample: 'trombone', range: [40, 72], gm: 57, family: 'brass', clef: 'bass', att: 0.03, rel: 0.12, gain: 0.75 },
    tuba: { name: 'Tuba', poly: 1, sample: 'tuba', range: [28, 58], gm: 58, family: 'brass', clef: 'bass', att: 0.04, rel: 0.14, gain: 0.85 },
    timpani: { name: 'Timpani', poly: 2, sample: 'timpani', range: [38, 57], gm: 47, family: 'percussion', clef: 'bass', att: 0.002, rel: 0.6, gain: 1.0 },
    percussion: { name: 'Percussion', poly: 4, sample: null, range: [35, 81], gm: 0, family: 'percussion', clef: 'perc', drums: true, gain: 0.8 },
    harp: { name: 'Harp', poly: 6, sample: 'orchestral_harp', range: [24, 103], gm: 46, family: 'keys', clef: 'treble', att: 0.002, rel: 0.4, gain: 0.85 },
    glockenspiel: { name: 'Glockenspiel', poly: 2, sample: 'glockenspiel', range: [79, 108], gm: 9, family: 'percussion', clef: 'treble', att: 0.001, rel: 0.5, gain: 0.55, writtenOctave: -24 },
  };
  const DRUMS = { 36: 'Bass drum', 38: 'Snare', 49: 'Crash cymbal', 51: 'Suspended cymbal', 81: 'Triangle', 42: 'Hi-hat' };
  const FAMILY_ORDER = ['woodwinds', 'brass', 'percussion', 'keys', 'strings'];
  const FAMILY_LABEL = { woodwinds: 'Woodwinds', brass: 'Brass', percussion: 'Percussion', keys: 'Keyboards & Harp', strings: 'Strings' };

  function fitRange(p, range) {
    while (p < range[0]) p += 12;
    while (p > range[1]) p -= 12;
    return p;
  }

  function timeSig(num, den) {
    const unit = PPQ * 4 / den;
    const compound = den === 8 && num % 3 === 0 && num > 3;
    const beatTicks = compound ? unit * 3 : unit;
    return { num, den, unit, compound, beatTicks, barTicks: num * unit, beatsPerBar: compound ? num / 3 : num };
  }

  // Seeded RNG (mulberry32)
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  window.T = { SHARP, FLAT, PPQ, MAJOR, MINOR, CHORDS, INSTR, DRUMS, FAMILY_ORDER, FAMILY_LABEL, flatKey, pcName, pitchName, parsePitch, keyName, scalePcs, chordPcs, chordName, estimateKey, mapPitch, mapChord, fitRange, timeSig, rng, hash };
})();
