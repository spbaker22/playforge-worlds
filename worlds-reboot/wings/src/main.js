/* PAPER WINGS - touch-first alpine gate racing. */
import * as THREE from 'three';
import { createPipeline } from '../../engine/post.js';
import { createFixedStepRunner } from '../../engine/fixed-step.js';
import * as SFX from '../../engine/sfx.js';
import { CONTROL_ORB_RADIUS, createWingActionController } from './action.js';
import { createFlightState, flightSnapshot, flightStanding, FLIGHT_STATUS, startFlight, stepFlight } from './flight.js';
import { createWingRoute } from './route.js';
import { buildAlpineWorld } from './scene.js';
import { parseStoredSharedOptions } from './options.js';
import { mountPreviewGameChrome, readPreviewOptions } from '../../preview/options.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const sharedStorageKey = 'playforge.preview.options.v1';

function storedSharedOptions(){
  try { return parseStoredSharedOptions(localStorage.getItem(sharedStorageKey)); }
  catch { return {}; }
}

function enumOption(name, values, fallback){
  const value = params.get(name);
  return values.includes(value) ? value : fallback;
}

const stored = storedSharedOptions();
const options = Object.freeze({
  route: enumOption('wingsRoute', ['quick', 'full'], 'full'),
  control: enumOption('wingsControl', ['guided', 'direct'], 'guided'),
  race: enumOption('wingsRace', ['solo', 'rivals'], 'rivals'),
  sound: enumOption('sound', ['on', 'off'], ['on', 'off'].includes(stored.sound) ? stored.sound : 'on'),
  quality: enumOption('quality', ['auto', 'performance'], stored.quality === 'performance' ? 'performance' : 'auto'),
  preview: params.get('preview') === '1',
  auto: params.has('auto'),
  fast: params.has('fast'),
});
const lowfx = options.quality === 'performance' || params.has('lowfx');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const route = createWingRoute(options.route);
let flight = createFlightState(route, options);
const action = createWingActionController({ control: options.control, dragSpan: CONTROL_ORB_RADIUS });

SFX.setMuted(options.sound === 'off');
let soundMuted = options.sound === 'off';
let wind = null;
function unlockSound(){
  if(soundMuted) return;
  SFX.unlock();
  if(!wind) wind = SFX.noiseLoop({ type: 'bandpass', freq: 850, Q: 0.55 });
}
function setSound(muted){
  soundMuted = Boolean(muted);
  SFX.setMuted(soundMuted);
  $('mute').textContent = soundMuted ? 'Muted' : 'Sound';
  return soundMuted;
}

const pipe = createPipeline({
  canvas: $('gl'),
  lowfx,
  exposure: 1.02,
  bloom: { strength: lowfx ? 0.08 : 0.17, radius: 0.38, threshold: 0.91 },
  vignette: 0.22,
  grain: lowfx ? 0 : 0.012,
  fov: 58,
  near: 0.15,
  far: 1800,
  clear: 0x91b5c2,
});
const { scene, camera, composer, renderer, grade } = pipe;
renderer.shadowMap.enabled = !lowfx;
const world = buildAlpineWorld(scene, camera, route, { lowfx, race: options.race, reducedMotion });

const screens = ['title', 'briefing', 'countdown', 'results'];
const allowed = Object.freeze({
  title: new Set(['briefing']),
  briefing: new Set(['countdown']),
  countdown: new Set(['flight']),
  flight: new Set(['recovery', 'finish', 'fail']),
  recovery: new Set(['flight', 'fail']),
  finish: new Set(['results']),
  fail: new Set(['results']),
  results: new Set(['countdown']),
});
let mode = 'title';
let previewPaused = false;
let modeTime = 0;
let transitionSequence = 0;
let statusTimer = 0;
let countdownIndex = 0;
let countdownTimer = 0;
let terminalTimer = 0;
let lastFlightEventSequence = 0;

function setScreen(id, active){
  const element = $(id);
  element.hidden = !active;
  element.inert = !active;
  element.setAttribute('aria-hidden', String(!active));
}

function showOnlyScreen(id = null){
  screens.forEach(screenId => setScreen(screenId, screenId === id));
}

function transition(next, reason = 'game-flow'){
  if(!allowed[mode]?.has(next)) return false;
  mode = next;
  modeTime = 0;
  transitionSequence += 1;
  document.body.dataset.mode = mode;
  if(next === 'title') showOnlyScreen('title');
  else if(next === 'briefing') showOnlyScreen('briefing');
  else if(next === 'countdown') showOnlyScreen('countdown');
  else if(next === 'results') showOnlyScreen('results');
  else showOnlyScreen(null);
  if(next !== 'flight') releasePointer(reason);
  return true;
}

function resetForCountdown(reason = 'new-flight'){
  resetInput(reason);
  flight = createFlightState(route, options);
  lastFlightEventSequence = flight.eventSequence;
  countdownIndex = 0;
  countdownTimer = 0;
  $('countValue').textContent = '3';
  $('countLabel').textContent = options.control === 'guided' ? 'Hold the line' : 'Fly your line';
  if(mode === 'briefing' || mode === 'results') transition('countdown', reason);
}

function beginActualFlight(){
  startFlight(flight);
  lastFlightEventSequence = flight.eventSequence;
  transition('flight', 'countdown-complete');
  if(!soundMuted){
    SFX.beep(true);
    SFX.sweep({ f0: 280, f1: 1700, dur: 0.42, vol: 0.1 });
  }
}

function tickCountdown(dt){
  const interval = options.fast ? 0.18 : 0.88;
  countdownTimer += dt;
  if(countdownTimer < interval) return;
  countdownTimer -= interval;
  countdownIndex += 1;
  const values = ['3', '2', '1', 'FLY'];
  $('countValue').textContent = values[Math.min(countdownIndex, values.length - 1)];
  if(!soundMuted) SFX.beep(countdownIndex >= 3);
  if(countdownIndex >= 3) beginActualFlight();
}

function flashStatus(message, seconds = 0.85){
  $('flightStatus').textContent = message;
  $('flightStatus').classList.add('show');
  statusTimer = seconds;
}

function handleFlightEvent(){
  if(flight.eventSequence === lastFlightEventSequence || !flight.event) return;
  lastFlightEventSequence = flight.eventSequence;
  if(flight.event === 'gate'){
    flashStatus(`Gate ${flight.gatesPassed} clear`);
    if(!soundMuted) SFX.blip(920 + flight.gatesPassed * 34, 0.13, 'triangle', 0.14, 180);
  } else if(flight.event === 'miss'){
    transition('recovery', 'gate-miss');
    flashStatus('Gate missed. Re-centering.', 1.2);
    if(!soundMuted) SFX.sweep({ f0: 700, f1: 180, dur: 0.42, vol: 0.12 });
  } else if(flight.event === 'recovered'){
    transition('flight', 'recovery-complete');
    flashStatus('Back on line', 0.7);
  } else if(flight.event === 'finished'){
    transition('finish', 'route-complete');
    $('terminalText').textContent = 'ROUTE CLEAR';
    terminalTimer = options.fast ? 0.45 : 1.4;
    if(!soundMuted) SFX.fanfare([523, 659, 784, 1046]);
  } else if(flight.event === 'failed'){
    if(mode === 'recovery') transition('fail', 'miss-limit');
    else transition('fail', 'miss-limit');
    $('terminalText').textContent = 'WIND OUT';
    terminalTimer = options.fast ? 0.45 : 1.25;
    if(!soundMuted) SFX.thump(100, 0.28, 0.18, -50);
  }
}

function formatTime(seconds){
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

function showResults(){
  const success = flight.status === FLIGHT_STATUS.FINISHED;
  $('resultKicker').textContent = success ? (options.race === 'rivals' ? `Finished ${flight.rank} of 4` : 'Route complete') : 'Flight ended';
  $('resultHeadline').textContent = success ? (flight.rank === 1 ? 'Clean air.' : 'Ridge crossed.') : 'Try the line again.';
  $('resultSub').textContent = success
    ? (flight.misses ? 'You recovered the route and brought the wing home.' : 'Every gate is behind you. The ridge is yours.')
    : 'Three misses ended this run. The next attempt starts from a clean launch.';
  $('resultTime').textContent = formatTime(flight.finishTime ?? flight.time);
  $('resultGates').textContent = `${flight.gatesPassed} / ${route.gates.length}`;
  $('resultMisses').textContent = String(flight.misses);
  transition('results', 'terminal-hold-complete');
}

function autoAxes(){
  const gate = route.gates[Math.min(flight.gateIndex, route.gates.length - 1)];
  if(!gate) return { bank: 0, pitch: 0 };
  return {
    bank: THREE.MathUtils.clamp((gate.x - flight.x) / 11, -1, 1),
    pitch: THREE.MathUtils.clamp((gate.y - flight.y) / 8, -1, 1),
  };
}

const fixedFrame = {};
const fixed = createFixedStepRunner({
  step: 1 / 120,
  maxFrame: 0.08,
  maxSteps: 10,
  onStep(dt){
    const actionState = action.tick(dt);
    if(mode !== 'flight' && mode !== 'recovery') return;
    const axes = options.auto ? autoAxes() : actionState;
    stepFlight(flight, dt, axes, route);
    handleFlightEvent();
  },
});

let orbPointer = null;
let orbX = 0;
let orbY = 0;
function clearPointerUi(){
  orbPointer = null;
  $('controlOrb').classList.remove('active');
  $('controlDot').style.transform = 'translate3d(0,0,0)';
}
function releasePointer(reason = 'release'){
  if(orbPointer !== null) action.end(orbPointer, reason);
  else action.cancel(reason);
  clearPointerUi();
}
function cancelInput(reason = 'cancel'){
  action.cancel(reason);
  clearPointerUi();
}
function resetInput(reason = 'reset'){
  action.reset(reason);
  clearPointerUi();
}

$('gl').addEventListener('pointerdown', event => {
  if(mode !== 'flight' || options.auto) return;
  if(!action.begin(event.pointerId, event.clientX, event.clientY)) return;
  event.preventDefault();
  orbPointer = event.pointerId;
  orbX = event.clientX;
  orbY = event.clientY;
  $('controlOrb').style.left = `${orbX}px`;
  $('controlOrb').style.top = `${orbY}px`;
  $('controlOrb').classList.add('active');
  if(typeof $('gl').setPointerCapture === 'function'){
    try { $('gl').setPointerCapture(event.pointerId); }
    catch { cancelInput('capture-failed'); }
  }
});
$('gl').addEventListener('pointermove', event => {
  if(event.pointerId !== orbPointer) return;
  event.preventDefault();
  action.move(event.pointerId, event.clientX, event.clientY);
  const gesture = action.snapshot();
  $('controlDot').style.transform = `translate3d(${gesture.indicatorX}px,${gesture.indicatorY}px,0)`;
});
$('gl').addEventListener('pointerup', event => {
  if(event.pointerId !== orbPointer) return;
  releasePointer('pointerup');
});
$('gl').addEventListener('pointercancel', event => {
  if(event.pointerId !== orbPointer) return;
  cancelInput('pointercancel');
});
$('gl').addEventListener('lostpointercapture', () => {
  if(orbPointer !== null) cancelInput('lostpointercapture');
});
window.addEventListener('blur', () => cancelInput('window-blur'));
window.addEventListener('orientationchange', () => cancelInput('orientationchange'));
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'hidden') cancelInput('visibility-hidden');
});

$('beginButton').addEventListener('click', () => {
  unlockSound();
  transition('briefing', 'title-start');
});
$('flightButton').addEventListener('click', () => {
  unlockSound();
  resetForCountdown('briefing-complete');
});
$('replayButton').addEventListener('click', () => {
  unlockSound();
  resetForCountdown('replay');
});
$('mute').addEventListener('click', () => {
  if(soundMuted){ setSound(false); unlockSound(); }
  else setSound(true);
});

$('titleGateCount').textContent = String(route.gates.length);
$('titleControl').textContent = options.control;
$('titleField').textContent = options.race === 'rivals' ? '4' : '1';
$('assistLine').textContent = options.control === 'guided'
  ? 'Guided flight gently levels the wing and opens each gate.'
  : 'Direct flight gives a faster response and a tighter gate.';
$('routeLabel').textContent = route.name;
setSound(soundMuted);
if(options.preview){
  document.body.classList.add('preview');
  mountPreviewGameChrome({
    game: 'wings',
    options: readPreviewOptions(),
    onOpenChange(open){
      previewPaused = open;
      if(open) cancelInput('preview-menu-open');
    },
    onSoundChange(value){
      setSound(value === 'off');
      if(value === 'on') unlockSound();
    },
  });
}
showOnlyScreen('title');

const perf = { frames: 0, totalMs: 0, maxMs: 0, droppedTime: 0 };
let previous = performance.now();
let totalTime = 0;
function frame(now){
  requestAnimationFrame(frame);
  const rawDt = Math.max(0, (now - previous) / 1000);
  previous = now;
  if(previewPaused){
    composer.render();
    return;
  }
  const dt = Math.min(0.08, rawDt);
  totalTime += dt;
  modeTime += dt;
  perf.frames += 1;
  perf.totalMs += rawDt * 1000;
  perf.maxMs = Math.max(perf.maxMs, rawDt * 1000);

  if(mode === 'countdown') tickCountdown(dt);
  if(mode === 'finish' || mode === 'fail'){
    terminalTimer -= dt;
    if(terminalTimer <= 0) showResults();
  }
  if(statusTimer > 0){
    statusTimer -= dt;
    if(statusTimer <= 0) $('flightStatus').classList.remove('show');
  }

  const simulating = mode === 'flight' || mode === 'recovery';
  fixed.setSimulating(simulating);
  const fixedResult = fixed.advanceInto(dt, { simulate: simulating, timeScale: 1 }, fixedFrame);
  perf.droppedTime += fixedResult.dropped;

  if(mode === 'title' || mode === 'briefing') world.stageTitle(totalTime);
  else world.updateFlight(flight, totalTime, dt);

  const standing = flightStanding(flight, route);
  const gate = route.gates[Math.min(flight.gateIndex, route.gates.length - 1)];
  $('gateName').textContent = gate ? gate.name : 'Finish line';
  $('positionValue').textContent = `${standing.rank} / ${standing.total}`;
  $('speedValue').textContent = String(Math.round(flight.speed * 5.4));
  if(wind) wind.set(simulating ? 0.5 + flight.speed / 55 : 0.12, 0.035, 620 + flight.speed * 26);

  grade.uniforms.uTime.value = totalTime;
  grade.uniforms.uCA.value = simulating ? Math.min(0.32, flight.speed / 90) : 0.04;
  pipe.govern(rawDt);
  composer.render();
}
requestAnimationFrame(frame);

if(options.auto){
  setTimeout(() => {
    if(mode !== 'title') return;
    transition('briefing', 'auto-title');
    setTimeout(() => mode === 'briefing' && resetForCountdown('auto-briefing'), options.fast ? 40 : 300);
  }, options.fast ? 30 : 250);
}

const gp = {};
Object.defineProperties(gp, {
  previewPaused: { enumerable: true, get: () => previewPaused },
  mode: { enumerable: true, get: () => mode },
  options: { enumerable: true, get: () => options },
  route: { enumerable: true, get: () => Object.freeze({ id: route.id, gates: route.gates.length, finishS: route.finishS }) },
  state: { enumerable: true, get: () => flightSnapshot(flight) },
  gesture: { enumerable: true, get: () => action.snapshot() },
  activeScreens: { enumerable: true, get: () => Object.freeze(screens.filter(id => !$(id).hidden)) },
  transitionSequence: { enumerable: true, get: () => transitionSequence },
  visual: { enumerable: true, get: () => world.diagnostics(flight) },
  perf: { enumerable: true, get: () => Object.freeze({
    frames: perf.frames,
    averageMs: perf.frames ? perf.totalMs / perf.frames : 0,
    maxMs: perf.maxMs,
    droppedTime: perf.droppedTime,
    pixelRatio: pipe.PR,
    renderCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  }) },
});
Object.freeze(gp);
Object.defineProperty(window, '__gp', { value: gp, writable: false, configurable: false, enumerable: false });
