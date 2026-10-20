/* Music Arranger — application shell: project state, settings, parts, piano roll, score, recording view,
   transport, arranging assistant (Claude via the artifact `sample` capability), exports, autosave. */
(function () {
  const $ = id => document.getElementById(id);
  const PPQ = T.PPQ;
  const S = {
    an: null, audioBuf: null, audioName: '', audioBytes: null, spec: null, demo: false,
    st: null, L: null, P: null, tracks: [], arrangements: {}, title: 'Harbor Lights',
    active: null, sel: new Set(), tool: 'sel', snap: 120, overlay: false, loop: null, loopOn: false,
    view: 'roll', chat: [], undo: [], redo: [], lockedNotice: new Set(), scoreDirty: true,
  };
  window.__S = S;

  const STYLE_LABEL = {
    classical: 'Classical', romantic: 'Romantic', pop: 'Pop ballad', jazz: 'Jazz (stride & shells)', baroque: 'Baroque (walking bass)', minimalist: 'Minimalist',
    cinematic: 'Cinematic', light: 'Light (pizzicato & winds)', epic: 'Epic',
  };
  const ORCH_STYLE_LABEL = { classical: 'Classical', romantic: 'Romantic', cinematic: 'Cinematic', baroque: 'Baroque', light: 'Light (pizzicato & winds)', epic: 'Epic' };
  const TS_OPTIONS = [[2, 4], [3, 4], [4, 4], [5, 4], [6, 8], [9, 8], [12, 8]];

  // ------------------------------------------------------------------ utils
  const clone = o => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function fmtTime(s) { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + (s % 60).toFixed(1).padStart(4, '0'); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  let toastTimer = null;
  function toast(msg, action) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status');
    const span = document.createElement('span'); span.textContent = msg; el.appendChild(span);
    if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { action.fn(); el.remove(); }; el.appendChild(b); }
    document.body.appendChild(el); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), action ? 6000 : 3200);
  }
  const trackById = id => S.tracks.find(t => t.id === id);
  const activeTrack = () => trackById(S.active) || S.tracks[0];
  const barTicks = () => S.L.ts.barTicks;
  const totalTicks = () => S.L.totalTicks;

  // ------------------------------------------------------------------ settings & project
  // the time signature that reproduces the analysed bars exactly
  function originalTs(an) { return an.suggestedTs && an.suggestedTs.num ? { ...an.suggestedTs } : { num: an.beatsPerBar, den: 4 }; }
  function isOriginalMeter(n, d) { const ts = T.timeSig(n, d); return ts.barTicks === S.an.beatsPerBar * (S.an.beatTicks || PPQ); }
  function defaultSettings(an, prev) {
    const mode = prev?.mode || 'piano';
    return {
      mode, style: prev?.style || (mode === 'piano' ? 'romantic' : 'cinematic'), ensemble: prev?.ensemble || 'full',
      tempo: Math.round(an.tempo * (an.beatTicks || PPQ) / PPQ), key: { ...an.key }, ts: originalTs(an), meterMode: 'fit',
      phrasing: prev?.phrasing || 'natural', dynamics: prev?.dynamics || 'follow', fidelity: prev?.fidelity ?? 50,
      expressive: prev?.expressive ?? true, swing: !!an.swing, timing: 'arranged', seed: 0, partSeeds: {}, removed: [],
    };
  }
  function relead() { S.L = Arranger.buildLead(S.an, S.st); S.P = Arranger.phrasePlan(S.L, S.st); }

  function loadProject(an, opts = {}) {
    Player.stop(true);
    S.an = an; S.spec = opts.spec || null; S.demo = !!an.demo;
    S.st = opts.st || defaultSettings(an, S.st);
    S.arrangements = opts.arrangements || {};
    S.undo = []; S.redo = []; S.sel.clear(); S.loop = null; S.loopOn = false; S.lockedNotice = new Set();
    S.chat = opts.chat || [];
    if (opts.title) S.title = opts.title;
    $('title').value = S.title;
    relead();
    if (opts.tracks) S.tracks = opts.tracks;
    else S.tracks = Arranger.build(S.an, S.st).tracks;
    S.active = S.tracks[0]?.id;
    Player.pos = 0;
    fillSettings(); renderFacts(); renderParts(); renderChat(); updateScope(); updateUndo();
    roll.R.fitted = false; roll.fitView(); roll.draw(); S.scoreDirty = true; S.scorePage = 0; if (S.view === 'score') renderScore(); anView.reset();
    $('srcName').textContent = an.fileName || 'Recording';
    const tag = $('srcTag'); tag.className = 'tag ' + (an.demo ? 'demo' : an.mode);
    tag.textContent = an.mode === 'score' ? ({ library: 'Song library', recall: 'Written out by Claude', original: 'Original tune', edited: 'Edited notation' }[an.source?.kind] || 'Notation') : (an.demo ? 'Demo · ' : '') + (an.mode === 'neural' ? 'Neural model' : 'Spectral method');
    if (an.mode === 'score') tag.className = 'tag score';
    const isScore = an.mode === 'score';
    $('anTitle').textContent = isScore ? 'The tune' : 'What was heard';
    $('reanalyse').hidden = isScore; $('tuneSrc').hidden = !isScore;
    $('timingSeg').hidden = isScore; $('origGroup').hidden = isScore; if (isScore && S.st.timing === 'original') S.st.timing = 'arranged';
    if (isScore) { $('tuneAbc').value = an.source?.abc || ''; $('tuneHint').textContent = ''; }
    updateTransportUI(); preloadSounds();
  }

  // Undo covers notes, parts and arrangement settings. Playback preferences (tempo, timing) and the mixer
  // (mute, solo, volume, pan) are deliberately left alone so undoing an edit never resets them.
  let undoSeq = 0;
  function snapshot() { return { tracks: clone(S.tracks), st: clone(S.st), arrangements: clone(S.arrangements), active: S.active }; }
  function pushUndo(label) { const id = ++undoSeq; S.undo.push({ id, label, ...snapshot() }); if (S.undo.length > 200) S.undo.shift(); S.redo = []; updateUndo(); return id; }
  function restore(snap) {
    const mix = new Map(S.tracks.map(t => [t.id, { mute: t.mute, solo: t.solo, vol: t.vol, pan: t.pan }]));
    const keep = { tempo: S.st.tempo, timing: S.st.timing };
    S.tracks = snap.tracks.map(t => mix.has(t.id) ? { ...t, ...mix.get(t.id) } : t);
    S.st = { ...snap.st, ...keep }; S.arrangements = snap.arrangements || S.arrangements;
    S.active = snap.active && trackById(snap.active) ? snap.active : S.tracks[0]?.id; S.sel.clear(); relead(); fillSettings(); changed();
  }
  // undo back to (and including) the step with this id; returns how many steps were undone, or -1 if it is gone
  function undoTo(id) { const i = S.undo.findIndex(u => u.id === id); if (i < 0) return -1; const n = S.undo.length - i; const label = S.undo[i].label; for (let k = 0; k < n; k++) undo(true); toast(n > 1 ? 'Undid ' + n + ' changes, back to before “' + label + '”' : 'Undid: ' + label); return n; }
  function undo(quiet) { const u = S.undo.pop(); if (!u) return; S.redo.push({ id: u.id, label: u.label, ...snapshot() }); restore(u); updateUndo(); if (!quiet) toast('Undid: ' + u.label); }
  function redo() { const r = S.redo.pop(); if (!r) return; S.undo.push({ id: r.id, label: r.label, ...snapshot() }); restore(r); updateUndo(); toast('Redid: ' + r.label); }
  function updateUndo() { $('undo').disabled = !S.undo.length; $('redo').disabled = !S.redo.length; $('undo').title = S.undo.length ? 'Undo: ' + S.undo[S.undo.length - 1].label : 'Nothing to undo'; }

  function changed(opts = {}) {
    renderParts(); roll.draw(); S.scoreDirty = true;
    if (S.view === 'score') renderScore();
    Player.refresh(S.tracks, S.st, S.L, S.an);
    updateTransportUI(); updateScope(); scheduleSave();
    if (!opts.noPreload) preloadSounds();
  }

  function markEdited(t) {
    if (!t) return;
    t.edited = true;
    if (!t.locked) {
      t.locked = true;
      if (!S.lockedNotice.has(t.id)) { S.lockedNotice.add(t.id); toast(t.name + ' is now locked, so setting changes keep your edits.', { label: 'Unlock', fn: () => { t.locked = false; renderParts(); } }); }
    }
  }

  // regenerate parts after a settings change; locked parts are transformed, not rebuilt
  function applySettings(prevSt, label, opts = {}) {
    const st = S.st;
    const keyChanged = prevSt.key.tonic !== st.key.tonic || prevSt.key.mode !== st.key.mode;
    const meterChanged = prevSt.ts.num !== st.ts.num || prevSt.ts.den !== st.ts.den || prevSt.meterMode !== st.meterMode;
    relead();
    const built = Arranger.build(S.an, st);
    const removed = new Set(st.removed || []);
    built.tracks = built.tracks.filter(t => !removed.has(t.id));
    const old = new Map(S.tracks.map(t => [t.id, t]));
    const out = [];
    const transformLocked = t => {
      let notes = t.notes;
      if (meterChanged) notes = Arranger.remapMeter(notes, S.an, prevSt, st);
      if (keyChanged) notes = Arranger.transposeNotes(notes, prevSt.key, st.key, T.INSTR[t.inst]?.drums ? null : T.INSTR[t.inst]?.range);
      return { ...t, notes };
    };
    for (const nt of built.tracks) {
      const o = old.get(nt.id);
      if (o && o.locked && !opts.force) out.push(transformLocked(o));
      else if (o) {
        // keep the user's name and instrument choice; regenerate the notes for the chosen instrument
        const inst = o.instOverride ? o.inst : nt.inst;
        const name = o.instOverride || o.renamed ? o.name : nt.name;
        const notes = o.instOverride ? Arranger.clean(Arranger.generate(S.an, st, nt.id, { ...Arranger.context(S.an, st), instKey: inst })) : nt.notes;
        out.push({ ...nt, mute: o.mute, solo: o.solo, vol: o.vol, pan: o.pan, name, renamed: o.renamed, inst, instOverride: o.instOverride, color: o.color || nt.color, notes });
      }
      else out.push(nt);
      old.delete(nt.id);
    }
    // custom parts and locked parts that no longer belong to the ensemble
    for (const [, o] of old) {
      if (o.custom && !o.locked) out.push({ ...o, notes: Arranger.generateRole(S.an, st, o.role, o.inst, { fromBar: o.fromBar, toBar: o.toBar, seed: st.seed }) });
      else if (o.locked || o.custom) out.push(transformLocked(o));
    }
    S.tracks = sortTracks(out);
    if (!trackById(S.active)) S.active = S.tracks[0]?.id;
    S.sel.clear();
    changed();
  }
  function fitNotes(notes, inst) { const r = T.INSTR[inst]?.range; return r && !T.INSTR[inst].drums ? notes.map(n => ({ ...n, p: T.fitRange(n.p, r) })) : notes; }
  function sortTracks(ts) {
    const order = ['rh', 'lh', 'fl', 'ob', 'cl', 'bn', 'hn', 'tp', 'tb', 'tu', 'timp', 'perc', 'hp', 'gl', 'v1', 'v2', 'va', 'vc', 'cb'];
    const fam = t => T.FAMILY_ORDER.indexOf(T.INSTR[t.inst]?.family || 'keys');
    if (S.st.mode === 'piano') return ts.slice().sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
    return ts.slice().sort((a, b) => fam(a) - fam(b) || ((order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99)));
  }

  function setMode(mode) {
    if (S.st.mode === mode) return;
    Player.stop(); updatePlayIcon();
    pushUndo('Switch to ' + (mode === 'piano' ? 'piano' : 'orchestra'));
    S.arrangements[S.st.mode] = { st: clone(S.st), tracks: clone(S.tracks) };
    const saved = S.arrangements[mode];
    if (saved) {
      // bring the other arrangement up to date with key and meter changes made meanwhile
      const prevSt = clone(saved.st);
      S.st = { ...saved.st, tempo: S.st.tempo, timing: S.st.timing, key: { ...S.st.key }, ts: { ...S.st.ts }, meterMode: S.st.meterMode };
      S.tracks = saved.tracks;
      if (prevSt.key.tonic !== S.st.key.tonic || prevSt.key.mode !== S.st.key.mode || prevSt.ts.num !== S.st.ts.num || prevSt.ts.den !== S.st.ts.den || prevSt.meterMode !== S.st.meterMode) { applySettings(prevSt, 'mode switch'); }
      relead();
    }
    else {
      S.st = { ...S.st, mode, style: mode === 'piano' ? 'romantic' : 'cinematic' };
      relead(); S.tracks = Arranger.build(S.an, S.st).tracks;
    }
    S.active = S.tracks[0]?.id; S.sel.clear();
    fillSettings(); changed(); roll.fitView();
  }

  // ------------------------------------------------------------------ settings form
  function fillSettings() {
    const st = S.st;
    $('modePiano').setAttribute('aria-pressed', st.mode === 'piano'); $('modeOrch').setAttribute('aria-pressed', st.mode === 'orchestra');
    const styles = st.mode === 'piano' ? Arranger.PIANO_STYLES : Arranger.ORCH_STYLES;
    $('style').innerHTML = styles.map(s => `<option value="${s}">${esc((st.mode === 'piano' ? STYLE_LABEL : ORCH_STYLE_LABEL)[s] || s)}</option>`).join('');
    $('style').value = st.style;
    $('ensFld').hidden = st.mode !== 'orchestra'; $('ensemble').value = st.ensemble;
    const keys = []; for (const mode of ['major', 'minor']) for (let t = 0; t < 12; t++) keys.push({ tonic: t, mode });
    $('key').innerHTML = keys.map(k => `<option value="${k.tonic}:${k.mode}">${esc(T.keyName(k))}${k.tonic === S.an.key.tonic && k.mode === S.an.key.mode ? ' · original' : ''}</option>`).join('');
    $('key').value = st.key.tonic + ':' + st.key.mode;
    const ot = originalTs(S.an);
    $('ts').innerHTML = TS_OPTIONS.map(([n, d]) => `<option value="${n}/${d}">${n}/${d}${n === ot.num && d === ot.den ? ' · original' : ''}</option>`).join('');
    $('ts').value = st.ts.num + '/' + st.ts.den;
    $('meterModeFld').hidden = isOriginalMeter(st.ts.num, st.ts.den);
    $('meterMode').value = st.meterMode;
    $('phrasing').value = st.phrasing; $('dynamics').value = st.dynamics; $('fidelity').value = st.fidelity; fidLabel();
    $('expressive').checked = st.expressive !== false; $('swing').checked = !!st.swing;
    updateTransportUI();
  }
  const FID_LABEL = { literal: 'Literal transcription', close: 'Close to the recording', balanced: 'Balanced', free: 'Freer re-voicing', reimagined: 'Reimagined' };
  const FID_HINT = {
    literal: 'Plays the transcribed notes as heard, split between the hands or sections. Style has no effect here.',
    close: 'Keeps the transcribed inner voices and fills gaps in the chosen style.',
    balanced: 'Keeps melody, bass and harmony; the style writes the accompaniment.',
    free: 'Keeps the melody; enriches chords with sevenths and lets the style lead.',
    reimagined: 'Keeps the melody; adds colour chords, doublings and busier textures.',
  };
  function fidLabel() { const tier = Arranger.tierOf(+$('fidelity').value); $('fidV').textContent = FID_LABEL[tier]; $('fidHint').textContent = FID_HINT[tier]; }
  function settingChange(label, mutate, opts = {}) {
    const prev = clone(S.st);
    pushUndo(label);
    mutate(S.st);
    applySettings(prev, label, opts);
    fillSettings();
  }
  function bindSettings() {
    $('modePiano').onclick = () => setMode('piano');
    $('modeOrch').onclick = () => setMode('orchestra');
    $('style').onchange = e => settingChange('Style: ' + e.target.selectedOptions[0].text, st => { st.style = e.target.value; });
    $('ensemble').onchange = e => settingChange('Ensemble: ' + e.target.selectedOptions[0].text, st => { st.ensemble = e.target.value; });
    $('key').onchange = e => { const [t, m] = e.target.value.split(':'); settingChange('Key: ' + e.target.selectedOptions[0].text, st => { st.key = { tonic: +t, mode: m }; }); };
    $('ts').onchange = e => {
      const [n, d] = e.target.value.split('/').map(Number);
      settingChange('Time signature ' + n + '/' + d, st => {
        const wasC = T.timeSig(st.ts.num, st.ts.den).compound, isC = T.timeSig(n, d).compound;
        if (!wasC && isC) st.tempo = Math.round(st.tempo * 1.5); else if (wasC && !isC) st.tempo = Math.round(st.tempo / 1.5);
        st.ts = { num: n, den: d };
        if (st.timing === 'original' && !isOriginalMeter(n, d)) st.timing = 'arranged';
      });
      roll.fitView();
    };
    $('meterMode').onchange = e => settingChange('Meter change mode', st => { st.meterMode = e.target.value; });
    $('phrasing').onchange = e => settingChange('Phrasing: ' + e.target.value, st => { st.phrasing = e.target.value; });
    $('dynamics').onchange = e => settingChange('Dynamics: ' + e.target.selectedOptions[0].text, st => { st.dynamics = e.target.value; });
    $('fidelity').oninput = fidLabel;
    $('fidelity').onchange = e => settingChange('Faithful/creative balance', st => { st.fidelity = +e.target.value; });
    $('expressive').onchange = e => settingChange('Phrase shaping', st => { st.expressive = e.target.checked; });
    $('swing').onchange = e => { pushUndo('Swing'); S.st.swing = e.target.checked; changed(); };
    const sigOf = ts => ts.filter(t => !t.locked).map(t => t.id + ':' + t.notes.map(n => n.p + ',' + n.s + ',' + n.d).join(';')).join('|');
    $('regenAll').onclick = () => {
      const edited = S.tracks.filter(t => !t.locked && t.edited).length;
      const before = sigOf(S.tracks), prev = clone(S.st);
      pushUndo('Reset unlocked parts'); applySettings(prev, 'reset');
      if (sigOf(S.tracks) === before) { S.undo.pop(); updateUndo(); toast('Nothing to reset: the unlocked parts already match the generated arrangement. Use “New variation” for a different take.'); }
      else toast('Reset ' + (edited || 'the') + ' edited part' + (edited === 1 ? '' : 's') + ' to the generated version');
    };
    $('variation').onclick = () => {
      // step through seeds until the unlocked parts actually come out different
      const before = sigOf(S.tracks), prev = clone(S.st);
      pushUndo('New variation');
      let tries = 0;
      do { S.st.seed = (S.st.seed || 0) + 1; applySettings(tries ? { ...prev, seed: S.st.seed - 1 } : prev, 'variation'); tries++; } while (sigOf(S.tracks) === before && tries < 12);
      fillSettings();
      if (sigOf(S.tracks) === before) toast('This style has no other patterns for these parts. Try another style or the faithful/creative slider.');
      else toast('Variation ' + S.st.seed + ' of the unlocked parts. Undo goes back.');
    };
  }

  // ------------------------------------------------------------------ analysis facts & report
  function confBar(v) { const c = v >= 0.6 ? '' : v >= 0.3 ? 'mid' : 'low'; return `<div class="conf" title="Confidence ${Math.round(v * 100)}%"><i class="${c}" style="width:${Math.round(clamp(v, 0.05, 1) * 100)}%"></i></div>`; }
  function renderFacts() {
    const an = S.an; if (!an) return;
    const s = an.stats || {};
    const keyFlats = T.flatKey(an.key.tonic, an.key.mode);
    $('facts').innerHTML = [
      ['Tempo', Math.round(T.timeSig(originalTs(an).num, originalTs(an).den).compound && (an.beatTicks || PPQ) === PPQ ? an.tempo / 1.5 : an.tempo) + ' BPM', s.tempoConfidence ?? 0.5],
      ['Key', T.pcName(an.key.tonic, keyFlats) + (an.key.mode === 'minor' ? ' min' : ' maj'), s.keyConfidence ?? 0.5],
      ['Meter', originalTs(an).num + '/' + originalTs(an).den, (s.meterConfidence ?? s.beatStability ?? 0.5)],
      ['Notes', String(s.notes ?? an.notes.length), null],
      ['Voices', (s.avgPolyphony ?? 0).toFixed(1), null],
      ['Length', fmtTime(an.analysedSec ?? an.duration).replace(/\.\d$/, ''), null],
    ].map(([k, v, c]) => `<div class="fact"><div class="k">${k}</div><div class="v">${esc(v)}</div>${c != null ? confBar(c) : ''}</div>`).join('');
    const w = (an.warnings || []).slice();
    if (!w.length && an.mode === 'score') w.push(an.source?.kind === 'library' ? 'Melody and chords come from the built-in, hand-checked song library. The arranger adds the bass, inner voices and orchestration.' : 'No problems flagged.');
    if (!w.length) w.push('No problems flagged. Inner voices are still the least certain part of any multi-instrument transcription; the Recording tab shows exactly what was detected.');
    $('warns').innerHTML = w.map(x => `<li>${esc(x)}</li>`).join('');
    $('rangeB').placeholder = Math.round(Math.min(an.duration, (+$('rangeA').value || 0) + 480)) + '';
  }
  function showReport() {
    const an = S.an, s = an.stats || {};
    const kc = (an.keyCandidates || []).map(k => T.keyName(k) + ' (' + k.r + ')').join(', ');
    if (an.mode === 'score') {
      const src = an.source || {};
      const how = { library: 'The melody and chord symbols come from the app’s built-in song library, written out by hand for tunes that are traditional or long out of copyright.', recall: 'Claude wrote out the melody and chord symbols from memory. Well-known public-domain tunes usually come out right, but a note, rhythm or chord can differ from the version you know. Fix anything in “Edit the tune’s notation” and rebuild.', original: 'Claude composed this melody and its chords from your description. It is new music, not a copy of an existing song.', edited: 'Built from notation you edited.' }[src.kind] || '';
      $('repBody').innerHTML = `
      <p><b>Source.</b> ${esc(src.title || an.fileName || '')}${src.composer ? ' — ' + esc(src.composer) : ''}. ${esc(how)}</p>
      <p><b>How the arrangement is built.</b> The tune is read as a lead sheet: melody, chord symbols and meter. Repeats and endings are written out in full. The bass follows the chord roots, or the bass note of a slash chord. A soft middle-register chord gives the faithful settings some harmony to keep. Louder, fuller bars are where the melody climbs or gets busier. Tempo ${an.tempo} BPM, ${originalTs(an).num}/${originalTs(an).den}, ${T.keyName(an.key)}, ${an.nBeats / an.beatsPerBar} bars, ${s.melodyNotes} melody notes.</p>
      <p><b>Limits.</b> There is no recording, so playback against the original and re-analysis are unavailable. Only the melody and harmony are taken from the tune; accompaniment patterns, countermelodies and orchestration come from the arranger and the style you choose.</p>
      ${(an.warnings || []).length ? '<p><b>Notes on this tune.</b></p><ul class="warns">' + an.warnings.map(w => `<li>${esc(w)}</li>`).join('') + '</ul>' : ''}
      <p><b>Credits.</b> Notation by abcjs (MIT); instrument samples from the FluidR3 GM soundfont (MIT).</p>`;
      openModal('report'); return;
    }
    $('repBody').innerHTML = `
      <p><b>Engine.</b> ${esc(an.engine || '')}. Analysed ${fmtTime(an.analysedSec || an.duration)} of audio${s.seconds ? ' in ' + s.seconds + ' s' : ''}.</p>
      <p><b>Pipeline.</b> The recording is mixed to mono at 22.05 kHz. A neural network (Spotify's open-source Basic Pitch model, running in a background thread in your browser) estimates which piano-range pitches sound in each 11.6 ms frame and where notes begin. Tempo comes from autocorrelation of an onset-strength curve, and beats are tracked with dynamic programming. Downbeats and meter are chosen from accent, bass and harmony-change patterns. Notes are aligned to the tracked beats and quantised to sixteenths, or to triplets where that fits better. The key comes from a Krumhansl–Kessler profile match, and chords from template matching smoothed with a Viterbi pass. The melody is the most salient continuous line, favouring the top voice; the bass is the lowest continuous line. Tempo level and meter are chosen together, and the report says when another beat level was nearly as likely.</p>
      <p><b>Measurements.</b> Tempo ${an.tempo} beats per minute (confidence ${Math.round((s.tempoConfidence ?? 0) * 100)}%; other plausible beat levels ${(s.tempoAlternatives || []).join(', ') || '—'} BPM). Beat stability ${Math.round((s.beatStability ?? 0) * 100)}%. Meter ${originalTs(an).num}/${originalTs(an).den} (confidence ${Math.round((s.meterConfidence ?? 0.5) * 100)}%). Key candidates: ${esc(kc)}. ${s.notes} notes, ${s.melodyNotes} in the melody, ${s.bassNotes} in the bass. About ${s.avgPolyphony} notes sound at once on average. ${s.tripletBeats ? s.tripletBeats + ' beats were quantised as triplets. ' : ''}</p>
      <p><b>Known limits.</b> Transcription is reliable for a clear lead line, bass, and sparse accompaniment. It gets less reliable as instruments pile up in the same register: inner voices blur, and doubled or octave parts can merge or vanish. Drums, sung lyrics, effects and timbre are not transcribed, and vocals become pitches only. Strongly bent or sliding pitches are rounded to the nearest semitone. Rubato is flattened onto the beat grid unless you play back with the recording's timing. Treat the arrangement as a well-informed starting draft, and check passages that matter against the original on the Recording tab.</p>
      ${(an.warnings || []).length ? '<p><b>Flags for this recording.</b></p><ul class="warns">' + an.warnings.map(w => `<li>${esc(w)}</li>`).join('') + '</ul>' : ''}
      <p><b>Credits.</b> Basic Pitch model by Spotify (Apache 2.0) on TensorFlow.js; notation by abcjs (MIT); instrument samples from the FluidR3 GM soundfont (MIT). Your audio never leaves this browser for analysis.</p>`;
    openModal('report');
  }

  // ------------------------------------------------------------------ parts panel
  function renderParts() {
    const host = $('parts');
    const anySolo = S.tracks.some(t => t.solo);
    let html = ''; let lastFam = null;
    for (const t of S.tracks) {
      const inst = T.INSTR[t.inst] || {};
      const fam = S.st.mode === 'piano' ? 'piano' : inst.family;
      if (fam !== lastFam && S.st.mode !== 'piano') { html += `<div class="fam">${esc(T.FAMILY_LABEL[fam] || fam)}</div>`; lastFam = fam; }
      const ps = t.notes.map(n => n.p);
      const rng = ps.length ? (inst.drums ? ps.length + ' hits' : T.pitchName(Math.min(...ps)) + '–' + T.pitchName(Math.max(...ps))) : 'resting';
      const dim = anySolo ? !t.solo : t.mute;
      html += `<div class="trk ${t.id === S.active ? 'active' : ''}" data-id="${t.id}" style="${dim ? 'opacity:.55' : ''}">
        <span class="bar" style="background:var(--${t.color})"></span>
        <span class="nm"><b>${esc(t.name)}</b><small>${t.notes.length} notes · ${esc(rng)}</small></span>
        <span class="ctl">
          <button class="ms m" data-act="mute" aria-pressed="${t.mute}" title="Mute" aria-label="Mute ${esc(t.name)}">M</button>
          <button class="ms s" data-act="solo" aria-pressed="${t.solo}" title="Solo" aria-label="Solo ${esc(t.name)}">S</button>
          <button class="ibtn lock" data-act="lock" aria-pressed="${t.locked}" title="${t.locked ? 'Locked: settings changes keep this part. Click to unlock.' : 'Lock this part so settings changes keep it'}" aria-label="Lock ${esc(t.name)}">${t.locked ? '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="7" width="9" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>' : '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="7" width="9" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/></svg>'}</button>
          <button class="ibtn" data-act="more" title="Part settings" aria-label="Settings for ${esc(t.name)}" aria-expanded="${S.openPart === t.id}"><svg class="icon" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg></button>
        </span>
        ${S.openPart === t.id ? partMore(t) : ''}
      </div>`;
    }
    host.innerHTML = html;
    // active track select in roll toolbar
    $('activeTrack').innerHTML = S.tracks.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    $('activeTrack').value = S.active;
    const sp = $('scorePart'); const cur = sp.value;
    sp.innerHTML = `<option value="all">${S.st.mode === 'piano' ? 'Grand staff' : 'Full score'}</option>` + (S.st.mode === 'piano' ? '' : S.tracks.map(t => `<option value="${t.id}">${esc(t.name)} part</option>`).join(''));
    sp.value = [...sp.options].some(o => o.value === cur) ? cur : 'all';
  }
  function partMore(t) {
    const insts = Object.entries(T.INSTR).filter(([k, v]) => !!v.drums === !!T.INSTR[t.inst]?.drums);
    return `<div class="trk-more" data-stop="1">
      <label class="fld"><span>Volume</span><input type="range" data-act="vol" min="0" max="1" step="0.02" value="${t.vol}"></label>
      <label class="fld"><span>Pan</span><input type="range" data-act="pan" min="-1" max="1" step="0.05" value="${t.pan || 0}"></label>
      <label class="fld"><span>Instrument</span><select data-act="inst">${insts.map(([k, v]) => `<option value="${k}" ${k === t.inst ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
      <label class="fld"><span>Name</span><input type="text" data-act="name" value="${esc(t.name)}"></label>
      <div class="row" style="grid-column:1/-1"><button class="btn sm" data-act="regen" title="Writes a new version of this part only; other parts stay as they are">New version of this part</button>${S.st.mode === 'orchestra' || t.custom ? '<button class="btn sm ghost" data-act="remove">Remove</button>' : ''}</div>
    </div>`;
  }
  function bindParts() {
    $('parts').addEventListener('click', e => {
      const row = e.target.closest('.trk'); if (!row) return;
      const t = trackById(row.dataset.id); if (!t) return;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (e.target.closest('[data-stop]') && !['regen', 'remove'].includes(act)) return;
      if (act === 'mute') { t.mute = !t.mute; Player.applyMix(S.tracks); renderParts(); roll.draw(); scheduleSave(); return; }
      if (act === 'solo') { t.solo = !t.solo; Player.applyMix(S.tracks); renderParts(); roll.draw(); scheduleSave(); return; }
      if (act === 'lock') { t.locked = !t.locked; renderParts(); scheduleSave(); toast(t.locked ? t.name + ' locked' : t.name + ' unlocked; it will follow setting changes'); return; }
      if (act === 'more') { S.openPart = S.openPart === t.id ? null : t.id; renderParts(); return; }
      if (act === 'regen') { regenTrack(t); return; }
      if (act === 'remove') { removePart(t); return; }
      setActive(t.id);
    });
    $('parts').addEventListener('input', e => {
      const row = e.target.closest('.trk'); const t = row && trackById(row.dataset.id); if (!t) return;
      const act = e.target.dataset.act;
      if (act === 'vol') { t.vol = +e.target.value; Player.applyMix(S.tracks); scheduleSave(); }
      if (act === 'pan') { t.pan = +e.target.value; Player.applyMix(S.tracks); scheduleSave(); }
    });
    $('parts').addEventListener('change', e => {
      const row = e.target.closest('.trk'); const t = row && trackById(row.dataset.id); if (!t) return;
      const act = e.target.dataset.act;
      if (act === 'inst') { pushUndo('Instrument for ' + t.name); swapInstrument(t, e.target.value); changed(); }
      if (act === 'name') { const nm = e.target.value.trim().slice(0, 40); if (nm && nm !== t.name) { pushUndo('Rename ' + t.name); t.name = nm; t.renamed = true; changed({ noPreload: true }); } }
    });
  }
  function removePart(t) {
    pushUndo('Remove ' + t.name);
    S.tracks = S.tracks.filter(x => x !== t);
    if (!t.custom) S.st.removed = [...new Set([...(S.st.removed || []), t.id])];
    if (S.active === t.id) S.active = S.tracks[0]?.id;
    changed(); toast(t.name + ' removed. Add it back with Add part.');
  }
  // change a part's instrument; a default name follows the instrument, a name you typed is kept
  function swapInstrument(t, inst) {
    if (!T.INSTR[inst]) return;
    const oldDefault = !t.renamed;
    t.inst = inst; t.instOverride = true; t.notes = fitNotes(t.notes, inst);
    if (oldDefault) {
      let nm = T.INSTR[inst].name; const used = new Set(S.tracks.filter(x => x !== t).map(x => x.name));
      if (used.has(nm)) { let k = 2; while (used.has(nm + ' ' + k)) k++; nm = nm + ' ' + k; }
      t.name = nm;
    }
    S.tracks = sortTracks(S.tracks);
  }
  function setActive(id) { S.active = id; S.sel.clear(); renderParts(); roll.draw(); roll.scrollToTrack(); updateScope(); }
  function regenTrack(t, opts = {}) {
    pushUndo('New version of ' + t.name);
    let notes;
    if (t.custom) notes = Arranger.generateRole(S.an, S.st, opts.role || t.role, t.inst, { fromBar: t.fromBar, toBar: t.toBar, seed: (S.st.seed || 0) + (t.regen = (t.regen || 0) + 1) });
    else {
      // only this part's own variation seed changes, so every other part stays exactly as it is
      S.st.partSeeds = { ...(S.st.partSeeds || {}), [t.id]: ((S.st.partSeeds || {})[t.id] || 0) + 1 };
      const st = opts.style ? { ...S.st, style: opts.style } : S.st;
      notes = Arranger.clean(Arranger.generate(S.an, st, t.id, { ...Arranger.context(S.an, st), instKey: t.inst }));
    }
    if (opts.fromBar != null) {
      const a = opts.fromBar * barTicks(), b = (opts.toBar + 1) * barTicks();
      notes = t.notes.filter(n => n.s < a || n.s >= b).concat(notes.filter(n => n.s >= a && n.s < b));
    }
    t.notes = notes.sort((a, b) => a.s - b.s); t.locked = false; t.edited = false;
    changed(); toast('New version of ' + t.name + '. Other parts are unchanged.');
  }

  // ------------------------------------------------------------------ add part
  function openAdd() {
    const insts = Object.entries(T.INSTR);
    $('addInst').innerHTML = insts.map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
    $('addInst').value = S.st.mode === 'piano' ? 'violin' : 'glockenspiel';
    $('addFrom').max = $('addTo').max = S.L.nBars;
    $('addFrom').value = S.loop ? Math.floor(S.loop.a / barTicks()) + 1 : 1;
    $('addTo').value = S.loop ? Math.ceil(S.loop.b / barTicks()) : S.L.nBars;
    const ROLE_LABEL = { mel: 'Melody', mel8va: 'Melody, octave up', mel8vb: 'Melody, octave down', counter: 'Counter-melody', harmA: 'Upper harmony', harmT: 'Inner harmony', pad1: 'Sustained harmony note', pad2: 'Sustained chords', chord3: 'Three-note chords', arp: 'Arpeggios', strum: 'Plucked chords', bass: 'Bass line', bass8vb: 'Bass, octave down', timp: 'Timpani strokes', perc: 'Percussion', rest: 'Nothing yet (write it yourself)' };
    $('addInst').onchange = () => {
      const k = $('addInst').value; const roles = Arranger.rolesFor(k).filter(r => (T.INSTR[k].poly || 1) >= 2 || !['pad2', 'chord3', 'strum'].includes(r));
      $('addRole').innerHTML = roles.map(r => `<option value="${r}">${ROLE_LABEL[r] || r}</option>`).join('');
      $('addRole').value = k === 'timpani' ? 'timp' : k === 'percussion' ? 'perc' : ['contrabass', 'tuba', 'cello', 'bassoon'].includes(k) ? 'bass' : k === 'harp' ? 'arp' : k === 'horn' ? 'counter' : 'mel';
    };
    $('addInst').onchange();
    openModal('addModal');
  }
  function addPart(inst, role, fromBar, toBar, name) {
    const id = 'x' + Math.random().toString(36).slice(2, 7);
    const notes = Arranger.generateRole(S.an, S.st, role, inst, { fromBar, toBar, seed: S.st.seed || 0 });
    const colors = ['c-pink', 'c-gold', 'c-lime', 'c-sky', 'c-orange', 'c-violet'];
    const t = Arranger.newTrack(id, name || T.INSTR[inst].name, inst, { custom: true, role, fromBar, toBar, color: colors[S.tracks.length % colors.length], pan: (Math.random() - 0.5) * 0.6 });
    t.notes = notes;
    S.tracks = sortTracks(S.tracks.concat([t]));
    return t;
  }

  // ------------------------------------------------------------------ piano roll
  const roll = (() => {
    const cv = $('roll'), ctx = cv.getContext('2d');
    const R = { ppt: 0.12, nh: 11, sx: 0, top: 96, keyW: 48, rulerH: 36, velH: 64, W: 0, H: 0, dpr: 1, drag: null, colors: {}, lastLen: 480, hover: null };
    function readColors() {
      const names = ['--roll-bg', '--roll-black', '--roll-bar', '--roll-beat', '--roll-sub', '--playhead', '--loop', '--ink', '--muted', '--faint', '--line', '--panel', '--panel-2', '--accent', '--sunken', '--focus'];
      for (const n of names) R.colors[n] = cssVar(n);
      for (const k of Object.values(Arranger.COLORS).concat(['c-gold', 'c-lime', 'c-sky', 'c-orange', 'c-violet', 'c-pink'])) R.colors[k] = cssVar('--' + k);
    }
    function resize() {
      const r = cv.getBoundingClientRect(); R.dpr = window.devicePixelRatio || 1;
      R.W = Math.max(100, r.width); R.H = Math.max(120, r.height);
      cv.width = Math.round(R.W * R.dpr); cv.height = Math.round(R.H * R.dpr);
      R.keyW = R.W < 500 ? 34 : 48; R.velH = R.H < 360 ? 40 : 64;
      if (!R.fitted && r.width > 150 && r.height > 150) fitView(); else draw();
    }
    const gridH = () => R.H - R.rulerH - R.velH;
    const X = t => R.keyW + (t - R.sx) * R.ppt;
    const Y = p => R.rulerH + (R.top - p) * R.nh;
    const tAt = x => R.sx + (x - R.keyW) / R.ppt;
    const pAt = y => Math.floor(R.top - (y - R.rulerH) / R.nh) + 1;
    const snapT = (t, mode = 'round') => { const g = S.snap; if (g <= 1) return Math.round(t / 10) * 10; return Math[mode](t / g) * g; };
    function fitView() {
      if (!S.L) return;
      const rr = cv.getBoundingClientRect(); if (rr.width < 150 || rr.height < 150) { R.fitted = false; return; } // not laid out yet: fit on first resize
      if (Math.abs(rr.width - R.W) > 1 || Math.abs(rr.height - R.H) > 1) { R.W = rr.width; R.H = rr.height; R.dpr = window.devicePixelRatio || 1; cv.width = Math.round(R.W * R.dpr); cv.height = Math.round(R.H * R.dpr); R.keyW = R.W < 500 ? 34 : 48; R.velH = R.H < 360 ? 40 : 64; }
      R.fitted = true;
      const tr = activeTrack(); const ps = tr && tr.notes.length ? tr.notes.map(n => n.p) : [60];
      const mid = (Math.min(...ps) + Math.max(...ps)) / 2;
      const rows = gridH() / R.nh; R.top = Math.min(127, Math.round(mid + rows / 2));
      R.ppt = clamp((R.W - R.keyW) / (barTicks() * Math.min(8, S.L.nBars)), 0.02, 0.6);
      R.sx = 0; draw();
    }
    function scrollToTrack() {
      const tr = activeTrack(); if (!tr || !tr.notes.length) return;
      const vis = tr.notes.filter(n => n.s + n.d > R.sx && n.s < tAt(R.W));
      const ps = (vis.length ? vis : tr.notes).map(n => n.p);
      const lo = Math.min(...ps), hi = Math.max(...ps); const rows = gridH() / R.nh;
      if (hi > R.top - 1 || lo < R.top - rows + 1) { R.top = Math.min(127, Math.round((lo + hi) / 2 + rows / 2)); draw(); }
    }
    function noteColor(t) { return R.colors[t.color] || R.colors['--accent']; }
    function draw() {
      if (!S.L || !R.W) return;
      const c = ctx; const C = R.colors; c.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
      c.fillStyle = C['--roll-bg']; c.fillRect(0, 0, R.W, R.H);
      const gh = gridH(); const bt = barTicks(), beat = S.L.ts.beatTicks;
      const t0 = R.sx, t1 = tAt(R.W);
      // rows
      c.save(); c.beginPath(); c.rect(R.keyW, R.rulerH, R.W - R.keyW, gh); c.clip();
      const rows = Math.ceil(gh / R.nh) + 1;
      for (let i = 0; i < rows; i++) {
        const p = R.top - i; const y = R.rulerH + i * R.nh;
        if ([1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12)) { c.fillStyle = C['--roll-black']; c.fillRect(R.keyW, y, R.W, R.nh); }
        if (((p % 12) + 12) % 12 === 0) { c.fillStyle = C['--roll-beat']; c.fillRect(R.keyW, y + R.nh - 1, R.W, 1); }
      }
      // out of piece
      const endX = X(totalTicks()); if (endX < R.W) { c.fillStyle = C['--sunken']; c.globalAlpha = 0.7; c.fillRect(endX, R.rulerH, R.W - endX, gh); c.globalAlpha = 1; }
      // instrument range shading
      const tr = activeTrack(); const inst = tr && T.INSTR[tr.inst];
      if (inst && !inst.drums) { c.fillStyle = C['--sunken']; c.globalAlpha = 0.55; const yHi = Y(inst.range[1]); const yLo = Y(inst.range[0] - 1); if (yHi > R.rulerH) c.fillRect(R.keyW, R.rulerH, R.W, yHi - R.rulerH); if (yLo < R.rulerH + gh) c.fillRect(R.keyW, yLo, R.W, R.rulerH + gh - yLo); c.globalAlpha = 1; }
      // loop
      if (S.loop) { c.fillStyle = C['--loop']; c.fillRect(X(S.loop.a), R.rulerH, (S.loop.b - S.loop.a) * R.ppt, gh); }
      // vertical lines
      const sub = S.snap > 1 ? S.snap : 120;
      const showSub = sub * R.ppt > 7;
      for (let t = Math.floor(t0 / sub) * sub; t <= t1; t += sub) {
        const x = Math.round(X(t)) + 0.5;
        if (t % bt === 0) c.strokeStyle = C['--roll-bar']; else if (t % beat === 0) c.strokeStyle = C['--roll-beat']; else if (showSub) c.strokeStyle = C['--roll-sub']; else continue;
        c.beginPath(); c.moveTo(x, R.rulerH); c.lineTo(x, R.rulerH + gh); c.stroke();
      }
      // other tracks
      const anySolo = S.tracks.some(t => t.solo);
      if (S.overlay) for (const t of S.tracks) {
        if (t === tr || T.INSTR[t.inst]?.drums) continue;
        c.fillStyle = noteColor(t); c.globalAlpha = (anySolo ? t.solo : !t.mute) ? 0.28 : 0.1;
        for (const n of t.notes) { if (n.s > t1 || n.s + n.d < t0) continue; c.fillRect(X(n.s), Y(n.p) + 1, Math.max(2, n.d * R.ppt - 1), R.nh - 2); }
        c.globalAlpha = 1;
      }
      // active track notes
      if (tr) {
        const col = noteColor(tr);
        c.font = `${Math.min(10, R.nh - 2)}px ${cssVar('--mono') || 'monospace'}`; c.textBaseline = 'middle';
        for (const n of tr.notes) {
          if (n.s > t1 || n.s + n.d < t0) continue;
          const x = X(n.s), y = Y(n.p), w = Math.max(3, n.d * R.ppt - 1), h = R.nh - 1;
          const sel = S.sel.has(n.id);
          c.globalAlpha = 0.45 + 0.55 * (n.v / 127); c.fillStyle = col; c.fillRect(x, y + 0.5, w, h);
          c.globalAlpha = 1; c.strokeStyle = sel ? C['--ink'] : col; c.lineWidth = sel ? 2 : 1; c.strokeRect(x + 0.5, y + 1, w - 1, h - 1);
          if (w > 30 && R.nh >= 10) { c.fillStyle = sel ? C['--ink'] : C['--panel']; c.globalAlpha = sel ? 1 : 0.92; c.fillText(inst?.drums ? (T.DRUMS[n.p] || n.p) : T.pitchName(n.p, T.flatKey(S.L.key.tonic, S.L.key.mode)), x + 3, y + R.nh / 2 + 0.5); c.globalAlpha = 1; }
        }
      }
      // marquee
      if (R.drag && R.drag.kind === 'marquee') { const d = R.drag; c.strokeStyle = C['--focus']; c.setLineDash([4, 3]); c.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); c.setLineDash([]); }
      c.restore();
      // ruler
      c.fillStyle = C['--panel']; c.fillRect(0, 0, R.W, R.rulerH);
      c.strokeStyle = C['--line']; c.beginPath(); c.moveTo(0, R.rulerH - 0.5); c.lineTo(R.W, R.rulerH - 0.5); c.stroke();
      if (S.loop) { c.fillStyle = C['--focus']; c.globalAlpha = S.loopOn ? 0.55 : 0.25; c.fillRect(X(S.loop.a), 0, (S.loop.b - S.loop.a) * R.ppt, 6); c.globalAlpha = 1; }
      c.font = `500 11px ${cssVar('--mono') || 'monospace'}`; c.textBaseline = 'alphabetic';
      const barStep = Math.max(1, Math.ceil(46 / (bt * R.ppt)));
      const phraseStart = new Map((S.P?.phrases || []).length > 1 ? S.P.phrases.map(p => [p.a, p.letter]) : []);
      for (let b = Math.max(0, Math.floor(t0 / bt)); b * bt <= t1 && b <= S.L.nBars; b++) {
        const x = X(b * bt);
        c.fillStyle = C['--muted']; c.fillRect(Math.round(x), 8, 1, R.rulerH - 8);
        if (b % barStep === 0) { c.fillStyle = C['--ink']; c.fillText(String(b + 1), x + 4, 18); }
        if (phraseStart.has(b)) { c.fillStyle = C['--accent']; c.font = `700 11px ${cssVar('--sans')}`; c.fillText(phraseStart.get(b), x + 4 + (b % barStep === 0 ? 18 : 0), 18); c.font = `500 11px ${cssVar('--mono') || 'monospace'}`; }
      }
      // chords
      c.font = `500 10.5px ${cssVar('--sans')}`; c.fillStyle = C['--muted'];
      let lastX = -1e9; const flats = T.flatKey(S.L.key.tonic, S.L.key.mode);
      for (const ch of S.L.chords) {
        if (ch.type === 'N' || ch.s > t1 || ch.s + ch.d < t0) continue;
        const x = X(ch.s); if (x - lastX < 34) continue;
        c.fillText(T.chordName(ch, flats), Math.max(R.keyW + 2, x + 3), R.rulerH - 6); lastX = x;
      }
      // keyboard
      c.save(); c.beginPath(); c.rect(0, R.rulerH, R.keyW, gh); c.clip();
      for (let i = 0; i < rows; i++) {
        const p = R.top - i; const y = R.rulerH + i * R.nh; const pc = ((p % 12) + 12) % 12; const black = [1, 3, 6, 8, 10].includes(pc);
        c.fillStyle = black ? C['--ink'] : C['--panel']; c.globalAlpha = black ? 0.75 : 1; c.fillRect(0, y, R.keyW - (black ? 14 : 0), R.nh); c.globalAlpha = 1;
        c.fillStyle = C['--line']; c.fillRect(0, y + R.nh - 0.5, R.keyW, 0.5);
        if (pc === 0 && R.nh >= 7) { c.fillStyle = C['--muted']; c.font = `10px ${cssVar('--mono')}`; c.textBaseline = 'middle'; c.fillText('C' + (Math.floor(p / 12) - 1), R.keyW - 24, y + R.nh / 2); }
        if (inst?.drums && T.DRUMS[p] && R.nh >= 9) { c.fillStyle = C['--accent']; c.font = `9px ${cssVar('--sans')}`; c.textBaseline = 'middle'; c.fillText(T.DRUMS[p].split(' ')[0], 2, y + R.nh / 2); }
      }
      c.restore();
      c.fillStyle = C['--line']; c.fillRect(R.keyW - 1, R.rulerH, 1, gh);
      // velocity lane
      const vy = R.rulerH + gh;
      c.fillStyle = C['--panel-2']; c.fillRect(0, vy, R.W, R.velH);
      c.fillStyle = C['--line']; c.fillRect(0, vy, R.W, 1);
      c.fillStyle = C['--muted']; c.font = `10px ${cssVar('--sans')}`; c.textBaseline = 'top'; c.fillText('Velocity', 4, vy + 4);
      if (tr) {
        const col = noteColor(tr);
        c.save(); c.beginPath(); c.rect(R.keyW, vy, R.W - R.keyW, R.velH); c.clip();
        for (const n of tr.notes) {
          if (n.s > t1 || n.s < t0 - 1) continue;
          const x = X(n.s), hh = (R.velH - 10) * n.v / 127;
          c.fillStyle = S.sel.has(n.id) ? C['--ink'] : col; c.fillRect(x, vy + R.velH - hh - 2, 3, hh); c.fillRect(x - 1, vy + R.velH - hh - 3, 5, 2);
        }
        c.restore();
      }
      // playhead
      const ph = Player.playing ? Player.currentTick() : Player.pos;
      const px = X(ph);
      if (px >= R.keyW && px <= R.W) { c.fillStyle = C['--playhead']; c.fillRect(Math.round(px) - 1, 0, 2, R.H); c.beginPath(); c.moveTo(px - 5, 0); c.lineTo(px + 5, 0); c.lineTo(px, 7); c.fill(); }
    }

    // ---- hit testing
    function hitNote(x, y) {
      const tr = activeTrack(); if (!tr) return null;
      const t = tAt(x), p = pAt(y);
      for (let i = tr.notes.length - 1; i >= 0; i--) { const n = tr.notes[i]; if (n.p === p && t >= n.s && t <= n.s + n.d) return n; }
      return null;
    }
    function hitOther(x, y) {
      if (!S.overlay) return null;
      const t = tAt(x), p = pAt(y);
      // topmost drawn part first; percussion is not drawn in the overlay, so it is not clickable either
      for (let i = S.tracks.length - 1; i >= 0; i--) { const tr = S.tracks[i]; if (tr.id === S.active || T.INSTR[tr.inst]?.drums) continue; for (const n of tr.notes) if (n.p === p && t >= n.s && t <= n.s + n.d) return { tr, n }; }
      return null;
    }
    let modStarted = false;
    function beginMod(label) { if (!modStarted) { pushUndo(label); modStarted = true; } }
    function endMod() { if (modStarted) { const tr = activeTrack(); markEdited(tr); tr.notes.sort((a, b) => a.s - b.s || a.p - b.p); changed({ noPreload: true }); } modStarted = false; }

    let lastDown = { t: 0, x: -99, y: -99 };
    cv.addEventListener('pointerdown', e => {
      if (!S.L) return;
      cv.focus({ preventScroll: true });
      const r = cv.getBoundingClientRect(); R.rect = r; const x = e.clientX - r.left, y = e.clientY - r.top;
      const now = performance.now(); const dbl = now - lastDown.t < 380 && Math.abs(x - lastDown.x) < 6 && Math.abs(y - lastDown.y) < 6;
      lastDown = dbl ? { t: 0, x: -99, y: -99 } : { t: now, x, y };
      cv.setPointerCapture(e.pointerId);
      const tr = activeTrack();
      if (y < R.rulerH) { R.drag = { kind: 'ruler', x0: x, t0: tAt(x) }; return; }
      if (x < R.keyW && y < R.H - R.velH) { const p = pAt(y); if (tr) Player.preview(tr.inst, p, 90, 0.5); R.drag = { kind: 'keys' }; return; }
      if (y >= R.H - R.velH) { R.drag = { kind: 'vel' }; velAt(x, y); return; }
      const n = hitNote(x, y);
      if (S.tool === 'erase') { R.drag = { kind: 'erase' }; if (n) { beginMod('Erase notes'); tr.notes = tr.notes.filter(q => q !== n); draw(); } return; }
      if (n) {
        if (dbl && S.tool === 'sel') { beginMod('Delete note'); tr.notes = tr.notes.filter(q => q !== n); S.sel.delete(n.id); endMod(); return; }
        if (!S.sel.has(n.id)) { if (!e.shiftKey) S.sel.clear(); S.sel.add(n.id); } else if (e.shiftKey) { S.sel.delete(n.id); draw(); updateSelInfo(); return; }
        const edge = X(n.s + n.d) - x < Math.min(8, n.d * R.ppt / 3);
        if (e.altKey && !edge) { beginMod('Duplicate notes'); const copies = tr.notes.filter(q => S.sel.has(q.id)).map(q => ({ ...q, id: Arranger.nid() })); S.sel = new Set(copies.map(q => q.id)); tr.notes.push(...copies); }
        const base = tr.notes.filter(q => S.sel.has(q.id)).map(q => ({ q, s: q.s, p: q.p, d: q.d }));
        const anchor = S.sel.has(n.id) ? (tr.notes.find(q => q.id === n.id) || n) : n;
        R.drag = { kind: edge ? 'resize' : 'move', x0: x, y0: y, base, anchor: { s: anchor.s, p: anchor.p }, moved: false };
        Player.preview(tr.inst, n.p, n.v, 0.3);
        draw(); updateSelInfo(); return;
      }
      const o = hitOther(x, y);
      if (o && S.tool === 'sel') { S.active = o.tr.id; S.sel = new Set([o.n.id]); renderParts(); draw(); updateScope(); updateSelInfo(); return; }
      if (S.tool === 'draw' || (S.tool === 'sel' && dbl)) {
        if (!tr) return;
        const p = pAt(y); const s = snapT(tAt(x), 'floor');
        if (s < 0 || s >= totalTicks()) return;
        beginMod('Add note');
        const len = Math.max(S.snap > 1 ? S.snap : 120, R.lastLen);
        const nn = { id: Arranger.nid(), p, s, d: len, v: 88 };
        tr.notes.push(nn); S.sel = new Set([nn.id]);
        Player.preview(tr.inst, p, 88, 0.3);
        R.drag = { kind: 'resize', x0: x, y0: y, base: [{ q: nn, s, p, d: len }], anchor: { s, p }, moved: true, created: true };
        draw(); updateSelInfo(); return;
      }
      if (!e.shiftKey) S.sel.clear();
      R.drag = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, keep: new Set(S.sel) };
      draw(); updateSelInfo();
    });
    function velAt(x, y) {
      const tr = activeTrack(); if (!tr) return;
      const vy = R.H - R.velH; const v = clamp(Math.round((1 - (y - vy - 2) / (R.velH - 10)) * 127), 1, 127);
      const t = tAt(x); const tol = 6 / R.ppt;
      let targets = tr.notes.filter(n => Math.abs(n.s - t) <= tol);
      if (S.sel.size && targets.some(n => S.sel.has(n.id))) targets = tr.notes.filter(n => S.sel.has(n.id));
      if (!targets.length) return;
      beginMod('Change velocity');
      targets.forEach(n => n.v = v); draw(); $('selInfo').textContent = 'Velocity ' + v;
    }
    cv.addEventListener('pointermove', e => {
      // during a drag, measure against the canvas position at pointer-down so layout shifts can't move notes
      const r = R.drag && R.rect ? R.rect : cv.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
      const d = R.drag;
      if (!d) {
        const n = y > R.rulerH && y < R.H - R.velH && x > R.keyW ? hitNote(x, y) : null;
        cv.style.cursor = y < R.rulerH ? 'col-resize' : n ? (X(n.s + n.d) - x < Math.min(8, n.d * R.ppt / 3) ? 'ew-resize' : 'grab') : S.tool === 'draw' ? 'crosshair' : S.tool === 'erase' ? 'not-allowed' : 'default';
        return;
      }
      const tr = activeTrack();
      if (d.kind === 'ruler') {
        if (Math.abs(x - d.x0) > 4) {
          const a = Math.floor(Math.min(d.t0, tAt(x)) / barTicks()) * barTicks(), b = Math.ceil(Math.max(d.t0, tAt(x)) / barTicks()) * barTicks();
          S.loop = { a: Math.max(0, a), b: Math.min(totalTicks(), Math.max(b, a + barTicks())) }; d.looped = true; draw(); updateScope();
        }
      } else if (d.kind === 'vel') velAt(x, y);
      else if (d.kind === 'erase') { const n = hitNote(x, y); if (n) { beginMod('Erase notes'); tr.notes = tr.notes.filter(q => q !== n); draw(); } }
      else if (d.kind === 'marquee') {
        d.x1 = x; d.y1 = y;
        const ta = tAt(Math.min(d.x0, x)), tb = tAt(Math.max(d.x0, x)), pa = pAt(Math.max(d.y0, y)), pb = pAt(Math.min(d.y0, y));
        S.sel = new Set(d.keep);
        for (const n of tr.notes) if (n.s + n.d >= ta && n.s <= tb && n.p >= pa && n.p <= pb) S.sel.add(n.id);
        draw(); updateSelInfo();
      } else if (d.kind === 'move' || d.kind === 'resize') {
        const dt = (x - d.x0) / R.ppt, dp = Math.round((d.y0 - y) / R.nh);
        if (!d.moved && Math.abs(x - d.x0) < 3 && Math.abs(y - d.y0) < 3) return;
        if (!d.moved) { beginMod(d.kind === 'move' ? 'Move notes' : 'Resize notes'); d.moved = true; }
        if (d.kind === 'move') {
          const ns = snapT(d.anchor.s + dt); const delta = ns - d.anchor.s;
          const range = T.INSTR[tr.inst]?.drums ? [27, 87] : [0, 127];
          let prevP = null;
          for (const b of d.base) { b.q.s = Math.max(0, b.s + delta); b.q.p = clamp(b.p + dp, range[0], range[1]); prevP = b.q.p; }
          if (d.lastDp !== dp && d.base.length === 1) { Player.preview(tr.inst, d.base[0].q.p, d.base[0].q.v, 0.25); }
          d.lastDp = dp;
          $('selInfo').textContent = d.base.length + ' note' + (d.base.length > 1 ? 's' : '') + ' · ' + (delta >= 0 ? '+' : '') + (delta / PPQ).toFixed(2) + ' beats, ' + (dp >= 0 ? '+' : '') + dp + ' st';
        } else {
          for (const b of d.base) { const end = snapT(b.s + b.d + dt); b.q.d = Math.max(S.snap > 1 ? Math.min(S.snap, 60) : 30, end - b.s); }
          R.lastLen = d.base[0].q.d;
        }
        draw();
      }
    });
    cv.addEventListener('pointerup', e => {
      const d = R.drag; R.drag = null;
      if (!d) return;
      if (d.kind === 'ruler' && !d.looped) { seek(clamp(snapT(d.t0, 'round'), 0, totalTicks())); }
      if (d.kind === 'ruler' && d.looped) { if (!S.loopOn) { S.loopOn = true; $('loopBtn').setAttribute('aria-pressed', 'true'); } Player.setLoop(S.loopOn ? S.loop : null); }
      if (d.kind === 'marquee') draw();
      endMod(); updateSelInfo();
    });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = cv.getBoundingClientRect(); const x = e.clientX - r.left; const t = tAt(x);
        R.ppt = clamp(R.ppt * Math.exp(-e.deltaY * 0.002), 0.01, 1.2); R.sx = Math.max(0, t - (x - R.keyW) / R.ppt);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        R.sx = clamp(R.sx + (e.deltaX || e.deltaY) / R.ppt, 0, Math.max(0, totalTicks() - (R.W - R.keyW) / R.ppt * 0.5));
      } else if (e.altKey) {
        R.nh = clamp(R.nh * Math.exp(-e.deltaY * 0.002), 5, 26);
      } else {
        R.top = clamp(R.top - Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 30)), 20, 127);
      }
      draw();
    }, { passive: false });
    function zoom(f) { const mid = tAt((R.keyW + R.W) / 2); R.ppt = clamp(R.ppt * f, 0.01, 1.2); R.sx = Math.max(0, mid - (R.W - R.keyW) / 2 / R.ppt); draw(); }
    function follow(t) { const x = X(t); if (x > R.W - 30 || x < R.keyW) { R.sx = Math.max(0, t - 20 / R.ppt); } }
    new ResizeObserver(resize).observe(cv);
    return { draw, resize, fitView, readColors, zoom, follow, scrollToTrack, R, get sel() { return S.sel; } };
  })();

  function updateSelInfo() {
    const n = S.sel.size; const tr = activeTrack();
    if (!n || !tr) { $('selInfo').textContent = ''; return; }
    const ns = tr.notes.filter(q => S.sel.has(q.id));
    if (n === 1 && ns[0]) { const q = ns[0]; $('selInfo').textContent = `${T.INSTR[tr.inst]?.drums ? (T.DRUMS[q.p] || q.p) : T.pitchName(q.p)} · bar ${Math.floor(q.s / barTicks()) + 1} beat ${(1 + (q.s % barTicks()) / PPQ).toFixed(2).replace(/\.00$/, '')} · ${(q.d / PPQ).toFixed(2)} beats · vel ${q.v}`; }
    else $('selInfo').textContent = n + ' notes selected';
  }

  // keyboard shortcuts
  let clipboard = null;
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === 'Escape') { if (window.__closeTopLayer && window.__closeTopLayer()) { e.preventDefault(); return; } }
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    if (document.querySelector('.modal:not([hidden])')) return; // dialogs are modal: no app shortcuts behind them
    const mod = e.ctrlKey || e.metaKey; const tr = activeTrack();
    // Space plays/pauses, except on controls where Space means "press this"
    if (e.code === 'Space') { if (tag === 'button' || tag === 'a' || tag === 'summary' || e.target.getAttribute('role') === 'button' || e.target.getAttribute('role') === 'tab' || e.target.getAttribute('role') === 'menuitem') return; e.preventDefault(); togglePlay(); return; }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Home') { seek(S.loopOn && S.loop ? S.loop.a : 0); return; }
    if (S.view !== 'roll' || !tr) return;
    const selNotes = () => tr.notes.filter(n => S.sel.has(n.id));
    const mutateSel = (label, fn) => { const ns = selNotes(); if (!ns.length) return; pushUndo(label); fn(ns); markEdited(tr); tr.notes.sort((a, b) => a.s - b.s); changed({ noPreload: true }); updateSelInfo(); };
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); mutateSel('Delete notes', ns => { const ids = new Set(ns.map(n => n.id)); tr.notes = tr.notes.filter(n => !ids.has(n.id)); S.sel.clear(); }); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1); mutateSel('Transpose notes', ns => ns.forEach(n => n.p = clamp(n.p + d, 0, 127))); const f = selNotes()[0]; if (f) Player.preview(tr.inst, f.p, f.v, 0.25); }
    else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { // step the selection through the notes
      e.preventDefault(); if (!tr.notes.length) return;
      const cur = tr.notes.findIndex(n => S.sel.has(n.id)); let i = cur < 0 ? 0 : cur + (e.key === 'ArrowRight' ? 1 : -1); i = clamp(i, 0, tr.notes.length - 1);
      const n = tr.notes[i]; S.sel = new Set([n.id]); roll.follow(n.s); roll.draw(); updateSelInfo(); Player.preview(tr.inst, n.p, n.v, 0.25);
    }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const g = S.snap > 1 ? S.snap : 120; const d = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? barTicks() : g); mutateSel('Move notes', ns => ns.forEach(n => n.s = Math.max(0, n.s + d))); }
    else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); S.sel = new Set(tr.notes.map(n => n.id)); roll.draw(); updateSelInfo(); }
    else if (mod && e.key.toLowerCase() === 'c') { const ns = selNotes(); if (ns.length) { const m = Math.min(...ns.map(n => n.s)); clipboard = ns.map(n => ({ ...n, s: n.s - m })); toast(ns.length + ' notes copied'); } }
    else if (mod && e.key.toLowerCase() === 'v' && clipboard) { e.preventDefault(); const at = Math.round((Player.playing ? Player.currentTick() : Player.pos) / 120) * 120; pushUndo('Paste notes'); const add = clipboard.map(n => ({ ...n, id: Arranger.nid(), s: n.s + at })); tr.notes.push(...add); S.sel = new Set(add.map(n => n.id)); markEdited(tr); tr.notes.sort((a, b) => a.s - b.s); changed({ noPreload: true }); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); const ns = selNotes(); if (!ns.length) return; const a = Math.min(...ns.map(n => n.s)), b = Math.max(...ns.map(n => n.s + n.d)); const span = Math.ceil((b - a) / barTicks()) * barTicks(); pushUndo('Duplicate notes'); const add = ns.map(n => ({ ...n, id: Arranger.nid(), s: n.s + span })); tr.notes.push(...add); S.sel = new Set(add.map(n => n.id)); markEdited(tr); changed({ noPreload: true }); }
    else if (e.key.toLowerCase() === 'q' && !mod) quantizeSel();
    else if (e.key.toLowerCase() === 'v' && !mod) setTool('sel');
    else if (e.key.toLowerCase() === 'd' && !mod) setTool('draw');
    else if (e.key.toLowerCase() === 'e' && !mod) setTool('erase');
    else if (e.key === 'Escape') { S.sel.clear(); roll.draw(); updateSelInfo(); }
    else if (e.key === 'Enter' && e.target.id === 'roll') { // keyboard note entry at the playhead
      e.preventDefault();
      const sel = tr.notes.filter(n => S.sel.has(n.id)); const g = S.snap > 1 ? S.snap : 120;
      const at = Math.round((Player.playing ? Player.currentTick() : Player.pos) / g) * g;
      const p = sel.length ? sel[sel.length - 1].p : Math.round(roll.R.top - (roll.R.H - roll.R.rulerH - roll.R.velH) / roll.R.nh / 2);
      pushUndo('Add note'); const nn = { id: Arranger.nid(), p, s: at, d: g, v: 88 }; tr.notes.push(nn); tr.notes.sort((a, b) => a.s - b.s); S.sel = new Set([nn.id]);
      markEdited(tr); Player.preview(tr.inst, p, 88, 0.3); Player.pos = at + g; changed({ noPreload: true }); updateSelInfo();
    }

  });
  function quantizeSel() {
    const tr = activeTrack(); if (!tr) return; const g = S.snap > 1 ? S.snap : 120;
    const ns = S.sel.size ? tr.notes.filter(n => S.sel.has(n.id)) : tr.notes;
    if (!ns.length) { toast('This part has no notes to quantise.'); return; }
    pushUndo('Quantise'); ns.forEach(n => { const s = Math.round(n.s / g) * g; const e2 = Math.max(s + g, Math.round((n.s + n.d) / g) * g); n.s = s; n.d = e2 - s; });
    const gridName = S.snap > 1 ? $('snap').selectedOptions[0].text : '1/16';
    markEdited(tr); changed({ noPreload: true }); toast((S.sel.size ? 'Quantised ' + ns.length + ' selected note' + (ns.length === 1 ? '' : 's') : 'Quantised all ' + ns.length + ' notes of ' + tr.name) + ' to ' + gridName + (S.snap > 1 ? '' : ' (snap is off, so sixteenths were used)'));
  }
  function setTool(t) { S.tool = t; $('toolSel').setAttribute('aria-pressed', t === 'sel'); $('toolDraw').setAttribute('aria-pressed', t === 'draw'); $('toolErase').setAttribute('aria-pressed', t === 'erase'); }

  // ------------------------------------------------------------------ score view
  let scoreRendered = null, scoreTimer = null;
  function pageBars() { const staffCount = $('scorePart').value === 'all' ? Notation.staves({ st: S.st, tracks: S.tracks }).length : 1; return staffCount >= 8 ? 12 : staffCount >= 3 ? 24 : 32; }
  function scorePages() { const pb = pageBars(); return { pb, n: Math.max(1, Math.ceil(S.L.nBars / pb)) }; }
  // render after the browser has painted the "Rendering" message, and coalesce bursts of edits
  function renderScore(immediate) {
    clearTimeout(scoreTimer);
    if (!immediate) { if (!scoreRendered) $('paper').innerHTML = '<div class="score-msg">Rendering score…</div>'; scoreTimer = setTimeout(() => renderScoreNow(), 60); return; }
    renderScoreNow();
  }
  function renderScoreNow() {
    if (!window.ABCJS) { $('paper').innerHTML = '<div class="score-msg">The notation renderer did not load.</div>'; return; }
    const part = $('scorePart').value || 'all';
    const mpl = +$('mpl').value || 4;
    const { pb, n } = scorePages();
    S.scorePage = clamp(S.scorePage || 0, 0, n - 1);
    const fromBar = S.scorePage * pb, toBar = Math.min(S.L.nBars, fromBar + pb);
    const project = { title: S.title, st: S.st, L: S.L, P: S.P, tracks: S.tracks };
    const only = part === 'all' ? null : [part];
    const abc = Notation.toABC(project, { measuresPerLine: mpl, only, fromBar, toBar, chords: $('chordSyms').checked, chordsOnTop: true, subtitle: only ? trackById(part)?.name : (S.st.mode === 'piano' ? 'for piano' : 'Full score in C'), composerLine: S.an.mode === 'score' ? (S.an.source?.composer || '') : 'Arranged from ' + (S.an.fileName || 'a recording').replace(/\.[a-z0-9]+$/i, '') });
    try {
      ABCJS.renderAbc('paper', abc, { add_classes: true, responsive: 'resize', staffwidth: Math.max(560, mpl * 230), paddingleft: 8, paddingright: 8, clickListener: (el, tn, classes) => { const m = /abcjs-mm(\d+)/.exec(classes || ''); if (m) seek((fromBar + +m[1]) * barTicks()); } });
      scoreRendered = { mpl, abc, fromBar, toBar };
    } catch (e) { $('paper').innerHTML = '<div class="score-msg">Could not render this score: ' + esc(e.message) + '</div>'; }
    $('scorePager').hidden = n <= 1;
    $('scorePageInfo').textContent = 'Bars ' + (fromBar + 1) + '–' + toBar + ' of ' + S.L.nBars;
    $('scorePrev').disabled = S.scorePage <= 0; $('scoreNext').disabled = S.scorePage >= n - 1;
    S.scoreDirty = false; lastHl = -1;
  }
  function scoreGoto(page) { S.scorePage = page; renderScore(true); $('scoreBox').scrollTop = 0; }
  let lastHl = -1;
  function highlightBar(bar) {
    if (!scoreRendered || bar === lastHl) return;
    document.querySelectorAll('#paper .bar-hl').forEach(el => el.classList.remove('bar-hl'));
    lastHl = bar;
    if (bar < 0) return;
    if (Player.playing && $('followScore').checked && (bar < scoreRendered.fromBar || bar >= scoreRendered.toBar)) { const { pb } = scorePages(); scoreGoto(Math.floor(bar / pb)); lastHl = bar; }
    const els = document.querySelectorAll(`#paper .abcjs-mm${bar - scoreRendered.fromBar}`);
    els.forEach(el => { if (el.classList.contains('abcjs-note') || el.classList.contains('abcjs-rest')) el.classList.add('bar-hl'); });
    if ($('followScore').checked && els[0] && Player.playing) {
      const box = $('scoreBox'); const r = els[0].getBoundingClientRect(), br = box.getBoundingClientRect();
      if (r.top < br.top + 20 || r.bottom > br.bottom - 20) box.scrollTop += r.top - br.top - 60;
    }
  }

  // ------------------------------------------------------------------ recording (analysis) view
  const anView = (() => {
    const cv = $('anCanvas'), c = cv.getContext('2d');
    const V = { t0: 0, t1: 30, lo: 28, hi: 100, W: 0, H: 0, dpr: 1, img: null, imgFor: null, computing: false, drag: null };
    function reset() { V.img = null; V.imgFor = null; const an = S.an; if (!an) return; V.t0 = an.offsetSec || 0; V.t1 = V.t0 + Math.min(an.analysedSec || an.duration, 40); draw(); }
    function resize() { const r = cv.getBoundingClientRect(); V.dpr = window.devicePixelRatio || 1; V.W = r.width; V.H = r.height; cv.width = Math.round(V.W * V.dpr); cv.height = Math.round(V.H * V.dpr); draw(); }
    async function ensureSpec() {
      if (S.spec || V.computing || !S.audioBuf) return;
      V.computing = true; draw();
      try { S.spec = await Analysis.spectrum(S.audioBuf, S.an.offsetSec || 0, (S.an.offsetSec || 0) + (S.an.analysedSec || S.audioBuf.duration)); } catch (e) { console.warn(e); }
      V.computing = false; V.img = null; draw();
    }
    function buildImg() {
      const sp = S.spec; if (!sp) return null;
      const dark = getComputedStyle(document.documentElement).colorScheme === 'dark' || cssVar('--bg').startsWith('#0');
      const key = sp.frames + ':' + dark; if (V.img && V.imgFor === key) return V.img;
      const off = document.createElement('canvas'); off.width = sp.frames; off.height = sp.bands;
      const ox = off.getContext('2d'); const id = ox.createImageData(sp.frames, sp.bands);
      // percentile normalisation
      const sample = []; for (let i = 0; i < sp.data.length; i += 97) sample.push(sp.data[i]); sample.sort((a, b) => a - b);
      const lo = sample[Math.floor(sample.length * 0.35)] || 0, hi = sample[Math.floor(sample.length * 0.995)] || 255;
      for (let f = 0; f < sp.frames; f++) for (let b = 0; b < sp.bands; b++) {
        const v = clamp((sp.data[f * sp.bands + b] - lo) / (hi - lo + 1e-6), 0, 1);
        const o = ((sp.bands - 1 - b) * sp.frames + f) * 4;
        if (dark) { id.data[o] = 18 + 200 * v; id.data[o + 1] = 22 + 150 * v * v; id.data[o + 2] = 29 + 40 * v; }
        else { id.data[o] = 248 - 200 * v; id.data[o + 1] = 249 - 190 * v; id.data[o + 2] = 251 - 120 * v; }
        id.data[o + 3] = 255;
      }
      ox.putImageData(id, 0, 0); V.img = off; V.imgFor = key; return off;
    }
    const X = t => 40 + (t - V.t0) / (V.t1 - V.t0) * (V.W - 40);
    const Y = p => 22 + (V.hi - p) / (V.hi - V.lo) * (V.H - 30);
    function draw() {
      if (!V.W || !S.an || S.view !== 'an') return;
      const C = roll.R.colors; c.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
      c.fillStyle = C['--roll-bg']; c.fillRect(0, 0, V.W, V.H);
      const an = S.an;
      if ($('layerSpec').checked) {
        const img = buildImg();
        if (img) {
          const sp = S.spec; const f0 = (V.t0 - sp.offsetSec) * sp.fps, f1 = (V.t1 - sp.offsetSec) * sp.fps;
          const b0 = V.lo - sp.minMidi, b1 = V.hi - sp.minMidi + 1;
          c.imageSmoothingEnabled = true;
          c.drawImage(img, f0, sp.bands - b1, f1 - f0, b1 - b0, 40, 22 - (V.H - 30) / (V.hi - V.lo) * 0.5, V.W - 40, V.H - 30 + (V.H - 30) / (V.hi - V.lo));
        } else { c.fillStyle = C['--muted']; c.font = `12px ${cssVar('--sans')}`; c.fillText(V.computing ? 'Computing spectrogram…' : S.audioBuf ? '' : 'The original audio is not loaded in this session, so only the detected notes are shown.', 52, 40); }
      }
      // beat & bar lines
      const bm = Analysis.makeBeatMap(an.beatTimes);
      const bpb = an.beatsPerBar;
      c.font = `500 10.5px ${cssVar('--mono')}`;
      for (let b = 0; b < an.beatTimes.length; b++) {
        const t = an.beatTimes[b]; if (t < V.t0 || t > V.t1) continue; const x = X(t);
        c.fillStyle = b % bpb === 0 ? C['--roll-bar'] : C['--roll-beat']; c.globalAlpha = b % bpb === 0 ? 0.9 : 0.5; c.fillRect(Math.round(x), 16, 1, V.H - 16); c.globalAlpha = 1;
        if (b % bpb === 0) { c.fillStyle = C['--ink']; c.fillText(String(b / bpb + 1), x + 3, 12); }
      }
      // chords
      c.fillStyle = C['--muted']; c.font = `500 10.5px ${cssVar('--sans')}`;
      const flats = T.flatKey(an.key.tonic, an.key.mode);
      for (const ch of an.chords) { if (ch.type === 'N') continue; const t = bm.toTime(ch.s); if (t < V.t0 || t > V.t1) continue; c.fillText(T.chordName(ch, flats), X(t) + 3, 24); }
      const nh = Math.max(2, (V.H - 30) / (V.hi - V.lo) - 1);
      if ($('layerNotes').checked) {
        c.fillStyle = C['--faint']; c.globalAlpha = 0.85;
        for (const n of an.raw || []) { if (n.t > V.t1 || n.t + n.d < V.t0) continue; c.globalAlpha = 0.3 + 0.6 * n.a; c.fillRect(X(n.t), Y(n.p) - nh / 2, Math.max(2, n.d / (V.t1 - V.t0) * (V.W - 40)), nh); }
        c.globalAlpha = 1;
      }
      if ($('layerLines').checked) {
        const line = (arr, col) => { c.strokeStyle = col; c.lineWidth = 2; for (const n of arr) { const t = bm.toTime(n.s), e = bm.toTime(n.s + n.d); if (t > V.t1 || e < V.t0) continue; c.strokeRect(X(t), Y(n.p) - nh / 2, Math.max(3, X(e) - X(t)), nh); } };
        line(an.melody, C['c-orange']); line(an.bass, C['c-blue']);
      }
      // pitch labels
      c.fillStyle = C['--panel']; c.fillRect(0, 0, 40, V.H);
      c.fillStyle = C['--muted']; c.font = `10px ${cssVar('--mono')}`;
      for (let p = Math.ceil(V.lo / 12) * 12; p <= V.hi; p += 12) { c.fillText('C' + (p / 12 - 1), 6, Y(p) + 3); c.fillStyle = C['--line']; c.fillRect(40, Math.round(Y(p)) + 0.5, V.W, 0.5); c.fillStyle = C['--muted']; }
      // playhead (recording time)
      if (V.playT != null) { c.fillStyle = C['--playhead']; c.fillRect(X(V.playT), 0, 2, V.H); }
      $('anInfo').textContent = `${fmtTime(V.t0)} – ${fmtTime(V.t1)} · scroll to pan, Ctrl+scroll to zoom`;
    }
    cv.addEventListener('wheel', e => {
      e.preventDefault(); const an = S.an; if (!an) return;
      const span = V.t1 - V.t0, startMin = an.offsetSec || 0, endMax = startMin + (an.analysedSec || an.duration);
      if (e.ctrlKey || e.metaKey) { const r = cv.getBoundingClientRect(); const tx = V.t0 + (e.clientX - r.left - 40) / (V.W - 40) * span; const ns = clamp(span * Math.exp(e.deltaY * 0.002), 2, endMax - startMin + 1); V.t0 = Math.max(startMin, tx - (tx - V.t0) * ns / span); V.t1 = V.t0 + ns; }
      else { const d = (e.deltaX || e.deltaY) / (V.W - 40) * span; V.t0 = clamp(V.t0 + d, startMin, Math.max(startMin, endMax - span)); V.t1 = V.t0 + span; }
      draw();
    }, { passive: false });
    cv.addEventListener('pointerdown', e => {
      const r = cv.getBoundingClientRect(); const x = e.clientX - r.left; if (x < 40) return;
      const t = V.t0 + (x - 40) / (V.W - 40) * (V.t1 - V.t0);
      if (!S.audioBuf) { toast('Upload the recording again to hear it here.'); return; }
      Player.stop(); updatePlayIcon(); Player.playOriginalSnippet(t, 3);
      V.playT = t; const start = performance.now();
      const anim = () => { const el = (performance.now() - start) / 1000; if (el > 3) { V.playT = null; draw(); return; } V.playT = t + el; draw(); requestAnimationFrame(anim); };
      requestAnimationFrame(anim);
    });
    new ResizeObserver(resize).observe(cv);
    return { reset, draw, ensureSpec, V };
  })();

  // ------------------------------------------------------------------ tabs
  function setView(v) {
    S.view = v;
    $('tabRoll').setAttribute('aria-selected', v === 'roll'); $('tabScore').setAttribute('aria-selected', v === 'score'); $('tabAn').setAttribute('aria-selected', v === 'an');
    $('viewRoll').hidden = v !== 'roll'; $('viewScore').hidden = v !== 'score'; $('viewAn').hidden = v !== 'an';
    $('rollTools').hidden = v !== 'roll'; $('scoreTools').hidden = v !== 'score'; $('anTools').hidden = v !== 'an';
    if (v === 'roll') roll.resize();
    if (v === 'score' && S.scoreDirty) renderScore();
    if (v === 'an') { requestAnimationFrame(() => { anView.draw(); anView.ensureSpec(); }); }
  }

  // ------------------------------------------------------------------ transport
  function seek(t) { Player.pos = t; if (Player.playing) startPlay(t); else { roll.draw(); updatePos(t); highlightBar(Math.floor(t / barTicks())); } }
  async function startPlay(from) {
    const need = S.tracks.filter(t => !Player.isLoaded(t.inst));
    if (need.length) { $('loadState').textContent = 'Loading sounds…'; await Player.loadFor(S.tracks); $('loadState').textContent = ''; }
    await Player.play({ tracks: S.tracks, st: S.st, L: S.L, an: S.an, from: from ?? Player.pos, loop: S.loopOn && S.loop ? S.loop : null, original: $('origOn').checked && S.st.timing === 'original', click: $('clickBtn').getAttribute('aria-pressed') === 'true', endTick: totalTicks(), onEnd: () => { updatePlayIcon(); roll.draw(); } });
    updatePlayIcon(); tickUI();
  }
  function togglePlay() { if (Player.playing) { Player.stop(); updatePlayIcon(); roll.draw(); } else startPlay(); }
  function updatePlayIcon() { $('playIcon').innerHTML = Player.playing ? '<path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/>' : '<path d="M4 2.5v11l9.5-5.5z"/>'; $('play').setAttribute('aria-label', Player.playing ? 'Pause' : 'Play'); }
  function updatePos(t) {
    const bt = barTicks(); const bar = Math.floor(t / bt) + 1; const beat = Math.floor((t % bt) / S.L.ts.beatTicks) + 1;
    $('posBar').textContent = bar + '.' + beat;
    const clock = Player.makeClock(S.st, S.an, S.L);
    $('posTime').textContent = fmtTime(clock.tickToSec(t) - clock.tickToSec(0));
  }
  function tickUI() {
    if (!Player.playing) { updatePlayIcon(); return; }
    const t = Player.currentTick();
    roll.follow(t); roll.draw(); updatePos(t);
    if (S.view === 'score') highlightBar(Math.floor(t / barTicks()));
    if (S.view === 'an' && S.st.timing === 'original') { anView.V.playT = Player.makeClock(S.st, S.an, S.L).tickToSec(t); anView.draw(); }
    requestAnimationFrame(tickUI);
  }
  function updateTransportUI() {
    if (!S.st) return;
    const ts = S.L ? S.L.ts : T.timeSig(4, 4);
    $('tempo').value = Math.round(ts.compound ? S.st.tempo / 1.5 : S.st.tempo);
    $('tempoUnit').textContent = ts.compound ? 'BPM (♩.)' : 'BPM';
    $('timeArr').setAttribute('aria-pressed', S.st.timing !== 'original'); $('timeOrig').setAttribute('aria-pressed', S.st.timing === 'original');
    const canOrig = S.L && S.L.identity;
    $('timeOrig').disabled = !canOrig; $('timeOrig').title = canOrig ? 'Follow the timing of the recording' : 'Available when the time signature matches the recording';
    $('origOn').disabled = !S.audioBuf;
    $('tempo').disabled = S.st.timing === 'original';
  }
  function bindTransport() {
    $('play').onclick = togglePlay;
    $('toStart').onclick = () => seek(S.loopOn && S.loop ? S.loop.a : 0);
    $('loopBtn').onclick = () => {
      if (!S.loop) { const a = Math.floor(Player.pos / barTicks()) * barTicks(); S.loop = { a, b: Math.min(totalTicks(), a + 4 * barTicks()) }; }
      S.loopOn = !S.loopOn; $('loopBtn').setAttribute('aria-pressed', S.loopOn); Player.setLoop(S.loopOn ? S.loop : null); roll.draw(); updateScope();
      if (Player.playing) startPlay(Player.currentTick());
    };
    $('clickBtn').onclick = () => { const on = $('clickBtn').getAttribute('aria-pressed') !== 'true'; $('clickBtn').setAttribute('aria-pressed', on); Player.setClick(on); };
    $('tempo').onchange = e => { const v = clamp(+e.target.value || 90, 20, 300); const ts = S.L.ts; S.st.tempo = ts.compound ? v * 1.5 : v; updateTransportUI(); scheduleSave(); S.scoreDirty = true; if (Player.playing) startPlay(Player.currentTick()); };
    $('timeArr').onclick = () => { S.st.timing = 'arranged'; $('origOn').checked = false; Player.setOriginalOn(false); updateTransportUI(); if (Player.playing) startPlay(Player.currentTick()); };
    $('timeOrig').onclick = () => { if (!S.L.identity) return; S.st.timing = 'original'; updateTransportUI(); if (Player.playing) startPlay(Player.currentTick()); };
    $('origOn').onchange = e => {
      if (e.target.checked && S.st.timing !== 'original') {
        if (!S.L.identity) { e.target.checked = false; toast('Set the time signature back to the original to play along with the recording.'); return; }
        S.st.timing = 'original'; updateTransportUI(); toast('Switched to the recording’s timing so both stay in sync.');
      }
      Player.setOriginalVol(+$('origVol').value);
      if (Player.playing) startPlay(Player.currentTick());
    };
    $('origVol').oninput = e => Player.setOriginalVol(+e.target.value);
    $('masterVol').oninput = e => Player.setMaster(+e.target.value);
  }
  let preloadTimer = null;
  function preloadSounds() { clearTimeout(preloadTimer); preloadTimer = setTimeout(() => { if (Player.ctx) Player.loadFor(S.tracks); }, 400); }

  // expose for later modules
  Object.assign(window, { __ui: { openModal, closeModal, swapInstrument, removePart, undoTo, originalTs, isOriginalMeter, S, roll, renderScore, renderParts, changed, pushUndo, markEdited, toast, trackById, activeTrack, setActive, regenTrack, addPart, applySettings, settingChange, fillSettings, loadProject, relead, sortTracks, fitNotes, seek, setView, updateScope: () => updateScope(), anView, showReport, togglePlay, setTool, quantizeSel, openAdd, undo, redo, fmtTime, esc, clone, clamp, cssVar, renderFacts, renderChat: () => renderChat(), scheduleSave: () => scheduleSave(), updateTransportUI, updatePlayIcon, startPlay } });

  // forward declarations completed in ui2.js
  function renderChat() { window.__ui2 && window.__ui2.renderChat(); }
  function updateScope() { window.__ui2 && window.__ui2.updateScope(); }
  function scheduleSave() { window.__ui2 && window.__ui2.scheduleSave(); }

  // ------------------------------------------------------------------ bind static controls
  // dialogs: move focus in, keep Tab inside, give focus back on close
  const modalReturn = {};
  function openModal(id) {
    modalReturn[id] = document.activeElement; const m = $(id); m.hidden = false;
    const f = m.querySelector('select, input, button, textarea, [tabindex]:not([tabindex="-1"])'); if (f) setTimeout(() => f.focus(), 0);
  }
  function closeModal(id) { $(id).hidden = true; const r = modalReturn[id]; if (r && r.focus) r.focus(); }
  document.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const m = document.querySelector('.modal:not([hidden])'); if (!m) return;
    const f = [...m.querySelectorAll('select, input, button, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
  });
  function bindStatic() {
    bindSettings(); bindParts(); bindTransport();
    $('tabRoll').onclick = () => setView('roll'); $('tabScore').onclick = () => setView('score'); $('tabAn').onclick = () => setView('an');
    $('toolSel').onclick = () => setTool('sel'); $('toolDraw').onclick = () => setTool('draw'); $('toolErase').onclick = () => setTool('erase');
    $('activeTrack').onchange = e => setActive(e.target.value);
    $('snap').onchange = e => { S.snap = +e.target.value; roll.draw(); };
    $('overlay').onchange = e => { S.overlay = e.target.checked; roll.draw(); };
    $('zoomIn').onclick = () => roll.zoom(1.4); $('zoomOut').onclick = () => roll.zoom(1 / 1.4);
    $('quantBtn').onclick = quantizeSel;
    $('undo').onclick = undo; $('redo').onclick = redo;
    $('scorePart').onchange = () => { S.scorePage = 0; renderScore(); }; $('mpl').onchange = () => renderScore(); $('chordSyms').onchange = () => renderScore();
    $('scorePrev').onclick = () => scoreGoto((S.scorePage || 0) - 1); $('scoreNext').onclick = () => scoreGoto((S.scorePage || 0) + 1);
    ['layerSpec', 'layerNotes', 'layerLines'].forEach(id => $(id).onchange = () => anView.draw());
    $('showReport').onclick = showReport; $('repClose').onclick = () => closeModal('report');
    $('addPart').onclick = openAdd; $('addCancel').onclick = () => closeModal('addModal');
    // tabs: arrow keys move between them
    const tabs = ['tabRoll', 'tabScore', 'tabAn'], views = ['roll', 'score', 'an'];
    tabs.forEach((id, i) => $(id).addEventListener('keydown', e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const j = (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3; setView(views[j]); $(tabs[j]).focus(); } }));
    $('addOk').onclick = () => {
      const inst = $('addInst').value, role = $('addRole').value;
      const a = clamp(+$('addFrom').value || 1, 1, S.L.nBars) - 1, b = clamp(+$('addTo').value || S.L.nBars, a + 1, S.L.nBars) - 1;
      pushUndo('Add ' + T.INSTR[inst].name);
      const t = addPart(inst, role, a, b);
      closeModal('addModal'); S.active = t.id; changed(); roll.scrollToTrack(); toast(t.name + ' added (' + $('addRole').selectedOptions[0].text.toLowerCase() + ', bars ' + (a + 1) + '–' + (b + 1) + ')');
    };
    $('title').onchange = e => { S.title = e.target.value.trim() || 'Untitled arrangement'; S.scoreDirty = true; scheduleSave(); };
    for (const m of ['report', 'addModal']) $(m).addEventListener('click', e => { if (e.target.id === m) closeModal(m); });
    window.__closeTopLayer = () => {
      if (window.__ui2 && window.__ui2.closeMenu && window.__ui2.closeMenu()) return true;
      for (const m of ['addModal', 'report']) if (!$(m).hidden) { closeModal(m); return true; }
      return false;
    };
    const themeObs = () => { roll.readColors(); roll.draw(); anView.V.img = null; anView.draw(); };
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeObs);
    new MutationObserver(themeObs).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    roll.readColors();
  }
  bindStatic();
})();
