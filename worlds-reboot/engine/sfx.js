/* Playforge engine — WebAudio kit: context, loops, one-shots, chord pad.
   Worlds compose their soundscape from these primitives. */
let ctx = null, master = null, muted = false;
const builders = [];

export function onReady(fn){ if(ctx) fn(); else builders.push(fn); }
export function ac(){
  if(!ctx){
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);
    for(const b of builders) b();
    builders.length = 0;
  }
  if(ctx.state === 'suspended') ctx.resume();
  return ctx;
}
export function unlock(){ ac(); }
export function getCtx(){ return ctx; }
export function out(){ return master; }
export function setMuted(m){ muted = m; if(master) master.gain.value = m ? 0 : 0.9; }
export function toggleMuted(){ setMuted(!muted); return muted; }

export function noiseBuf(){
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i] = Math.random()*2-1;
  return b;
}

/* continuous filtered-noise loop (wind, rain, surf, screech, embers) */
export function noiseLoop({ type = 'bandpass', freq = 700, Q = 0.6 } = {}){
  const src = ctx.createBufferSource(); src.buffer = noiseBuf(); src.loop = true;
  const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = freq; flt.Q.value = Q;
  const g = ctx.createGain(); g.gain.value = 0;
  src.connect(flt).connect(g).connect(master); src.start();
  return {
    set(amount, vol = 0.05, f = null, tc = 0.15){
      g.gain.setTargetAtTime(amount * vol, ctx.currentTime, tc);
      if(f !== null) flt.frequency.setTargetAtTime(f, ctx.currentTime, tc + 0.05);
    },
    flt, g
  };
}

/* dual-osc motor loop (engine, hum, reel, propeller) */
export function motorLoop({ t1 = 'sawtooth', t2 = 'square', g1 = 0.5, g2 = 0.22, Q = 2.2 } = {}){
  const o1 = ctx.createOscillator(); o1.type = t1;
  const o2 = ctx.createOscillator(); o2.type = t2;
  const ga = ctx.createGain(); ga.gain.value = g1;
  const gb = ctx.createGain(); gb.gain.value = g2;
  const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.Q.value = Q;
  const og = ctx.createGain(); og.gain.value = 0;
  o1.connect(ga).connect(flt); o2.connect(gb).connect(flt);
  flt.connect(og).connect(master);
  o1.start(); o2.start();
  return {
    set(freq, filterF, vol, tc = 0.05){
      const t = ctx.currentTime;
      o1.frequency.setTargetAtTime(freq, t, 0.04);
      o2.frequency.setTargetAtTime(freq * 0.5, t, 0.04);
      flt.frequency.setTargetAtTime(filterF, t, tc);
      og.gain.setTargetAtTime(vol, t, 0.08);
    },
    off(){ og.gain.setTargetAtTime(0, ctx.currentTime, 0.2); }
  };
}

/* one-shots */
export function blip(freq, dur = 0.14, type = 'sine', vol = 0.2, slide = 0){
  if(!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  if(slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
}
export function sweep({ f0 = 300, f1 = 3200, dur = 0.5, vol = 0.16, Q = 1.4 } = {}){
  if(!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource(); src.buffer = noiseBuf();
  const flt = ctx.createBiquadFilter(); flt.type = 'bandpass'; flt.Q.value = Q;
  flt.frequency.setValueAtTime(f0, t);
  flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.1);
  src.connect(flt).connect(g).connect(master); src.start(t); src.stop(t + dur + 0.2);
}
export function thump(freq = 120, dur = 0.2, vol = 0.2, slide = -60){ blip(freq, dur, 'square', vol, slide); }
export function beep(final){ blip(final ? 1180 : 660, final ? 0.5 : 0.16, 'triangle', 0.28); }
export function uiTick(){ blip(980, 0.05, 'sine', 0.1); }
export function notify(){ blip(880, 0.1, 'triangle', 0.16); setTimeout(() => blip(1320, 0.14, 'triangle', 0.16), 90); }
export function fanfare(notes = [523, 659, 784, 1046]){
  notes.forEach((f, i) => setTimeout(() => blip(f, 0.5, 'triangle', 0.2), i * 130));
}

/* soft chord pad — each world brings its own progression */
export function pad({ chords, interval = 4200, lp = 780, types = ['sawtooth','sawtooth','triangle'], vGain = 0.05 }){
  const outG = ctx.createGain(); outG.gain.value = 0.0;
  const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = lp; flt.Q.value = 0.4;
  flt.connect(outG).connect(master);
  const voices = [];
  for(let i=0;i<chords[0].length;i++){
    const o = ctx.createOscillator(); o.type = types[i % types.length];
    const g = ctx.createGain(); g.gain.value = vGain;
    o.detune.value = (i - 1) * 7;
    o.connect(g).connect(flt); o.start();
    voices.push(o);
  }
  let ci = 0;
  setInterval(() => {
    if(!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime, ch = chords[ci = (ci + 1) % chords.length];
    voices.forEach((o, i) => o.frequency.setTargetAtTime(ch[i], t, 1.2));
  }, interval);
  return { on(a){ outG.gain.setTargetAtTime(a, ctx.currentTime, 1.5); } };
}
