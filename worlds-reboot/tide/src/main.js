/* LOW TIDE — cinematic night-harbor fishing. */
import * as THREE from 'three';
import '../../engine/base.css';
import './tide.css';
import { createPipeline } from '../../engine/post.js';
import { createFixedStepRunner } from '../../engine/fixed-step.js';
import { setScreenActive, auditInactiveScreenState } from '../../engine/screen.js';
import * as SFX from '../../engine/sfx.js';
import { buildHarbor, waterHeight } from './harbor.js';
import { createTideActionController } from './action.js';
import { tideCompetition } from './competition.js';
import { harborZoneForCast, tideRunSeed } from './fish.js';
import { cancelTideInput } from './input.js';
import { tideLastFishVisible, tideOutcomeNote } from './presentation.js';
import { createTideSim, tideDuration } from './sim.js';
import { mountPreviewGameChrome, readPreviewOptions } from '../../preview/options.js';

const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (a, b, t) => a + (b - a) * t;
const params = new URLSearchParams(location.search);
const oneOf = (value, choices, fallback) => choices.includes(value) ? value : fallback;
const OPTIONS = Object.freeze({
  preview: params.get('preview') === '1',
  sound: oneOf(params.get('sound'), ['on', 'off'], 'on'),
  quality: oneOf(params.get('quality'), ['auto', 'performance', 'balanced', 'cinematic'], params.has('lowfx') ? 'performance' : 'balanced'),
  session: oneOf(params.get('tideSession'), ['quick', 'full'], 'full'),
  tension: oneOf(params.get('tideTension'), ['relaxed', 'standard'], 'standard'),
  scoring: oneOf(params.get('tideScoring'), ['haul', 'trophy'], 'haul'),
});
const LOWFX = OPTIONS.quality === 'performance';
const RENDER_QUALITY = OPTIONS.quality === 'auto' ? 'balanced' : OPTIONS.quality;
SFX.setMuted(OPTIONS.sound === 'off');

const pipe = createPipeline({
  canvas: $('gl'), lowfx: LOWFX, exposure: RENDER_QUALITY === 'cinematic' ? 1.18 : 1.10,
  bloom: { strength: LOWFX ? 0.22 : 0.38, radius: 0.64, threshold: 0.83 },
  vignette: 0.42, grain: LOWFX ? 0.018 : 0.026, clear: 0x07151c, fov: 54, near: 0.12, far: 240,
});
const { scene, camera, composer, grade } = pipe;
camera.position.set(0, 7.65, 19.2);
camera.lookAt(0, 0.9, -14);
const harbor = buildHarbor(scene, { quality: RENDER_QUALITY });

/* ---------- fishing line, float, and splash ---------- */
const rig = new THREE.Group();
scene.add(rig);
const bobber = new THREE.Group();
const bobberWhite = new THREE.MeshStandardMaterial({ color: 0xe8dfca, roughness: 0.38 });
const bobberRed = new THREE.MeshStandardMaterial({ color: 0xb85545, roughness: 0.42 });
const floatBody = new THREE.Mesh(new THREE.SphereGeometry(0.25, 14, 10), bobberWhite);
floatBody.scale.y = 1.28;
const floatTop = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.52), bobberRed);
floatTop.position.y = 0.08;
const floatStem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.68, 8), bobberRed);
floatStem.position.y = 0.38;
bobber.add(floatBody, floatTop, floatStem);
bobber.visible = false;
rig.add(bobber);

const lineCount = 42;
const lineArray = new Float32Array(lineCount * 3);
const lineGeometry = new THREE.BufferGeometry();
lineGeometry.setAttribute('position', new THREE.BufferAttribute(lineArray, 3));
const lineMaterial = new THREE.LineBasicMaterial({ color: 0xe4d9c3, transparent: true, opacity: 0.72, depthWrite: false });
const fishingLine = new THREE.Line(lineGeometry, lineMaterial);
fishingLine.frustumCulled = false;
rig.add(fishingLine);

const splash = new THREE.Group();
for(let i = 0; i < 3; i += 1){
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.48, 0.53, 28).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xa8cac5, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.userData.delay = i * 0.21;
  splash.add(ring);
}
rig.add(splash);

const rodTip = new THREE.Vector3();
const castTarget = new THREE.Vector3(0, 0.06, -26);
const bobberWorld = new THREE.Vector3();
const nearBoat = new THREE.Vector3(0, 0.08, 5.3);
const aimPreview = new THREE.Vector3();
let rigVisible = false;

function targetFor(power, lateral, out = castTarget){
  out.set(lateral * (8.5 + power * 4.2), 0.06, -12.5 - power * 28.5);
  return out;
}

function writeCurve(start, end, { arc = 0, sag = 0, reveal = 1 } = {}){
  const points = Math.max(2, Math.round((lineCount - 1) * clamp(reveal, 0.02, 1)) + 1);
  for(let i = 0; i < points; i += 1){
    const t = i / (points - 1);
    const index = i * 3;
    lineArray[index] = lerp(start.x, end.x, t);
    lineArray[index + 1] = lerp(start.y, end.y, t) + Math.sin(Math.PI * t) * arc - Math.sin(Math.PI * t) * sag;
    lineArray[index + 2] = lerp(start.z, end.z, t);
  }
  lineGeometry.setDrawRange(0, points);
  lineGeometry.attributes.position.needsUpdate = true;
}

function updateRig(state, time){
  harbor.rodTip.getWorldPosition(rodTip);
  const actionState = action.state;
  const phase = state?.phase ?? 'none';
  rigVisible = uiFlow === 'play' && ['aim','casting','waiting','bite','reeling'].includes(phase);
  fishingLine.visible = rigVisible;
  bobber.visible = rigVisible && phase !== 'aim';
  lineMaterial.color.setHex(phase === 'bite' ? 0xf0b96f : 0xe4d9c3);
  lineMaterial.opacity = phase === 'aim' ? (actionState.active ? 0.62 : 0) : 0.72;

  if(phase === 'aim'){
    if(actionState.active){
      const previewPower = Math.max(0.12, actionState.power);
      const preview = targetFor(previewPower, actionState.lateral, aimPreview);
      preview.y = waterHeight(preview.x, preview.z, time) + 0.08;
      writeCurve(rodTip, preview, { arc: 4.4 + previewPower * 5.6 });
    }
    splash.visible = false;
    return;
  }

  targetFor(state.castPower, state.castLateral);
  castTarget.y = waterHeight(castTarget.x, castTarget.z, time) + 0.10;
  if(phase === 'casting'){
    const t = state.castProgress;
    bobberWorld.lerpVectors(rodTip, castTarget, t);
    bobberWorld.y += Math.sin(Math.PI * t) * (4.6 + state.castPower * 5.4);
    bobber.position.copy(bobberWorld);
    writeCurve(rodTip, bobberWorld, { sag: 0.08, reveal: 1 });
  } else if(phase === 'reeling'){
    const draw = clamp(state.reelProgress * 0.86, 0, 0.88);
    bobberWorld.lerpVectors(castTarget, nearBoat, draw);
    bobberWorld.y = waterHeight(bobberWorld.x, bobberWorld.z, time) + 0.11;
    bobber.position.copy(bobberWorld);
    const taut = clamp(state.tension / 0.9, 0, 1);
    writeCurve(rodTip, bobberWorld, { sag: lerp(1.3, 0.12, taut) });
  } else {
    bobberWorld.copy(castTarget);
    const biteDip = phase === 'bite' ? 0.40 + Math.sin(time * 24) * 0.13 : 0;
    bobberWorld.y -= biteDip;
    bobber.position.copy(bobberWorld);
    writeCurve(rodTip, bobberWorld, { sag: phase === 'bite' ? 0.28 : 1.05 });
  }
  bobber.rotation.z = Math.sin(time * 1.7) * 0.08;
  splash.position.set(bobberWorld.x, 0.07, bobberWorld.z);
  splash.visible = phase === 'waiting' && state.phaseTime < 1.15;
  for(const ring of splash.children){
    const age = state.phaseTime - ring.userData.delay;
    ring.visible = age >= 0 && age <= 0.82;
    const scale = 0.7 + Math.max(0, age) * 3.2;
    ring.scale.setScalar(scale);
    ring.material.opacity = clamp(1 - age / 0.82, 0, 1) * 0.48;
  }
}

/* ---------- round, flow, and screens ---------- */
const screenIds = ['title', 'instructions', 'count', 'outcome', 'results'];
const BASE_RUN_SEED = 0x10f71de;
let uiFlow = 'title';
let previewPaused = false;
let runIndex = -1;
let sim = createTideSim({ session: OPTIONS.session, tension: OPTIONS.tension, scoring: OPTIONS.scoring, seed: tideRunSeed(BASE_RUN_SEED, 0) });
let countdown = 0;
let countdownShown = null;
const action = createTideActionController();
const frameState = {};
const fixed = createFixedStepRunner({
  step: 1 / 120,
  maxFrame: 0.1,
  maxSteps: 12,
  onStep: dt => {
    if(uiFlow !== 'play') return;
    sim.step(dt);
    consumeEvents();
  },
});
fixed.setSimulating(false);

function activateOnly(active, { focus = false } = {}){
  for(const id of screenIds) setScreenActive(id, id === active, { focus: id === active ? focus : false });
}

function configureCopy(){
  const duration = tideDuration(OPTIONS.session);
  $('sessionMeta').textContent = `${OPTIONS.session === 'quick' ? 'QUICK' : 'FULL'} WATCH · ${duration} SEC`;
  $('tensionMeta').textContent = `${OPTIONS.tension.toUpperCase()} LINE`;
  $('scoringMeta').textContent = `${OPTIONS.scoring.toUpperCase()} SCORING`;
  $('scoreLabel').textContent = OPTIONS.scoring === 'haul' ? 'HAUL' : 'TROPHY POINTS';
  $('tensionLimit').style.left = `${sim.config.limit * 100}%`;
  if(OPTIONS.preview) $('previewStamp').textContent = `FAMILY PREVIEW / ${OPTIONS.quality.toUpperCase()} QUALITY`;
}

function newSim(){
  runIndex += 1;
  const seed = tideRunSeed(BASE_RUN_SEED, runIndex);
  sim = createTideSim({ session: OPTIONS.session, tension: OPTIONS.tension, scoring: OPTIONS.scoring, seed });
  sim.drainEvents();
  action.reset();
  fixed.reset();
  fixed.setSimulating(false);
  castTarget.set(0, 0.06, -26);
  configureCopy();
  updateHud(sim.state);
}

function startCountdown(){
  ensureAudio();
  newSim();
  uiFlow = 'countdown';
  document.body.classList.remove('play');
  activateOnly('count');
  countdown = 3.72;
  countdownShown = null;
  showCount('3');
}

function showCount(value){
  if(value === countdownShown) return;
  countdownShown = value;
  const node = $('countN');
  node.textContent = value;
  node.classList.remove('pop');
  void node.offsetWidth;
  node.classList.add('pop');
  SFX.beep(value === 'CAST');
}

function beginPlay(){
  uiFlow = 'play';
  document.body.classList.add('play');
  activateOnly(null);
  fixed.setSimulating(true);
  $('stateTag').textContent = 'DRAG BACK OR SIDEWAYS · RELEASE TO CAST';
}

function showOutcome(outcome){
  uiFlow = 'outcome';
  fixed.setSimulating(false);
  action.reset();
  renderLastFish(sim.state);
  const caught = outcome.type === 'catch';
  $('outcome').classList.toggle('snap-card', !caught);
  $('outcomeKicker').textContent = caught ? outcome.fish.tierLabel : 'THE LINE GOES QUIET';
  $('outcomeKicker').style.color = caught ? outcome.fish.tierColor : 'var(--red)';
  $('outcomeTitle').textContent = caught ? outcome.fish.name : (outcome.reason === 'missed-bite' ? 'BITE MISSED' : 'LINE SNAPPED');
  $('outcomeWeight').innerHTML = caught
    ? (OPTIONS.scoring === 'trophy'
      ? `+${outcome.points} <small>PTS · ${outcome.fish.weightKg.toFixed(1)} KG</small>`
      : `${outcome.fish.weightKg.toFixed(1)} <small>KG · +${outcome.points} PTS</small>`)
    : '—';
  $('outcomeNote').textContent = tideOutcomeNote(outcome);
  $('nextBtn').textContent = sim.state.remaining <= 0 || sim.state.overtime ? 'SEE THE LEDGER' : 'NEXT CAST';
  activateOnly('outcome', { focus: '#nextBtn' });
}

function competitionFor(state, time = state.time){
  return tideCompetition({
    session: OPTIONS.session,
    scoring: OPTIONS.scoring,
    time,
    duration: state.duration,
    haulKg: state.haulKg,
    score: state.score,
  });
}

function showResults(){
  if(uiFlow === 'results') return;
  uiFlow = 'results';
  fixed.setSimulating(false);
  action.reset();
  renderLastFish(sim.state);
  document.body.classList.remove('play');
  const state = sim.state;
  const competition = competitionFor(state, state.duration);
  const rank = competition.rank;
  const rankLabel = ['1ST','2ND','3RD'][rank - 1];
  $('resultBig').innerHTML = OPTIONS.scoring === 'trophy' ? `${competition.player} <small>PTS</small>` : `${competition.player.toFixed(1)} <small>KG</small>`;
  const finishCopy = state.finishReason === 'last-fish'
    ? (state.lastOutcome?.type === 'catch' ? 'LAST FISH LANDED' : 'LAST FISH COMPLETE')
    : 'WATCH COMPLETE';
  $('resultRank').textContent = `${rankLabel} IN THE HARBOR · ${finishCopy}`;
  $('resultRows').innerHTML = `
    <div><span>FISH LANDED</span><b>${state.catches}</b></div>
    <div><span>${OPTIONS.scoring === 'trophy' ? 'TOTAL WEIGHT' : 'BEST CATCH'}</span><b>${OPTIONS.scoring === 'trophy' ? `${state.haulKg.toFixed(1)} kg` : (state.bestFish ? `${state.bestFish.weightKg.toFixed(1)} kg` : '—')}</b></div>
    <div><span>LINES LOST</span><b>${state.snaps}</b></div>`;
  activateOnly('results', { focus: '#replayBtn' });
  SFX.fanfare([392, 494, 587, 784]);
}

function consumeEvents(){
  for(const event of sim.drainEvents()){
    if(event.type === 'cast') SFX.sweep({ f0: 180, f1: 780, dur: 0.52, vol: 0.08 });
    else if(event.type === 'splash') SFX.thump(86, 0.24, 0.13, -24);
    else if(event.type === 'bite') SFX.notify();
    else if(event.type === 'hooked') SFX.blip(520, 0.18, 'triangle', 0.16, 260);
    else if(event.type === 'catch'){
      SFX.fanfare(event.fish.tier === 'trophy' ? [392, 523, 659, 988] : [392, 494, 659]);
      showOutcome(sim.state.lastOutcome);
    } else if(event.type === 'snap'){
      SFX.thump(115, 0.35, 0.18, -70);
      showOutcome(sim.state.lastOutcome);
    } else if(event.type === 'finished') showResults();
  }
}

/* ---------- one-finger input ---------- */
const touch = $('touchSurface');
function inputTime(){ return performance.now() / 1000; }
touch.addEventListener('pointerdown', event => {
  if(uiFlow !== 'play') return;
  event.preventDefault();
  const result = action.begin({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, phase: sim.state.phase, time: inputTime() });
  if(!result) return;
  if(result.type === 'cast-start' || result.type === 'reel-start'){
    if(typeof touch.setPointerCapture === 'function'){
      try { touch.setPointerCapture(event.pointerId); }
      catch {
        cancelInput('capture-failed');
        return;
      }
    }
  }
  if(result.type === 'hook') sim.hook();
  else if(result.type === 'reel-start') sim.setReeling(true);
  consumeEvents();
}, { passive: false });

addEventListener('pointermove', event => {
  if(uiFlow !== 'play' || !action.state.active) return;
  event.preventDefault();
  action.move({ pointerId: event.pointerId, x: event.clientX, y: event.clientY });
}, { passive: false, capture: true });

function endPointer(event, cancelled = false){
  if(!action.state.active) return;
  event.preventDefault();
  const result = action.end({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: inputTime(), cancelled });
  if(!result) return;
  if(result.type === 'cast'){
    targetFor(result.power, result.lateral);
    sim.cast(result.power, result.lateral);
  } else if(result.type === 'reel-stop') sim.setReeling(false);
  consumeEvents();
}
addEventListener('pointerup', event => endPointer(event, false), { passive: false, capture: true });
function cancelInput(reason = 'cancel'){
  const result = cancelTideInput(action, sim);
  consumeEvents();
  return Object.freeze({ reason, result });
}
addEventListener('pointercancel', event => {
  if(action.state.active && event.pointerId !== action.state.pointerId) return;
  event.preventDefault();
  cancelInput('pointercancel');
}, { passive: false, capture: true });
touch.addEventListener('lostpointercapture', () => cancelInput('lostpointercapture'));
addEventListener('blur', () => cancelInput('window-blur'));
addEventListener('orientationchange', () => cancelInput('orientationchange'));
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'hidden') cancelInput('visibility-hidden');
});
addEventListener('contextmenu', event => event.preventDefault());

/* ---------- controls and audio ---------- */
let audioReady = false;
let seaLoop = null;
let reelLoop = null;
function ensureAudio(){
  if(audioReady) return;
  audioReady = true;
  SFX.unlock();
  seaLoop = SFX.noiseLoop({ type: 'lowpass', freq: 520, Q: 0.55 });
  seaLoop.set(1, 0.032, 430, 0.8);
  reelLoop = SFX.motorLoop({ t1: 'triangle', t2: 'sine', g1: 0.42, g2: 0.18, Q: 1.7 });
  reelLoop.off();
}

$('enterBtn').addEventListener('click', event => {
  event.stopPropagation(); ensureAudio(); uiFlow = 'instructions'; activateOnly('instructions', { focus: '#launchBtn' });
});
$('launchBtn').addEventListener('click', event => { event.stopPropagation(); startCountdown(); });
$('nextBtn').addEventListener('click', event => {
  event.stopPropagation();
  sim.nextCast();
  consumeEvents();
  if(sim.state.status === 'finished'){ showResults(); return; }
  uiFlow = 'play';
  document.body.classList.add('play');
  activateOnly(null);
  fixed.setSimulating(true);
});
$('replayBtn').addEventListener('click', event => { event.stopPropagation(); startCountdown(); });
$('mute').addEventListener('click', event => {
  event.stopPropagation(); ensureAudio();
  const muted = SFX.toggleMuted();
  $('mute').textContent = muted ? 'OFF' : 'SND';
  $('mute').setAttribute('aria-label', muted ? 'Turn sound on' : 'Turn sound off');
});
$('mute').textContent = OPTIONS.sound === 'off' ? 'OFF' : 'SND';

/* ---------- HUD and presentation ---------- */
function formatClock(seconds){
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}
function stateCopy(state, previewZone = null){
  const prefix = state.overtime ? 'LAST FISH · ' : '';
  if(state.phase === 'aim') return previewZone
    ? `AIMING FOR ${previewZone.label} · RELEASE TO CAST`
    : 'DRAG BACK OR SIDEWAYS · RELEASE TO CAST';
  const water = state.castZone?.label ? `${state.castZone.label} · ` : '';
  if(state.phase === 'casting') return `${prefix}${water}LINE OUT`;
  if(state.phase === 'waiting') return `${prefix}${water}WATCH THE FLOAT`;
  if(state.phase === 'bite') return `${prefix}${water}TAP ONCE TO SET THE HOOK`;
  if(state.phase === 'reeling') return `${prefix}${water}${state.reelHeld ? 'REELING · RELEASE IF THE LINE TURNS HOT' : 'HOLD ANYWHERE TO REEL'}`;
  return '';
}
function renderLastFish(state){
  const visible = tideLastFishVisible({ flow: uiFlow, state });
  $('lastFish').classList.toggle('show', visible);
  $('lastFish').setAttribute('aria-hidden', String(!visible));
  $('lastFish').textContent = state.castZone ? `LAST FISH · ${state.castZone.label}` : 'LAST FISH';
}
function updateHud(state){
  $('clock').textContent = formatClock(state.remaining);
  const castActive = state.phase === 'aim' && action.state.active;
  const previewZone = castActive ? harborZoneForCast({ castPower: action.state.power, castLateral: action.state.lateral }) : null;
  const competition = competitionFor(state);
  const primary = competition.metrics.primary;
  const secondary = competition.metrics.secondary;
  const primaryValue = primary.unit === 'KG' ? primary.value.toFixed(1) : primary.value;
  const secondaryValue = secondary.unit === 'KG' ? secondary.value.toFixed(1) : secondary.value;
  $('haul').innerHTML = `${primaryValue} <small>${primary.unit}</small>`;
  $('points').textContent = `${secondaryValue} ${secondary.unit}${secondary.unit === 'KG' ? ' LANDED' : ''}`;
  $('stateTag').textContent = stateCopy(state, previewZone);
  $('castMeter').classList.toggle('show', castActive);
  $('castFill').style.width = `${Math.round(action.state.power * 100)}%`;
  const reeling = state.phase === 'reeling';
  $('tensionDock').classList.toggle('show', reeling);
  const tensionRatio = clamp(state.tension / 1.04, 0, 1);
  $('tensionFill').style.width = `${tensionRatio * 100}%`;
  const hot = state.tension >= sim.config.limit;
  const warning = state.tension >= sim.config.limit * 0.78;
  $('tensionWord').textContent = hot ? 'RELEASE' : warning ? 'EASE IT' : state.reelHeld ? 'PULLING' : 'STEADY';
  $('tensionWord').style.color = hot ? 'var(--red)' : warning ? 'var(--amber)' : 'var(--green)';
  $('biteCue').classList.toggle('show', state.phase === 'bite');
  renderLastFish(state);
  const rivals = competition.rivals;
  $('maraScore').textContent = OPTIONS.scoring === 'trophy' ? `${rivals.mara} PTS` : `${rivals.mara.toFixed(1)} KG`;
  $('eliasScore').textContent = OPTIONS.scoring === 'trophy' ? `${rivals.elias} PTS` : `${rivals.elias.toFixed(1)} KG`;
}

let last = performance.now();
let worldTime = 0;
function frame(now){
  requestAnimationFrame(frame);
  const dt = clamp((now - last) / 1000, 0, 0.1);
  last = now;
  if(previewPaused){
    composer.render();
    return;
  }
  worldTime += dt;

  if(uiFlow === 'countdown'){
    countdown -= dt;
    if(countdown > 2.7) showCount('3');
    else if(countdown > 1.7) showCount('2');
    else if(countdown > 0.7) showCount('1');
    else if(countdown > 0) showCount('CAST');
    else beginPlay();
  }

  fixed.advanceInto(dt, { simulate: uiFlow === 'play', timeScale: 1 }, frameState);
  const state = sim.state;
  updateHud(state);
  updateRig(state, worldTime);
  harbor.update(worldTime, {
    phase: state.phase,
    tension: state.tension,
    reelHeld: state.reelHeld,
    bobber: bobber.visible ? bobberWorld : null,
    fishFight: state.currentFish?.fight ?? 0.5,
  });
  if(audioReady && reelLoop){
    if(uiFlow === 'play' && state.phase === 'reeling' && state.reelHeld) reelLoop.set(82 + state.tension * 54, 420 + state.tension * 340, 0.035 + state.tension * 0.022);
    else reelLoop.off();
  }
  camera.position.y = 7.65 + Math.sin(worldTime * 0.41) * 0.025;
  camera.lookAt(0, 0.92 + Math.sin(worldTime * 0.35) * 0.018, -14);
  grade.uniforms.uTime.value = worldTime;
  pipe.govern(dt);
  composer.render();
}

configureCopy();
activateOnly('title', { focus: '#enterBtn' });
if(OPTIONS.preview){
  mountPreviewGameChrome({
    game: 'tide',
    options: readPreviewOptions(),
    onOpenChange(open){
      previewPaused = open;
      if(open) cancelInput('preview-menu-open');
    },
    onSoundChange(value){
      SFX.setMuted(value === 'off');
      $('mute').textContent = value === 'off' ? 'OFF' : 'SND';
      if(value === 'on') ensureAudio();
    },
  });
}
requestAnimationFrame(frame);

Object.defineProperty(window, '__gp', {
  enumerable: true,
  configurable: false,
  get(){
    return Object.freeze({
      game: 'low-tide', version: 'preview-1', flow: uiFlow,
      previewPaused,
      options: OPTIONS,
      run: Object.freeze({ index: runIndex, seed: sim.config.seed }),
      competition: competitionFor(sim.state),
      state: sim.state,
      input: action.state,
      screens: Object.freeze(auditInactiveScreenState()),
      render: Object.freeze({ quality: OPTIONS.quality, engineQuality: RENDER_QUALITY, pixelRatio: pipe.PR }),
    });
  },
});
