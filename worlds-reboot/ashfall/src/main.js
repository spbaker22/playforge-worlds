import * as THREE from 'three';
import '../../engine/base.css';
import { createPipeline } from '../../engine/post.js';
import { buildAtmosphere } from '../../engine/atmo.js';
import * as SFX from '../../engine/sfx.js';
import { createGestureSession } from '../../engine/gesture.js';
import { createFixedStepRunner } from '../../engine/fixed-step.js';
import { setScreenActive, auditInactiveScreenHits, auditInactiveScreenState } from '../../engine/screen.js';
import { createStateTrace } from '../../engine/trace.js';
import { $, clamp, lerp, readParams } from '../../engine/util.js';
import { mountPreviewGameChrome, readPreviewOptions } from '../../preview/options.js';
import { createAshfallActionController } from './action.js';
import { createAshfallSim } from './sim.js';
import { createAshfallScene } from './scene.js';
import { ashfallRunLabel, ashfallSeedForRun } from './rules.js';

const P = readParams();
const Q = P.Q;
const enumParam = (name, allowed, fallback) => allowed.includes(Q.get(name)) ? Q.get(name) : fallback;
const options = Object.freeze({
  mode: enumParam('ashMode', ['quick', 'full'], 'full'),
  intensity: enumParam('ashIntensity', ['calm', 'standard', 'inferno'], 'standard'),
  preview: Q.get('preview') === '1',
  sound: enumParam('sound', ['on', 'off'], 'on'),
  quality: enumParam('quality', ['auto', 'performance'], P.LOWFX ? 'performance' : 'auto'),
});
const LOWFX = P.LOWFX || options.quality === 'performance';
const runLabel = ashfallRunLabel(options.mode, options.intensity);
const BASE_SEED = 0xA5F411;
const trace = createStateTrace({ limit: 320 });
document.body.classList.toggle('preview', options.preview);
SFX.setMuted(options.sound === 'off');

const pipe = createPipeline({
  canvas: $('gl'),
  lowfx: LOWFX,
  exposure: 1.08,
  bloom: { strength: 0.38, radius: 0.52, threshold: 0.82 },
  vignette: 0.38,
  grain: LOWFX ? 0.012 : 0.022,
  fov: 48,
  near: 0.18,
  far: 5000,
  clear: 0x120F12,
});
const { renderer, scene, camera, composer, grade } = pipe;
renderer.info.autoReset = false;

const sunDir = new THREE.Vector3(-0.44, 0.36, -0.82).normalize();
const atmo = buildAtmosphere(scene, renderer, {
  sunDir,
  sky: { zenith: 0x16141E, violet: 0x3A1F25, horizon: 0xA5442D, sunHot: 0xFFB06B, stars: 0.18, sunDisc: 0.82, coronaPow: 130 },
  fog: { color: 0x5E342E, density: 0.009 },
  key: { color: 0xFFB980, intensity: 2.35, shadowBox: 28, mapSize: LOWFX ? 512 : 1024 },
  fill: { color: 0x667290, intensity: 0.46 },
  hemi: { sky: 0x565A74, ground: 0x4B2722, intensity: 1.0 },
  flare: null,
  clouds: null,
  ranges: [
    { radius: 540, height: 76, color: 0x291D24, seedMul: 7, blend: 0.25 },
    { radius: 330, height: 48, color: 0x3C2526, seedMul: 11, blend: 0.32 },
  ],
});
if(LOWFX) atmo.sun.castShadow = false;

const visual = createAshfallScene({ scene, camera, renderer, lowfx: LOWFX });
let runIndex = 0;
const createRunSim = () => createAshfallSim({
  mode: options.mode,
  intensity: options.intensity,
  seed: ashfallSeedForRun(BASE_SEED, runIndex),
});
let sim = createRunSim();
let simPrevious = sim.state;
let simCurrent = sim.state;
const presentation = {};
const action = createAshfallActionController();
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.03);
const groundHit = new THREE.Vector3();

const SCREEN_IDS = ['title', 'instructions', 'count', 'finish', 'results'];
const MODE_SCREEN = Object.freeze({
  title: 'title',
  instructions: 'instructions',
  countdown: 'count',
  play: null,
  finish: 'finish',
  fail: 'finish',
  results: 'results',
});
const ALLOWED = Object.freeze({
  none: Object.freeze(['title']),
  title: Object.freeze(['instructions']),
  instructions: Object.freeze(['countdown']),
  countdown: Object.freeze(['play']),
  play: Object.freeze(['finish', 'fail']),
  finish: Object.freeze(['results']),
  fail: Object.freeze(['results']),
  results: Object.freeze(['countdown']),
});
let mode = null;
let previewPaused = false;
let countdownTime = 0;
let countdownLabel = '';
let terminalTime = 0;
let terminalSnapshot = null;
let toastTime = 0;
let toastPriority = 0;
let hitTime = 0;
let audioReady = false;
let wind = null;

function activateOnly(screenId, focus = false){
  for(const id of SCREEN_IDS) setScreenActive(id, id === screenId, { focus: id === screenId ? focus : false });
}

function setMode(next, reason){
  const fromKey = mode ?? 'none';
  if(!ALLOWED[fromKey]?.includes(next)){
    trace.record('mode-rejected', { from: mode, to: next, reason });
    return false;
  }
  const from = mode;
  mode = next;
  trace.transition(from, next, reason);
  activateOnly(MODE_SCREEN[next], ['title', 'instructions', 'results'].includes(next));
  document.body.classList.toggle('play', next === 'play');
  if(next === 'countdown'){
    countdownTime = 0;
    countdownLabel = '';
    fixed.setSimulating(false);
    gesture.disable();
  } else if(next === 'play'){
    fixed.setSimulating(true);
    gesture.enable();
    trace.record('run-started', { mode: options.mode, intensity: options.intensity });
    if(wind) wind.set(1, 0.035, 530);
  } else {
    gesture.disable();
    if(next === 'finish' || next === 'fail'){
      terminalTime = 0;
      fixed.setSimulating(false);
      if(wind) wind.set(0.28, 0.025, 320);
    }
  }
  return true;
}

function projectToGround(screenX, screenY){
  pointerNdc.set(screenX / innerWidth * 2 - 1, -(screenY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  return raycaster.ray.intersectPlane(groundPlane, groundHit) ? groundHit : null;
}

function markerAt(x, y, visible){
  const marker = $('touchMarker');
  marker.style.left = `${x}px`;
  marker.style.top = `${y}px`;
  marker.classList.toggle('show', visible);
}

const gesture = createGestureSession({
  target: $('gl'),
  deadzone: 0.006,
  hysteresis: 0,
  axisLock: false,
  preventDefault: true,
  onStart(pointerState, event){
    if(mode !== 'play') return;
    const ground = projectToGround(pointerState.x, pointerState.y);
    if(!ground) return;
    const current = sim.state;
    action.begin({
      pointerId: pointerState.pointerId,
      screenX: pointerState.x,
      screenY: pointerState.y,
      groundX: ground.x,
      groundZ: ground.z,
      playerX: current.x,
      playerZ: current.z,
      time: event.timeStamp / 1000,
    });
    markerAt(pointerState.x, pointerState.y, true);
    trace.record('pointer-start', { pointerId: pointerState.pointerId, x: current.x, z: current.z });
  },
  onMove(pointerState){
    if(mode !== 'play' || !action.state.active) return;
    const ground = projectToGround(pointerState.x, pointerState.y);
    if(!ground) return;
    const target = action.move({
      pointerId: pointerState.pointerId,
      screenX: pointerState.x,
      screenY: pointerState.y,
      groundX: ground.x,
      groundZ: ground.z,
    });
    if(target) sim.setTarget(target.x, target.z);
    markerAt(pointerState.x, pointerState.y, true);
  },
  onEnd(pointerState, event){
    markerAt(pointerState.x, pointerState.y, false);
    const result = action.end({
      pointerId: pointerState.pointerId,
      screenX: pointerState.x,
      screenY: pointerState.y,
      time: event.timeStamp / 1000,
    });
    if(!result) return;
    trace.record('pointer-end', { type: result.type, distance: result.distance, duration: result.duration });
    if(result.type === 'dash'){
      sim.setTarget(result.target.x, result.target.z);
      if(sim.dash()){
        SFX.sweep({ f0: 180, f1: 1300, dur: 0.18, vol: 0.11, Q: 1.1 });
        showToast('DASH');
      } else showToast('DASH RECHARGING');
    }
  },
  onCancel(pointerState, event, reason){
    markerAt(pointerState.x, pointerState.y, false);
    action.cancel(pointerState.pointerId);
    trace.record('pointer-cancel', { reason });
  },
  onError(error, detail){ trace.record('gesture-error', { message: error?.message || String(error), callback: detail.callback }); },
});
gesture.disable();

function showToast(message, seconds = 0.7, priority = 0){
  if(toastTime > 0 && priority < toastPriority) return;
  $('toast').textContent = message;
  $('toast').style.opacity = '1';
  toastTime = seconds;
  toastPriority = priority;
}

function processEvents(events){
  if(events.length === 0) return;
  visual.triggerEvents(events);
  let waveTelegraphed = false;
  let urgentNotice = false;
  for(const event of events){
    trace.record(`sim:${event.type}`, event);
    if(event.type === 'hit'){
      urgentNotice = true;
      hitTime = 0.28;
      document.body.classList.add('hit');
      showToast('HIT. MOVE NOW.', 0.9, 2);
      SFX.thump(82, 0.28, 0.26, -38);
    } else if(event.type === 'wave-telegraph'){
      waveTelegraphed = true;
    } else if(event.type === 'shielded'){
      showToast('SHIELD HELD', 0.6, 2);
      SFX.blip(720, 0.1, 'sine', 0.08, 260);
    } else if(event.type === 'near-miss'){
      showToast('NEAR MISS +90');
      SFX.blip(940, 0.12, 'triangle', 0.12, 280);
    } else if(event.type === 'evade'){
      showToast('EVADE +28', 0.5);
    } else if(event.type === 'finished'){
      urgentNotice = true;
      terminalSnapshot = sim.state;
      $('finishPre').textContent = 'CALDERA SURVIVED';
      $('finishBig').textContent = 'RESCUE CLEAR';
      $('finishSub').textContent = 'THE WINDOW HELD · YOUR SIGNAL IS SECURE';
      setMode('finish', 'survival-complete');
      SFX.fanfare([392, 523, 659, 784]);
    } else if(event.type === 'failed'){
      urgentNotice = true;
      terminalSnapshot = sim.state;
      $('finishPre').textContent = 'CALDERA OVERRUN';
      $('finishBig').textContent = 'ASHED OUT';
      $('finishSub').textContent = 'THE RESCUE TEAM IS PULLING YOU BACK';
      setMode('fail', 'hearts-empty');
    }
  }
  if(waveTelegraphed && !urgentNotice){
    showToast('PERIMETER WAVE · FIND THE GAP', 1.2, 1);
    SFX.notify();
  }
}

let fixed = null;
const fixedFrame = {};
fixed = createFixedStepRunner({
  step: 1 / 120,
  maxFrame: 0.1,
  maxSteps: 24,
  onStep(dt){
    if(mode !== 'play') return;
    simPrevious = simCurrent;
    simCurrent = sim.step(dt);
    processEvents(sim.drainEvents());
  },
});
fixed.setSimulating(false);

function resetRun({ nextSeed = false } = {}){
  if(nextSeed) runIndex += 1;
  sim = createRunSim();
  sim.drainEvents();
  simCurrent = sim.state;
  simPrevious = simCurrent;
  terminalSnapshot = null;
  fixed.reset();
  fixed.setSimulating(false);
  updateHud(simCurrent);
  trace.record('run-reset', { mode: options.mode, intensity: options.intensity, runIndex, seed: sim.config.seed });
}

function unlockAudio(){
  if(audioReady) return;
  audioReady = true;
  SFX.unlock();
  wind = SFX.noiseLoop({ type: 'bandpass', freq: 480, Q: 0.55 });
  wind.set(0.2, 0.025, 440);
}

$('tapGo').addEventListener('click', () => {
  unlockAudio();
  SFX.uiTick();
  setMode('instructions', 'title-button');
});
$('btnReady').addEventListener('click', () => {
  unlockAudio();
  SFX.uiTick();
  resetRun();
  setMode('countdown', 'instructions-ready');
});
$('btnAgain').addEventListener('click', () => {
  SFX.uiTick();
  resetRun({ nextSeed: true });
  setMode('countdown', 'replay-button');
});
$('mute').addEventListener('click', () => {
  unlockAudio();
  const muted = SFX.toggleMuted();
  $('mute').textContent = muted ? 'MUTED' : 'SOUND';
  trace.record('sound-toggle', { muted });
});
$('mute').textContent = options.sound === 'off' ? 'MUTED' : 'SOUND';
$('previewLabel').textContent = `${runLabel} · FAMILY PREVIEW`;
$('briefLabel').textContent = `SURVIVAL BRIEF · ${runLabel}`;
$('bigU').textContent = `${options.intensity.toUpperCase()} · EVASION SCORE`;

function updateFlow(dt){
  if(mode === 'countdown'){
    countdownTime += dt;
    const index = Math.min(3, Math.floor(countdownTime / 0.78));
    const label = ['3', '2', '1', 'GO'][index];
    if(label !== countdownLabel){
      countdownLabel = label;
      const node = $('countN');
      node.textContent = label;
      node.classList.remove('pop');
      void node.offsetWidth;
      node.classList.add('pop');
      SFX.beep(label === 'GO');
    }
    if(countdownTime >= 3.12) setMode('play', 'countdown-complete');
  } else if(mode === 'finish' || mode === 'fail'){
    terminalTime += dt;
    if(terminalTime >= 1.85){
      renderResults(terminalSnapshot ?? sim.state);
      setMode('results', 'terminal-hold-complete');
    }
  }
  if(toastTime > 0){
    toastTime -= dt;
    if(toastTime <= 0){
      toastPriority = 0;
      $('toast').style.opacity = '0';
    }
  }
  if(hitTime > 0){
    hitTime -= dt;
    if(hitTime <= 0) document.body.classList.remove('hit');
  }
}

function updateHud(snapshot){
  $('timeLeft').textContent = String(Math.max(0, Math.ceil(snapshot.remaining)));
  $('bigN').textContent = String(snapshot.score);
  const hearts = [...$('heartMarks').children];
  hearts.forEach((heart, index) => heart.classList.toggle('off', index >= snapshot.hearts));
  $('heartMarks').setAttribute('aria-label', `${snapshot.hearts} hearts`);
  const dashProgress = 1 - clamp(snapshot.dashCooldown / sim.config.dashCooldown, 0, 1);
  $('dashHud').style.setProperty('--dash-ready', dashProgress.toFixed(3));
  $('dashLabel').textContent = snapshot.dashReady ? 'READY' : snapshot.dashCooldown.toFixed(1);
  $('stateTag').textContent = snapshot.invulnerable > 0
    ? 'SHIELD ACTIVE · MOVE CLEAR'
    : snapshot.dashDuration > 0
      ? 'DASHING TO SAFETY'
      : snapshot.dashReady
        ? 'DASH READY · TAP SAFE GROUND'
        : `DASH ${snapshot.dashCooldown.toFixed(1)} · READ THE RINGS`;
}

function renderResults(snapshot){
  const won = snapshot.status === 'won';
  $('resPre').textContent = `${won ? 'RESCUE WINDOW COMPLETE' : 'RECOVERY CREW ARRIVED'} · ${runLabel}`;
  $('resBig').textContent = String(snapshot.score);
  $('resSub').textContent = won ? 'EVASION SCORE' : 'SCORE BEFORE RECOVERY';
  $('resRows').innerHTML = [
    ['TIME', `${snapshot.time.toFixed(1)} SEC`],
    ['HEARTS', `${snapshot.hearts} OF 3`],
    ['RESCUE BONUS', String(snapshot.completionBonus)],
    ['NEAR MISSES', String(snapshot.nearMisses)],
    ['EVADES', String(snapshot.evades)],
    ['HITS', String(snapshot.hits)],
  ].map(([label, value]) => `<div class="resultCell">${label}<b>${value}</b></div>`).join('');
}

const perfCapacity = 300;
const perfFrames = new Float32Array(perfCapacity);
const perf = { frames: 0, cursor: 0, count: 0, total: 0, max: 0 };
function recordFrame(milliseconds){
  perf.frames += 1;
  perf.total += milliseconds;
  perf.max = Math.max(perf.max, milliseconds);
  perfFrames[perf.cursor] = milliseconds;
  perf.cursor = (perf.cursor + 1) % perfCapacity;
  perf.count = Math.min(perfCapacity, perf.count + 1);
}
function perfSnapshot(){
  const values = [];
  for(let i = 0; i < perf.count; i += 1) values.push(perfFrames[i]);
  values.sort((a, b) => a - b);
  return Object.freeze({
    frames: perf.frames,
    averageMs: perf.frames ? perf.total / perf.frames : 0,
    p95Ms: values.length ? values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] : 0,
    maxMs: perf.max,
    pixelRatio: pipe.PR,
  });
}

let lastTime = performance.now();
let visualTime = 0;
function frame(now){
  requestAnimationFrame(frame);
  const wallDt = Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;
  if(previewPaused){
    renderer.info.reset();
    composer.render();
    return;
  }
  visualTime += wallDt;
  updateFlow(wallDt);
  const started = performance.now();
  const fixedState = fixed.advanceInto(wallDt, { simulate: mode === 'play', timeScale: P.WARP }, fixedFrame);
  const alpha = fixedState.alpha;
  Object.assign(presentation, simCurrent);
  presentation.x = lerp(simPrevious.x, simCurrent.x, alpha);
  presentation.z = lerp(simPrevious.z, simCurrent.z, alpha);
  presentation.vx = lerp(simPrevious.vx, simCurrent.vx, alpha);
  presentation.vz = lerp(simPrevious.vz, simCurrent.vz, alpha);
  visual.update(presentation, { dt: wallDt, time: visualTime, mode });
  atmo.tick(wallDt, camera.position.x, camera.position.z);
  atmo.followShadow(presentation.x, 0.2, presentation.z);
  grade.uniforms.uTime.value = visualTime;
  grade.uniforms.uCA.value = hitTime > 0 ? 0.75 : presentation.dashDuration > 0 ? 0.22 : 0.04;
  updateHud(simCurrent);
  pipe.govern(wallDt);
  renderer.info.reset();
  composer.render();
  recordFrame(performance.now() - started);
}

function freezeEntries(entries){ return Object.freeze(entries.map(entry => Object.freeze(entry))); }
const gp = {};
Object.defineProperties(gp, {
  ready: { enumerable: true, get: () => mode !== null },
  game: { enumerable: true, get: () => 'ashfall' },
  previewPaused: { enumerable: true, get: () => previewPaused },
  mode: { enumerable: true, get: () => mode },
  gameplayState: { enumerable: true, get: () => mode !== 'play' ? mode : simCurrent.invulnerable > 0 ? 'invulnerable' : 'active' },
  options: { enumerable: true, get: () => options },
  run: { enumerable: true, get: () => Object.freeze({ number: runIndex + 1, index: runIndex, seed: sim.config.seed, label: runLabel }) },
  simulation: { enumerable: true, get: () => sim.state },
  action: { enumerable: true, get: () => Object.freeze(action.snapshot()) },
  gesture: { enumerable: true, get: () => Object.freeze(gesture.snapshot()) },
  trace: { enumerable: true, get: () => freezeEntries(trace.snapshot()) },
  activeScreens: { enumerable: true, get: () => Object.freeze(SCREEN_IDS.filter(id => $(id).dataset.screenActive === 'true')) },
  screenAudit: { enumerable: true, get: () => Object.freeze({ state: auditInactiveScreenState(), hits: auditInactiveScreenHits({ step: 24 }) }) },
  performance: { enumerable: true, get: perfSnapshot },
  scene: { enumerable: true, get: () => visual.diagnostics },
});
Object.freeze(gp);
Object.defineProperty(window, '__gp', { value: gp, writable: false, configurable: false, enumerable: false });

if(options.preview){
  mountPreviewGameChrome({
    game: 'ashfall',
    options: readPreviewOptions(),
    onOpenChange(open){
      previewPaused = open;
      if(!open) return;
      gesture.cancel('preview-menu-open');
      action.cancel();
      $('touchMarker').classList.remove('show');
    },
    onSoundChange(value){
      SFX.setMuted(value === 'off');
      if(value === 'on') unlockAudio();
      $('mute').textContent = value === 'off' ? 'MUTED' : 'SOUND';
    },
  });
}

setMode('title', 'boot');
updateHud(simCurrent);
requestAnimationFrame(frame);
