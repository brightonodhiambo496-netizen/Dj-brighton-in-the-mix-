'use strict';
/* =====================================================================
   CROSS DJ PRO  -  two-deck DJ app (Web Audio)
   Sections: 1 Helpers | 2 Audio engine | 3 Deck | 4 Mixer | 5 Demo songs
             6 Recording | 7 Start-up
   ===================================================================== */

/* ---------- 1. HELPERS ---------- */
const $ = (s, r = document) => r.querySelector(s);
let ctx, master, comp, analyser, recDest;
const decks = {};
const fmt = t => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
};
let statusTimer;
function status(msg) {
  const el = $('#status');
  el.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = 'Cross DJ Pro'; }, 6000);
}
function holdRepeat(btn, fn) {          // press & hold = repeat
  let iv, to;
  const stop = () => { clearTimeout(to); clearInterval(iv); };
  btn.addEventListener('pointerdown', e => {
    e.preventDefault(); fn();
    to = setTimeout(() => { iv = setInterval(fn, 70); }, 350);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => btn.addEventListener(ev, stop));
}

/* ---------- 2. AUDIO ENGINE ---------- */
function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = +$('#master').value;
  comp = ctx.createDynamicsCompressor();          // soft limiter so it never clips harshly
  comp.threshold.value = -6; comp.knee.value = 6; comp.ratio.value = 12;
  comp.attack.value = 0.003; comp.release.value = 0.12;
  analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  recDest = ctx.createMediaStreamDestination();
  master.connect(comp); comp.connect(analyser); analyser.connect(ctx.destination);
  comp.connect(recDest);
  Object.values(decks).forEach(d => d.buildAudio());
  applyCross();
}
function makeImpulse(sec) {
  const len = Math.floor(ctx.sampleRate * sec);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  }
  return b;
}
function detectBPM(buf) {               // simple tempo finder (autocorrelation of beat onsets)
  const sr = buf.sampleRate, ch = buf.getChannelData(0);
  const hop = Math.round(sr / 200);     // 5 ms
  const n = Math.floor(Math.min(ch.length, sr * 90) / hop);
  if (n < 400) return 0;
  const env = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < hop; j++) { lp += 0.1 * (ch[i * hop + j] - lp); sum += lp * lp; }
    env[i] = Math.sqrt(sum / hop);
  }
  const on = new Float32Array(n);
  for (let i = 1; i < n; i++) on[i] = Math.max(0, env[i] - env[i - 1]);
  const minLag = Math.floor(200 * 60 / 180), maxLag = Math.ceil(200 * 60 / 70);
  const ac = new Float32Array(maxLag + 2);
  let best = minLag, bv = -1;
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += on[i] * on[i + lag];
    ac[lag] = s / (n - lag);
    if (lag >= minLag && lag <= maxLag && ac[lag] > bv) { bv = ac[lag]; best = lag; }
  }
  const a = ac[best - 1], b = ac[best], c = ac[best + 1];
  const den = a - 2 * b + c;
  const lagF = best + (den !== 0 ? 0.5 * (a - c) / den : 0);
  let bpm = 12000 / lagF;
  while (bpm < 80) bpm *= 2;
  while (bpm >= 170) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

/* ---------- 3. DECK ---------- */
class Deck {
  constructor(id) {
    this.id = id;
    this.other = null;
    this.buf = null; this.src = null; this.playing = false;
    this.offset = 0; this.startedAt = 0;
    this.pitch = 0; this.nudge = 0;
    this.bpm = 0; this.cue = 0; this.hot = [null, null, null, null];
    this.loop = null; this.peaks = null; this.name = '';
    this.fxOn = false; this.preview = false; this.dirty = true;
    this.vol = 1; this.xf = 1;
    this.el = $('#deck' + id);
    this.buildUI();
  }
  get eff() { return (1 + this.pitch / 100) * (1 + this.nudge); }
  q(s) { return this.el.querySelector(s); }

  buildUI() {
    const sl = (name, key, min, max, step, val, wide) =>
      `<label class="sl${wide ? ' wide' : ''}"><span data-reset="${key}">${name}</span><input data-r="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
    this.el.innerHTML = `
      <div class="dh"><b class="dn">DECK ${this.id}</b><span class="tname" data-r="name">No track loaded</span></div>
      <div class="wave"><canvas data-r="wave"></canvas></div>
      <div class="info"><span data-r="time">0:00.0</span>
        <span class="bpmbox"><button data-a="bpm-">−</button><b data-r="bpm">--</b><small>BPM</small><button data-a="bpm+">+</button></span>
        <span data-r="rem">-0:00.0</span></div>
      <div class="row"><button data-a="load">LOAD</button><button data-a="demo">DEMO</button><button data-a="cue" class="cue">CUE</button><button data-a="play" class="play">▶</button><button data-a="sync">SYNC</button></div>
      <div class="row"><span class="lbl">LOOP</span><button data-loop="1">1</button><button data-loop="2">2</button><button data-loop="4">4</button><button data-loop="8">8</button></div>
      <div class="row"><button class="pad" data-hot="0">1</button><button class="pad" data-hot="1">2</button><button class="pad" data-hot="2">3</button><button class="pad" data-hot="3">4</button><span class="lbl">HOT CUE</span></div>
      <div class="sliders">
        ${sl('HI', 'hi', -1, 1, 0.01, 0)}${sl('MID', 'mid', -1, 1, 0.01, 0)}
        ${sl('LOW', 'lo', -1, 1, 0.01, 0)}${sl('FILTER', 'flt', -1, 1, 0.01, 0)}
        ${sl('PITCH', 'pitch', -16, 16, 0.1, 0)}${sl('VOLUME', 'vol', 0, 1, 0.01, 1)}
      </div>
      <div class="nudge"><button data-nudge="-1">◀ NUDGE</button><button data-nudge="1">NUDGE ▶</button></div>
      <div class="fx"><select data-r="fxType"><option value="echo">ECHO</option><option value="reverb">REVERB</option><option value="flanger">FLANGER</option></select>
        <input data-r="fxAmt" type="range" min="0" max="1" step="0.01" value="0.5"><button data-a="fx">FX</button></div>`;

    const on = (sel, ev, fn) => this.el.querySelectorAll(sel).forEach(e => e.addEventListener(ev, fn));
    on('[data-a="load"]', 'click', () => { this.pickFile(); });
    on('[data-a="demo"]', 'click', () => { this.loadDemo(); });
    on('[data-a="play"]', 'click', () => { initAudio(); this.togglePlay(); });
    on('[data-a="sync"]', 'click', () => this.sync());
    on('[data-a="fx"]', 'click', () => { this.fxOn = !this.fxOn; this.applyFx(); });
    holdRepeat(this.q('[data-a="bpm-"]'), () => this.adjBpm(-0.1));
    holdRepeat(this.q('[data-a="bpm+"]'), () => this.adjBpm(0.1));

    const cue = this.q('[data-a="cue"]');
    cue.addEventListener('pointerdown', e => { e.preventDefault(); initAudio(); this.cueDown(); });
    ['pointerup', 'pointercancel'].forEach(ev => cue.addEventListener(ev, () => this.cueUp()));

    on('[data-loop]', 'click', e => this.toggleLoop(+e.currentTarget.dataset.loop));

    this.el.querySelectorAll('[data-hot]').forEach(p => {
      let t, held = false;
      p.addEventListener('pointerdown', e => {
        e.preventDefault(); held = false;
        t = setTimeout(() => { held = true; this.clearHot(+p.dataset.hot); }, 700);
      });
      const up = () => { clearTimeout(t); };
      p.addEventListener('pointerup', () => { up(); if (!held) this.hotTap(+p.dataset.hot); });
      p.addEventListener('pointercancel', up);
    });

    this.el.querySelectorAll('[data-nudge]').forEach(b => {
      const s = +b.dataset.nudge;
      b.addEventListener('pointerdown', e => { e.preventDefault(); b.classList.add('on'); this.setNudge(0.06 * s); });
      const off = () => { b.classList.remove('on'); this.setNudge(0); };
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => b.addEventListener(ev, off));
    });

    // sliders
    this.q('[data-r="hi"]').addEventListener('input', () => this.applyEq());
    this.q('[data-r="mid"]').addEventListener('input', () => this.applyEq());
    this.q('[data-r="lo"]').addEventListener('input', () => this.applyEq());
    this.q('[data-r="flt"]').addEventListener('input', () => this.applyFilter());
    this.q('[data-r="pitch"]').addEventListener('input', e => this.setPitch(+e.target.value));
    this.q('[data-r="vol"]').addEventListener('input', e => { this.vol = +e.target.value; applyCross(); });
    this.q('[data-r="fxAmt"]').addEventListener('input', () => this.applyFx());
    this.q('[data-r="fxType"]').addEventListener('change', () => this.applyFx());
    this.el.querySelectorAll('[data-reset]').forEach(sp => sp.addEventListener('click', () => {
      const inp = this.q('[data-r="' + sp.dataset.reset + '"]');
      inp.value = sp.dataset.reset === 'vol' ? 1 : 0;
      inp.dispatchEvent(new Event('input'));
    }));

    // waveform seek
    const wave = this.q('[data-r="wave"]');
    wave.addEventListener('pointerdown', e => {
      if (!this.buf) return;
      const r = wave.getBoundingClientRect();
      this.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * this.buf.duration);
    });
    this.dirty = true;
  }

  buildAudio() {
    const c = ctx;
    this.trim = c.createGain();
    this.lo = c.createBiquadFilter(); this.lo.type = 'lowshelf'; this.lo.frequency.value = 250;
    this.mid = c.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1200; this.mid.Q.value = 0.8;
    this.hi = c.createBiquadFilter(); this.hi.type = 'highshelf'; this.hi.frequency.value = 3500;
    this.flt = c.createBiquadFilter(); this.flt.type = 'lowpass'; this.flt.frequency.value = 20000; this.flt.Q.value = 0.9;
    this.dry = c.createGain();
    this.out = c.createGain();
    this.trim.connect(this.lo); this.lo.connect(this.mid); this.mid.connect(this.hi);
    this.hi.connect(this.flt); this.flt.connect(this.dry); this.dry.connect(this.out);
    this.out.connect(master);
    // FX send
    this.fxIn = c.createGain(); this.fxIn.gain.value = 0;
    this.flt.connect(this.fxIn);
    this.dl = c.createDelay(2); this.dl.delayTime.value = 0.375;
    this.fb = c.createGain(); this.fb.gain.value = 0.45;
    this.echoOut = c.createGain();
    this.fxIn.connect(this.dl); this.dl.connect(this.echoOut); this.dl.connect(this.fb); this.fb.connect(this.dl);
    this.echoOut.connect(this.out);
    this.conv = c.createConvolver(); this.conv.buffer = makeImpulse(2.2);
    this.revOut = c.createGain();
    this.fxIn.connect(this.conv); this.conv.connect(this.revOut); this.revOut.connect(this.out);
    this.fl = c.createDelay(0.05); this.fl.delayTime.value = 0.004;
    this.lfo = c.createOscillator(); this.lfo.frequency.value = 0.3;
    this.lfoG = c.createGain(); this.lfoG.gain.value = 0.003;
    this.lfo.connect(this.lfoG); this.lfoG.connect(this.fl.delayTime); this.lfo.start();
    this.flFb = c.createGain(); this.flFb.gain.value = 0.5;
    this.flOut = c.createGain();
    this.fxIn.connect(this.fl); this.fl.connect(this.flOut); this.fl.connect(this.flFb); this.flFb.connect(this.fl);
    this.flOut.connect(this.out);
    this.applyEq(); this.applyFilter(); this.applyFx(); this.afterRate();
  }

  /* --- knobs --- */
  applyEq() {
    const db = v => v < 0 ? v * 40 : v * 6;
    if (!this.lo) return;
    this.lo.gain.value = db(+this.q('[data-r="lo"]').value);
    this.mid.gain.value = db(+this.q('[data-r="mid"]').value);
    this.hi.gain.value = db(+this.q('[data-r="hi"]').value);
  }
  applyFilter() {
    if (!this.flt) return;
    const v = +this.q('[data-r="flt"]').value;
    if (Math.abs(v) < 0.03) { this.flt.type = 'lowpass'; this.flt.frequency.value = 20000; }
    else if (v < 0) { this.flt.type = 'lowpass'; this.flt.frequency.value = 200 * Math.pow(100, v + 1); }
    else { this.flt.type = 'highpass'; this.flt.frequency.value = 20 * Math.pow(400, v); }
  }
  applyFx() {
    const type = this.q('[data-r="fxType"]').value, amt = +this.q('[data-r="fxAmt"]').value;
    this.q('[data-a="fx"]').classList.toggle('on', this.fxOn);
    if (!this.fxIn) return;
    this.echoOut.gain.value = type === 'echo' ? 1 : 0;
    this.revOut.gain.value = type === 'reverb' ? 1.4 : 0;
    this.flOut.gain.value = type === 'flanger' ? 1 : 0;
    this.fxIn.gain.value = this.fxOn ? amt : 0;
    this.updateEchoTime();
  }
  updateEchoTime() {
    if (!this.dl) return;
    const bpm = (this.bpm || 120) * this.eff;
    this.dl.delayTime.value = Math.min(1.9, Math.max(0.05, 60 / bpm * 0.75));
  }
  setCross(g) { this.xf = g; if (this.out) this.out.gain.value = this.vol * g; }

  /* --- tempo --- */
  setPitch(p) {
    if (this.playing) this.rebase();
    this.pitch = p; this.afterRate();
  }
  setNudge(n) {
    if (this.playing) this.rebase();
    this.nudge = n; this.afterRate();
  }
  afterRate() {
    if (this.src) this.src.playbackRate.value = this.eff;
    this.updateEchoTime(); this.updateBpmText();
  }
  adjBpm(d) { if (!this.buf) return; this.bpm = Math.max(40, Math.min(240, Math.round((this.bpm + d) * 10) / 10)); this.afterRate(); }
  updateBpmText() { this.q('[data-r="bpm"]').textContent = this.bpm ? (this.bpm * this.eff).toFixed(1) : '--'; }
  rebase() { const p = this.pos(); this.offset = p; this.startedAt = ctx.currentTime; }

  /* --- transport --- */
  pos() {
    if (!this.buf) return 0;
    if (!this.playing) return this.offset;
    let p = this.offset + (ctx.currentTime - this.startedAt) * this.eff;
    const L = this.loop;
    if (L && p >= L.end) p = L.start + ((p - L.start) % (L.end - L.start));
    return Math.min(p, this.buf.duration);
  }
  togglePlay() { this.playing ? this.pause() : this.play(); }
  play() {
    if (!this.buf || this.playing) { if (!this.buf) status('Load a song first (LOAD or DEMO).'); return; }
    initAudio();
    if (this.offset >= this.buf.duration - 0.05) this.offset = 0;
    const s = ctx.createBufferSource();
    s.buffer = this.buf; s.playbackRate.value = this.eff; s.connect(this.trim);
    if (this.loop) { s.loop = true; s.loopStart = this.loop.start; s.loopEnd = this.loop.end; }
    s.onended = () => { if (this.src === s) { this.src = null; this.playing = false; this.offset = 0; this.dirty = true; this.refreshBtns(); } };
    s.start(0, this.offset);
    this.src = s; this.playing = true; this.startedAt = ctx.currentTime;
    this.refreshBtns();
  }
  pause() {
    if (!this.playing) return;
    this.offset = this.pos();
    const s = this.src; s.onended = null;
    try { s.stop(); } catch (e) {}
    s.disconnect(); this.src = null; this.playing = false;
    this.refreshBtns(); this.dirty = true;
  }
  seek(t) {
    if (!this.buf) return;
    const was = this.playing;
    if (was) this.pause();
    this.offset = Math.max(0, Math.min(this.buf.duration - 0.01, t));
    if (this.loop && (this.offset < this.loop.start || this.offset >= this.loop.end)) { this.loop = null; this.refreshBtns(); }
    this.dirty = true;
    if (was) this.play();
  }
  cueDown() {
    if (!this.buf) return;
    if (this.playing) { this.pause(); this.offset = this.cue; this.dirty = true; }
    else if (Math.abs(this.offset - this.cue) > 0.05) { this.cue = this.offset; this.dirty = true; status('Cue point set'); }
    else { this.preview = true; this.play(); }
  }
  cueUp() {
    if (this.preview) { this.preview = false; this.pause(); this.offset = this.cue; this.dirty = true; }
  }
  sync() {
    const o = this.other;
    if (!this.buf || !o.buf || !this.bpm || !o.bpm) { status('SYNC needs a song with a BPM on both decks.'); return; }
    const target = o.bpm * o.eff;
    let best = null;
    [1, 0.5, 2].forEach(m => {
      const r = target * m / this.bpm;
      if (r >= 0.84 && r <= 1.16 && (best === null || Math.abs(r - 1) < Math.abs(best - 1))) best = r;
    });
    if (best === null) { status('Tempos are too far apart to sync.'); return; }
    const p = Math.round((best - 1) * 1000) / 10;
    this.q('[data-r="pitch"]').value = p;
    this.setPitch(p);
    status('Deck ' + this.id + ' synced to ' + target.toFixed(1) + ' BPM');
  }

  /* --- loops & hot cues --- */
  toggleLoop(n) {
    if (!this.buf) return;
    if (this.loop && this.loop.beats === n) { this.clearLoop(); return; }
    if (!this.bpm) { status('No BPM found - use the − / + buttons to set it.'); return; }
    const p = this.pos();
    let len = n * 60 / this.bpm;
    if (p + len > this.buf.duration) len = this.buf.duration - p;
    if (len < 0.1) return;
    if (this.playing) { this.offset = p; this.startedAt = ctx.currentTime; }
    this.loop = { start: p, end: p + len, beats: n };
    if (this.src) { this.src.loopStart = p; this.src.loopEnd = p + len; this.src.loop = true; }
    this.refreshBtns(); this.dirty = true;
  }
  clearLoop() {
    if (this.playing) { const p = this.pos(); this.offset = p; this.startedAt = ctx.currentTime; if (this.src) this.src.loop = false; }
    this.loop = null; this.refreshBtns(); this.dirty = true;
  }
  hotTap(i) {
    if (!this.buf) return;
    if (this.hot[i] === null) { this.hot[i] = this.pos(); status('Hot cue ' + (i + 1) + ' set'); }
    else { this.seek(this.hot[i]); if (!this.playing) this.play(); }
    this.refreshBtns(); this.dirty = true;
  }
  clearHot(i) { this.hot[i] = null; this.refreshBtns(); this.dirty = true; status('Hot cue ' + (i + 1) + ' cleared'); }

  /* --- loading --- */
  pickFile() { fileTarget = this; $('#file').value = ''; $('#file').click(); }
  async loadFile(file) {
    initAudio();
    this.q('[data-r="name"]').textContent = 'Loading ' + file.name + ' ...';
    try {
      const ab = await file.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      this.setTrack(buf, file.name.replace(/\.[^.]+$/, ''), 0);
    } catch (e) {
      this.q('[data-r="name"]').textContent = 'Could not read that file';
      status('Could not decode that file. Try an MP3, M4A, WAV or OGG.');
    }
  }
  loadDemo() {
    initAudio();
    this.q('[data-r="name"]').textContent = 'Generating demo beat ...';
    if (this.demoIdx === undefined) this.demoIdx = this.id === 'A' ? 0 : 1;
    const n = this.demoIdx;
    setTimeout(() => {
      const d = makeDemo(n);
      this.setTrack(d.buf, d.name, d.bpm);
      this.demoIdx = (n + 1) % 2;
    }, 30);
  }
  setTrack(buf, name, knownBpm) {
    this.pause();
    this.buf = buf; this.name = name; this.offset = 0; this.cue = 0;
    this.hot = [null, null, null, null]; this.loop = null; this.pitch = 0; this.nudge = 0;
    this.q('[data-r="pitch"]').value = 0;
    this.q('[data-r="name"]').textContent = name;
    this.computePeaks();
    this.bpm = knownBpm || 0;
    this.afterRate(); this.refreshBtns(); this.dirty = true;
    if (!knownBpm) {
      this.q('[data-r="bpm"]').textContent = '...';
      setTimeout(() => {
        this.bpm = detectBPM(buf); this.afterRate();
        status(this.bpm ? 'Deck ' + this.id + ': ' + this.bpm + ' BPM detected (adjust with − / + if needed)' : 'Could not detect BPM - set it with − / +');
      }, 40);
    } else status('Deck ' + this.id + ' loaded: ' + name);
  }
  computePeaks() {
    const d = this.buf.getChannelData(0), W = 1000, step = Math.max(1, Math.floor(d.length / W));
    const pk = new Float32Array(W);
    for (let i = 0; i < W; i++) {
      let m = 0; const s = i * step, e = Math.min(d.length, s + step);
      for (let j = s; j < e; j += 8) { const v = Math.abs(d[j]); if (v > m) m = v; }
      pk[i] = m;
    }
    let mx = 0; pk.forEach(v => { if (v > mx) mx = v; });
    if (mx > 0) for (let i = 0; i < W; i++) pk[i] /= mx;
    this.peaks = pk;
  }

  /* --- screen --- */
  refreshBtns() {
    this.q('[data-a="play"]').classList.toggle('on', this.playing);
    this.q('[data-a="play"]').textContent = this.playing ? '❚❚' : '▶';
    this.el.querySelectorAll('[data-loop]').forEach(b => b.classList.toggle('on', !!this.loop && this.loop.beats === +b.dataset.loop));
    this.el.querySelectorAll('[data-hot]').forEach(b => {
      const set = this.hot[+b.dataset.hot] !== null;
      b.classList.toggle('set', set);
    });
  }
  draw() {
    const cv = this.q('[data-r="wave"]');
    const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); this.dirty = true; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const col = getComputedStyle(this.el).getPropertyValue('--c').trim() || '#22d3ee';
    if (!this.buf || !this.peaks) {
      g.fillStyle = '#243456'; g.fillRect(0, h / 2 - 1, w, 2); return;
    }
    const p = this.pos(), frac = p / this.buf.duration, W = this.peaks.length, mid = h / 2;
    if (this.loop) {
      g.fillStyle = 'rgba(251,191,36,.22)';
      g.fillRect(this.loop.start / this.buf.duration * w, 0, (this.loop.end - this.loop.start) / this.buf.duration * w, h);
    }
    const bw = w / W;
    g.fillStyle = '#35507f';
    g.beginPath();
    for (let i = Math.floor(frac * W); i < W; i++) { const a = this.peaks[i] * (mid - 4); g.rect(i * bw, mid - a, Math.max(1, bw), a * 2 + 1); }
    g.fill();
    g.fillStyle = col;
    g.beginPath();
    for (let i = 0; i < Math.floor(frac * W); i++) { const a = this.peaks[i] * (mid - 4); g.rect(i * bw, mid - a, Math.max(1, bw), a * 2 + 1); }
    g.fill();
    // cue + hot cues
    g.fillStyle = '#fbbf24'; g.fillRect(this.cue / this.buf.duration * w - 1, 0, 2, h);
    const hc = ['#34d399', '#fb923c', '#a78bfa', '#f87171'];
    this.hot.forEach((t, i) => { if (t !== null) { g.fillStyle = hc[i]; g.fillRect(t / this.buf.duration * w - 1, 0, 3, h); } });
    g.fillStyle = '#fff'; g.fillRect(frac * w - 1, 0, 2, h);
  }
  tick() {
    const p = this.pos();
    if (this.buf) {
      this.q('[data-r="time"]').textContent = fmt(p);
      this.q('[data-r="rem"]').textContent = '-' + fmt((this.buf.duration - p) / this.eff);
    }
    if (this.playing || this.dirty) { this.draw(); this.dirty = false; }
  }
}

/* ---------- 4. MIXER ---------- */
let fileTarget = null, curve = 'smooth';
function applyCross() {
  const x = +$('#xfader').value;
  let a, b;
  if (curve === 'smooth') { a = Math.cos(x * Math.PI / 2); b = Math.sin(x * Math.PI / 2); }
  else { a = Math.min(1, 2 * (1 - x)); b = Math.min(1, 2 * x); }
  decks.A.setCross(a); decks.B.setCross(b);
}
let lvl = 0;
const meterBuf = new Float32Array(1024);
function frame() {
  decks.A.tick(); decks.B.tick();
  if (analyser) {
    analyser.getFloatTimeDomainData(meterBuf);
    let pk = 0; for (let i = 0; i < meterBuf.length; i++) { const v = Math.abs(meterBuf[i]); if (v > pk) pk = v; }
    lvl = Math.max(pk, lvl * 0.9);
    const db = 20 * Math.log10(lvl + 1e-6);
    $('#vu').style.width = Math.max(0, Math.min(100, (db + 48) / 48 * 100)) + '%';
  }
  requestAnimationFrame(frame);
}

/* ---------- 5. DEMO SONGS (built in code, no files needed) ---------- */
function makeDemo(kind) {
  const sr = ctx.sampleRate;
  const bpm = kind === 0 ? 124 : 128, beat = 60 / bpm, bars = 16;
  const n = Math.floor(bars * 4 * beat * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const add = (t0, dur, fn) => {
    const i0 = Math.floor(t0 * sr), len = Math.floor(dur * sr);
    for (let i = 0; i < len && i0 + i < n; i++) { const v = fn(i / sr, t0 + i / sr); L[i0 + i] += v; R[i0 + i] += v; }
  };
  const bassNotes = kind === 0 ? [55, 55, 65.4, 55, 73.4, 55, 65.4, 82.4] : [49, 49, 58.3, 49, 65.4, 49, 58.3, 73.4];
  const arp = kind === 0 ? [220, 262, 330, 392, 330, 262, 294, 349] : [196, 233, 294, 349, 294, 233, 262, 311];
  const duck = abs => 1 - Math.exp(-((abs % beat)) * 11) * 0.85;
  let prev = 0;
  for (let b = 0; b < bars * 4; b++) {
    const bar = Math.floor(b / 4), t = b * beat;
    add(t, 0.38, tt => Math.sin(2 * Math.PI * (45 * tt + 105 * (1 - Math.exp(-30 * tt)) / 30)) * Math.exp(-tt * 9) * 0.95);
    if (bar >= 1) add(t + beat / 2, 0.09, tt => { const x = Math.random() * 2 - 1; const v = x - prev; prev = x; return v * Math.exp(-tt * 60) * 0.22; });
    if (bar >= 2 && b % 2 === 1) add(t, 0.16, tt => (Math.random() * 2 - 1) * Math.exp(-tt * 24) * 0.3);
    if (bar >= 2) for (let h = 0; h < 2; h++) {
      const f = bassNotes[(b * 2 + h) % 8], t0 = t + h * beat / 2;
      add(t0, beat / 2, (tt, abs) => (Math.sin(2 * Math.PI * f * tt) + 0.45 * Math.sin(4 * Math.PI * f * tt) + 0.2 * Math.sin(6 * Math.PI * f * tt)) * Math.exp(-tt * 5) * 0.32 * duck(abs));
    }
    if (bar >= 4) for (let s = 0; s < 4; s++) {
      const f = arp[(b * 4 + s + bar) % 8] * (bar >= 8 && s % 2 ? 2 : 1), t0 = t + s * beat / 4;
      add(t0, beat / 3, (tt, abs) => Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 14) * 0.13 * duck(abs));
    }
  }
  let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(L[i]));
  const k = mx > 0 ? 0.9 / mx : 1;
  for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; }
  return { buf, bpm, name: (kind === 0 ? 'Neon Drive (demo)' : 'Night Pulse (demo)') };
}

/* ---------- 6. RECORDING ---------- */
let rec = null, recChunks = [], recT0 = 0, recTimer = null;
function toggleRec() {
  initAudio();
  if (rec) { rec.stop(); return; }
  if (!window.MediaRecorder) { status('Recording is not supported on this device.'); return; }
  const mt = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
  rec = new MediaRecorder(recDest.stream, mt ? { mimeType: mt } : undefined);
  recChunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
  rec.onstop = () => {
    const type = (rec && rec.mimeType) || mt || 'audio/webm';
    rec = null; clearInterval(recTimer);
    $('#rec').classList.remove('live'); $('#recT').textContent = '';
    saveBlob(new Blob(recChunks, { type }), type);
  };
  rec.start(1000); recT0 = Date.now();
  $('#rec').classList.add('live');
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recT0) / 1000);
    $('#recT').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }, 500);
  status('Recording the master mix...');
}
function saveBlob(blob, type) {
  const d = new Date(), p = x => String(x).padStart(2, '0');
  const ext = /ogg/.test(type) ? 'ogg' : /mp4/.test(type) ? 'm4a' : 'webm';
  const name = `CrossDJ-mix-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
  if (window.AndroidBridge) {
    const fr = new FileReader();
    fr.onload = () => {
      const b64 = String(fr.result).split(',')[1] || '';
      const where = window.AndroidBridge.saveFile(name, type.split(';')[0], b64);
      status(where);
    };
    fr.readAsDataURL(blob);
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    status('Saved ' + name);
  }
}

/* ---------- 7. START-UP ---------- */
decks.A = new Deck('A'); decks.B = new Deck('B');
decks.A.other = decks.B; decks.B.other = decks.A;

$('#splash').addEventListener('pointerdown', () => { initAudio(); $('#splash').classList.add('hidden'); });
$('#file').addEventListener('change', e => { const f = e.target.files[0]; if (f && fileTarget) fileTarget.loadFile(f); });
$('#master').addEventListener('input', e => { if (master) master.gain.value = +e.target.value; });
$('#xfader').addEventListener('input', applyCross);
$('#xfCenter').addEventListener('click', () => { $('#xfader').value = 0.5; applyCross(); });
$('#curve').addEventListener('click', () => {
  curve = curve === 'smooth' ? 'sharp' : 'smooth';
  $('#curve').textContent = 'CURVE: ' + curve.toUpperCase();
  applyCross();
});
$('#rec').addEventListener('click', toggleRec);
$('#helpBtn').addEventListener('click', () => $('#help').classList.remove('hidden'));
$('#helpClose').addEventListener('click', () => $('#help').classList.add('hidden'));
document.querySelector('.mx-row .sl span').addEventListener('click', () => { $('#master').value = 0.85; if (master) master.gain.value = 0.85; });
window.addEventListener('resize', () => { decks.A.dirty = decks.B.dirty = true; });
requestAnimationFrame(frame);
