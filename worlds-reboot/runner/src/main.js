/* GRIDLOCK RUN — Phase 4 production presentation on the verified 150m slice. */
import * as THREE from 'three';
import '../../engine/base.css';
import { createPipeline } from '../../engine/post.js';
import { buildAtmosphere } from '../../engine/atmo.js';
import { Particles } from '../../engine/fx.js';
import * as SFX from '../../engine/sfx.js';
import { SpringCam } from '../../engine/cam.js';
import { setScreenActive, auditInactiveScreenHits, auditInactiveScreenState } from '../../engine/screen.js';
import { createFixedStepRunner } from '../../engine/fixed-step.js';
import { createStateTrace } from '../../engine/trace.js';
import { $, clamp, lerp, ease, ORD, readParams, fmt } from '../../engine/util.js';
import { PAL, buildCity, tickCity } from './city.js';
import {
  buildCourier, poseCourier, updateCourierTether, courierHotPathReport,
  courierSemanticReport, COURIER_SLIDE_BOUNDS,
} from './courier.js';
import { createRunnerCourseModel, createRunnerPoseOutput, RUNNER_TUTORIAL_LENGTH } from './course.js';
import { createRunnerSim, RUNNER_LOCOMOTION } from './sim.js';
import { createRunnerActionController } from './action.js';
import { createRunnerCueInputBuffer, runnerCuePresentation } from './cue.js';
import { createRunnerFlow } from './flow.js';
import {
  mountPreviewGameChrome,
  readPreviewOptions,
  runnerFormatLabel,
} from '../../preview/options.js';

const P = readParams();
let AUTO = P.AUTO;
let WARP = P.WARP;
let FREEZE = P.FREEZE;
const FAST = P.FAST;
const PREVIEW_MODE = P.Q.get('preview') === '1';
const PREVIEW_OPTIONS = readPreviewOptions();
const LOWFX = P.LOWFX || (PREVIEW_MODE && PREVIEW_OPTIONS.quality === 'performance');
const RUNNER_START_MODE = PREVIEW_MODE && PREVIEW_OPTIONS.runner.format === 'final-relay' ? 'race' : 'tutorial';
const RUNNER_SIM_CONFIG = PREVIEW_MODE ? {
  startS: PREVIEW_OPTIONS.runner.format === 'final-relay' ? 112 : 6,
  initialShields: PREVIEW_OPTIONS.runner.safety,
  ...(PREVIEW_OPTIONS.runner.pace === 'calm' ? {
    startSpeed: 7.2,
    recoverySpeed: 7.4,
    maxSpeed: 11.8,
    acceleration: 1.65,
    rivalPaceScale: 0.7,
  } : {}),
} : {};
const RUNNER_INITIAL_STATE = PREVIEW_MODE && PREVIEW_OPTIONS.runner.format === 'final-relay'
  ? { lane: -1 }
  : {};
SFX.setMuted(PREVIEW_MODE && PREVIEW_OPTIONS.sound === 'off');

/* ---------------- benchmark-capable renderer + preserved atmosphere ---------------- */
const pipe = createPipeline({
  canvas: $('gl'), lowfx: LOWFX, exposure: 1.04,
  bloom: { strength: 0.31, radius: 0.48, threshold: 0.86 },
  vignette: 0.32, clear: 0x07101F,
});
const { renderer, scene, camera, composer, grade } = pipe;
// Accumulate the scene, shadow, and post passes into one per-frame diagnostic.
// EffectComposer otherwise resets renderer.info between its internal passes.
renderer.info.autoReset = false;
const atmo = buildAtmosphere(scene, renderer, {
  sunDir: new THREE.Vector3(0.34, 0.30, -0.89).normalize(),
  sky: { zenith: PAL.zenith, violet: PAL.violet, horizon: PAL.horizon, sunHot: PAL.sunHot, stars: 0.4, sunDisc: 1.2, coronaPow: 200 },
  fog: { color: PAL.fog, density: 0.0027 },
  key: { color: 0xC8D7FF, intensity: 1.58, shadowBox: 34, mapSize: LOWFX ? 512 : 1024 },
  fill: { color: PAL.magenta, intensity: 0.18 },
  hemi: { sky: 0x3A4B78, ground: 0x211B32, intensity: 0.92 },
  flare: null,
  clouds: null,
  ranges: [
    { radius: 1500, height: 160, color: 0x241640, seedMul: 7, blend: 0.45 },
    { radius: 1000, height: 105, color: 0x181030, seedMul: 11, blend: 0.3 },
  ],
});

/* ---------------- authoritative course + production world ---------------- */
const course = createRunnerCourseModel();
const COURSE_LEN = course.length || RUNNER_TUTORIAL_LENGTH || 150;
const city = buildCity(scene, course, { lowfx: LOWFX });

function createPoseScratch(){
  return {
    raw: createRunnerPoseOutput(),
    pos: new THREE.Vector3(),
    tan: new THREE.Vector3(),
    right: new THREE.Vector3(),
  };
}

const poseScratch = createPoseScratch();
const heroPoseScratch = createPoseScratch();
const chasePoseScratch = createPoseScratch();
const lookPoseScratch = createPoseScratch();
const cameraPoseScratch = createPoseScratch();
const introStartScratch = createPoseScratch();
const introPreviewScratch = createPoseScratch();
const rivalPoseScratches = course.rivals.map(() => createPoseScratch());

function poseAt(s, lane = 0, out = poseScratch){
  const raw = course.poseAtInto(s, lane, out.raw);
  out.pos.set(raw.position.x, raw.position.y, raw.position.z);
  out.tan.set(raw.tangent.x, raw.tangent.y, raw.tangent.z);
  out.right.set(raw.right.x, raw.right.y, raw.right.z);
  return out;
}

/* ---------------- authored courier family, presentation-only views ---------------- */
const hero = buildCourier(0x38E4F5, true, 'player');
scene.add(hero);
// Presentation-only views. Distance, speed, lane, finish state, and times all
// live exclusively in runnerSim's authoritative rival state.
const rivalViews = course.rivals.map(profile => {
  const mesh = buildCourier(profile.color, false, profile.id);
  scene.add(mesh);
  return { id: profile.id, name: profile.name, profile, mesh };
});
const allCourierViews = [hero, ...rivalViews.map(view => view.mesh)];
const titleLineup = Object.freeze([
  Object.freeze({ mesh: rivalViews[0].mesh, s: 7.5, lane: -1.8, phase: 0.3, scratch: rivalPoseScratches[0] }),
  Object.freeze({ mesh: rivalViews[2].mesh, s: 6.8, lane: -0.7, phase: 1.2, scratch: rivalPoseScratches[2] }),
  Object.freeze({ mesh: hero, s: 6.1, lane: -0.2, phase: 2.1, scratch: heroPoseScratch }),
  Object.freeze({ mesh: rivalViews[1].mesh, s: 7.3, lane: 1.5, phase: 2.8, scratch: rivalPoseScratches[1] }),
]);
const titleLineupIdentity = titleLineup;
const titlePoseScratchIdentities = titleLineup.map(entry => entry.scratch);
const titleHotPath = {
  stageCalls: 0,
  lineupStable: true,
  poseOutputsStable: true,
};
if(LOWFX){
  // Low tier keeps the articulated silhouettes but drops the four sub-pixel
  // line draws and the shadow pass; normal quality retains both treatments.
  atmo.sun.castShadow = false;
  hero.userData.tether.visible = false;
  for(const view of rivalViews) view.mesh.userData.tether.visible = false;
}

function setRecoveryPresentation(active, safeS = stateSafePad?.(simCurrent), fromS = stateS?.(simCurrent)){
  city.setRecoveryPresentation(Boolean(active), safeS, fromS);
  hero.userData.tether.visible = Boolean(active) && !LOWFX;
}

const rain = new Particles(scene, LOWFX ? 180 : 420, false);
const splash = new Particles(scene, 96, false);
const sparks = new Particles(scene, 96, true);
const fireworks = new Particles(scene, LOWFX ? 72 : 160, true);

/* ---------------- pure simulation + runtime diagnostics ---------------- */
const runnerSim = createRunnerSim({ course, config: RUNNER_SIM_CONFIG, initial: RUNNER_INITIAL_STATE });
let simCurrent = runnerSim.createPresentationFrame();
let simPrevious = runnerSim.createPresentationFrame();
const renderState = runnerSim.createPresentationFrame();
let interpolationAlpha = 0;

const trace = createStateTrace({ limit: 320 });
const diagnostics = {
  lastAcceptedAction: null,
  actionCounts: { up: 0, down: 0, left: 0, right: 0 },
  crashCount: 0,
  damageCount: 0,
  recoverCount: 0,
  resultsCount: 0,
  finishCount: 0,
  lastRecoveryReason: null,
  lastResetReason: 'initial',
  lastEvent: null,
  lastSimActionEvent: null,
  lastHazardCue: null,
  terminalSnapshot: null,
};
const game = {
  timescale: 1,
  total: 0,
  startedAtSimulation: 0,
  failed: false,
  runStarted: false,
  topCamHeight: 0,
  fireworksTimer: 0,
};
let previewPaused = false;
let pendingRecovery = null;

/* Bounded, allocation-free frame telemetry. Sorting only happens when the
   diagnostic getter is read, never in the render/fixed-step hot path. */
const PERF_CAPACITY = 600;
const perfSamples = new Float32Array(PERF_CAPACITY);
const perfState = {
  frames: 0,
  sampleCount: 0,
  sampleCursor: 0,
  total: 0,
  max: 0,
  over50ms: 0,
  droppedTime: 0,
  presentationWrites: 0,
};
const perfAllocationBaseline = {
  fixedLegacyAdvanceCalls: 0,
  fixedStepSnapshotAllocations: 0,
  fixedFrameSnapshotAllocations: 0,
  fixedAdvanceIntoCalls: 0,
  actionLegacyDrainCalls: 0,
  actionLegacyDrainAllocations: 0,
  actionDrainIntoCalls: 0,
};
const hotIdentity = { fixedFrameOutputStable: true, actionDrainOutputStable: true };

function resetPerf(){
  perfState.frames = 0;
  perfState.sampleCount = 0;
  perfState.sampleCursor = 0;
  perfState.total = 0;
  perfState.max = 0;
  perfState.over50ms = 0;
  perfState.droppedTime = 0;
  perfState.presentationWrites = 0;
  const fixedMetrics = fixed?.metrics || {};
  const actionMetrics = actionController?.metrics || {};
  perfAllocationBaseline.fixedLegacyAdvanceCalls = fixedMetrics.legacyAdvanceCalls || 0;
  perfAllocationBaseline.fixedStepSnapshotAllocations = fixedMetrics.legacyStepSnapshotAllocations || 0;
  perfAllocationBaseline.fixedFrameSnapshotAllocations = fixedMetrics.legacyFrameSnapshotAllocations || 0;
  perfAllocationBaseline.fixedAdvanceIntoCalls = fixedMetrics.advanceIntoCalls || 0;
  perfAllocationBaseline.actionLegacyDrainCalls = actionMetrics.legacyDrainCalls || 0;
  perfAllocationBaseline.actionLegacyDrainAllocations = actionMetrics.legacyDrainAllocations || 0;
  perfAllocationBaseline.actionDrainIntoCalls = actionMetrics.drainIntoCalls || 0;
  hotIdentity.fixedFrameOutputStable = true;
  hotIdentity.actionDrainOutputStable = true;
  return true;
}

function recordFrame(milliseconds){
  perfState.frames += 1;
  perfState.total += milliseconds;
  perfState.max = Math.max(perfState.max, milliseconds);
  if(milliseconds > 50) perfState.over50ms += 1;
  perfState.droppedTime += Math.max(0, milliseconds - 1000 / 60);
  perfSamples[perfState.sampleCursor] = milliseconds;
  perfState.sampleCursor = (perfState.sampleCursor + 1) % PERF_CAPACITY;
  perfState.sampleCount = Math.min(PERF_CAPACITY, perfState.sampleCount + 1);
}

function perfSnapshot(){
  const samples = new Array(perfState.sampleCount);
  const start = (perfState.sampleCursor - perfState.sampleCount + PERF_CAPACITY) % PERF_CAPACITY;
  for(let index = 0; index < perfState.sampleCount; index += 1){
    samples[index] = perfSamples[(start + index) % PERF_CAPACITY];
  }
  samples.sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(samples.length * 0.95) - 1);
  const fixedMetrics = fixed?.metrics || {};
  const actionMetrics = actionController?.metrics || {};
  return {
    frames: perfState.frames,
    average: perfState.frames ? perfState.total / perfState.frames : 0,
    p95: samples.length ? samples[p95Index] : 0,
    max: perfState.max,
    over50ms: perfState.over50ms,
    droppedTime: perfState.droppedTime,
    presentationWrites: perfState.presentationWrites,
    allocations: {
      fixedLegacyAdvanceCalls: (fixedMetrics.legacyAdvanceCalls || 0) - perfAllocationBaseline.fixedLegacyAdvanceCalls,
      fixedStepSnapshotAllocations: (fixedMetrics.legacyStepSnapshotAllocations || 0) - perfAllocationBaseline.fixedStepSnapshotAllocations,
      fixedFrameSnapshotAllocations: (fixedMetrics.legacyFrameSnapshotAllocations || 0) - perfAllocationBaseline.fixedFrameSnapshotAllocations,
      fixedAdvanceIntoCalls: (fixedMetrics.advanceIntoCalls || 0) - perfAllocationBaseline.fixedAdvanceIntoCalls,
      actionLegacyDrainCalls: (actionMetrics.legacyDrainCalls || 0) - perfAllocationBaseline.actionLegacyDrainCalls,
      actionLegacyDrainAllocations: (actionMetrics.legacyDrainAllocations || 0) - perfAllocationBaseline.actionLegacyDrainAllocations,
      actionDrainIntoCalls: (actionMetrics.drainIntoCalls || 0) - perfAllocationBaseline.actionDrainIntoCalls,
      fixedFrameOutputStable: hotIdentity.fixedFrameOutputStable,
      actionDrainOutputStable: hotIdentity.actionDrainOutputStable,
    },
  };
}

const stateS = state => Number.isFinite(state?.s) ? state.s
  : Number.isFinite(state?.courseS) ? state.courseS : 0;
const stateSpeed = state => Number.isFinite(state?.speed) ? state.speed
  : Number.isFinite(state?.spd) ? state.spd : 0;
const stateY = state => Number.isFinite(state?.yRel) ? state.yRel
  : Number.isFinite(state?.y) ? state.y : 0;
const stateLane = state => Number.isFinite(state?.lanePosition) ? state.lanePosition
  : Number.isFinite(state?.laneValue) ? state.laneValue
    : Number.isFinite(state?.lane) ? state.lane : 0;
const stateLaneTarget = state => Number.isFinite(state?.targetLane) ? state.targetLane
  : Number.isFinite(state?.laneTarget) ? state.laneTarget
    : Number.isFinite(state?.lane) ? state.lane : stateLane(state);
const stateShields = state => Number.isFinite(state?.shields) ? state.shields : 3;
const stateSafePad = state => Number.isFinite(state?.lastSafePad) ? state.lastSafePad
  : Number.isFinite(state?.safePad) ? state.safePad
    : Number.isFinite(state?.checkpoint) ? state.checkpoint
      : course.safePadById?.(state?.lastSafePadId)?.resumeS
        ?? course.checkpointById?.(state?.checkpointId)?.resumeS
        ?? course.safePadBefore?.(stateS(state))?.resumeS
        ?? 6;

const locomotionName = code => code === RUNNER_LOCOMOTION.SLIDE ? 'slide'
  : code === RUNNER_LOCOMOTION.AIR ? 'air'
    : code === RUNNER_LOCOMOTION.FALLING ? 'falling'
      : code === RUNNER_LOCOMOTION.STUMBLE ? 'stumble'
        : code === RUNNER_LOCOMOTION.RECOVERING ? 'recovering'
          : code === RUNNER_LOCOMOTION.FROZEN ? 'frozen' : 'run';
const stateLocomotion = state => typeof state?.locomotion === 'string'
  ? state.locomotion
  : locomotionName(state?.locomotionCode);

const FRAME_FIELDS = [
  'time', 's', 'speed', 'lane', 'lanePosition', 'y', 'vy', 'grounded',
  'jumpsUsed', 'coyoteRemaining', 'slideRemaining', 'stumbleRemaining',
  'invulnerabilityRemaining', 'shields', 'rank', 'frozen', 'terminal',
  'finishTime', 'locomotionCode', 'statusCode', 'previousTime', 'previousS',
  'previousSpeed', 'previousLanePosition', 'previousY',
];

function copyPresentationFrame(out, source){
  for(let index = 0; index < FRAME_FIELDS.length; index += 1){
    const field = FRAME_FIELDS[index];
    out[field] = source[field];
  }
  for(let index = 0; index < source.rivals.length; index += 1){
    const from = source.rivals[index];
    const to = out.rivals[index];
    to.s = from.s;
    to.previousS = from.previousS;
    to.speed = from.speed;
    to.lane = from.lane;
    to.finished = from.finished;
    to.finishTime = from.finishTime;
  }
  for(let index = 0; index < source.standings.length; index += 1){
    const from = source.standings[index];
    const to = out.standings[index];
    to.id = from.id;
    to.name = from.name;
    to.kind = from.kind;
    to.competitorIndex = from.competitorIndex;
    to.rivalIndex = from.rivalIndex;
    to.rank = from.rank;
    to.s = from.s;
    to.finished = from.finished;
    to.finishTime = from.finishTime;
  }
  return out;
}

function interpolateSimulation(alpha){
  copyPresentationFrame(renderState, simCurrent);
  renderState.time = lerp(simPrevious.time, simCurrent.time, alpha);
  renderState.s = lerp(simPrevious.s, simCurrent.s, alpha);
  renderState.speed = lerp(simPrevious.speed, simCurrent.speed, alpha);
  renderState.y = lerp(simPrevious.y, simCurrent.y, alpha);
  renderState.lanePosition = lerp(simPrevious.lanePosition, simCurrent.lanePosition, alpha);
  renderState.phase = renderState.time * (6.4 + renderState.speed * 0.42);
  for(let index = 0; index < renderState.rivals.length; index += 1){
    renderState.rivals[index].s = lerp(simPrevious.rivals[index].s, simCurrent.rivals[index].s, alpha);
  }
  interpolationAlpha = alpha;
  return renderState;
}

function worldFor(state, out, scratch = poseScratch){
  const pose = poseAt(stateS(state), stateLane(state), scratch);
  out.copy(pose.pos);
  out.y += stateY(state);
  return pose;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmp3 = new THREE.Vector3();
const velocity = new THREE.Vector3();
const CHASE_FOV = 50;
const spring = new SpringCam(camera, { k: 11, lookK: 13, ffPos: 0.065, ffLook: 0.032, baseFov: CHASE_FOV });

function poseHero(dt){
  const pose = worldFor(renderState, tmp, heroPoseScratch);
  hero.position.copy(tmp);
  hero.rotation.y = Math.atan2(pose.tan.x, pose.tan.z);
  const stateName = stateLocomotion(renderState);
  const terminalMode = flow?.mode === 'failed' || flow?.mode === 'finish' || flow?.mode === 'results';
  let playerWon = !game.failed;
  if(terminalMode && !game.failed){
    for(let standingIndex = 0; standingIndex < simCurrent.standings.length; standingIndex += 1){
      const standing = simCurrent.standings[standingIndex];
      if(standing.id === 'player'){
        playerWon = standing.rank === 1;
        break;
      }
    }
  }
  const locomotion = terminalMode
    ? (playerWon ? 'win' : 'fail')
    : flow?.mode === 'crash' || stateName === 'stumble' ? 'stumble'
      : flow?.mode === 'recover' || stateName === 'recovering' ? 'recover'
        : stateName === 'falling' || stateName === 'air' ? 'air'
          : renderState.slideRemaining > 0 || stateName === 'slide' ? 'slide' : 'run';
  poseCourier(hero, locomotion, renderState.phase, renderState.speed, dt);
}

function chasePosition(out, state = renderState){
  const pose = worldFor(state, out, chasePoseScratch);
  out.addScaledVector(pose.tan, -5.02);
  out.addScaledVector(pose.right, -0.62 - stateLane(state) * 0.04);
  out.y += 2.16 + (stateLocomotion(state) === 'falling' ? 0.75 : 0);
  return out;
}

function chaseLook(out, state = renderState){
  const pose = worldFor(state, out, lookPoseScratch);
  out.addScaledVector(pose.tan, 6.8);
  out.y += 1.02 + (stateLocomotion(state) === 'falling' ? -1.6 : 0);
  return out;
}

/* ---------------- authoritative screen + control ownership ---------------- */
const SCREEN_IDS = ['title', 'count', 'results'];
function activateOnly(id, focus = false){
  for(const screenId of SCREEN_IDS){
    setScreenActive(screenId, screenId === id, { focus: screenId === id ? focus : false });
  }
}

let flow = null;
const cuePresentation = {
  id: null,
  text: '',
  stage: 'orientation',
  requirement: null,
  armed: false,
  shownAtSimulation: -1,
  shownAtS: -1,
  hazardStart: -1,
  cueStart: -1,
  actionAt: -1,
  actionReady: false,
};
const emittedCueEvents = new Map();
const cueInputBuffer = createRunnerCueInputBuffer();
const actionController = createRunnerActionController({
  canvas: $('gl'),
  swipeThreshold: PREVIEW_MODE && PREVIEW_OPTIONS.runner.swipe === 'easy' ? 0.022 : 0.032,
  directionHysteresis: PREVIEW_MODE && PREVIEW_OPTIONS.runner.swipe === 'easy' ? 0.004 : 0.006,
  canAct: () => flow?.mode === 'tutorial' || flow?.mode === 'race',
  onAction(action){
    diagnostics.lastAcceptedAction = {
      ...action,
      atS: stateS(simCurrent),
      atSimulation: simCurrent.time,
      cueId: cuePresentation.id,
      beforePointerUp: true,
    };
    diagnostics.actionCounts[action.direction] += 1;
    trace.record('gesture-action', { direction: action.direction, type: action.type, atS: stateS(simCurrent), sequence: action.sequence });
  },
  onCancel(reason){ trace.record('gesture-cancel', { reason, mode: flow?.mode || null }); },
  onError(error, context){ trace.record('gesture-error', { message: error?.message || String(error), callback: context?.callback || null }); },
});

function setCue(text = '', cue = null){
  const element = $('actionCue');
  const nextId = text ? (cue?.id || 'status') : null;
  if(nextId !== cuePresentation.id){
    cuePresentation.id = nextId;
    cuePresentation.shownAtSimulation = text ? simCurrent.time : -1;
    cuePresentation.shownAtS = text ? stateS(simCurrent) : -1;
    cuePresentation.hazardStart = Number.isFinite(cue?.s0) ? cue.s0 : -1;
    cuePresentation.cueStart = Number.isFinite(cue?.cueStart) ? cue.cueStart : -1;
  }
  cuePresentation.text = text;
  cuePresentation.stage = cue?.stage || 'orientation';
  cuePresentation.requirement = cue?.requirement || null;
  cuePresentation.armed = Boolean(cue?.armed);
  cuePresentation.actionAt = Number.isFinite(cue?.actionAt) ? cue.actionAt : -1;
  cuePresentation.actionReady = Boolean(cue?.actionReady);
  element.textContent = text;
  element.classList.toggle('show', Boolean(text));
}

function cueSnapshot(){
  const element = $('actionCue');
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const emitted = emittedCueEvents.get(cuePresentation.id) || null;
  const speed = Math.max(0.001, stateSpeed(simCurrent));
  const distanceToStart = cuePresentation.hazardStart >= 0
    ? Math.max(0, cuePresentation.hazardStart - stateS(simCurrent))
    : null;
  return {
    ...cuePresentation,
    visible: document.body.classList.contains('play')
      && element.classList.contains('show')
      && Number.parseFloat(style.opacity) >= 0.95
      && style.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0,
    opacity: Number.parseFloat(style.opacity) || 0,
    distanceToStart,
    runtimeSecondsToStart: distanceToStart === null ? null : distanceToStart / speed,
    currentS: stateS(simCurrent),
    currentSpeed: speed,
    emitted: emitted ? structuredClone(emitted) : null,
  };
}

function stateTagSnapshot(){
  const element = $('stateTag');
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    text: element.textContent,
    opacity: Number.parseFloat(style.opacity) || 0,
    visible: document.body.classList.contains('play')
      && Number.parseFloat(style.opacity) >= 0.95
      && style.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0,
  };
}

let toastRemaining = 0;
function toast(message, duration = 1.5){
  const element = $('toast');
  element.textContent = message || '';
  element.style.opacity = message ? 1 : 0;
  toastRemaining = message ? duration : 0;
}

function updateShieldHud(){
  const shields = Math.max(0, stateShields(simCurrent));
  $('shieldRow').textContent = shields > 0 ? '◆'.repeat(shields) : '—';
}

function showResults(){
  const terminal = diagnostics.terminalSnapshot || runnerSim.snapshot();
  const playerStanding = terminal.standings?.find(entry => entry.id === 'player') || { rank: terminal.rank || 1 };
  game.total = terminal.finishTime >= 0
    ? Math.max(0, terminal.finishTime - game.startedAtSimulation)
    : Math.max(0, terminal.time - game.startedAtSimulation);
  const failed = game.failed;
  $('resPre').textContent = failed ? 'SIGNAL LOST' : 'TRAINING CLEAR';
  $('resBig').textContent = failed
    ? `${Math.round(stateS(simCurrent))}M`
    : ORD[Math.max(0, Math.min(rivalViews.length, playerStanding.rank - 1))];
  $('resSub').textContent = PREVIEW_MODE
    ? `GRIDLOCK RUN · ${runnerFormatLabel(PREVIEW_OPTIONS).toUpperCase()}`
    : 'GRIDLOCK RUN · DISTRICT 01';
  if(failed){
    $('resRows').innerHTML = `LAST SAFE PAD <b>${Math.round(stateSafePad(simCurrent))}M</b><br>`
      + `SHIELDS SPENT <b>${diagnostics.damageCount}</b><br>SWIPE ON THE GLOWING WARNING BANDS`;
  } else {
    const order = terminal.standings || [];
    $('resRows').innerHTML = [`RUN TIME <b>${fmt(game.total * 1000)}</b> · SHIELDS <b>${stateShields(simCurrent)}</b>`,
      ...order.map(entry => {
        const elapsed = entry.finishTime >= 0 ? Math.max(0, entry.finishTime - game.startedAtSimulation) : Infinity;
        const name = entry.id === 'player' ? '<b>YOU</b>' : entry.name;
        return `${entry.rank} ${name} ${Number.isFinite(elapsed) ? fmt(elapsed * 1000) : `${Math.round(entry.s)}M`}`;
      }),
    ].join('<br>');
  }
  activateOnly('results', '#btnAgain');
}

function syncAfterSimulationMutation(){
  runnerSim.writePresentationFrame(simCurrent);
  perfState.presentationWrites += 1;
  copyPresentationFrame(simPrevious, simCurrent);
  interpolateSimulation(0);
  updateShieldHud();
  poseHero(0.016);
}

function resetSimulation(reason = 'replay'){
  runnerSim.reset();
  fixed?.reset();
  fixed?.setSimulating(false);
  game.failed = false;
  game.runStarted = false;
  game.timescale = 1;
  game.total = 0;
  actionController.clear();
  cueInputBuffer.clear(`reset:${reason}`, { clearFired: true });
  diagnostics.lastAcceptedAction = null;
  diagnostics.actionCounts = { up: 0, down: 0, left: 0, right: 0 };
  diagnostics.crashCount = 0;
  diagnostics.damageCount = 0;
  diagnostics.recoverCount = 0;
  diagnostics.finishCount = 0;
  diagnostics.lastSimActionEvent = null;
  diagnostics.lastHazardCue = null;
  diagnostics.lastRecoveryReason = null;
  diagnostics.lastResetReason = reason;
  diagnostics.terminalSnapshot = null;
  pendingRecovery = null;
  autoTriggered.clear();
  emittedCueEvents.clear();
  cuePresentation.id = null;
  cuePresentation.text = '';
  cuePresentation.stage = 'orientation';
  cuePresentation.requirement = null;
  cuePresentation.armed = false;
  cuePresentation.shownAtSimulation = -1;
  cuePresentation.shownAtS = -1;
  cuePresentation.hazardStart = -1;
  cuePresentation.cueStart = -1;
  cuePresentation.actionAt = -1;
  cuePresentation.actionReady = false;
  $('stateTag').textContent = RUNNER_START_MODE === 'race' ? 'FINAL RELAY' : 'TRAINING DECK';
  setCue('');
  syncAfterSimulationMutation();
  spring.snap(chasePosition(tmp), chaseLook(tmp2));
}

const flowDurations = FAST
  ? { intro: 0.08, countdown: 0.18, crash: 0.08, failed: 0.12, finish: 0.16 }
  : { intro: 4.2, countdown: 3, crash: 0.48, failed: 1.05, finish: 2.1 };

const handlers = {
  title: {
    enter(){
      activateOnly('title', '#tapGo');
      actionController.disable();
      cueInputBuffer.clear('mode:title');
      document.body.classList.remove('play', 'cine');
      setCue('');
      fixed?.setSimulating(false);
      city.setTitlePresentation(true);
      setRecoveryPresentation(false, 0, 0);
    },
  },
  intro: {
    enter(){
      activateOnly(null);
      actionController.disable();
      cueInputBuffer.clear('mode:intro');
      document.body.classList.add('cine');
      document.body.classList.remove('play');
      city.setTitlePresentation(false);
      setRecoveryPresentation(false, 0, 0);
      SFX.onReady(() => { padLoop?.on(0.055); rainLoop?.set(0.5, 0.035, 1100); });
      SFX.unlock();
    },
  },
  countdown: {
    enter(){
      activateOnly('count');
      actionController.disable();
      cueInputBuffer.clear('mode:countdown');
      document.body.classList.remove('cine');
      document.body.classList.add('play');
      fixed.setSimulating(false);
      setRecoveryPresentation(false, 0, 0);
      $('countN').textContent = '3';
      spring.snap(chasePosition(tmp), chaseLook(tmp2));
      SFX.beep(false);
    },
  },
  tutorial: {
    enter(){
      activateOnly(null);
      cueInputBuffer.clear('mode:tutorial');
      actionController.enable();
      document.body.classList.add('play');
      $('stateTag').textContent = 'TRAINING DECK';
      if(!game.runStarted){
        game.startedAtSimulation = fixed.state.simulationTime;
        game.runStarted = true;
      }
      fixed.setSimulating(true);
      setRecoveryPresentation(false, 0, 0);
      toast('SWIPE THE GLOWING CUES', 1.8);
    },
    exit(){
      actionController.disable();
      cueInputBuffer.clear('exit:tutorial');
    },
  },
  race: {
    enter(){
      activateOnly(null);
      cueInputBuffer.clear('mode:race');
      actionController.enable();
      fixed.setSimulating(true);
      setRecoveryPresentation(false, 0, 0);
      $('stateTag').textContent = RUNNER_START_MODE === 'race' ? 'FINAL RELAY' : 'FINAL LESSON';
      if(!game.runStarted){
        game.startedAtSimulation = fixed.state.simulationTime;
        game.runStarted = true;
      }
    },
    exit(){
      actionController.disable();
      cueInputBuffer.clear('exit:race');
    },
  },
  crash: {
    enter(_flow, request){
      activateOnly(null);
      actionController.disable();
      cueInputBuffer.clear('mode:crash', { clearFired: true });
      fixed.setSimulating(false);
      game.timescale = 1;
      diagnostics.crashCount += 1;
      if(request.detail?.lethal !== false) diagnostics.damageCount += 1;
      diagnostics.lastRecoveryReason = request.detail?.hazardId || 'hazard';
      setRecoveryPresentation(true, request.detail?.safeS ?? stateSafePad(simCurrent), stateS(simCurrent));
      spring.addShake(0.65);
      grade.uniforms.uCA.value = 1.35;
      SFX.thump(82, 0.34, 0.18, -34);
      toast(request.detail?.lethal === false
        ? `PRACTICE REWIND · ${Math.round(request.detail?.safeS ?? stateSafePad(simCurrent))}M`
        : `SHIELD DOWN · REWINDING TO ${Math.round(request.detail?.safeS ?? stateSafePad(simCurrent))}M`, 1.2);
      updateShieldHud();
    },
  },
  recover: {
    enter(){
      cueInputBuffer.clear('mode:recover', { clearFired: true });
      diagnostics.recoverCount += 1;
      runnerSim.recover({
        safePad: pendingRecovery?.safePadId,
        shields: pendingRecovery?.shieldsRemaining ?? stateShields(simCurrent),
      });
      syncAfterSimulationMutation();
      setRecoveryPresentation(true, stateSafePad(simCurrent), pendingRecovery?.fromS ?? stateS(simCurrent));
      fixed.setSimulating(true);
      spring.snap(chasePosition(tmp), chaseLook(tmp2));
      SFX.notify();
    },
  },
  failed: {
    enter(){
      game.failed = true;
      actionController.disable();
      cueInputBuffer.clear('mode:failed');
      fixed.setSimulating(false);
      runnerSim.freeze('shields-exhausted', { terminal: true });
      syncAfterSimulationMutation();
      diagnostics.terminalSnapshot = structuredClone(runnerSim.snapshot());
      setRecoveryPresentation(false, 0, 0);
      document.body.classList.add('cine');
      SFX.thump(70, 0.5, 0.2, -40);
    },
  },
  finish: {
    enter(){
      diagnostics.finishCount += 1;
      actionController.disable();
      cueInputBuffer.clear('mode:finish');
      fixed.setSimulating(false);
      // A checkpoint toast can still be alive when the terminal event lands.
      // Replace that transient state at the source so the real finish screen
      // never claims an earlier course position.
      toast('');
      $('stateTag').textContent = 'TRAINING CLEAR';
      runnerSim.freeze('training-complete', { terminal: true });
      syncAfterSimulationMutation();
      diagnostics.terminalSnapshot = structuredClone(runnerSim.snapshot());
      setRecoveryPresentation(false, 0, 0);
      document.body.classList.add('cine');
      SFX.fanfare([659, 830, 988, 1318]);
    },
  },
  results: {
    enter(){
      diagnostics.resultsCount += 1;
      actionController.disable();
      cueInputBuffer.clear('mode:results');
      fixed.setSimulating(false);
      document.body.classList.remove('play', 'cine');
      setRecoveryPresentation(false, 0, 0);
      setCue('');
      showResults();
    },
  },
};

flow = createRunnerFlow({ handlers, trace, durations: flowDurations });

/* ---------------- deterministic fixed-step event bridge ---------------- */
function submitSimAction(action, source = 'gesture'){
  const normalized = typeof action === 'string'
    ? { type: action === 'up' ? 'jump' : action === 'down' ? 'slide' : action, direction: action }
    : action;
  const result = runnerSim.input(normalized.type, normalized);
  trace.record('simulation-input', { source, type: normalized?.type || null, direction: normalized?.direction || null, accepted: result?.ok !== false, atS: stateS(simCurrent) });
  return result;
}

function routeCueAction(action, source = 'gesture'){
  const route = cueInputBuffer.route({
    course,
    s: stateS(simCurrent),
    lane: stateLaneTarget(simCurrent),
    action,
  });
  trace.record('cue-input', {
    source,
    kind: route.kind,
    reason: route.reason,
    hazardId: route.hazardId || null,
    atS: stateS(simCurrent),
  });
  if(route.kind === 'armed'){
    toast('READY · ACTION ARMED', 0.7);
    return { ok: true, queued: true, armed: true, ...route };
  }
  if(route.kind === 'fire') return submitSimAction(route.action, `${source}-cue`);
  return { ok: false, queued: false, ...route };
}

function fireReadyCueAction(){
  const ready = cueInputBuffer.takeReady({ course, s: stateS(simCurrent) });
  if(!ready) return null;
  trace.record('cue-input-fired', {
    hazardId: ready.hazardId,
    armedAtS: ready.armedAtS,
    firedAtS: stateS(simCurrent),
  });
  return submitSimAction(ready.action, 'armed-cue');
}

const autoTriggered = new Set();
function autoPilotStep(){
  const s = stateS(simCurrent);
  const next = course.nextHazardAfter?.(s - 0.2) || null;
  if(!next || autoTriggered.has(next.id)) return;
  const lead = next.action === 'slide' ? 6.5 : next.action?.startsWith('lane') ? 8 : 5.3;
  if(next.s0 - s > lead) return;
  const direction = next.action === 'slide' ? 'down'
    : next.action === 'lane-left' ? 'left'
      : next.action === 'lane-right' ? 'right' : 'up';
  submitSimAction(direction, 'auto');
  autoTriggered.add(next.id);
}

function handleSimulationEvent(event){
  diagnostics.lastEvent = structuredClone(event);
  trace.record(`simulation-${event.type || 'event'}`, { ...event });
  if(event.type === 'action-accepted'){
    diagnostics.lastSimActionEvent = structuredClone(event);
  } else if(event.type === 'hazard-cue'){
    const cueEvent = structuredClone(event);
    emittedCueEvents.set(event.hazardId, cueEvent);
    diagnostics.lastHazardCue = cueEvent;
  } else if(event.type === 'checkpoint' || event.type === 'safe-pad'){
    const eventSection = course.sectionAt(event.s ?? stateSafePad(simCurrent));
    $('stateTag').textContent = eventSection?.lesson === 'combined' ? 'FINAL LESSON' : 'CHECKPOINT 01';
    toast(`CHECKPOINT ${Math.round(event.s ?? stateSafePad(simCurrent))}M`, 1.2);
    SFX.notify();
  } else if(event.type === 'jump' || event.type === 'jumped'){
    SFX.sweep({ f0: 420, f1: event.double || event.jumpNumber === 2 ? 2300 : 1700, dur: 0.2, vol: 0.055 });
  } else if(event.type === 'land' || event.type === 'landed'){
    SFX.thump(150, 0.07, 0.075);
  } else if(event.type === 'stumble' || event.type === 'training-hit'){
    spring.addShake(0.32);
    toast('SAFE BARRIER · FOLLOW THE LIT LANE', 1.1);
  } else if(event.type === 'crash' || event.type === 'crash-pending'){
    const shieldsRemaining = Number.isFinite(event.suggestedShieldsRemaining)
      ? event.suggestedShieldsRemaining
      : Math.max(0, (event.shieldsBefore ?? stateShields(simCurrent)) - (event.lethal === false ? 0 : 1));
    runnerSim.setShields(shieldsRemaining);
    runnerSim.writePresentationFrame(simCurrent);
    copyPresentationFrame(simPrevious, simCurrent);
    pendingRecovery = {
      safePadId: event.safePadId,
      safeS: event.safeS,
      fromS: stateS(simCurrent),
      shieldsRemaining,
      lethal: event.lethal !== false,
    };
    const resumeMode = flow.mode === 'tutorial' ? 'tutorial' : 'race';
    flow.transition('crash', {
      reason: 'hazard-crash',
      detail: {
        shieldsRemaining, resumeMode, hazardId: event.hazardId || event.id || null,
        safePad: stateSafePad(simCurrent), safeS: event.safeS, lethal: event.lethal !== false,
      },
    });
  } else if(event.type === 'recovery-complete'){
    pendingRecovery = null;
    flow.completeRecovery(event);
  } else if(event.type === 'finish' || event.type === 'finish-pending'){
    flow.transition('finish', { reason: 'training-finish', detail: { s: stateS(simCurrent) } });
  }
}

const simulationEvents = [];
function drainSimulationEvents(){
  runnerSim.drainEventsInto(simulationEvents);
  for(const event of simulationEvents){
    handleSimulationEvent(event);
  }
}

const actionDrainBuffer = [];
const fixedFrameOutput = {};
const fixedAdvanceOptions = { simulate: false, timeScale: 1, cinematicScale: 1 };
let fixed = null;
fixed = createFixedStepRunner({
  step: 1 / 120,
  maxFrame: 0.1,
  maxSteps: 120,
  onStep(dt){
    if(AUTO) autoPilotStep();
    fireReadyCueAction();
    const drained = actionController.drainInto(actionDrainBuffer);
    hotIdentity.actionDrainOutputStable = hotIdentity.actionDrainOutputStable && drained === actionDrainBuffer;
    for(let index = 0; index < drained.length; index += 1){
      routeCueAction(drained[index], 'gesture');
    }
    const swap = simPrevious;
    simPrevious = simCurrent;
    simCurrent = swap;
    runnerSim.step(dt, simCurrent);
    perfState.presentationWrites += 1;
    drainSimulationEvents();
    if(flow.mode === 'tutorial' && course.sectionAt(stateS(simCurrent))?.lesson === 'combined'){
      flow.transition('race', { reason: 'tutorial-lessons-complete', detail: { s: stateS(simCurrent) } });
    }
  },
});
fixed.setSimulating(false);

/* ---------------- controls, completed clicks, and audio ---------------- */
$('gl').addEventListener('pointerdown', () => SFX.unlock(), { passive: true });
$('tapGo').addEventListener('click', event => {
  event.preventDefault();
  SFX.unlock();
  if(flow.mode === 'title') flow.transition('intro', { reason: 'start-button', detail: { nextMode: RUNNER_START_MODE } });
});
$('btnAgain').addEventListener('click', event => {
  event.preventDefault();
  if(flow.mode !== 'results') return;
  resetSimulation('run-again-button');
  flow.transition('countdown', { reason: 'run-again-button', detail: { nextMode: RUNNER_START_MODE } });
});
$('mute').addEventListener('click', event => {
  event.stopPropagation();
  const muted = SFX.toggleMuted();
  $('mute').textContent = muted ? '𝄽' : '♪';
});

let padLoop = null;
let rainLoop = null;
let windLoop = null;
let slideLoop = null;
SFX.onReady(() => {
  padLoop = SFX.pad({
    chords: [[110, 164.8, 220], [87.3, 174.6, 220], [130.8, 196, 261.6], [98, 146.8, 196]],
    lp: 920, types: ['sawtooth', 'sawtooth', 'triangle'], vGain: 0.045,
  });
  rainLoop = SFX.noiseLoop({ type: 'lowpass', freq: 1100, Q: 0.4 });
  windLoop = SFX.noiseLoop({ type: 'bandpass', freq: 700, Q: 0.6 });
  slideLoop = SFX.noiseLoop({ type: 'bandpass', freq: 850, Q: 2.2 });
});

/* ---------------- cameras and presentation ---------------- */
function introCamera(time){
  const duration = flow.durations.intro || 1;
  const t = FREEZE !== null ? FREEZE : time;
  const u = clamp(t / Math.max(0.001, duration), 0, 1);
  const start = poseAt(8, 0, introStartScratch);
  const preview = poseAt(72, 0, introPreviewScratch);
  if(u < 0.52){
    const phase = ease(u / 0.52);
    tmp.copy(preview.pos).addScaledVector(preview.right, 12);
    tmp.y += 16;
    tmp2.copy(start.pos).addScaledVector(start.right, 3.5);
    tmp2.y += 4.8;
    camera.position.copy(tmp).lerp(tmp2, phase);
    tmp3.copy(start.pos).addScaledVector(start.tan, 18);
    tmp3.y += 1.8;
    camera.lookAt(tmp3);
    camera.fov = lerp(48, 46, phase);
  } else {
    const phase = ease((u - 0.52) / 0.48);
    tmp.copy(start.pos).addScaledVector(start.tan, 3.5).addScaledVector(start.right, 2.2);
    tmp.y += 1.65;
    chasePosition(tmp2);
    camera.position.copy(tmp).lerp(tmp2, phase);
    chaseLook(tmp3);
    camera.lookAt(tmp3);
    camera.fov = lerp(45, CHASE_FOV, phase);
  }
  camera.updateProjectionMatrix();
}

const TITLE_AZIMUTH_DEGREES = 47;
function titleCamera(){
  const pose = poseAt(7, 0, cameraPoseScratch);
  const radians = THREE.MathUtils.degToRad(TITLE_AZIMUTH_DEGREES);
  const radius = 9.35;
  camera.position.copy(pose.pos)
    .addScaledVector(pose.tan, -Math.cos(radians) * radius)
    .addScaledVector(pose.right, -Math.sin(radians) * radius);
  camera.position.y += 3.25;
  tmp3.copy(pose.pos).addScaledVector(pose.tan, 1.6).addScaledVector(pose.right, 2.1);
  tmp3.y += 0.95;
  camera.lookAt(tmp3);
  camera.fov = CHASE_FOV;
  camera.updateProjectionMatrix();
}

function recoveryCamera(){
  const safeS = stateSafePad(renderState);
  const midpoint = clamp((safeS + stateS(renderState)) * 0.5, 0, COURSE_LEN);
  const pose = poseAt(midpoint, 0, cameraPoseScratch);
  camera.position.copy(pose.pos)
    .addScaledVector(pose.tan, -4.5)
    .addScaledVector(pose.right, -9.0);
  camera.position.y += 5.2;
  tmp3.copy(pose.pos).addScaledVector(pose.tan, 1.2);
  tmp3.y += 1.30;
  camera.lookAt(tmp3);
  camera.fov = 48;
  camera.updateProjectionMatrix();
}

function terminalCamera(results = false){
  const focusS = game.failed ? clamp(stateS(renderState), 2, COURSE_LEN - 1.4) : Math.min(COURSE_LEN - 1.4, 148.2);
  const pose = poseAt(focusS, 0, cameraPoseScratch);
  camera.position.copy(pose.pos)
    .addScaledVector(pose.tan, -14.0)
    .addScaledVector(pose.right, -5.5);
  camera.position.y += 4.55;
  tmp3.copy(pose.pos).addScaledVector(pose.tan, 0.8).addScaledVector(pose.right, 3.0);
  tmp3.y += 4.05;
  camera.lookAt(tmp3);
  camera.fov = results ? 52 : 50;
  camera.updateProjectionMatrix();
}

function rivalJumpY(rival){
  const gap = course.isGapAt(rival.s, rival.lane);
  if(!gap) return 0;
  const span = Math.max(0.1, gap.s1 - gap.s0);
  return Math.sin(clamp((rival.s - gap.s0) / span, 0, 1) * Math.PI) * 1.6;
}

function updateRivals(dt){
  for(let index = 0; index < rivalViews.length; index += 1){
    const view = rivalViews[index];
    const rival = renderState.rivals[index];
    const gap = course.isGapAt(rival.s, rival.lane);
    let jumpY = 0;
    if(gap){
      jumpY = rivalJumpY(rival);
    }
    const pose = poseAt(rival.s, rival.lane, rivalPoseScratches[index]);
    view.mesh.position.copy(pose.pos);
    view.mesh.position.y += jumpY;
    view.mesh.rotation.y = Math.atan2(pose.tan.x, pose.tan.z);
    const phase = renderState.time * (6.2 + rival.speed * 0.42) + view.profile.phase;
    let poseState = gap ? 'air' : 'run';
    if(flow?.mode === 'failed' || flow?.mode === 'finish' || flow?.mode === 'results'){
      let rank = rival.rank || 4;
      for(let standingIndex = 0; standingIndex < simCurrent.standings.length; standingIndex += 1){
        if(simCurrent.standings[standingIndex].id === view.id){
          rank = simCurrent.standings[standingIndex].rank;
          break;
        }
      }
      poseState = rank === 1 ? 'win' : index % 2 ? 'stumble' : 'fail';
    }
    poseCourier(view.mesh, poseState, phase, rival.speed, dt);
  }
}

function stageTitleCouriers(){
  titleHotPath.stageCalls += 1;
  titleHotPath.lineupStable = titleHotPath.lineupStable && titleLineup === titleLineupIdentity;
  for(let index = 0; index < titleLineup.length; index += 1){
    const runner = titleLineup[index];
    titleHotPath.poseOutputsStable = titleHotPath.poseOutputsStable
      && runner.scratch === titlePoseScratchIdentities[index];
    const pose = poseAt(runner.s, runner.lane, runner.scratch);
    titleHotPath.poseOutputsStable = titleHotPath.poseOutputsStable && pose === runner.scratch;
    runner.mesh.position.copy(pose.pos);
    runner.mesh.rotation.y = Math.atan2(pose.tan.x, pose.tan.z);
    poseCourier(runner.mesh, 'crouch', runner.phase, 0, 0);
  }
}

function playerPosition(){
  return Math.max(1, Math.min(1 + rivalViews.length, simCurrent.rank));
}

function updateHud(){
  $('dist').textContent = Math.min(COURSE_LEN, Math.round(stateS(simCurrent)));
  $('bigN').textContent = Math.round(stateSpeed(simCurrent) * 3.6);
  $('pos').textContent = ORD[Math.max(0, Math.min(rivalViews.length, playerPosition() - 1))];
  updateShieldHud();
  if(flow.mode === 'tutorial' || flow.mode === 'race'){
    const cue = runnerCuePresentation(course, stateS(simCurrent), stateLaneTarget(simCurrent), {
      armed: cueInputBuffer.armed,
    });
    const distance = cue.hazard ? ` · ${Math.ceil(cue.distance)}M` : '';
    setCue(`${cue.text}${distance}`, cue);
    if(cueInputBuffer.armed?.hazardId === cue.id && cueInputBuffer.markPresented(cue.id)){
      trace.record('cue-ready-presented', { hazardId: cue.id, text: cue.text, atS: stateS(simCurrent) });
    }
  } else setCue('');
}

function renderParticles(dt, nowSeconds){
  const rainCount = LOWFX ? 3 : 9;
  for(let i = 0; i < rainCount; i++){
    camera.getWorldDirection(tmp2);
    rain.emit(
      camera.position.x + tmp2.x * (5 + Math.random() * 22) + (Math.random() - 0.5) * 24,
      camera.position.y + 7 + Math.random() * 9,
      camera.position.z + tmp2.z * (5 + Math.random() * 22) + (Math.random() - 0.5) * 24,
      1.1, -27 - Math.random() * 5, 0.4,
      { life: 0.75, size: 0.22, grow: 0, alpha: 0.24, col: [0.62, 0.74, 1.0] },
    );
  }
  if((flow.mode === 'finish' || flow.mode === 'results') && !game.failed){
    game.fireworksTimer -= dt;
    if(game.fireworksTimer <= 0){
      game.fireworksTimer = 0.34;
      const pose = poseAt(COURSE_LEN - 1);
      const color = [[0.3, 0.95, 1], [1, 0.35, 0.8], [1, 0.8, 0.35]][(Math.random() * 3) | 0];
      for(let i = 0; i < 18; i++){
        const angle = Math.random() * Math.PI * 2;
        const speed = 5 + Math.random() * 5;
        fireworks.emit(pose.pos.x, pose.pos.y + 9, pose.pos.z,
          Math.cos(angle) * speed, 2 + Math.random() * 6, Math.sin(angle) * speed,
          { life: 0.9, size: 0.45, grow: -0.08, alpha: 0.9, col: color, grav: 5 });
      }
    }
  }
  rain.tick(dt);
  splash.tick(dt);
  sparks.tick(dt);
  fireworks.tick(dt);
  tickCity(dt, nowSeconds, city);
}

/* ---------------- real wall-delta loop + fixed-step interpolation ---------------- */
resetSimulation('initial');
if(PREVIEW_MODE){
  document.querySelector('#title .sub').textContent = `MIDNIGHT CIRCUIT · ${runnerFormatLabel(PREVIEW_OPTIONS).toUpperCase()} · ${PREVIEW_OPTIONS.runner.pace === 'calm' ? 'CALM PACE' : 'STANDARD PACE'}`;
  document.querySelector('#title .titleMeta').textContent = `${PREVIEW_OPTIONS.runner.safety} SHIELDS // ${PREVIEW_OPTIONS.runner.swipe === 'easy' ? 'EASY SWIPE' : 'STANDARD SWIPE'}`;
  document.querySelector('#distChip').firstChild.textContent = RUNNER_START_MODE === 'race' ? 'FINAL RELAY' : 'TRAINING RUN';
  mountPreviewGameChrome({
    game: 'runner',
    options: PREVIEW_OPTIONS,
    onOpenChange(open){
      previewPaused = open;
      if(!open) return;
      actionController.cancel('preview-menu-open');
      actionController.clear();
      cueInputBuffer.clear('preview-menu-open');
    },
    onSoundChange(value){ SFX.setMuted(value === 'off'); },
  });
}
flow.transition('title', { reason: 'initial' });
let lastFrame = performance.now();
let countShown = null;

function frame(now){
  requestAnimationFrame(frame);
  const elapsedMilliseconds = Math.max(0, now - lastFrame);
  recordFrame(elapsedMilliseconds);
  const wallDelta = Math.min(elapsedMilliseconds / 1000, 0.25);
  const renderDelta = Math.min(wallDelta, 0.05);
  lastFrame = now;
  if(previewPaused){
    renderer.info.reset();
    composer.render();
    return;
  }
  grade.uniforms.uTime.value = now / 1000;

  const flowScale = FAST ? 1 : 1;
  if(!(flow.mode === 'intro' && FREEZE !== null)) flow.tick(wallDelta * flowScale);

  const activeSimulation = flow.mode === 'tutorial' || flow.mode === 'race' || flow.mode === 'recover';
  fixedAdvanceOptions.simulate = activeSimulation;
  fixedAdvanceOptions.timeScale = game.timescale * Math.max(1, WARP || 1);
  const stepFrame = fixed.advanceInto(wallDelta, fixedAdvanceOptions, fixedFrameOutput);
  hotIdentity.fixedFrameOutputStable = hotIdentity.fixedFrameOutputStable && stepFrame === fixedFrameOutput;
  interpolateSimulation(stepFrame.alpha);
  poseHero(renderDelta);
  updateRivals(renderDelta);
  if(hero.userData.tether.visible) updateCourierTether(hero, city.recoveryVisual.eye);

  if(flow.mode === 'title'){
    stageTitleCouriers();
    titleCamera();
  } else if(flow.mode === 'intro'){
    introCamera(flow.modeTime);
    poseCourier(hero, 'crouch', 0, 0, renderDelta);
  } else if(flow.mode === 'countdown'){
    const remaining = Math.max(0, flow.durations.countdown - flow.modeTime);
    const number = remaining <= 0.2 ? 'GO' : String(Math.max(1, Math.ceil(remaining)));
    if(number !== countShown){
      countShown = number;
      $('countN').textContent = number;
      $('countN').classList.remove('pop');
      void $('countN').offsetWidth;
      $('countN').classList.add('pop');
      SFX.beep(number === 'GO');
    }
    spring.tick(renderDelta, chasePosition(tmp), chaseLook(tmp2), velocity.set(0, 0, 0), { sway: 0.012, fovTarget: CHASE_FOV });
    poseCourier(hero, 'crouch', 0, 0, renderDelta);
  } else if(flow.mode === 'tutorial' || flow.mode === 'race'){
    const pose = poseAt(renderState.s, stateLane(renderState), cameraPoseScratch);
    velocity.copy(pose.tan).multiplyScalar(renderState.speed);
    spring.tick(renderDelta, chasePosition(tmp), chaseLook(tmp2), velocity,
      { sway: 0.012 + renderState.speed * 0.0008, fovTarget: CHASE_FOV + clamp(renderState.speed - 11, 0, 8) * 0.12 });
  } else if(flow.mode === 'crash' || flow.mode === 'recover'){
    recoveryCamera();
  } else if(flow.mode === 'failed' || flow.mode === 'finish' || flow.mode === 'results'){
    terminalCamera(flow.mode === 'results');
  }

  if(game.topCamHeight > 0){
    worldFor(renderState, tmp);
    camera.position.set(tmp.x, tmp.y + game.topCamHeight, tmp.z);
    camera.lookAt(tmp.x, tmp.y, tmp.z);
    camera.fov = 55;
    camera.updateProjectionMatrix();
  }

  grade.uniforms.uCA.value = Math.max(0.18 * clamp((renderState.speed - 12) / 8, 0, 1), grade.uniforms.uCA.value - renderDelta * 2.4);
  updateHud();
  if(toastRemaining > 0){
    toastRemaining -= wallDelta;
    if(toastRemaining <= 0) toast('');
  }
  renderParticles(renderDelta, now / 1000);
  atmo.tick(renderDelta, camera.position.x, camera.position.z);
  worldFor(renderState, tmp);
  atmo.followShadow(tmp.x, tmp.y, tmp.z);
  windLoop?.set(clamp(renderState.speed / 20, 0, 1) * (activeSimulation ? 1 : 0.18), 0.045, 500 + renderState.speed * 45);
  slideLoop?.set(renderState.slideRemaining > 0 ? 0.65 : 0, 0.045, 820);
  pipe.govern(renderDelta);
  renderer.info.reset();
  composer.render();
}
requestAnimationFrame(frame);

/* ---------------- preserved + extended diagnostics contract ---------------- */
function activeScreens(){
  return SCREEN_IDS.filter(id => document.getElementById(id)?.dataset.screenActive === 'true');
}

function deterministicAction(direction){
  if(!['up', 'down', 'left', 'right'].includes(direction)) return false;
  diagnostics.lastAcceptedAction = { direction, source: 'diagnostic', atS: stateS(simCurrent) };
  diagnostics.actionCounts[direction] += 1;
  return submitSimAction(direction, 'diagnostic');
}

function debugSetCourseS(s, options = {}){
  if(!Number.isFinite(s)) throw new TypeError('debug course s must be finite');
  actionController.clear();
  cueInputBuffer.clear('debug-set-course-s', { clearFired: true });
  const overrides = { ...options, s };
  if(typeof runnerSim.restore === 'function') runnerSim.restore(overrides);
  else runnerSim.reset(overrides);
  syncAfterSimulationMutation();
  diagnostics.lastResetReason = 'debug-set-course-s';
  spring.snap(chasePosition(tmp), chaseLook(tmp2));
  return runnerSim.snapshot();
}

function presentationSummary(frame){
  return {
    time: frame.time,
    s: frame.s,
    speed: frame.speed,
    yRel: frame.y,
    lane: frame.lanePosition,
    laneTarget: frame.lane,
    shields: frame.shields,
    safePad: stateSafePad(frame),
    locomotion: stateLocomotion(frame),
    jumps: frame.jumpsUsed,
    slideRemaining: frame.slideRemaining,
    phase: frame.phase ?? frame.time * (6.4 + frame.speed * 0.42),
    frozen: Boolean(frame.frozen || frame.terminal),
    rank: frame.rank,
    finishTime: frame.finishTime,
    rivals: frame.rivals.map(rival => ({ ...rival })),
    standings: frame.standings.map(entry => ({ ...entry })),
  };
}

function rivalParityReport(){
  let maxDelta = 0;
  const rows = rivalViews.map((view, index) => {
    const rendered = renderState.rivals[index];
    const authoritative = simCurrent.rivals[index];
    const pose = poseAt(rendered.s, rendered.lane, rivalPoseScratches[index]);
    const expectedY = pose.pos.y + rivalJumpY(rendered);
    const delta = Math.hypot(
      view.mesh.position.x - pose.pos.x,
      view.mesh.position.y - expectedY,
      view.mesh.position.z - pose.pos.z,
    );
    maxDelta = Math.max(maxDelta, delta);
    return {
      id: view.id,
      delta,
      simS: authoritative.s,
      renderS: rendered.s,
      speed: rendered.speed,
      lane: rendered.lane,
      finishTime: authoritative.finishTime,
    };
  });
  const hudRank = ORD.indexOf($('pos').textContent) + 1;
  const authoritativeRank = playerPosition();
  return {
    ok: maxDelta <= 1e-5 && hudRank === authoritativeRank,
    maxDelta,
    rows,
    hudRank,
    authoritativeRank,
  };
}

const visualWorldPosition = new THREE.Vector3();
const visualProjectedPosition = new THREE.Vector3();
const visualCornerPosition = new THREE.Vector3();
const visualBounds = new THREE.Box3();
function cameraFramingReport(){
  const views = [{ id: 'player', object: hero }, ...rivalViews.map(view => ({ id: view.id, object: view.mesh }))];
  const rows = views.map(view => {
    view.object.getWorldPosition(visualWorldPosition);
    visualProjectedPosition.copy(visualWorldPosition);
    visualProjectedPosition.y += 0.9;
    visualProjectedPosition.project(camera);
    const inFront = visualProjectedPosition.z >= -1 && visualProjectedPosition.z <= 1;
    visualBounds.setFromObject(view.object, true);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let allCornersInFront = true;
    for(let corner = 0; corner < 8; corner += 1){
      visualCornerPosition.set(
        corner & 1 ? visualBounds.max.x : visualBounds.min.x,
        corner & 2 ? visualBounds.max.y : visualBounds.min.y,
        corner & 4 ? visualBounds.max.z : visualBounds.min.z,
      ).project(camera);
      minX = Math.min(minX, visualCornerPosition.x);
      maxX = Math.max(maxX, visualCornerPosition.x);
      minY = Math.min(minY, visualCornerPosition.y);
      maxY = Math.max(maxY, visualCornerPosition.y);
      allCornersInFront = allCornersInFront && visualCornerPosition.z >= -1 && visualCornerPosition.z <= 1;
    }
    const fullyInFrame = allCornersInFront && minX >= -0.98 && maxX <= 0.98 && minY >= -0.98 && maxY <= 0.98;
    return {
      id: view.id,
      ndc: [visualProjectedPosition.x, visualProjectedPosition.y, visualProjectedPosition.z],
      inFrame: inFront && Math.abs(visualProjectedPosition.x) <= 0.94 && Math.abs(visualProjectedPosition.y) <= 0.9,
      bounds: { minX, maxX, minY, maxY },
      fullyInFrame,
      rightClipped: allCornersInFront && maxX > 0.98,
    };
  });
  return {
    allFourInFrame: rows.length === 4 && rows.every(row => row.inFrame),
    allFourFullyInFrame: rows.length === 4 && rows.every(row => row.fullyInFrame),
    rightClippedIds: rows.filter(row => row.rightClipped).map(row => row.id),
    rows,
  };
}

function slideClearanceReport(){
  const gate = course.hazards.find(hazard => hazard.id === 'slide-gate-01');
  let minBottomAboveDeck = Infinity;
  let maxTopAboveDeck = -Infinity;
  let finite = true;
  for(let courierIndex = 0; courierIndex < allCourierViews.length; courierIndex += 1){
    const courier = allCourierViews[courierIndex];
    for(let sample = 0; sample < COURIER_SLIDE_BOUNDS.samples; sample += 1){
      const phase = sample / Math.max(1, COURIER_SLIDE_BOUNDS.samples - 1) * Math.PI * 2;
      poseCourier(courier, 'slide', phase, 14, 0);
      courier.updateWorldMatrix(true, true);
      visualBounds.setFromObject(courier, true);
      const bottom = visualBounds.min.y - courier.position.y;
      const top = visualBounds.max.y - courier.position.y;
      minBottomAboveDeck = Math.min(minBottomAboveDeck, bottom);
      maxTopAboveDeck = Math.max(maxTopAboveDeck, top);
      finite = finite && Number.isFinite(bottom) && Number.isFinite(top);
    }
  }
  if(flow.mode === 'title') stageTitleCouriers();
  else {
    poseHero(0);
    updateRivals(0);
    if(hero.userData.tether.visible) updateCourierTether(hero, city.recoveryVisual.eye);
  }
  const gateBoundaryHeight = gate?.boundaryHeight ?? 1.58;
  const clearance = gateBoundaryHeight - maxTopAboveDeck;
  const report = {
    samples: COURIER_SLIDE_BOUNDS.samples,
    profiles: allCourierViews.length,
    floorTarget: COURIER_SLIDE_BOUNDS.floor,
    ceilingTarget: COURIER_SLIDE_BOUNDS.ceiling,
    minBottomAboveDeck,
    maxTopAboveDeck,
    // Compatibility aliases retained for the existing private gate.
    bottomAboveDeck: minBottomAboveDeck,
    topAboveDeck: maxTopAboveDeck,
    gateBoundaryHeight,
    clearance,
    finite,
  };
  report.neverBelowDeck = finite && minBottomAboveDeck >= COURIER_SLIDE_BOUNDS.floor;
  report.neverAboveTarget = finite && maxTopAboveDeck <= COURIER_SLIDE_BOUNDS.ceiling;
  report.clears = report.neverBelowDeck && report.neverAboveTarget && clearance >= 0.18;
  return report;
}

function actionPoseReport(){
  const states = ['run', 'air', 'slide', 'stumble', 'recover', 'win', 'fail', 'crouch'];
  let minBottomAboveDeck = Infinity;
  let maxTopAboveDeck = -Infinity;
  let finite = true;
  let samples = 0;
  for(let courierIndex = 0; courierIndex < allCourierViews.length; courierIndex += 1){
    const courier = allCourierViews[courierIndex];
    for(let stateIndex = 0; stateIndex < states.length; stateIndex += 1){
      for(let phaseIndex = 0; phaseIndex < 9; phaseIndex += 1){
        poseCourier(courier, states[stateIndex], phaseIndex / 8 * Math.PI * 2, 14, 0);
        courier.updateWorldMatrix(true, true);
        visualBounds.setFromObject(courier, true);
        const bottom = visualBounds.min.y - courier.position.y;
        const top = visualBounds.max.y - courier.position.y;
        minBottomAboveDeck = Math.min(minBottomAboveDeck, bottom);
        maxTopAboveDeck = Math.max(maxTopAboveDeck, top);
        finite = finite && Number.isFinite(bottom) && Number.isFinite(top);
        samples += 1;
      }
    }
  }
  if(flow.mode === 'title') stageTitleCouriers();
  else {
    poseHero(0);
    updateRivals(0);
    if(hero.userData.tether.visible) updateCourierTether(hero, city.recoveryVisual.eye);
  }
  return {
    states,
    profiles: allCourierViews.length,
    samples,
    minBottomAboveDeck,
    maxTopAboveDeck,
    finite,
    neverBelowDeck: finite && minBottomAboveDeck >= -0.015,
  };
}

function visualResourceSnapshot(){
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  let renderables = 0;
  let transparentRenderables = 0;
  let shadowCasters = 0;
  let finiteTransforms = true;
  scene.traverse(object => {
    const values = [
      object.position.x, object.position.y, object.position.z,
      object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w,
      object.scale.x, object.scale.y, object.scale.z,
    ];
    if(values.some(value => !Number.isFinite(value))) finiteTransforms = false;
    if(object.geometry) geometries.add(object.geometry);
    const list = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
    if(list.length){
      renderables += 1;
      if(list.some(material => material.transparent)) transparentRenderables += 1;
      for(const material of list){
        materials.add(material);
        for(const key of ['map', 'envMap', 'alphaMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']){
          if(material[key]) textures.add(material[key]);
        }
      }
    }
    if(object.geometry && object.castShadow) shadowCasters += 1;
  });
  if(scene.environment) textures.add(scene.environment);
  let largestTextureEdge = 0;
  for(const texture of textures){
    const image = texture.image;
    largestTextureEdge = Math.max(largestTextureEdge, image?.width || 0, image?.height || 0);
  }
  return {
    renderables,
    geometries: geometries.size,
    materials: materials.size,
    textures: textures.size,
    largestTextureEdge,
    transparentRenderables,
    shadowCasters,
    finiteTransforms,
  };
}

const recoveryEndpointWorld = new THREE.Vector3();
const recoveryAnchorWorld = new THREE.Vector3();
function recoveryStoryReport(){
  const attribute = hero.userData.tether.geometry.getAttribute('position');
  const array = attribute.array;
  hero.userData.root.updateWorldMatrix(true, false);
  recoveryEndpointWorld.set(array[3], array[4], array[5]).applyMatrix4(hero.userData.root.matrixWorld);
  city.recoveryVisual.eye.getWorldPosition(recoveryAnchorWorld);
  return {
    active: city.recoveryVisual.active,
    heroTetherVisible: hero.userData.tether.visible,
    lowfxSkipped: LOWFX && !hero.userData.tether.visible,
    anchorVisible: city.recoveryVisual.anchor.visible,
    anchorName: city.recoveryVisual.eye.name,
    trailVisible: city.recoveryVisual.trail.visible,
    trailPoints: city.recoveryVisual.trail.geometry.getAttribute('position').count,
    safeS: city.recoveryVisual.safeS,
    anchorS: city.recoveryVisual.anchorS,
    fromS: city.recoveryVisual.fromS,
    tetherTargetDelta: hero.userData.tether.visible
      ? recoveryEndpointWorld.distanceTo(recoveryAnchorWorld) : null,
  };
}

function hotPathSnapshot(){
  return {
    title: {
      stageCalls: titleHotPath.stageCalls,
      lineupStable: titleHotPath.lineupStable,
      poseOutputsStable: titleHotPath.poseOutputsStable,
    },
    couriers: courierHotPathReport(allCourierViews),
    districts: city.districts.allocationReport?.() || null,
  };
}

function visualSnapshot(){
  const courierReports = [courierSemanticReport(hero), ...rivalViews.map(view => courierSemanticReport(view.mesh))];
  const torsoGeometries = [hero, ...rivalViews.map(view => view.mesh)].map(view => view.getObjectByName('torsoShell')?.geometry);
  const rigRoots = [hero, ...rivalViews.map(view => view.mesh)].map(view => view.userData.root);
  return {
    phase: 4,
    mode: flow.mode,
    courseS: stateS(renderState),
    couriers: courierReports,
    courierContract: {
      topLevelRoots: hero.parent === scene && rivalViews.every(view => view.mesh.parent === scene),
      independentRigs: new Set(rigRoots).size === 4,
      sharedGeometry: torsoGeometries.every(geometry => geometry && geometry === torsoGeometries[0]),
      distinctProfiles: new Set(courierReports.map(report => report.profileId)).size === 4,
      distinctSilhouettes: new Set(courierReports.map(report => report.silhouette)).size === 4,
      distinctCadences: new Set(courierReports.map(report => report.cadence)).size === 4,
    },
    camera: {
      fov: camera.fov,
      chaseFov: CHASE_FOV,
      titleAzimuthDegrees: TITLE_AZIMUTH_DEGREES,
      framing: cameraFramingReport(),
    },
    slideClearance: slideClearanceReport(),
    actionPoses: actionPoseReport(),
    recoveryStory: recoveryStoryReport(),
    terminalPoses: allCourierViews.map(courier => ({
      profileId: courier.userData.profileId,
      pose: courier.userData.currentPose,
    })),
    districts: city.districts.semanticReport(),
    resources: visualResourceSnapshot(),
    frame: {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      lines: renderer.info.render.lines,
      points: renderer.info.render.points,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    },
  };
}

window.__gp = {
  get previewPaused(){ return previewPaused; },
  get previewOptions(){ return structuredClone(PREVIEW_OPTIONS); },
  get previewRuntime(){
    return {
      enabled: PREVIEW_MODE,
      lowfx: LOWFX,
      startMode: RUNNER_START_MODE,
      simConfig: { ...RUNNER_SIM_CONFIG },
      initialState: { ...RUNNER_INITIAL_STATE },
      swipeThreshold: PREVIEW_MODE && PREVIEW_OPTIONS.runner.swipe === 'easy' ? 0.022 : 0.032,
    };
  },
  get mode(){ return flow.mode; },
  get trace(){ return flow.trace.snapshot(); },
  get flow(){ return flow.snapshot(); },
  get simulation(){ return structuredClone(runnerSim.snapshot()); },
  get courseS(){ return stateS(simCurrent); },
  get dist(){ return Math.round(stateS(simCurrent)); },
  get spd(){ return stateSpeed(simCurrent); },
  get lane(){ return stateLane(simCurrent); },
  get laneTarget(){ return stateLaneTarget(simCurrent); },
  get locomotion(){ return stateLocomotion(simCurrent); },
  get state(){ return stateLocomotion(simCurrent); },
  get yRel(){ return stateY(simCurrent); },
  get slide(){ return simCurrent.slideRemaining > 0; },
  get shields(){ return stateShields(simCurrent); },
  get checkpoint(){ return stateSafePad(simCurrent); },
  get safePad(){ return stateSafePad(simCurrent); },
  get position(){ return playerPosition(); },
  get pos(){ return playerPosition(); },
  get gesture(){ return actionController.snapshot(); },
  get cueInput(){ return cueInputBuffer.snapshot(); },
  get lastAcceptedAction(){ return structuredClone(diagnostics.lastAcceptedAction); },
  get lastSimActionEvent(){ return structuredClone(diagnostics.lastSimActionEvent); },
  get lastHazardCue(){ return structuredClone(diagnostics.lastHazardCue); },
  get cue(){ return cueSnapshot(); },
  get statusTag(){ return stateTagSnapshot(); },
  get actionCounts(){ return { ...diagnostics.actionCounts }; },
  get crashCount(){ return diagnostics.crashCount; },
  get damageCount(){ return diagnostics.damageCount; },
  get recoveryCount(){ return diagnostics.recoverCount; },
  get resultsCount(){ return diagnostics.resultsCount; },
  get finishCount(){ return diagnostics.finishCount; },
  get lastRecoveryReason(){ return diagnostics.lastRecoveryReason; },
  get lastResetReason(){ return diagnostics.lastResetReason; },
  get lastEvent(){ return structuredClone(diagnostics.lastEvent); },
  get terminalSnapshot(){ return structuredClone(diagnostics.terminalSnapshot); },
  get activeScreens(){ return activeScreens(); },
  get alignment(){ return city.alignmentReport(); },
  get semanticGeometry(){ return city.semanticReport(); },
  get rivalParity(){ return rivalParityReport(); },
  get standings(){ return simCurrent.standings.map(entry => ({ ...entry })); },
  get resultsPresentation(){
    return {
      headline: $('resBig').textContent,
      rowsText: $('resRows').innerText,
      rowsHtml: $('resRows').innerHTML,
    };
  },
  get perf(){ return perfSnapshot(); },
  get hotPaths(){ return hotPathSnapshot(); },
  get visual(){ return visualSnapshot(); },
  perfReset: resetPerf,
  debugOffsetAnchor(key, delta){ return city.debugOffsetAnchor(key, delta); },
  restoreOffsetAnchor(key){ return city.restoreOffsetAnchor(key); },
  debugOffsetHazard(id, delta){ return city.debugOffsetHazard(id, delta); },
  restoreOffsetHazard(id){ return city.restoreOffsetHazard(id); },
  debugDetachAnchorOwner(key){ return city.debugDetachAnchorOwner(key); },
  restoreDetachedAnchorOwner(key){ return city.restoreDetachedAnchorOwner(key); },
  get renderedCorridor(){ return city.districts.auditCorridorSafety(); },
  debugMoveAsterRelayIntoCorridor(s){ return city.districts.debugMoveAsterRelayIntoCorridor(s); },
  restoreAsterRelay(){ return city.districts.restoreAsterRelay(); },
  debugScaleAsterRelay(scale){ return city.districts.debugScaleAsterRelay(scale); },
  restoreScaledAsterRelay(){ return city.districts.restoreScaledAsterRelay(); },
  debugMoveDistrictInstanceIntoCorridor(s){ return city.districts.debugMoveInstanceIntoCorridor(s); },
  restoreDistrictInstance(){ return city.districts.restoreMovedInstance(); },
  debugDetachDistrictDecoration(){ return city.districts.debugDetachDecoration(); },
  restoreDistrictDecoration(){ return city.districts.restoreDetachedDecoration(); },
  debugRemoveRelayPart(){ return city.districts.debugRemoveRelayPart(); },
  restoreRelayPart(){ return city.districts.restoreRelayPart(); },
  debugDetachDistrictInstanceMesh(){ return city.districts.debugDetachInstanceMesh(); },
  restoreDistrictInstanceMesh(){ return city.districts.restoreDetachedInstanceMesh(); },
  debugDecrementDistrictInstanceCount(){ return city.districts.debugDecrementInstanceCount(); },
  restoreDistrictInstanceCount(){ return city.districts.restoreInstanceCount(); },
  restoreDistrictSafetyMutations(){ return city.districts.restoreSafetyMutations(); },
  get presentation(){
    return {
      previous: presentationSummary(simPrevious),
      current: presentationSummary(simCurrent),
      rendered: presentationSummary(renderState),
      alpha: interpolationAlpha,
    };
  },
  get fixedStep(){ return fixed.state; },
  get titleHidden(){ return $('title').hidden; },
  get countHidden(){ return $('count').hidden; },
  start(){
    if(flow.mode === 'title') return flow.transition('intro', { reason: 'test-start', detail: { nextMode: RUNNER_START_MODE } });
    return false;
  },
  setFreeze(value){ FREEZE = value; },
  setAuto(value){ AUTO = Boolean(value); },
  setWarp(value){ WARP = Math.max(1, Math.min(10, value | 0)); },
  action: deterministicAction,
  cueAction(direction){
    if(!['up', 'down', 'left', 'right'].includes(direction)) return false;
    return routeCueAction(direction, 'diagnostic');
  },
  jump(){ return deterministicAction('up'); },
  slideOn(){ return deterministicAction('down'); },
  slideOff(){ return true; },
  topcam(height){ game.topCamHeight = Math.max(0, Number(height) || 0); },
  slowmo(value){ game.timescale = Math.max(0, Number(value) || 0); },
  again(){
    if(flow.mode !== 'results') return false;
    resetSimulation('test-again');
    return flow.transition('countdown', { reason: 'test-again', detail: { nextMode: RUNNER_START_MODE } });
  },
  debugSetCourseS,
  auditScreens(){
    return {
      state: auditInactiveScreenState(),
      hits: auditInactiveScreenHits({ step: 12 }),
    };
  },
};
window.__dbg = {
  camera, scene, renderer, composer, THREE, course, city, hero, rivalViews,
  fixed, actionController, fixedFrameOutput, actionDrainBuffer,
};

if(AUTO) flow.transition('intro', { reason: 'auto-start', detail: { nextMode: RUNNER_START_MODE } });
