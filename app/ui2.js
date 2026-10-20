/* Music Arranger — part 2: arranging assistant, edit operations, exports, upload/analysis flow, autosave, boot. */
(function () {
  const U = window.__ui; const S = U.S; const $ = id => document.getElementById(id);
  const PPQ = T.PPQ;
  const { esc, clamp, toast } = U;
  let sample = null, downloads = null, toolsOK = false, capsReady = false;

  // ------------------------------------------------------------------ capabilities
  (async () => {
    try {
      if (window.claude && typeof window.claude.use === 'function') {
        const [s, d] = await Promise.all([window.claude.use('sample').catch(() => null), window.claude.use('downloads').catch(() => null)]);
        sample = s; downloads = d;
        if (sample && sample.limits) { try { const lim = await sample.limits(); toolsOK = !!lim.tools; } catch (e) { toolsOK = false; } }
      }
    } catch (e) { }
    // outside claude.ai (for example on GitHub Pages) save files with an ordinary browser download
    if (!downloads && !window.claude) downloads = { save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000); return { status: 'saved' };
    } };
    capsReady = true; renderChat();
  })();

  // ------------------------------------------------------------------ helpers for edits
  const bt = () => S.L.ts.barTicks;
  const flats = () => T.flatKey(S.L.key.tonic, S.L.key.mode);
  const DYN = { ppp: 30, pp: 40, p: 52, mp: 64, mf: 78, f: 94, ff: 108, fff: 118 };
  function resolveTrack(ref, allowNew) {
    if (ref == null) return null;
    const r = String(ref).trim();
    if (allowNew && /^new:/i.test(r)) {
      const inst = resolveInst(r.slice(4)); if (!inst) throw new Error('Unknown instrument "' + r.slice(4) + '". Use one of: ' + Object.keys(T.INSTR).join(', '));
      return U.addPart(inst, 'rest', 0, S.L.nBars - 1, T.INSTR[inst].name);
    }
    const low = r.toLowerCase(), norm = low.replace(/[^a-z0-9]/g, '');
    const exact = S.tracks.find(t => t.id.toLowerCase() === low) || S.tracks.find(t => t.name.toLowerCase() === low) || S.tracks.find(t => t.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
    if (exact) return exact;
    const byInst = S.tracks.filter(t => t.inst === resolveInst(r));
    if (byInst.length === 1) return byInst[0];
    if (byInst.length > 1) throw new Error('"' + r + '" matches several parts (' + byInst.map(t => t.id).join(', ') + '); use a part id');
    return null;
  }
  function resolveInst(name) {
    if (!name) return null; const n = String(name).toLowerCase().trim();
    if (T.INSTR[n]) return n;
    const alias = { 'french horn': 'horn', horns: 'horn', 'double bass': 'contrabass', 'string bass': 'contrabass', basses: 'contrabass', violins: 'violin', cellos: 'cello', violoncello: 'cello', violas: 'viola', drums: 'percussion', snare: 'percussion', cymbal: 'percussion', cymbals: 'percussion', glock: 'glockenspiel', 'string section': 'strings', 'string ensemble': 'strings', pizz: 'pizzicato', 'pizzicato strings': 'pizzicato', flutes: 'flute', oboes: 'oboe', clarinets: 'clarinet', bassoons: 'bassoon', trumpets: 'trumpet', trombones: 'trombone', tubas: 'tuba', harps: 'harp', 'grand piano': 'piano' };
    if (alias[n]) return alias[n];
    return Object.keys(T.INSTR).find(k => T.INSTR[k].name.toLowerCase() === n) || null;
  }
  function tracksArg(arg) {
    if (arg == null || arg === 'all' || (Array.isArray(arg) && arg.includes('all'))) return S.tracks.slice();
    const list = Array.isArray(arg) ? arg : [arg];
    return list.map(x => { const t = resolveTrack(x); if (!t) throw new Error('Unknown part "' + x + '". Part ids: ' + S.tracks.map(t => t.id).join(', ')); return t; });
  }
  const num = (v, name, lo, hi) => { const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(name + ' must be a number'); if ((lo != null && x < lo) || (hi != null && x > hi)) throw new Error(name + ' must be between ' + lo + ' and ' + hi); return x; };
  const bool = (v, name) => { if (typeof v === 'boolean') return v; if (v === 'true' || v === 1) return true; if (v === 'false' || v === 0) return false; throw new Error(name + ' must be true or false'); };
  function range(o) {
    const n = S.L.nBars;
    const a1 = o.from_bar != null ? Math.round(num(o.from_bar, 'from_bar')) : 1;
    const b1 = o.to_bar != null ? Math.round(num(o.to_bar, 'to_bar')) : (o.from_bar != null ? a1 : n);
    if (a1 > b1) throw new Error('from_bar (' + a1 + ') is after to_bar (' + b1 + ')');
    if (a1 < 1 || b1 > n) throw new Error('bars must be between 1 and ' + n);
    const a = a1 - 1, b = b1 - 1;
    return { a, b, ta: a * bt(), tb: (b + 1) * bt(), label: a === 0 && b === n - 1 ? 'whole piece' : (a === b ? 'bar ' + (a + 1) : 'bars ' + (a + 1) + '–' + (b + 1)) };
  }
  const inR = (n, r) => n.s >= r.ta && n.s < r.tb;
  function velOf(x) { if (typeof x === 'number' && Number.isFinite(x)) return clamp(Math.round(x), 1, 127); const v = DYN[String(x).toLowerCase()]; if (v == null) throw new Error('Unknown dynamic "' + x + '" (use pp p mp mf f ff or 1–127)'); return v; }
  function parseP(p) { const v = typeof p === 'number' ? p : T.parsePitch(String(p).replace('♯', '#').replace('♭', 'b')); if (v == null || !Number.isFinite(v)) throw new Error('Bad pitch "' + p + '" (use names like C4, F#5, Bb3 or MIDI numbers)'); if (v < 0 || v > 127) throw new Error('Pitch ' + p + ' is outside MIDI 0–127'); return Math.round(v); }
  const rangeName = inst => T.pitchName(inst.range[0], flats()) + '–' + T.pitchName(inst.range[1], flats());

  const NOTES_TEXT_CAP = 26000; // tool results must stay under 32 KB
  function notesText(tracks, r) {
    const lines = []; let bytes = 0;
    const push = l => { bytes += l.length + 1; lines.push(l); };
    for (const t of tracks) {
      const drum = T.INSTR[t.inst]?.drums;
      push(`# ${t.id} (${t.name}, ${T.INSTR[t.inst]?.name || t.inst})${t.locked ? ' [locked]' : ''}`);
      for (let b = r.a; b <= r.b; b++) {
        const ns = t.notes.filter(n => n.s >= b * bt() && n.s < (b + 1) * bt());
        const l = ns.length ? `bar ${b + 1}: ` + ns.map(n => `${drum ? (T.DRUMS[n.p] || n.p) + '(' + n.p + ')' : T.pitchName(n.p, flats())}@${+(1 + (n.s - b * bt()) / PPQ).toFixed(3)}:${+(n.d / PPQ).toFixed(3)}v${n.v}`).join(' ') : `bar ${b + 1}: rest`;
        if (bytes + l.length > NOTES_TEXT_CAP) { push(`…truncated at bar ${b + 1} of ${t.id}. Ask for fewer parts or bars.`); return lines.join('\n'); }
        push(l);
      }
    }
    return lines.join('\n');
  }

  function overview() {
    const st = S.st, L = S.L;
    const ts = L.ts;
    const lines = [];
    const shownTempo = Math.round(Notation.beatTempo(st, ts));
    const unit = ts.compound ? 'dotted-quarter beats' : ts.den === 8 ? 'eighth notes' : 'quarter notes';
    lines.push(`Title: ${S.title}. Arrangement type: ${st.mode}${st.mode === 'orchestra' ? ' (' + st.ensemble + ' ensemble)' : ''}, style ${st.style}.`);
    lines.push(`Key ${T.keyName(L.key)} (recording was in ${T.keyName(S.an.key)}). Time signature ${ts.num}/${ts.den}. Tempo ${shownTempo} ${unit} per minute (the settings op takes this same number). ${L.nBars} bars. Playback timing: ${st.timing === 'original' ? 'follows the recording' : 'steady tempo'}. Phrasing ${st.phrasing}, dynamics ${st.dynamics}, faithful↔creative ${st.fidelity}/100, swing ${st.swing ? 'on' : 'off'}.`);
    lines.push('Sections (letters as shown in the score; orchestration level 0 = softest/sparsest, 3 = tutti): ' + S.P.phrases.map(p => `${p.letter} bars ${p.a + 1}–${p.b} level ${p.level}`).join('; '));
    const chordLine = [];
    const maxB = Math.min(L.nBars, 128);
    for (let b = 0; b < maxB; b++) {
      const cs = L.chords.filter(c => c.s >= b * bt() && c.s < (b + 1) * bt() && c.type !== 'N');
      const first = Arranger.chordAt(L, b * bt());
      const items = cs.length && cs[0].s === b * bt() ? cs : [first, ...cs];
      chordLine.push(`${b + 1}: ` + items.map(c => T.chordName(c, flats()) + (c.s > b * bt() ? '@' + (+(1 + (c.s - b * bt()) / PPQ).toFixed(2)) : '')).join(' '));
    }
    lines.push('Chords by bar: ' + chordLine.join(' | ') + (L.nBars > maxB ? ` | (bars ${maxB + 1}–${L.nBars} not listed)` : ''));
    const mel = []; const maxM = Math.min(L.nBars, 64);
    for (let b = 0; b < maxM; b++) { const ns = L.melody.filter(n => n.s >= b * bt() && n.s < (b + 1) * bt()); mel.push(`${b + 1}: ${ns.map(n => T.pitchName(n.p, flats())).join(' ') || '—'}`); }
    lines.push('Analysed melody pitches by bar: ' + mel.join(' | ') + (L.nBars > maxM ? ` | (bars ${maxM + 1}–${L.nBars} not listed; use get_notes)` : ''));
    lines.push('Parts:');
    for (const t of S.tracks) {
      const inst = T.INSTR[t.inst]; const ps = t.notes.map(n => n.p);
      lines.push(`- ${t.id}: "${t.name}", instrument ${t.inst}${inst.drums ? ' (unpitched; GM drum numbers 36 bass drum, 38 snare, 49 crash, 51 suspended cymbal, 81 triangle)' : `, range ${rangeName(inst)}, plays up to ${inst.poly || 1} note${(inst.poly || 1) > 1 ? 's' : ''} at once`}; ${t.notes.length} notes${ps.length && !inst.drums ? ', currently ' + T.pitchName(Math.min(...ps), flats()) + '–' + T.pitchName(Math.max(...ps), flats()) : ''}; volume ${(+t.vol).toFixed(2)}, pan ${(+(t.pan || 0)).toFixed(2)}${t.mute ? ', muted' : ''}${t.solo ? ', soloed' : ''}${t.locked ? ', locked (user-edited)' : ''}.`);
    }
    if ((st.removed || []).length) lines.push('Parts the user removed (do not bring back unless asked): ' + st.removed.join(', '));
    return lines.join('\n');
  }

  const RULES = `You are the arranging assistant inside Music Arranger, a web app that transcribes an audio recording and turns it into an editable piano or orchestral arrangement. You change the arrangement only through the app's tools; the app applies your edits exactly as written.

Conventions
- Bars are numbered from 1. "beat" is the quarter-note position inside the bar starting at 1 (1.5 = the "and" of beat 1, 2.333 = second triplet of beat 2). "dur" is in quarter notes. In 6/8 a bar has 3 quarter-note beats.
- Pitches use scientific names (C4 = middle C, F#5, Bb3) or MIDI numbers. Velocity 1–127 (pp≈40, p≈52, mp≈64, mf≈78, f≈94, ff≈108).
- Parts are referred to by their id (e.g. v1, rh, hn).

Edit operations for apply_edits (each item is an object with "op"):
- replace_notes {track, from_bar, to_bar, notes:[{bar, beat, pitch, dur, vel}]} replaces every note that starts in those bars with exactly these notes.
- transpose {tracks, from_bar, to_bar, semitones}
- dynamics {tracks, from_bar, to_bar, from, to} sets velocities, changing gradually from "from" to "to" (same value = flat level). Values: pp p mp mf f ff or numbers.
- scale_velocity {tracks, from_bar, to_bar, factor}
- articulation {tracks, from_bar, to_bar, style: legato|natural|detached|staccato}
- copy {from_track, to_track, from_bar, to_bar, semitones, replace} doubles a passage in another part; to_track may be "new:<instrument>". By default the copied notes are added to what the target already plays; replace=true clears the target bars first.
- move {from_track, to_track, from_bar, to_bar, semitones, replace} hands a passage to another part and removes it from the source. Same replace rule as copy.
  Copy and move shift the passage by whole octaves to fit the target's range and keep only as many simultaneous notes as the target can play.
- clear {tracks, from_bar, to_bar}
- regenerate {track, from_bar, to_bar, role, style} re-arranges a part (or just those bars) from the analysed melody and chords. role: mel, mel8va, mel8vb, counter, harmA, harmT, pad2, chord3, arp, strum, bass, bass8vb, timp, perc, rest. style: classical romantic pop jazz baroque minimalist cinematic light epic.
- add_part {instrument, role, from_bar, to_bar, name}. Instruments: piano violin viola cello contrabass strings pizzicato flute oboe clarinet bassoon horn trumpet trombone tuba timpani percussion harp glockenspiel.
- remove_part {track}
- set_instrument {track, instrument}
- mix {track, volume (0–1), pan (-1..1), mute, solo}
- settings {tempo, key ("Eb major"), time_signature (2/4 3/4 4/4 5/4 6/8 9/8 12/8), style, ensemble (full|chamber|strings|winds), phrasing (legato|natural|detached|staccato), dynamics (follow|expanded|compressed|gentle|powerful), fidelity (0–100), swing (true/false)}. tempo is in the same beat units as the overview. This is global and regenerates every unlocked part.
- humanize {tracks, from_bar, to_bar, amount (0–1)}
- quantize {tracks, from_bar, to_bar, grid ("1/8", "1/16", "1/8T")}
"tracks" may be a list of ids or "all". Leaving out from_bar/to_bar means the whole piece.

How to work
1. Use the overview below. If you need the actual notes of a passage, call get_notes for only the parts and bars you need.
2. Call apply_edits with all edits in one list. If the result reports an error, fix it with another call.
3. Then answer the user in one to three short sentences: what changed, in which parts and bars. Plain text, no headings or lists.

Rules
- Change only what the user asked for. Do not touch other parts or bars unless the request needs it, so the rest of the arrangement stays as it is.
- Keep every part idiomatic and inside its instrument's range (given per part in the overview). replace_notes refuses notes outside the range, and wind and brass parts play one note at a time.
- Keep the melody, harmony and character of the original recording unless the user asks for reinterpretation. When they do, be musical and stay in the current key and meter unless told otherwise.
- Prefer high-level operations (regenerate, move, copy, transpose, dynamics, articulation). Use replace_notes for specific rewrites such as a reharmonised passage, a new countermelody or an ornament, and include every note in the replaced bars.
- Words like "here", "this part" or "these bars" refer to the current selection given with the request.
- If a request is ambiguous, make a sensible musical choice and say what you chose. If it is impossible, say so briefly. If the user says notes are wrong, remember the transcription can contain errors and fix the specific bars.`;

  // ------------------------------------------------------------------ apply edits
  const MAX_OPS = 200, MAX_NOTES = 4000;
  const STYLES_ALL = () => (S.st.mode === 'piano' ? Arranger.PIANO_STYLES : Arranger.ORCH_STYLES);
  const enumOf = (v, list, name) => { const x = String(v).toLowerCase(); if (!list.includes(x)) throw new Error(name + ' must be one of: ' + list.join(', ')); return x; };
  // keep a passage's contour, shifting it by whole octaves into the target range; returns how many notes still had to be folded
  function fitPassage(ns, inst) {
    if (inst.drums || !ns.length) return { ns, folded: 0 };
    const rg = inst.range; let k = 0, best = -1;
    for (let o = -3; o <= 3; o++) { const c = ns.filter(n => n.p + 12 * o >= rg[0] && n.p + 12 * o <= rg[1]).length - Math.abs(o) * 0.01; if (c > best) { best = c; k = o; } }
    let folded = 0;
    const out = ns.map(n => { const p0 = n.p + 12 * k, p = T.fitRange(p0, rg); if (p !== p0) folded++; return { ...n, p }; });
    return { ns: out, folded };
  }
  // a single wind/brass player can't play chords: keep the top note at each onset
  function limitPoly(ns, inst) {
    const poly = inst.poly || 1; if (poly >= 4) return { ns, dropped: 0 };
    const by = new Map(); ns.forEach(n => { if (!by.has(n.s)) by.set(n.s, []); by.get(n.s).push(n); });
    let dropped = 0; const out = [];
    for (const [, g] of by) { g.sort((a, b) => b.p - a.p); out.push(...g.slice(0, poly)); dropped += Math.max(0, g.length - poly); }
    return { ns: out.sort((a, b) => a.s - b.s), dropped };
  }
  function applyEdits(edits) {
    const done = [], errors = [];
    if (!Array.isArray(edits)) return { done, errors: ['"edits" must be a list of operations'] };
    if (edits.length > MAX_OPS) return { done, errors: ['Too many operations (' + edits.length + '); send at most ' + MAX_OPS + ' at a time'] };
    const touched = new Set();
    let settingsPrev = null;
    const before = U.clone({ tracks: S.tracks, st: S.st });
    for (const [i, e] of edits.entries()) {
      try {
        if (!e || typeof e !== 'object') throw new Error('each edit must be an object with an "op"');
        const op = String(e.op || '').toLowerCase();
        if (op === 'replace_notes') {
          const t = resolveTrack(e.track, true); if (!t) throw new Error('Unknown part "' + e.track + '"');
          const r = range(e); const inst = T.INSTR[t.inst];
          if (!Array.isArray(e.notes)) throw new Error('"notes" must be a list');
          if (e.notes.length > MAX_NOTES) throw new Error('too many notes (' + e.notes.length + '); replace fewer bars at a time');
          const add = []; let outOfRange = 0;
          const barQ = bt() / PPQ;
          for (const n of e.notes) {
            const bar = Math.round(num(n.bar ?? (r.a + 1), 'bar')) - 1; const beat = num(n.beat ?? 1, 'beat'); const dur = num(n.dur ?? 1, 'dur');
            if (bar < r.a || bar > r.b) throw new Error('a note in bar ' + (bar + 1) + ' is outside ' + r.label);
            if (beat < 1 || beat >= 1 + barQ) throw new Error('beat ' + beat + ' is outside bar ' + (bar + 1) + ' (beats 1 to ' + (1 + barQ - 0.001).toFixed(2) + ')');
            if (dur <= 0 || dur > 64) throw new Error('dur must be greater than 0 (quarter notes)');
            const p = parseP(n.pitch);
            if (!inst.drums && (p < inst.range[0] || p > inst.range[1])) outOfRange++;
            const s0 = Math.round((bar * bt() + (beat - 1) * PPQ) / 10) * 10;
            add.push({ id: Arranger.nid(), p, s: s0, d: Math.round(dur * PPQ), v: velOf(n.vel ?? 80) });
          }
          if (outOfRange) throw new Error(outOfRange + ' note' + (outOfRange > 1 ? 's are' : ' is') + ' outside the ' + inst.name.toLowerCase() + '’s range (' + rangeName(inst) + '); nothing was changed for this part');
          t.notes = t.notes.filter(n => !inR(n, r)).concat(add).sort((a, b) => a.s - b.s);
          touched.add(t); done.push(`${t.name}: rewrote ${r.label} (${add.length} notes)`);
        } else if (op === 'transpose') {
          const r = range(e); const st = Math.round(num(e.semitones, 'semitones', -48, 48)); let folded = 0;
          for (const t of tracksArg(e.tracks)) { const inst = T.INSTR[t.inst]; if (inst.drums) continue; t.notes.forEach(n => { if (!inR(n, r)) return; const p0 = n.p + st, p = T.fitRange(p0, inst.range); if (p !== p0) folded++; n.p = p; }); touched.add(t); }
          done.push(`Transposed ${trackNames(e.tracks)} ${st > 0 ? 'up' : 'down'} ${Math.abs(st)} semitone${Math.abs(st) === 1 ? '' : 's'}, ${r.label}` + (folded ? ` (${folded} note${folded > 1 ? 's' : ''} moved by an octave to stay in range)` : ''));
        } else if (op === 'dynamics') {
          const r = range(e); const v0 = velOf(e.from ?? e.level ?? 'mf'), v1 = velOf(e.to ?? e.from ?? e.level ?? 'mf');
          for (const t of tracksArg(e.tracks)) {
            const ns = t.notes.filter(n => inR(n, r)); if (!ns.length) continue;
            const base = ns.reduce((s2, n) => s2 + n.v, 0) / ns.length;
            ns.forEach(n => { const f = (n.s - r.ta) / (r.tb - r.ta); const target = v0 + (v1 - v0) * f; n.v = clamp(Math.round(target + (n.v - base) * 0.35), 1, 127); });
            touched.add(t);
          }
          done.push(`Dynamics ${e.from ?? e.level ?? ''}${e.to && e.to !== e.from ? '→' + e.to : ''} for ${trackNames(e.tracks)}, ${r.label}`);
        } else if (op === 'scale_velocity') {
          const r = range(e); const f = num(e.factor, 'factor', 0.05, 4);
          for (const t of tracksArg(e.tracks)) { t.notes.forEach(n => { if (inR(n, r)) n.v = clamp(Math.round(n.v * f), 1, 127); }); touched.add(t); }
          done.push(`Velocity ×${f} for ${trackNames(e.tracks)}, ${r.label}`);
        } else if (op === 'articulation') {
          const r = range(e); const style = enumOf(e.style || 'natural', ['legato', 'natural', 'tenuto', 'detached', 'staccato', 'staccatissimo', 'marcato'], 'style');
          const fac = { legato: 1, natural: 0.9, tenuto: 0.97, detached: 0.7, staccato: 0.4, staccatissimo: 0.25, marcato: 0.75 }[style];
          for (const t of tracksArg(e.tracks)) {
            const ns = t.notes.filter(n => inR(n, r)).sort((a, b) => a.s - b.s);
            ns.forEach((n, k) => {
              const next = ns.slice(k + 1).find(m => m.s > n.s);
              const gap = next ? next.s - n.s : n.d;
              if (style === 'legato') n.d = next && gap <= PPQ * 2 ? gap : n.d;
              else n.d = Math.max(40, Math.round(Math.min(n.d, gap) * fac));
              if (style === 'marcato') n.v = clamp(n.v + 10, 1, 127);
            });
            touched.add(t);
          }
          done.push(`${style[0].toUpperCase() + style.slice(1)} articulation for ${trackNames(e.tracks)}, ${r.label}`);
        } else if (op === 'copy' || op === 'move') {
          const src = resolveTrack(e.from_track); if (!src) throw new Error('Unknown part "' + e.from_track + '"');
          const dst = resolveTrack(e.to_track, true); if (!dst) throw new Error('Unknown part "' + e.to_track + '"');
          if (src === dst) throw new Error('from_track and to_track are the same part');
          const r = range(e); const st = Math.round(num(e.semitones ?? 0, 'semitones', -48, 48));
          const dInst = T.INSTR[dst.inst];
          let ns = src.notes.filter(n => inR(n, r)).map(n => ({ ...n, id: Arranger.nid(), p: n.p + st }));
          const fit = fitPassage(ns, dInst); ns = fit.ns;
          const lim = limitPoly(ns, dInst); ns = lim.ns;
          const replace = e.replace != null ? bool(e.replace, 'replace') : false;
          if (replace) dst.notes = dst.notes.filter(n => !inR(n, r));
          dst.notes = dst.notes.concat(ns).sort((a, b) => a.s - b.s);
          if (op === 'move') { src.notes = src.notes.filter(n => !inR(n, r)); touched.add(src); }
          touched.add(dst);
          done.push(`${op === 'move' ? 'Moved' : 'Copied'} ${src.name} → ${dst.name}, ${r.label}` + (lim.dropped ? ` (kept the top line: ${dst.name} plays ${dInst.poly || 1} note${(dInst.poly || 1) > 1 ? 's' : ''} at once)` : '') + (fit.folded ? ` (${fit.folded} notes folded into range)` : ''));
        } else if (op === 'clear') {
          const r = range(e); for (const t of tracksArg(e.tracks)) { t.notes = t.notes.filter(n => !inR(n, r)); touched.add(t); }
          done.push(`Cleared ${trackNames(e.tracks)}, ${r.label}`);
        } else if (op === 'regenerate') {
          const t = resolveTrack(e.track); if (!t) throw new Error('Unknown part "' + e.track + '"');
          const r = range(e);
          const roles = Arranger.rolesFor(t.inst);
          if (e.role != null && !roles.includes(String(e.role))) throw new Error('role for ' + t.name + ' must be one of: ' + roles.join(', '));
          if (e.style != null) enumOf(e.style, STYLES_ALL(), 'style for ' + S.st.mode);
          const st = e.style ? { ...S.st, style: String(e.style).toLowerCase() } : S.st;
          let notes;
          if (e.role || t.custom) notes = Arranger.generateRole(S.an, st, e.role || t.role, t.inst, { fromBar: r.a, toBar: r.b, seed: (S.st.seed || 0) + i + 1 });
          else notes = Arranger.clean(Arranger.generate(S.an, st, t.id, { ...Arranger.context(S.an, st), instKey: t.inst }));
          t.notes = t.notes.filter(n => !inR(n, r)).concat(notes.filter(n => inR(n, r))).sort((a, b) => a.s - b.s);
          touched.add(t); done.push(`Regenerated ${t.name}${e.role ? ' as ' + e.role : ''}${e.style ? ' (' + e.style + ')' : ''}, ${r.label}`);
        } else if (op === 'add_part') {
          const inst = resolveInst(e.instrument); if (!inst) throw new Error('Unknown instrument "' + e.instrument + '". Use one of: ' + Object.keys(T.INSTR).join(', '));
          const r = range(e); const role = String(e.role || 'mel');
          const roles = Arranger.rolesFor(inst); if (!roles.includes(role)) throw new Error('role for ' + T.INSTR[inst].name + ' must be one of: ' + roles.join(', '));
          const t = U.addPart(inst, role, r.a, r.b, e.name ? String(e.name).slice(0, 40) : undefined);
          S.st.removed = (S.st.removed || []).filter(id => id !== t.id);
          touched.add(t); done.push(`Added ${t.name} (${role}), ${r.label}`);
        } else if (op === 'remove_part') {
          const t = resolveTrack(e.track); if (!t) throw new Error('Unknown part "' + e.track + '"');
          S.tracks = S.tracks.filter(x => x !== t); if (S.active === t.id) S.active = S.tracks[0]?.id;
          if (!t.custom) S.st.removed = [...new Set([...(S.st.removed || []), t.id])];
          done.push(`Removed ${t.name}`);
        } else if (op === 'set_instrument') {
          const t = resolveTrack(e.track); if (!t) throw new Error('Unknown part "' + e.track + '"');
          const inst = resolveInst(e.instrument); if (!inst) throw new Error('Unknown instrument "' + e.instrument + '"');
          if (!!T.INSTR[inst].drums !== !!T.INSTR[t.inst].drums) throw new Error('cannot switch between pitched and unpitched instruments');
          const old = t.name; U.swapInstrument(t, inst); touched.add(t);
          done.push(`${old} now played by ${T.INSTR[inst].name}` + (t.name !== old ? ` (renamed ${t.name})` : ''));
        } else if (op === 'mix') {
          const t = resolveTrack(e.track); if (!t) throw new Error('Unknown part "' + e.track + '"');
          const nv = e.volume != null ? num(e.volume, 'volume', 0, 1) : t.vol, np = e.pan != null ? num(e.pan, 'pan', -1, 1) : t.pan;
          const nm = e.mute != null ? bool(e.mute, 'mute') : t.mute, ns2 = e.solo != null ? bool(e.solo, 'solo') : t.solo;
          t.vol = nv; t.pan = np; t.mute = nm; t.solo = ns2;
          done.push(`Mix changed for ${t.name}`);
        } else if (op === 'settings') {
          const st = U.clone(S.st);
          if (e.tempo != null) { const v = num(e.tempo, 'tempo', 20, 300); st.tempo = T.timeSig(st.ts.num, st.ts.den).compound ? v * 1.5 : v; }
          if (e.key != null) { const k = parseKey(e.key); if (!k) throw new Error('Unknown key "' + e.key + '" (use e.g. "Eb major" or "F# minor")'); st.key = k; }
          if (e.time_signature != null) {
            const m = /^(\d+)\/(\d+)$/.exec(String(e.time_signature).trim());
            const ok = ['2/4', '3/4', '4/4', '5/4', '6/8', '9/8', '12/8'];
            if (!m || !ok.includes(m[1] + '/' + m[2])) throw new Error('time_signature must be one of: ' + ok.join(', '));
            const wasC = T.timeSig(st.ts.num, st.ts.den).compound; st.ts = { num: +m[1], den: +m[2] }; const isC = T.timeSig(st.ts.num, st.ts.den).compound;
            if (!wasC && isC) st.tempo = Math.round(st.tempo * 1.5); else if (wasC && !isC) st.tempo = Math.round(st.tempo / 1.5);
            if (!U.isOriginalMeter(st.ts.num, st.ts.den)) st.timing = 'arranged';
          }
          if (e.style != null) st.style = enumOf(e.style, STYLES_ALL(), 'style for ' + st.mode);
          if (e.ensemble != null) { if (st.mode !== 'orchestra') throw new Error('ensemble only applies to orchestral arrangements'); st.ensemble = enumOf(e.ensemble, ['full', 'chamber', 'strings', 'winds'], 'ensemble'); }
          if (e.phrasing != null) st.phrasing = enumOf(e.phrasing, ['legato', 'natural', 'detached', 'staccato'], 'phrasing');
          if (e.dynamics != null) st.dynamics = enumOf(e.dynamics, ['follow', 'expanded', 'compressed', 'gentle', 'powerful'], 'dynamics');
          if (e.fidelity != null) st.fidelity = Math.round(num(e.fidelity, 'fidelity', 0, 100));
          if (e.swing != null) st.swing = bool(e.swing, 'swing');
          if (!settingsPrev) settingsPrev = U.clone(S.st);
          S.st = st;
          done.push('Settings: ' + Object.keys(e).filter(k => k !== 'op').map(k => k + ' ' + JSON.stringify(e[k])).join(', '));
        } else if (op === 'humanize') {
          const r = range(e); const amt = num(e.amount ?? 0.4, 'amount', 0, 1); const rnd = T.rng(Date.now() & 0xffff);
          for (const t of tracksArg(e.tracks)) { t.notes.forEach(n => { if (!inR(n, r)) return; n.s = Math.max(0, n.s + Math.round((rnd() - 0.5) * 30 * amt)); n.v = clamp(Math.round(n.v + (rnd() - 0.5) * 16 * amt), 1, 127); }); touched.add(t); }
          done.push(`Humanised ${trackNames(e.tracks)}, ${r.label}`);
        } else if (op === 'quantize') {
          const r = range(e); const key = String(e.grid || '1/16').toLowerCase();
          const g = { '1/4': 480, '1/8': 240, '1/16': 120, '1/8t': 160, '1/16t': 80 }[key];
          if (!g) throw new Error('grid must be one of: 1/4, 1/8, 1/16, 1/8T, 1/16T');
          for (const t of tracksArg(e.tracks)) { t.notes.forEach(n => { if (!inR(n, r)) return; const s0 = Math.round(n.s / g) * g; const en = Math.max(s0 + g, Math.round((n.s + n.d) / g) * g); n.s = s0; n.d = en - s0; }); touched.add(t); }
          done.push(`Quantised ${trackNames(e.tracks)} to ${e.grid || '1/16'}, ${r.label}`);
        } else throw new Error('Unknown op "' + e.op + '"');
      } catch (err) { errors.push(`edit ${i + 1} (${e && e.op}): ${err.message}`); }
    }
    for (const t of touched) { if (S.tracks.includes(t)) { U.markEdited(t); } }
    if (settingsPrev) {
      try { U.applySettings(settingsPrev, 'chat'); U.fillSettings(); }
      catch (err) { // never leave a half-applied settings change behind
        S.tracks = before.tracks; S.st = before.st; U.relead(); U.fillSettings(); U.changed();
        return { done: [], errors: errors.concat(['settings could not be applied (' + err.message + '); no changes were made']) };
      }
    }
    else U.changed();
    return { done, errors };
  }
  function trackNames(arg) { try { const ts = tracksArg(arg); return ts.length === S.tracks.length && S.tracks.length > 2 ? 'all parts' : ts.map(t => t.name).join(', '); } catch (e) { return String(arg); } }
  function parseKey(s) {
    const m = /^\s*([A-Ga-g])([#b♯♭]?)\s*(major|minor|maj|min|m)?\s*$/i.exec(String(s)); if (!m) return null;
    let pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()]; if (m[2] === '#' || m[2] === '♯') pc++; if (m[2] === 'b' || m[2] === '♭') pc--;
    const mode = /^(minor|min|m)$/i.test(m[3] || '') ? 'minor' : 'major'; return { tonic: (pc + 12) % 12, mode };
  }

  // ------------------------------------------------------------------ chat
  function scopeText() {
    const parts = [];
    if (S.loop) parts.push(`Selected bars: ${Math.floor(S.loop.a / bt()) + 1}–${Math.round(S.loop.b / bt())}.`);
    const t = U.activeTrack(); if (t) parts.push(`Part open in the editor: ${t.id} (${t.name}).`);
    return parts.join(' ');
  }
  function updateScope() {
    if (!S.L) return;
    const t = U.activeTrack();
    const items = [];
    if (S.loop) items.push(`<span class="tag" id="scopeBars" title="Clear the bar selection">Bars ${Math.floor(S.loop.a / bt()) + 1}–${Math.round(S.loop.b / bt())} ✕</span>`);
    else items.push('<span>Drag on the bar ruler to point at specific bars.</span>');
    if (t) items.push(`<span class="tag">${esc(t.name)}</span>`);
    $('scope').innerHTML = items.join('');
    const sb = document.getElementById('scopeBars'); if (sb) sb.onclick = () => { S.loop = null; S.loopOn = false; $('loopBtn').setAttribute('aria-pressed', 'false'); Player.setLoop(null); U.roll.draw(); updateScope(); };
  }
  function chips() {
    return S.st.mode === 'piano'
      ? ['Simplify the left hand in the first phrase', 'Reharmonise the last 4 bars with jazz chords', 'Melody an octave higher in the final section', 'More legato, with a gentler touch']
      : ['Give the melody to the oboe in bars 1–4', 'Add a horn countermelody in section B', 'Build a crescendo into the final section', 'Take out the percussion and soften the brass'];
  }
  function renderChat() {
    const box = $('msgs'); if (!box || !S.st) return;
    let html = '';
    if (!S.chat.length) {
      html += `<div class="msg sys">Describe a change in plain words. The assistant reads the arrangement and edits only the parts and bars you mention. Each change can be undone.</div>`;
      html += `<div class="chips">${chips().map(c => `<button class="chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
    }
    S.chat.forEach((m, i) => {
      if (m.role === 'user') html += `<div class="msg me">${esc(m.content)}</div>`;
      else if (m.role === 'assistant') {
        html += `<div class="msg ai">${esc(m.content || '')}${m.changes && m.changes.length ? `<div class="chg">${m.changes.map(c => '• ' + esc(c)).join('<br>')}</div>` : ''}${m.errors && m.errors.length ? `<div class="chg" style="color:var(--warn)">${m.errors.map(c => '• ' + esc(c)).join('<br>')}</div>` : ''}
          <div class="acts">${m.undoId != null && !m.undone ? `<button class="btn sm" data-undo="${i}">Undo this change</button>` : m.undone && m.changes?.length ? `<span class="hint">${m.lost ? 'No longer undoable' : 'Undone'}</span>` : ''}${m.firstBar != null ? `<button class="btn sm ghost" data-play="${m.firstBar}">Play from bar ${m.firstBar + 1}</button>` : ''}</div></div>`;
      } else html += `<div class="msg sys">${esc(m.content)}</div>`;
    });
    if (busy) html += `<div class="msg ai" id="thinking">${esc(busy.text || 'Thinking…')}<div class="acts"><button class="btn sm" id="chatStop">Stop</button></div></div>`;
    if (capsReady && !sample) html += `<div class="msg sys">The assistant needs Claude, which is available when this page is opened on claude.ai. Editing, playback and export all work without it.</div>`;
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
    $('chatSend').disabled = !!busy || (capsReady && !sample);
    $('chatIn').disabled = capsReady && !sample;
  }
  let busy = null;
  async function send(text) {
    text = String(text || '').trim(); if (!text || busy || !S.L) return;
    if (!sample) { toast('The assistant is not available in this view.'); return; }
    $('chatIn').value = '';
    S.chat.push({ role: 'user', content: text });
    const ctl = new AbortController();
    busy = { ctl, text: 'Thinking…' }; renderChat();
    let undoId = null; const allDone = [], allErr = [];
    let streamed = '', lastToolAt = 0;
    const doApply = (edits) => {
      const id = U.pushUndo('Assistant: ' + text.slice(0, 40));
      const r = applyEdits(edits);
      if (!r.done.length) { S.undo.pop(); } // nothing changed: no undo step
      else if (undoId == null) undoId = id;
      else { const k = S.undo.findIndex(u => u.id === id); if (k >= 0) S.undo.splice(k, 1); } // one request = one undo step
      allDone.push(...r.done); allErr.push(...r.errors);
      if (busy) { busy.text = 'Applied ' + allDone.length + ' change' + (allDone.length === 1 ? '' : 's') + '…'; renderChat(); }
      return r;
    };
    try {
      // everything that can throw lives inside try, so the composer can never get stuck
      const history = S.chat.filter(m => m.role === 'user' || m.role === 'assistant').slice(-12).map(m => ({ role: m.role, content: m.role === 'assistant' ? (m.content || '(no reply)') + (m.changes?.length ? '\n[Applied: ' + m.changes.join('; ') + ']' : '') + (m.errors?.length ? '\n[Problems: ' + m.errors.join('; ') + ']' : '') : m.content }));
      const last = history.pop();
      const turns = [{ role: 'user', content: RULES }, ...history, { role: 'user', content: `Current arrangement overview:\n${overview()}\n\n${scopeText()}\n\nRequest: ${last.content}` }];
      let reply;
      if (toolsOK) {
        const cap = str => str.length > 30000 ? str.slice(0, 30000) + '…(truncated)' : str;
        const tools = [
          { name: 'get_notes', description: 'Returns the notes of the given parts and bar range as text lines "bar N: PITCH@BEAT:DURvVEL ...". Use only the parts and bars you need.', inputSchema: { type: 'object', properties: { tracks: { type: 'array', items: { type: 'string' }, description: 'part ids, or ["all"]' }, from_bar: { type: 'integer' }, to_bar: { type: 'integer' } }, required: ['tracks'] }, execute: (inp) => { lastToolAt = streamed.length; const ts = tracksArg(inp.tracks); const r = range(inp); if (busy) { busy.text = 'Reading ' + r.label + '…'; renderChat(); } return notesText(ts, r); } },
          { name: 'apply_edits', description: 'Applies a list of edit operations (see the operation list in the instructions) to the arrangement as one undoable change. Returns what was applied and any errors.', inputSchema: { type: 'object', properties: { edits: { type: 'array', items: { type: 'object' } } }, required: ['edits'] }, execute: (inp) => { lastToolAt = streamed.length; const r = doApply(inp.edits); return cap(JSON.stringify({ applied: r.done, errors: r.errors })); } },
        ];
        const res = await sample(turns, { tools, signal: ctl.signal, onText: ({ text: t }) => { streamed = t; if (busy) { busy.text = t.slice(lastToolAt).trim() || 'Working…'; renderChatThinking(); } } });
        // the reply is everything written after the last tool call (the final round)
        reply = (res.text.slice(lastToolAt).trim() || res.text.split(/\n\n/).filter(Boolean).pop() || '').trim();
      } else {
        const r = S.loop ? range({ from_bar: Math.floor(S.loop.a / bt()) + 1, to_bar: Math.round(S.loop.b / bt()) }) : range({ from_bar: 1, to_bar: Math.min(S.L.nBars, 8) });
        const notes = notesText(S.tracks, r);
        const prompt = [...turns.slice(0, -1), { role: 'user', content: turns[turns.length - 1].content + `\n\nNotes of every part for ${r.label} (ask the user to select bars on the ruler if you need others):\n${notes}\n\nThis view cannot run tools. Reply with only a JSON object {"reply": "one to three sentences for the user", "edits": [ ...operations ]}.` }];
        const out = await sample.json(prompt, { signal: ctl.signal, cache: false });
        if (out && out.edits != null && !Array.isArray(out.edits)) allErr.push('The reply’s edits were not a list, so nothing was changed.');
        else if (out && Array.isArray(out.edits) && out.edits.length) doApply(out.edits);
        reply = out?.reply || '';
      }
      const firstBar = (() => { const m = /bars? (\d+)/.exec(allDone.join(' ')); return m ? +m[1] - 1 : null; })();
      S.chat.push({ role: 'assistant', content: reply || (allDone.length ? 'Done.' : 'I did not change anything.'), changes: allDone, errors: allErr, undoId, firstBar });
    } catch (e) {
      const code = e && e.code;
      const partial = code !== 'refused' && e && e.text ? (e.text.slice(lastToolAt).trim() || e.text) : '';
      if (allDone.length || partial) S.chat.push({ role: 'assistant', content: partial || (code === 'cancelled' ? 'Stopped after applying the changes below.' : 'Interrupted after applying the changes below.'), changes: allDone, errors: allErr, undoId });
      const SYS = {
        cancelled: 'Stopped.',
        not_granted: 'Claude access was not allowed for this page, so the assistant is off. Editing, playback and export still work.',
        sampling_disabled: 'Claude is not available for this account, so the assistant is off.',
        not_declared: 'This version of the page cannot reach Claude.', capability_disabled: 'Claude is switched off for this view.', capability_removed: 'This app version cannot reach Claude.',
        tools_unavailable: 'This view cannot run the assistant’s tools. Send the request again to use the simpler mode.',
        rate_limited: 'Too many requests right now, or a usage limit was reached. Wait a moment and send again.',
        refused: 'Claude declined that request. Try rephrasing it as a musical change.',
        invalid_json: 'The reply could not be read as edits. Try again, or ask for a smaller change.',
        prompt_too_large: 'This arrangement is too large to send in one request. Select fewer bars on the ruler, or ask about fewer parts.',
        session_expired: 'Your Claude session expired. Sign in again on claude.ai, then send the request again.',
        empty_completion: 'Claude returned an empty answer. Try rephrasing the request.',
      };
      if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) sample = null;
      if (code === 'tools_unavailable') toolsOK = false;
      const msg = SYS[code] || ('Something went wrong (' + (code || (e && e.message) || 'error') + '). ' + (allDone.length ? 'The changes listed above were applied and can be undone.' : 'Your arrangement is unchanged.'));
      if (code !== 'cancelled' || !allDone.length) S.chat.push({ role: 'system', content: msg });
    } finally {
      busy = null; renderChat(); scheduleSave();
    }
  }
  function renderChatThinking() { const el = document.getElementById('thinking'); if (el && busy) el.firstChild.textContent = busy.text.slice(-400); }
  function bindChat() {
    $('chatSend').onclick = () => send($('chatIn').value);
    $('chatIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('chatIn').value); } });
    $('msgs').addEventListener('click', e => {
      const c = e.target.closest('[data-chip]'); if (c) { $('chatIn').value = c.dataset.chip; $('chatIn').focus(); return; }
      if (e.target.id === 'chatStop' && busy) { busy.ctl.abort(); return; }
      const u = e.target.closest('[data-undo]');
      if (u) {
        const m = S.chat[+u.dataset.undo]; if (!m || m.undoId == null) return;
        const idx = S.undo.findIndex(x => x.id === m.undoId);
        if (idx < 0) { m.undone = true; m.lost = true; renderChat(); toast('That change is too far back in the history to undo.'); return; }
        const later = S.undo.length - idx - 1;
        if (later > 0 && !u.dataset.armed) { u.dataset.armed = '1'; u.textContent = 'Also undoes ' + later + ' later change' + (later > 1 ? 's' : '') + '. Click to confirm'; setTimeout(() => { if (u.isConnected) { delete u.dataset.armed; u.textContent = 'Undo this change'; } }, 6000); return; }
        U.undoTo(m.undoId); S.chat.forEach(c => { if (c.undoId != null && !S.undo.some(x => x.id === c.undoId)) c.undone = true; }); renderChat(); return;
      }
      const p = e.target.closest('[data-play]'); if (p) { U.seek(+p.dataset.play * bt()); U.startPlay(+p.dataset.play * bt()); }
    });
    $('clearChat').onclick = () => { S.chat = []; renderChat(); scheduleSave(); };
  }

  // ------------------------------------------------------------------ exports
  function baseName() { const b = (S.title || '').normalize('NFC').replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, ' ').replace(/\.+/g, '.').trim().replace(/\s+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80); return b || 'arrangement'; }
  function project() { return { title: S.title, st: S.st, L: S.L, P: S.P, tracks: S.tracks }; }
  function scoreSVG(opts = {}) {
    const stage = $('exportStage'); stage.innerHTML = '<div id="exportPaper"></div>';
    const abc = Notation.toABC(project(), { measuresPerLine: opts.mpl || 4, chords: true, chordsOnTop: true, subtitle: S.st.mode === 'piano' ? 'for piano' : 'Full score in C', composerLine: S.an.mode === 'score' ? (S.an.source?.composer || '') : 'Arranged from ' + (S.an.fileName || 'a recording').replace(/\.[a-z0-9]+$/i, '') });
    ABCJS.renderAbc('exportPaper', abc, { staffwidth: 1000, paddingleft: 20, paddingright: 20 });
    const svg = stage.querySelector('svg');
    if (!svg) return { abc, svg: '' };
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.querySelectorAll('[class]').forEach(el => el.removeAttribute('class'));
    const style = '<style>text{font-family:Georgia,serif}</style>';
    const s = svg.outerHTML.replace(/<svg([^>]*)>/, `<svg$1>${style}<rect width="100%" height="100%" fill="#ffffff"/>`);
    stage.innerHTML = '';
    return { abc, svg: s };
  }
  function scoreHTML(svg) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(S.title)} — score</title><style>body{margin:0;background:#fff;color:#111;font-family:Georgia,serif}main{max-width:1050px;margin:0 auto;padding:24px}svg{width:100%;height:auto}p{font-size:12px;color:#555}@media print{main{padding:0}p{display:none}}</style></head><body><main>${svg}<p>Generated by Music Arranger ${S.an.mode === 'score' ? 'from the tune “' + esc(S.an.fileName || '') + '”' : 'from an automatic transcription of ' + esc(S.an.fileName || 'a recording')}. Use your browser's Print command to save as PDF.</p></main></body></html>`;
  }
  function readme() {
    const an = S.an, ts = S.L.ts;
    const beat = Math.round(Notation.beatTempo(S.st, ts)), unit = ts.compound ? 'dotted-quarter' : ts.den === 8 ? 'eighth' : 'quarter';
    const orig = S.st.timing === 'original' && S.L.identity;
    return `${S.title}\n${'='.repeat(Math.max(4, S.title.length))}\n\nArranged in Music Arranger for ${S.st.mode === 'piano' ? 'piano' : S.st.ensemble + ' orchestra'} (${S.st.style} style).\nKey ${T.keyName(S.L.key)}, ${ts.num}/${ts.den}, ${beat} ${unit}-note beats per minute${S.st.swing ? ', swung eighths' : ''}, ${S.L.nBars} bars.\n\nFiles\n- ${baseName()}.mid: Standard MIDI file, one track per part with General MIDI programs.${orig ? ' It follows the recording’s timing (a tempo change on every beat); bar 1 is a silent lead-in as long as the recording’s intro, so the file lines up with the original audio from time zero.' : ''}${S.st.swing ? ' Off-beat eighths are delayed for swing.' : ''}\n- ${baseName()}.musicxml: open in MuseScore, Dorico, Finale or Sibelius. Clarinet and trumpet parts are written in B♭ and horns in F, with transposition information, so notation programs can switch to concert pitch.\n- ${baseName()}-score.svg / .html: the rendered score in concert pitch (the HTML prints to PDF from any browser).\n- ${baseName()}.abc: ABC notation source.\n\n${an.mode === 'score' ? `Source\n${an.fileName || 'Tune'}${an.source?.composer ? ' (' + an.source.composer + ')' : ''}, from ${({ library: 'the built-in song library', recall: 'a melody written out by Claude from memory; check it against the version you know', original: 'an original tune Claude composed from a description', edited: 'notation you edited' })[an.source?.kind] || 'notation'}.\nThe ABC source of the tune:\n\n${an.source?.abc || ''}\n` : `Source and transcription\nTranscribed from ${an.fileName || 'a recording'} with ${an.engine || 'automatic transcription'}.\nDetected tempo ${an.tempo} BPM, key ${T.keyName(an.key)}, ${an.beatsPerBar} beats per bar.\n${(an.warnings || []).map(w => '- ' + w).join('\n')}\n\nAutomatic transcription is a starting point. Inner voices in dense recordings, drums and timbre are not captured exactly.\n`}`;
  }
  async function save(filename, data, label) {
    if (!downloads) { toast(capsReady ? 'Downloads aren’t available here. Open this page on claude.ai to save files.' : 'Downloads are still starting up. Try again in a moment.'); return false; }
    try { await downloads.save({ filename, data }); toast(label + ' saved'); return true; }
    catch (e) {
      const c = e && e.code;
      if (c === 'declined') return false;
      toast(c === 'too_large' ? 'That file is too large to download here. Try a shorter range or the MIDI-only export.' : c === 'rate_limited' ? 'Another download is waiting for your answer. Finish that one first.' : c === 'unavailable' || c === 'not_granted' ? 'Downloads aren’t available in this view.' : 'Could not save the file (' + (c || 'error') + ').');
      return false;
    }
  }
  function busyOn(title, detail) { $('busy').hidden = false; $('busyTitle').textContent = title; $('busyFile').textContent = detail || ''; $('busyStages').innerHTML = ''; $('busyBar').style.width = '10%'; $('busyCancel').hidden = true; $('busyEta').textContent = ''; }
  function busyOff() { $('busy').hidden = true; $('busyCancel').hidden = false; }
  async function exportWith(kind) {
    closeMenu();
    if (!S.L) return;
    const name = baseName();
    try {
      if (kind === 'package') {
        const { abc, svg } = scoreSVG();
        const files = [
          { name: name + '.mid', data: Notation.toMIDI(project(), S.an) },
          { name: name + '.musicxml', data: Notation.toMusicXML(project()) },
          { name: name + '.abc', data: abc },
          { name: name + '-score.svg', data: svg },
          { name: name + '-score.html', data: scoreHTML(svg) },
          { name: 'README.txt', data: readme() },
        ];
        await save(name + '.zip', Notation.zip(files), 'Score package');
      } else if (kind === 'midi') {
        await save(name + '-midi.zip', Notation.zip([{ name: name + '.mid', data: Notation.toMIDI(project(), S.an) }, { name: 'README.txt', data: readme() }]), 'MIDI file');
      } else if (kind === 'svg') { const { svg } = scoreSVG(); await save(name + '-score.svg', svg, 'Score (SVG)'); }
      else if (kind === 'html') { const { svg } = scoreSVG(); await save(name + '-score.html', scoreHTML(svg), 'Printable score'); }
      else if (kind === 'audio') {
        busyOn('Rendering audio…', 'Mixing ' + S.tracks.filter(t => !t.mute).length + ' parts. This takes a few seconds per minute of music.');
        let wav;
        try { wav = await Player.renderMix(S.tracks, S.st, S.L, S.an, p => { $('busyBar').style.width = Math.round(10 + 85 * p) + '%'; }); } finally { busyOff(); }
        await save(name + '-audio.zip', Notation.zip([{ name: name + '.wav', data: wav }]), 'Audio mixdown');
      } else if (kind === 'project') {
        await save(name + '.partitura.json', JSON.stringify(projectData()), 'Project file');
      }
    } catch (e) { console.error(e); busyOff(); toast('Export failed: ' + e.message); }
  }
  let menuEl = null, menuReturn = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; $('exportBtn').setAttribute('aria-expanded', 'false'); if (menuReturn) menuReturn.focus(); return true; } return false; }
  function openMenu() {
    if (menuEl) { closeMenu(); return; }
    menuReturn = $('exportBtn');
    const b = $('exportBtn').getBoundingClientRect();
    menuEl = document.createElement('div'); menuEl.className = 'menu'; menuEl.setAttribute('role', 'menu'); menuEl.setAttribute('aria-label', 'Export');
    menuEl.style.top = (b.bottom + window.scrollY + 6) + 'px'; menuEl.style.right = Math.max(8, window.innerWidth - b.right) + 'px';
    const items = [
      ['package', 'Score package (.zip)', 'MIDI, MusicXML, ABC, SVG and printable score'],
      ['midi', 'MIDI file (.zip)', 'One track per part, ready for any DAW'],
      ['html', 'Printable score (.html)', 'Opens in a browser; print to PDF'],
      ['svg', 'Sheet music (.svg)', 'Vector image of the full score'],
      ['audio', 'Audio mixdown (.wav in .zip)', 'Renders the current mix'],
      null,
      ['project', 'Project file (.json)', 'Reopen later with Open project'],
    ];
    menuEl.innerHTML = items.map(it => it ? `<button role="menuitem" tabindex="-1" data-k="${it[0]}"><span>${it[1]}</span><small>${it[2]}</small></button>` : '<hr>').join('') + (downloads || !capsReady ? '' : '<p class="hint" style="padding:6px 10px;margin:0">Downloads need this page to be opened on claude.ai.</p>');
    menuEl.onclick = e => { const k = e.target.closest('[data-k]')?.dataset.k; if (k) exportWith(k); };
    menuEl.onkeydown = e => {
      const btns = [...menuEl.querySelectorAll('[role=menuitem]')]; const i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); btns[0].focus(); } else if (e.key === 'End') { e.preventDefault(); btns[btns.length - 1].focus(); }
      else if (e.key === 'Tab') closeMenu();
    };
    document.body.appendChild(menuEl);
    $('exportBtn').setAttribute('aria-expanded', 'true');
    menuEl.querySelector('[role=menuitem]').focus();
    setTimeout(() => document.addEventListener('click', function h(ev) { if (menuEl && !menuEl.contains(ev.target) && ev.target.id !== 'exportBtn') { closeMenu(); } if (!menuEl) document.removeEventListener('click', h); }), 0);
  }

  // ------------------------------------------------------------------ persistence (per-browser autosave)
  const IDB = {
    db: null,
    open() { if (this.db) return Promise.resolve(this.db); return new Promise((res, rej) => { try { const r = indexedDB.open('partitura', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { this.db = r.result; res(this.db); }; r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); },
    async get(k) { try { const db = await this.open(); return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (e) { return null; } },
    async set(k, v) { try { const db = await this.open(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) { } },
  };
  function projectData() {
    const an = { ...S.an }; delete an.spec;
    return { app: 'partitura', v: 3, title: S.title, an, st: S.st, tracks: S.tracks, arrangements: S.arrangements, chat: S.chat.slice(-40), audioName: S.audioName };
  }
  let saveTimer = null;
  function saveNow() { clearTimeout(saveTimer); saveTimer = null; if (S.an) IDB.set('project', projectData()); }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 600); }
  // never lose the last edit to a reload or a closed tab
  window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) saveNow(); });

  // ---------- project validation: check everything before touching any state
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  function validateNotes(arr, where) {
    if (!Array.isArray(arr)) throw new Error(where + ' must be a list');
    const out = [];
    for (const n of arr) {
      if (!n || typeof n !== 'object') continue;
      const p = +n.p, s = +n.s, d = +n.d, v = n.v == null ? 80 : +n.v;
      if (![p, s, d, v].every(Number.isFinite) || p < 0 || p > 127 || s < 0 || d <= 0) continue; // drop broken notes, keep the rest
      out.push({ ...n, id: typeof n.id === 'string' ? n.id : Arranger.nid(), p: Math.round(p), s: Math.round(s), d: Math.round(d), v: clamp(Math.round(v), 1, 127) });
    }
    return out;
  }
  function validateAnalysis(an) {
    if (!an || typeof an !== 'object') throw new Error('the analysis is missing');
    if (!Array.isArray(an.beatTimes) || an.beatTimes.length < 2 || !an.beatTimes.every(isNum)) throw new Error('the beat grid is missing or damaged');
    if (!isNum(an.beatsPerBar) || an.beatsPerBar < 1 || an.beatsPerBar > 12) throw new Error('the meter is damaged');
    if (!isNum(an.tempo) || an.tempo <= 0) throw new Error('the tempo is damaged');
    if (!an.key || !isNum(an.key.tonic) || !['major', 'minor'].includes(an.key.mode)) throw new Error('the key is damaged');
    for (const k of ['notes', 'melody', 'bass', 'chords', 'energy']) if (!Array.isArray(an[k])) throw new Error('the ' + k + ' list is missing');
    if (!isNum(an.nBeats)) an.nBeats = an.beatTimes.length;
    const okNote = n => n && isNum(n.p) && isNum(n.s) && isNum(n.d);
    an.notes = an.notes.filter(okNote); an.melody = an.melody.filter(okNote); an.bass = an.bass.filter(okNote);
    an.chords = an.chords.filter(c => c && isNum(c.s) && isNum(c.d) && (c.type === 'N' || (T.CHORDS[c.type] && isNum(c.root))));
    an.energy = an.energy.map(e => isNum(e) ? e : 0.5);
    return an;
  }
  function validateSettings(st, an) {
    const def = { mode: 'piano', style: 'romantic', ensemble: 'full', tempo: an.tempo, key: { ...an.key }, ts: an.suggestedTs || { num: an.beatsPerBar, den: 4 }, meterMode: 'fit', phrasing: 'natural', dynamics: 'follow', fidelity: 50, expressive: true, swing: false, timing: 'arranged', seed: 0, partSeeds: {}, removed: [] };
    if (!st || typeof st !== 'object') return def;
    const out = { ...def, ...st };
    if (!['piano', 'orchestra'].includes(out.mode)) out.mode = 'piano';
    const styles = out.mode === 'piano' ? Arranger.PIANO_STYLES : Arranger.ORCH_STYLES; if (!styles.includes(out.style)) out.style = styles[0];
    if (!Arranger.ENSEMBLES[out.ensemble]) out.ensemble = 'full';
    if (!isNum(out.tempo) || out.tempo < 20 || out.tempo > 400) out.tempo = def.tempo;
    if (!out.key || !isNum(out.key.tonic) || !['major', 'minor'].includes(out.key.mode)) out.key = def.key;
    if (!out.ts || !['2/4', '3/4', '4/4', '5/4', '6/8', '9/8', '12/8'].includes(out.ts.num + '/' + out.ts.den)) out.ts = def.ts;
    if (!isNum(out.fidelity)) out.fidelity = 50; out.fidelity = clamp(out.fidelity, 0, 100);
    if (!Array.isArray(out.removed)) out.removed = []; if (!out.partSeeds || typeof out.partSeeds !== 'object') out.partSeeds = {};
    out.swing = !!out.swing; out.expressive = out.expressive !== false;
    return out;
  }
  function validateTracks(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) throw new Error('the project has no parts');
    return tracks.map((t, i) => {
      if (!t || typeof t !== 'object') throw new Error('part ' + (i + 1) + ' is damaged');
      const inst = T.INSTR[t.inst] ? t.inst : 'piano';
      return { ...Arranger.newTrack(String(t.id || 'x' + i), String(t.name || T.INSTR[inst].name).slice(0, 60), inst), ...t, inst, id: String(t.id || 'x' + i), name: String(t.name || T.INSTR[inst].name).slice(0, 60), notes: validateNotes(t.notes, 'notes of part ' + (i + 1)), vol: isNum(t.vol) ? clamp(t.vol, 0, 1) : 0.8, pan: isNum(t.pan) ? clamp(t.pan, -1, 1) : 0, mute: !!t.mute, solo: !!t.solo };
    });
  }
  function validateProject(d) {
    if (!d || d.app !== 'partitura') throw new Error('this is not a Music Arranger project file');
    const an = validateAnalysis(U.clone(d.an));
    const st = validateSettings(d.st, an);
    const tracks = validateTracks(d.tracks);
    const arrangements = {};
    if (d.arrangements && typeof d.arrangements === 'object') for (const k of ['piano', 'orchestra']) { const a = d.arrangements[k]; if (a && a.st && a.tracks) { try { arrangements[k] = { st: validateSettings(a.st, an), tracks: validateTracks(a.tracks) }; } catch (e) { } } }
    const chat = Array.isArray(d.chat) ? d.chat.filter(m => m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string').map(m => ({ ...m, undoId: null })) : [];
    // make sure the arrangement can actually be built before we switch to it
    Arranger.buildLead(an, st);
    return { an, st, tracks, arrangements, chat, title: typeof d.title === 'string' ? d.title.slice(0, 80) : 'Arrangement', audioName: typeof d.audioName === 'string' ? d.audioName : '' };
  }

  // ---------- replacing the current work: confirm, and keep a way back
  let backup = null;
  function hasWork() { return !!S.an && (S.tracks.some(t => t.edited) || S.chat.length > 0 || S.undo.length > 0 || !S.demo); }
  function takeBackup(label) {
    if (!S.an) return;
    backup = { data: projectData(), audioBuf: S.audioBuf, label };
  }
  function offerRestore(msg) { if (!backup) return; toast(msg, { label: 'Undo', fn: restoreBackup }); }
  function restoreBackup() {
    if (!backup) return;
    const b = backup; backup = null;
    const v = validateProject(b.data);
    S.audioBuf = b.audioBuf; Player.setOriginalBuffer(b.audioBuf);
    U.loadProject(v.an, { st: v.st, tracks: v.tracks, arrangements: v.arrangements, chat: v.chat, title: v.title });
    S.audioName = v.audioName; scheduleSave(); toast('Restored ' + (v.title || 'your previous work'));
  }
  function confirmButton(btn, question, fn) { // two-step confirmation, since dialogs are unavailable in this frame
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; fn(); return; }
    btn.dataset.label = btn.dataset.label || btn.textContent; btn.dataset.armed = '1'; btn.textContent = question;
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 5000);
  }

  // ------------------------------------------------------------------ upload & analysis
  const STAGES = ['Preparing audio', 'Measuring spectrum and onsets', 'Loading neural transcription model', 'Transcribing notes (neural network)', 'Transcribing notes (spectral fallback)', 'Tracking tempo and beats', 'Finding meter and downbeats', 'Quantising rhythm', 'Detecting key and harmony', 'Separating melody and bass', 'Done'];
  let runId = 0, activeRun = null;
  function showBusy(file, forceDsp) {
    $('busy').hidden = false; $('busyTitle').textContent = 'Listening…'; $('busyFile').textContent = file; $('busyEta').textContent = '';
    $('busyStages').innerHTML = STAGES.filter(s => s !== 'Done' && s !== (forceDsp ? 'Transcribing notes (neural network)' : 'Transcribing notes (spectral fallback)') && !(forceDsp && s === 'Loading neural transcription model')).map(s => `<li data-s="${esc(s)}">${esc(s)}</li>`).join(''); $('busyBar').style.width = '0%';
    $('busyBar').parentElement.setAttribute('aria-valuenow', '0');
    $('busyCancel').textContent = 'Cancel'; $('busyCancel').hidden = false;
    setTimeout(() => $('busyCancel').focus(), 0);
  }
  function stageUpdate(name, p, extra) {
    const lis = [...$('busyStages').children]; const idx = STAGES.indexOf(name);
    if (name.includes('fallback') && !lis.some(l => l.dataset.s === name)) { const nn = lis.find(l => l.dataset.s.includes('neural network')); if (nn) { nn.dataset.s = name; nn.textContent = 'Transcribing notes (spectral method; the neural model could not run here)'; } }
    lis.forEach(li => { const i = STAGES.indexOf(li.dataset.s); li.className = i < idx ? 'done' : i === idx ? 'now' : ''; });
    const weight = { 'Preparing audio': [0, 3], 'Measuring spectrum and onsets': [3, 10], 'Loading neural transcription model': [10, 14], 'Transcribing notes (neural network)': [14, 88], 'Transcribing notes (spectral fallback)': [14, 88], 'Tracking tempo and beats': [88, 91], 'Finding meter and downbeats': [91, 93], 'Quantising rhythm': [93, 95], 'Detecting key and harmony': [95, 97], 'Separating melody and bass': [97, 99], Done: [100, 100] }[name] || [0, 0];
    const pct = Math.round(weight[0] + (weight[1] - weight[0]) * (p || 0));
    $('busyBar').style.width = pct + '%'; $('busyBar').parentElement.setAttribute('aria-valuenow', String(pct));
    if (extra && extra.eta != null && p > 0.04) $('busyEta').textContent = 'About ' + Math.max(1, Math.round(extra.eta)) + ' s left for the notes' + (extra.backend ? '' : '');
    if (extra && extra.backend) $('busyEta').textContent = 'Running on ' + ({ webgl: 'your graphics card', wasm: 'the CPU (WebAssembly)', cpu: 'the CPU (slow)' }[extra.backend] || extra.backend) + '…';
  }
  async function runAnalysis(buf, opts, label) {
    const id = ++runId; const run = { id, cancelled: false }; activeRun = run;
    showBusy(label, opts.forceDsp);
    try {
      const an = await Analysis.analyze(buf, { ...opts, cancelled: () => run.cancelled || activeRun !== run }, (n, p, x) => { if (activeRun === run) stageUpdate(n, p, x); });
      if (run.cancelled || activeRun !== run) return null; // a cancelled or superseded run never replaces anything
      const spec = an.spec; delete an.spec;
      $('busy').hidden = true; activeRun = null;
      return { an, spec };
    } catch (e) {
      if (activeRun !== run) return null;
      activeRun = null;
      if (String(e && e.message) === 'cancelled') { $('busy').hidden = true; toast('Analysis cancelled. Nothing was changed.'); return null; }
      $('busyTitle').textContent = e && e.noContent ? 'No notes to arrange' : 'Could not analyse this file'; $('busyFile').textContent = e.message || String(e); $('busyCancel').textContent = 'Close'; $('busyEta').textContent = '';
      console.error(e); return null;
    }
  }
  function cancelRun() { if (activeRun) { activeRun.cancelled = true; try { activeRun.ctl && activeRun.ctl.abort(); } catch (e) { } activeRun = null; } $('busy').hidden = true; }
  const AUDIO_RE = /\.(mp3|wav|wave|m4a|aac|ogg|oga|flac|opus|webm|aif|aiff|mp4)$/i;
  async function handleFile(file) {
    if (!file) return;
    if (activeRun) { toast('An analysis is already running. Cancel it first to start another.'); return; }
    if (!(/^audio\/|^video\//.test(file.type || '') || AUDIO_RE.test(file.name))) { toast('“' + file.name + '” doesn’t look like an audio file. Use MP3, WAV, M4A, OGG or FLAC.'); return; }
    if (file.size > 150 * 1024 * 1024) { toast('That file is over 150 MB. Trim it or export a compressed version first.'); return; }
    Player.stop(); U.updatePlayIcon();
    const id = ++runId; const run = { id, cancelled: false }; activeRun = run;
    showBusy(file.name); stageUpdate('Preparing audio', 0);
    let buf, bytes;
    try { bytes = await file.arrayBuffer(); buf = await Analysis.decodeFile(new File([bytes], file.name)); }
    catch (e) { if (activeRun !== run) return; activeRun = null; $('busyTitle').textContent = 'Could not open this file'; $('busyFile').textContent = e.message; $('busyCancel').textContent = 'Close'; return; }
    if (run.cancelled || activeRun !== run) return; // cancelled while decoding
    activeRun = null;
    const maxSec = 480;
    const opts = { fileName: file.name, maxSec, sensitivity: +$('sens').value };
    if (buf.duration > maxSec) toast('Analysing the first 8 minutes. Use Re-analyse to choose another range.');
    const r = await runAnalysis(buf, opts, file.name);
    if (!r) return;
    takeBackup('before upload');
    S.audioBuf = buf; S.audioName = file.name; Player.setOriginalBuffer(buf);
    S.title = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').slice(0, 60);
    U.loadProject(r.an, { spec: r.spec, title: S.title, st: null });
    resetReanalyse();
    IDB.set('audio', { name: file.name, bytes, type: file.type });
    scheduleSave();
    const n = r.an.stats.notes;
    offerRestore('Transcribed ' + n + ' note' + (n === 1 ? '' : 's') + (r.an.mode === 'neural' ? '.' : ' with the spectral method.'));
  }
  function resetReanalyse() { $('tempoAdj').value = '1'; $('tempoOv').value = ''; $('meterOv').value = ''; $('dbShift').value = '0'; $('rangeA').value = Math.round(S.an?.offsetSec || 0); $('rangeB').value = ''; $('forceDsp').checked = false; $('reanHint').textContent = ''; }
  async function reanalyse() {
    if (!S.audioBuf) { toast('The original audio is not loaded. Upload the recording again to re-analyse it.'); return; }
    if (activeRun) { toast('An analysis is already running.'); return; }
    const dur = S.audioBuf.duration;
    const notes = [];
    const opts = { fileName: S.an.fileName, sensitivity: +$('sens').value, maxSec: 480 };
    const ta = +$('tempoAdj').value; if (ta !== 1) opts.tempoScale = ta;
    const tov = $('tempoOv').value.trim();
    if (tov) { const v = +tov; if (!Number.isFinite(v)) { $('reanHint').textContent = 'Exact BPM must be a number.'; return; } opts.tempoOverride = clamp(v, 30, 260); if (opts.tempoOverride !== v) notes.push('BPM limited to ' + opts.tempoOverride); }
    if ($('meterOv').value) opts.meterOverride = +$('meterOv').value;
    if (+$('dbShift').value) opts.downbeatShift = +$('dbShift').value;
    let a = +$('rangeA').value || 0, b = $('rangeB').value.trim() ? +$('rangeB').value : null;
    if (a < 0 || a > dur - 2) { $('reanHint').textContent = 'Start must be between 0 and ' + Math.floor(dur - 2) + ' seconds.'; return; }
    if (b != null && (!Number.isFinite(b) || b <= a + 1.99)) { $('reanHint').textContent = 'End must be at least 2 seconds after the start.'; return; }
    if (b != null && b > dur) { b = dur; notes.push('end set to the end of the recording'); }
    if ((b ?? dur) - a > 480) { b = a + 480; notes.push('limited to 8 minutes (' + Math.round(a) + '–' + Math.round(b) + ' s)'); }
    opts.startSec = a; if (b != null) opts.endSec = b;
    opts.forceDsp = $('forceDsp').checked;
    const hasEdits = S.tracks.some(t => t.edited) || Object.values(S.arrangements).some(x => x.tracks?.some(t => t.edited));
    const go = async () => {
      Player.stop(); U.updatePlayIcon();
      if (notes.length) toast('Re-analysing: ' + notes.join('; ') + '.');
      const r = await runAnalysis(S.audioBuf, opts, S.an.fileName);
      if (!r) return;
      takeBackup('before re-analysis');
      if (S.demo) { r.an.demo = true; r.an.fileName = S.an.fileName; }
      const keepMode = { mode: S.st.mode, style: S.st.style, ensemble: S.st.ensemble, phrasing: S.st.phrasing, dynamics: S.st.dynamics, fidelity: S.st.fidelity, expressive: S.st.expressive };
      S.st = keepMode;
      U.loadProject(r.an, { spec: r.spec, title: S.title });
      scheduleSave();
      offerRestore('Re-analysed: ' + Math.round(r.an.tempo) + ' BPM, ' + T.keyName(r.an.key) + ', ' + U.originalTs(r.an).num + '/' + U.originalTs(r.an).den + '.');
    };
    if (hasEdits) confirmButton($('reanBtn'), 'Replace parts, including edits?', go); else go();
  }
  function sensLabel() { const v = +$('sens').value; $('sensV').textContent = v < 0.3 ? 'Fewer, surer notes' : v > 0.7 ? 'More notes' : 'Balanced'; }

  async function loadDemo(silent) {
    try {
      const raw = await (await fetch('demo/harbor-lights.json')).json();
      const an = validateAnalysis(raw);
      if (!silent) takeBackup('before demo');
      S.title = 'Harbor Lights'; S.st = null;
      U.loadProject(an, { title: 'Harbor Lights' });
      S.audioName = an.fileName;
      S.audioBuf = null; Player.setOriginalBuffer(null); U.updateTransportUI();
      loadDemoAudio();
      resetReanalyse();
      if (!silent) { scheduleSave(); offerRestore('Demo loaded.'); }
    } catch (e) { console.error(e); toast('Could not load the demo.'); }
  }
  function openProjectFile(file) {
    const r = new FileReader();
    r.onload = () => {
      let v;
      try { v = validateProject(JSON.parse(r.result)); }
      catch (e) { toast('Could not open “' + file.name + '”: ' + (e instanceof SyntaxError ? 'it is not valid JSON' : e.message) + '. Nothing was changed.'); return; }
      takeBackup('before opening a project');
      S.audioBuf = null; Player.setOriginalBuffer(null);
      U.loadProject(v.an, { st: v.st, tracks: v.tracks, arrangements: v.arrangements, chat: v.chat, title: v.title });
      S.audioName = v.audioName;
      if (v.an.demo) loadDemoAudio();
      scheduleSave();
      offerRestore('Opened ' + (v.title || 'project') + (v.an.demo || v.an.mode === 'score' ? '.' : '. Upload the original recording to hear it alongside.'));
    };
    r.onerror = () => toast('Could not read that file.');
    r.readAsText(file);
  }
  async function loadDemoAudio() { try { const ab = await (await fetch('demo/harbor-lights.mp3')).arrayBuffer(); S.audioBuf = await Analysis.decodeFile(new File([ab], 'demo.mp3')); Player.setOriginalBuffer(S.audioBuf); U.updateTransportUI(); if (S.view === 'an') U.anView.ensureSpec(); } catch (e) { console.warn('demo audio', e); } }

  // ------------------------------------------------------------------ a song by name, without a recording
  const songPrompt = (q, original) => `You are the tune finder inside a music-arranging app. The app turns a melody with chord symbols into piano or orchestral arrangements. The user typed:
«${q.replace(/[«»]/g, '')}»

Decide which case applies and reply with only a JSON object.

1. It names a specific existing piece that is in the public domain: a traditional or folk song, nursery rhyme, hymn, carol or spiritual, or a work whose composer died long ago and that was published before 1930 (Bach, Mozart, Beethoven, Tchaikovsky, Stephen Foster and so on). Write out its main melody: status "recall".
2. It names a piece that is still under copyright: most songs, film, TV, show, game and pop music from 1930 on, and modern arrangements of old tunes. Do not write out any part of its melody, not even a fragment or a "simplified" version: status "copyrighted". In "suggestion", name the mood and genre an original tune could have instead (a few words, for example "a dramatic rock ballad"), without describing the melody itself.
3. It describes music rather than naming a piece (for example "a gentle lullaby in F" or "an upbeat march"): compose a new, original melody that fits: status "original".
4. It names a piece you do not know well enough to write out accurately, or it is not about music: status "unknown". Do not guess at melodies.
${original ? '\nThe user has asked for an ORIGINAL tune instead. Compose new music in the general mood and genre suggested above. Do not quote, paraphrase or imitate the melody, the hook or the chord progression of any copyrighted song: status "original".\n' : ''}
For "recall" and "original", put the tune in "abc" as ABC notation:
- headers X:1, T:, M:, L:, Q:, then K: last (for example K:G, K:Am, K:Ddor)
- one voice only: the melody, in a comfortable singing range (about C4 to G5)
- chord symbols in double quotes before notes, such as "G" "Am" "D7" "F#m" "Bb" "C/E", at least once per bar
- every bar must add up to the meter; a pickup bar is fine at the start
- use |: :| and [1 [2 endings when the tune repeats
- 8 to 48 bars; no lyrics (no w: lines), no decorations, no comments
For "recall", write the best-known version of the tune and set "confidence" to how sure you are that the notes are right (0 to 1).

JSON shape:
{"status": "recall" | "original" | "copyrighted" | "unknown", "title": "the piece's usual title, or a short title for an original", "composer": "composer and date, 'Traditional', or 'Original'", "reason": "one sentence for the user: why it is public domain, or why it cannot be written out", "suggestion": "only for copyrighted: mood and genre for an original", "confidence": 0.9, "abc": "X:1\\nT:...\\nM:4/4\\nL:1/8\\nQ:1/4=100\\nK:C\\n..."}`;

  function songStages(names, at) { $('busyStages').innerHTML = names.map((n, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}">${esc(n)}</li>`).join(''); const pct = Math.round(at / names.length * 100); $('busyBar').style.width = pct + '%'; $('busyBar').parentElement.setAttribute('aria-valuenow', String(pct)); }
  function songAlt(html) { const el = $('songAlt'); if (!html) { el.hidden = true; el.innerHTML = ''; return; } el.innerHTML = html; el.hidden = false; }
  function libraryButtons(n) { return '<div class="row">' + Songs.LIBRARY.slice(0, n || 6).map(x => `<button class="btn sm ghost" data-song="${esc(x.title)}">${esc(x.title)}</button>`).join('') + '</div>'; }
  function finishSong(an, label) {
    Player.stop(); U.updatePlayIcon();
    takeBackup('before ' + label);
    S.audioBuf = null; Player.setOriginalBuffer(null);
    S.title = (an.fileName || 'Tune').slice(0, 60);
    U.loadProject(an, { title: S.title });
    S.audioName = '';
    resetReanalyse(); U.updateTransportUI();
    scheduleSave();
    offerRestore('Arranged “' + S.title + '”' + (an.source?.kind === 'recall' ? ', written out by Claude from memory. Check the melody by ear.' : '.'));
  }
  async function arrangeSong(q, original) {
    q = String(q || '').trim().slice(0, 160);
    if (!q) { $('songIn').focus(); toast('Type a song name, or describe the tune you want.'); return; }
    if (activeRun) { toast('Something is already running. Cancel it first.'); return; }
    songAlt(null);
    const hit = !original && Songs.match(q);
    if (hit) {
      try { finishSong(Songs.fromABC(hit.abc, { title: hit.title, composer: hit.composer, origin: 'library', query: q, engine: 'Built-in song library' }), 'song'); $('songIn').value = ''; }
      catch (e) { console.error(e); toast('Could not build “' + hit.title + '”: ' + e.message); }
      return;
    }
    if (!sample) {
      songAlt(`<p>“${esc(q)}” isn’t in the built-in library. ${capsReady ? 'Looking up other tunes needs Claude, which is available when this page is opened on claude.ai.' : 'Claude is still starting up. Try again in a moment.'} These load right away:</p>${libraryButtons(15)}`);
      return;
    }
    const ctl = new AbortController();
    const id = ++runId; const run = { id, cancelled: false, ctl }; activeRun = run;
    const names = ['Asking Claude for the tune', 'Reading the notation', 'Building the arrangement'];
    $('busy').hidden = false; $('busyTitle').textContent = original ? 'Composing an original tune…' : 'Finding the tune…'; $('busyFile').textContent = q; $('busyEta').textContent = 'This usually takes 10–30 seconds.';
    $('busyCancel').textContent = 'Cancel'; $('busyCancel').hidden = false; setTimeout(() => $('busyCancel').focus(), 0);
    songStages(names, 0);
    const alive = () => !run.cancelled && activeRun === run;
    const fail = (title, msg) => { if (!alive()) return; activeRun = null; $('busyTitle').textContent = title; $('busyFile').textContent = msg; $('busyEta').textContent = ''; $('busyCancel').textContent = 'Close'; };
    try {
      const prompt = [{ role: 'user', content: songPrompt(q, original) }];
      let out = await sample.json(prompt, { signal: ctl.signal, cache: false });
      if (!alive()) return;
      const status = String(out && out.status || '').toLowerCase();
      const title = String(out && out.title || q).slice(0, 80);
      if (status === 'copyrighted') {
        $('busy').hidden = true; activeRun = null;
        const comp = out.composer ? ' — ' + esc(String(out.composer).slice(0, 80)) : '';
        const idea = out.suggestion ? ' Claude could write ' + esc(String(out.suggestion).replace(/^an? /i, m => m).slice(0, 120)) + ' instead.' : '';
        songAlt(`<p><b>${esc(title)}</b>${comp} is still under copyright, so its melody can’t be written out here.</p><p>You can upload a recording of it to transcribe, or have Claude compose an original tune in a similar mood.${idea}</p><div class="row"><button class="btn sm primary" data-orig="1">Compose an original tune</button><button class="btn sm" data-upload="1">Upload a recording</button></div>`);
        $('songAlt').dataset.q = q;
        return;
      }
      if (status !== 'recall' && status !== 'original') {
        $('busy').hidden = true; activeRun = null;
        songAlt(`<p>Claude doesn’t know “${esc(q)}” well enough to write it out accurately. ${esc(String(out && out.reason || ''))}</p><p>Try the usual title, upload a recording, or describe the tune you want (for example “a gentle waltz in D minor”). Built-in tunes:</p>${libraryButtons(8)}`);
        return;
      }
      songStages(names, 1);
      const meta = { title, composer: String(out.composer || (status === 'original' ? 'Original tune' : '')).slice(0, 100), origin: status, query: q, engine: status === 'original' ? 'Original melody composed by Claude' : 'Melody written out by Claude from memory' };
      let an, err;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          an = Songs.fromABC(out.abc, meta);
          if (an.melody.length < 8 || an.nBeats / an.beatsPerBar < 4) throw new Error('the tune is too short (' + an.melody.length + ' notes)');
          if (an.melody.some(n => n.p < 36 || n.p > 100)) throw new Error('some notes are far outside a melody range');
          break;
        } catch (e) {
          err = e; an = null;
          if (attempt === 1 || !alive()) break;
          $('busyEta').textContent = 'Fixing the notation…';
          out = await sample.json([...prompt, { role: 'assistant', content: JSON.stringify(out) }, { role: 'user', content: 'The app could not use that ABC: ' + e.message + '. Reply with the same JSON object, with the ABC corrected. Keep the same tune.' }], { signal: ctl.signal, cache: false });
          if (!alive()) return;
        }
      }
      if (!alive()) return;
      if (!an) { fail('Could not read the tune', 'The notation Claude returned could not be used (' + (err ? err.message : 'unknown problem') + '). Try again, or try another title.'); return; }
      songStages(names, 2);
      if (status === 'recall') {
        const conf = Math.max(0, Math.min(1, +out.confidence || 0.6));
        an.stats.recallConfidence = conf;
        an.warnings.unshift('Claude wrote this melody out from memory' + (conf < 0.7 ? ' and is not fully sure of it' : '') + '. Check it against the version you know; fix notes or chords in “Edit the tune’s notation”.');
        if (out.reason) an.warnings.push(String(out.reason).slice(0, 240));
      } else an.warnings.unshift('An original melody composed by Claude from your description. Use “Variation” or the chat to change it.');
      $('busy').hidden = true; activeRun = null;
      finishSong(an, 'song'); $('songIn').value = '';
    } catch (e) {
      if (!alive()) return;
      const code = e && e.code;
      if (code === 'cancelled' || (e && e.name === 'AbortError')) { activeRun = null; $('busy').hidden = true; return; }
      const MSG = { rate_limited: 'Too many requests right now, or a usage limit was reached. Wait a moment and try again.', refused: 'Claude declined that request. Try another title or a description of the tune.', invalid_json: 'Claude’s answer could not be read. Try again.', session_expired: 'Your Claude session expired. Sign in again on claude.ai and try again.', empty_completion: 'Claude returned an empty answer. Try again.' };
      if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) sample = null;
      console.error(e);
      fail('Could not find the tune', MSG[code] || ('Something went wrong (' + (code || (e && e.message) || 'error') + '). Nothing was changed.'));
    }
  }
  function rebuildTune() {
    if (!S.an || S.an.mode !== 'score') return;
    const txt = $('tuneAbc').value;
    const src = S.an.source || {};
    let an;
    try { an = Songs.fromABC(txt, { title: S.an.fileName, composer: src.composer, origin: txt.trim() === String(src.abc || '').trim() ? src.kind : 'edited', query: src.query, engine: S.an.engine }); }
    catch (e) { $('tuneHint').textContent = 'Could not read the notation: ' + e.message + '.'; return; }
    if (an.melody.length < 2) { $('tuneHint').textContent = 'The notation has almost no notes.'; return; }
    const keep = (S.an.warnings || []).filter(w => /from memory|original melody/i.test(w));
    an.warnings = [...keep, ...an.warnings.filter(w => !keep.includes(w))];
    const go = () => { finishSong(an, 'rebuilding'); };
    const hasEdits = S.tracks.some(t => t.edited);
    if (hasEdits) confirmButton($('tuneRebuild'), 'Replace parts, including edits?', go); else go();
  }
  function bindSongs() {
    $('songList').innerHTML = Songs.LIBRARY.map(x => `<option value="${esc(x.title)}"></option>`).join('');
    $('songForm').addEventListener('submit', e => { e.preventDefault(); arrangeSong($('songIn').value); });
    $('songAlt').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.song) { $('songIn').value = b.dataset.song; arrangeSong(b.dataset.song); }
      else if (b.dataset.orig) arrangeSong($('songAlt').dataset.q || $('songIn').value, true);
      else if (b.dataset.upload) $('fileIn').click();
    });
    $('tuneRebuild').onclick = rebuildTune;
  }

  function bindIO() {
    $('fileIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; handleFile(f); };
    const drop = $('drop');
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileIn').click(); } });
    $('uploadQuick').onclick = () => $('fileIn').click();
    // page-wide drop target with a counter so child elements don't make it flicker
    let depth = 0;
    const isFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
    document.addEventListener('dragenter', e => { if (!isFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    document.addEventListener('dragleave', e => { if (!isFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    document.addEventListener('dragover', e => { if (isFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', e => {
      if (!isFiles(e)) return; e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const f = e.dataTransfer.files[0]; if (!f) return;
      if (/\.json$/i.test(f.name)) openProjectFile(f); else handleFile(f);
    });
    $('busyCancel').onclick = () => cancelRun();
    $('reanBtn').onclick = reanalyse;
    $('sens').oninput = sensLabel;
    $('rangeA').oninput = () => { const a = +$('rangeA').value || 0; if (S.an) $('rangeB').placeholder = String(Math.round(Math.min(S.an.duration, a + 480))); };
    $('loadDemo').onclick = () => { if (hasWork()) confirmButton($('loadDemo'), 'Replace current work?', () => loadDemo(false)); else loadDemo(false); };
    $('openProject').onclick = () => $('projIn').click();
    $('projIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openProjectFile(f); };
    $('exportBtn').onclick = openMenu;
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    bindChat(); bindIO(); bindSongs(); sensLabel();
    const saved = await IDB.get('project');
    if (saved && saved.app === 'partitura') {
      try {
        const v = validateProject(saved);
        U.loadProject(v.an, { st: v.st, tracks: v.tracks, arrangements: v.arrangements, chat: v.chat, title: v.title });
        S.audioName = v.audioName;
        resetReanalyse();
        if (v.an.demo) loadDemoAudio();
        else {
          const audio = await IDB.get('audio');
          if (audio && audio.bytes && audio.name === v.audioName) { try { S.audioBuf = await Analysis.decodeFile(new File([audio.bytes], audio.name)); Player.setOriginalBuffer(S.audioBuf); U.updateTransportUI(); } catch (e) { } }
          toast('Restored your last session: ' + v.title);
        }
        return;
      } catch (e) { console.warn('restore failed', e); toast('Your last session could not be restored (' + e.message + '), so the demo is shown.'); }
    }
    await loadDemo(true);
  }
  window.__ui2 = { renderChat, updateScope, scheduleSave, applyEdits, overview, notesText, send, closeMenu, validateProject };
  boot();
})();
