/* PAPER WINGS - touch-first alpine gate racing. */
import * as THREE from 'three';
import { createPipeline } from '../../engine/post.js';
import { createFixedStepRunner } from '../../engine/fixed-step.js';
import * as SFX from '../../engine/sfx.js';
import { CONTROL_ORB_RADIUS, createWingTwoPointerController } from './action.js';
import { createMissionAutopilot, nextMissionAutopilot } from './autopilot.js';
import { applyMissionResult } from './campaign.js';
import { createFlightState, flightSnapshot, flightStanding, FLIGHT_STATUS, startFlight, stepFlight } from './flight.js';
import { createWingFlowState, reduceWingFlow, WING_FLOW_ACTION, wingFlowSnapshot } from './flow.js';
import { WING_MISSION_IDS, WING_MISSIONS } from './missions.js';
import { createWingRoute } from './route.js';
import { buildAlpineWorld } from './scene.js';
import { parseStoredSharedOptions } from './options.js';
import { createWingsPresentation } from './presentation.js';
import { createCampaignProgressStore } from './progress-store.js';
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
const previewOptions = readPreviewOptions();
const options = Object.freeze({
  route: enumOption('wingsRoute', ['quick', 'full'], stored.wingsRoute || previewOptions.wings.route),
  control: enumOption('wingsControl', ['guided', 'direct'], stored.wingsControl || previewOptions.wings.control),
  race: enumOption('wingsRace', ['solo', 'rivals'], stored.wingsRace || previewOptions.wings.race),
  mission: enumOption('wingsMission', WING_MISSION_IDS, stored.wingsMission || previewOptions.wings.mission),
  loadout: enumOption('wingsLoadout', ['balanced', 'racer', 'stunt', 'guardian'], stored.wingsLoadout || previewOptions.wings.loadout),
  sound: enumOption('sound', ['on', 'off'], ['on', 'off'].includes(stored.sound) ? stored.sound : 'on'),
  quality: enumOption('quality', ['auto', 'performance'], stored.quality === 'performance' ? 'performance' : 'auto'),
  preview: params.get('preview') === '1',
  auto: params.has('auto'),
  fast: params.has('fast'),
});
// Preserve links from the shipped gate racer without weakening authored
// campaign objectives to fit its six-gate route.
const legacyGateMode = params.has('wingsRoute') && !params.has('wingsMission');
const lowfx = options.quality === 'performance' || params.has('lowfx');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const route = createWingRoute(legacyGateMode ? options.route : 'full');

function campaignStorage(){
  try { return localStorage; }
  catch { return null; }
}

const progressStore = createCampaignProgressStore({ storage: campaignStorage(), catalog: WING_MISSIONS });
let campaignState = progressStore.load().state;
let wingFlow = createWingFlowState();
let selectedMissionId = campaignState.unlockedMissionIds.includes(options.mission)
  ? options.mission
  : campaignState.unlockedMissionIds[0] || WING_MISSION_IDS[0];
let flight = createFlightState(route, legacyGateMode ? options : { ...options, missionId: selectedMissionId });
let missionAutopilot = legacyGateMode ? null : createMissionAutopilot(selectedMissionId);
const action = createWingTwoPointerController({
  control: options.control,
  dragSpan: CONTROL_ORB_RADIUS,
  viewportWidth: Math.max(1, window.innerWidth),
  actionContext: 'race',
});
const presentation = createWingsPresentation({ root: document });

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
const world = buildAlpineWorld(scene, camera, route, {
  lowfx,
  race: options.race,
  reducedMotion,
  missionId: selectedMissionId,
});

const screens = ['title', 'campaign', 'briefing', 'countdown', 'results'];
let legacyMode = 'title';
let previewPaused = false;
let modeTime = 0;
let transitionSequence = 0;
let statusTimer = 0;
let countdownIndex = 0;
let countdownTimer = 0;
let terminalTimer = 0;
let lastFlightEventSequence = 0;
let pendingTerminal = null;
let resultPersisted = false;
let lastProgressSave = null;
let phaseOverlayTimer = 0;
let stuntCueTimer = 0;
let stuntCue = { label: '', points: 0 };
let statusMessage = '';
let manualStunt = null;
let manualStuntSequence = 0;
let branchPreference = options.loadout === 'racer' ? 'shortcut' : 'safe';
const processedMissionEventIds = new Set();
const commandCounts = Object.create(null);
let commandEvidenceSequence = 0;
let lastCommandEdges = Object.freeze([]);
let lastFlightCommand = Object.freeze({});
let lastCommandSource = 'initial';
const completedStuntKinds = new Set();
const SCENE_SNAPSHOT_INTERVAL_MS = 1000 / 30;
const HUD_PRESENTATION_INTERVAL_MS = 1000 / 15;
let cachedFlightSnapshot = null;
let flightSnapshotDirty = true;
let flightSnapshotRefreshForced = true;
let lastFlightSnapshotRefreshAt = -Infinity;
let flightSnapshotRefreshCount = 0;
let presentationRevision = 0;
let cachedPresentationMode = null;
let cachedPresentationInput = null;
let renderedPresentationInput = null;
let presentationDirty = true;
let presentationRefreshForced = true;
let lastPresentationRefreshAt = -Infinity;
let presentationRefreshCount = 0;
let cachedCampaignRevision = -1;
let cachedCampaignDiagnostics = null;

const EMPTY_COMMAND = Object.freeze({});
const EMPTY_EVENTS = Object.freeze([]);

function cloneAndFreezeModel(value){
  if(value === null || typeof value !== 'object') return value;
  if(Array.isArray(value)) return Object.freeze(value.map(cloneAndFreezeModel));
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneAndFreezeModel(child)]),
  ));
}

function sameModel(left, right){
  if(Object.is(left, right)) return true;
  if(!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if(Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if(leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => Object.hasOwn(right, key) && sameModel(left[key], right[key]));
}

function invalidatePresentation(force = true){
  presentationDirty = true;
  if(force) presentationRefreshForced = true;
}

function markFlightChanged(force = true){
  flightSnapshotDirty = true;
  if(force) flightSnapshotRefreshForced = true;
  invalidatePresentation(force);
}

function requestImmediateRefresh(){
  flightSnapshotDirty = true;
  flightSnapshotRefreshForced = true;
  invalidatePresentation(true);
}

function currentFlightSnapshot(now = performance.now(), force = false){
  const due = now - lastFlightSnapshotRefreshAt >= SCENE_SNAPSHOT_INTERVAL_MS;
  if(!cachedFlightSnapshot || force || (flightSnapshotDirty && (flightSnapshotRefreshForced || due))){
    cachedFlightSnapshot = flightSnapshot(flight);
    flightSnapshotDirty = false;
    flightSnapshotRefreshForced = false;
    lastFlightSnapshotRefreshAt = now;
    flightSnapshotRefreshCount += 1;
  }
  return cachedFlightSnapshot;
}

function diagnosticFlightSnapshot(){
  return flightSnapshot(flight);
}

function setScreen(id, active){
  const element = $(id);
  element.hidden = !active;
  element.inert = !active;
  element.setAttribute('aria-hidden', String(!active));
}

function showOnlyScreen(id = null){
  screens.forEach(screenId => setScreen(screenId, screenId === id));
}

function campaignPresentation(){
  return {
    selectedMissionId,
    unlockedMissionIds: [...campaignState.unlockedMissionIds],
    completedMissionIds: [...campaignState.completedMissionIds],
    totalStars: campaignState.totalStars,
    missionStars: Object.fromEntries(WING_MISSION_IDS.map(id => [id, campaignState.missions[id]?.bestStars || 0])),
  };
}

function legacyModeForFlow(flowMode){
  return flowMode === 'play' ? 'flight' : flowMode;
}

function activeMode(){
  return legacyGateMode ? legacyMode : legacyModeForFlow(wingFlow.mode);
}

function noteModeTransition(previous, next){
  if(previous !== next){
    modeTime = 0;
    transitionSequence += 1;
  }
  requestImmediateRefresh();
}

function renderNavigation(nextMode = activeMode(), force = false){
  return renderPresentation(nextMode, force);
}

function setLegacyMode(next, reason = 'game-flow'){
  if(!legacyGateMode) return false;
  const previous = legacyMode;
  legacyMode = next;
  noteModeTransition(previous, next);
  renderNavigation(next, true);
  if(!['flight', 'recovery'].includes(next)) cancelInput(reason);
  return true;
}

function dispatchFlow(event){
  const previousMode = activeMode();
  const next = reduceWingFlow(wingFlow, event, { campaign: campaignState, catalog: WING_MISSIONS });
  const accepted = next.lastDecision?.accepted === true;
  wingFlow = next;
  if(next.signals.some(signal => signal.type === 'cancel-pointers')){
    cancelInput(next.signals.at(-1)?.reason || event.type);
    wingFlow = reduceWingFlow(wingFlow, { type: WING_FLOW_ACTION.ACK_SIGNALS }, { campaign: campaignState, catalog: WING_MISSIONS });
  }
  if(accepted){
    if(legacyGateMode) setLegacyMode(legacyModeForFlow(wingFlow.mode), event.reason || event.type);
    else {
      const nextMode = activeMode();
      noteModeTransition(previousMode, nextMode);
      renderNavigation(nextMode, true);
      if(!['flight', 'recovery'].includes(nextMode)) cancelInput(event.reason || event.type);
    }
  }
  return accepted;
}

function transition(next, reason = 'game-flow'){
  if(next === 'flight') return dispatchFlow({
    type: wingFlow.mode === 'recovery' ? WING_FLOW_ACTION.COMPLETE_RECOVERY : WING_FLOW_ACTION.COUNTDOWN_COMPLETE,
    reason,
  });
  if(next === 'recovery') return dispatchFlow({ type: WING_FLOW_ACTION.BEGIN_RECOVERY, reason });
  if(next === 'briefing' && activeMode() === 'title'){
    dispatchFlow({ type: WING_FLOW_ACTION.OPEN_CAMPAIGN, reason });
    return dispatchFlow({ type: WING_FLOW_ACTION.SELECT_MISSION, missionId: selectedMissionId, reason });
  }
  return legacyGateMode ? setLegacyMode(next, reason) : false;
}

const GUARDIAN_ACTION_CONTEXT = Object.freeze({ id: 'guardian', tap: 'fire', hold: 'shield' });
const GUARDIAN_CONTEXT_ACTION_CONTEXT = Object.freeze({ id: 'guardian-context', tap: 'context', hold: 'shield' });
const COMBAT_THREAT_ACTION_CONTEXT = Object.freeze({ id: 'combat-threat', tap: 'fire', hold: 'shield' });

function baseActionContextForMission(missionId){
  const base = missionId === 'mountain-rescue' ? 'rescue'
    : missionId === 'storm-escape' ? 'defense'
      : ['target-run', 'ace-pursuit', 'skybreaker-finale'].includes(missionId) ? 'combat'
        : 'race';
  if(options.loadout !== 'guardian' || ['defense', 'rescue'].includes(base)) return base;
  return base === 'combat' ? GUARDIAN_ACTION_CONTEXT : GUARDIAN_CONTEXT_ACTION_CONTEXT;
}

function upcomingThreat(){
  if(legacyGateMode || !['storm-escape', 'skybreaker-finale'].includes(flight.missionId || selectedMissionId)) return null;
  if(!['flight', 'recovery'].includes(activeMode()) || pendingTerminal) return null;
  const encountered = flight.encounteredVolumeIds || [];
  return route.volumes.hazards.find(entry => !encountered.includes(entry.id)
    && entry.s >= flight.s - 1 && entry.s - flight.s <= 48) || null;
}

function actionContextForMission(missionId){
  const base = baseActionContextForMission(missionId);
  if(!upcomingThreat()) return base;
  if(base === 'combat') return COMBAT_THREAT_ACTION_CONTEXT;
  return base;
}

let appliedActionContextKey = '';
function syncActionContext(force = false){
  const context = actionContextForMission(selectedMissionId);
  const key = typeof context === 'string' ? context : `${context.id}:${context.tap}:${context.hold}`;
  if(!force && key === appliedActionContextKey) return false;
  if(!force && appliedActionContextKey){
    const actionPointerId = action.snapshot().actionPointerId;
    if(actionPointerId !== null){
      action.cancelPointer(actionPointerId, 'action-context-change');
      releaseCapturedPointer(actionPointerId);
      lastInputEndReason = 'action-context-change';
    }
  }
  action.setContext(context);
  appliedActionContextKey = key;
  invalidatePresentation();
  return true;
}

function resetMission(reason = 'mission-reset'){
  resetInput(reason);
  flight = createFlightState(route, legacyGateMode ? options : { ...options, missionId: selectedMissionId });
  missionAutopilot = legacyGateMode ? null : createMissionAutopilot(selectedMissionId);
  appliedActionContextKey = '';
  syncActionContext(true);
  world.loadMission(selectedMissionId);
  lastFlightEventSequence = flight.eventSequence;
  pendingTerminal = null;
  resultPersisted = false;
  lastProgressSave = null;
  phaseOverlayTimer = 0;
  stuntCueTimer = 0;
  stuntCue = { label: '', points: 0 };
  statusTimer = 0;
  statusMessage = '';
  manualStunt = null;
  branchPreference = options.loadout === 'racer' ? 'shortcut' : 'safe';
  completedStuntKinds.clear();
  processedMissionEventIds.clear();
  lastCommandEdges = Object.freeze([]);
  lastFlightCommand = Object.freeze({});
  lastCommandSource = 'reset';
  markFlightChanged();
}

function resetForCountdown(reason = 'new-flight'){
  resetMission(reason);
  countdownIndex = 0;
  countdownTimer = 0;
  $('countValue').textContent = '3';
  $('countLabel').textContent = options.control === 'guided' ? 'Hold the line' : 'Fly your line';
  invalidatePresentation();
  if(wingFlow.mode === 'briefing') dispatchFlow({ type: WING_FLOW_ACTION.CONFIRM_BRIEFING, reason });
}

function beginActualFlight(){
  startFlight(flight);
  markFlightChanged();
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
  invalidatePresentation();
  if(!soundMuted) SFX.beep(countdownIndex >= 3);
  if(countdownIndex >= 3) beginActualFlight();
}

function flashStatus(message, seconds = 0.85){
  statusMessage = message;
  $('flightStatus').textContent = message;
  $('flightStatus').classList.add('show');
  statusTimer = seconds;
  invalidatePresentation();
}

function terminalFlightResult(){
  if(flight.result) return flight.result;
  return {
    missionId: selectedMissionId,
    completed: flight.status === FLIGHT_STATUS.FINISHED,
    outcome: flight.status === FLIGHT_STATUS.FINISHED ? 'success' : 'failure',
    reason: flight.status === FLIGHT_STATUS.FINISHED ? 'route-complete' : 'route-failed',
    timeMs: Math.round((flight.finishTime ?? flight.time) * 1000),
    score: flight.score || 0,
    bestCombo: flight.bestCombo || 0,
    rank: flight.rank,
    gatesPassed: flight.gatesPassed,
    misses: flight.misses,
    energy: flight.energy || 0,
    integrity: flight.integrity || 0,
    completedObjectiveIds: [],
    optionalCompleted: 0,
    optionalTotal: 0,
  };
}

function starsForResult(result){
  if(result?.completed !== true) return 0;
  let stars = 1;
  if(result.misses === 0 || result.rank === 1) stars += 1;
  if(result.optionalTotal > 0 && result.optionalCompleted >= result.optionalTotal) stars += 1;
  else if(result.integrity >= 2 || result.energy >= 50) stars += 1;
  return Math.min(3, stars);
}

function flowResultEvent(type, result = terminalFlightResult()){
  return {
    type,
    reason: result.reason,
    score: result.score,
    stars: starsForResult(result),
    timeMs: result.timeMs,
    combo: result.bestCombo,
    completedObjectiveIds: result.completedObjectiveIds,
  };
}

function beginTerminal(outcome, reason){
  if(pendingTerminal) return false;
  const result = terminalFlightResult();
  pendingTerminal = {
    outcome,
    reason: reason || result.reason,
    result,
    shown: false,
  };
  cancelInput(`terminal-${outcome}`);
  terminalTimer = options.fast ? 0.32 : outcome === 'success' ? 1.4 : 1.25;
  if(outcome === 'failure'){
    if(['play', 'recovery'].includes(wingFlow.mode)) dispatchFlow(flowResultEvent(WING_FLOW_ACTION.MISSION_FAIL, result));
    else if(legacyGateMode) setLegacyMode('fail', reason);
    if(!soundMuted) SFX.thump(100, 0.28, 0.18, -50);
  } else {
    if(legacyGateMode) setLegacyMode('finish', reason);
    else flashStatus('Route clear', terminalTimer);
    if(!soundMuted) SFX.fanfare([523, 659, 784, 1046]);
  }
  invalidatePresentation();
  return true;
}

function handleMissionPresentationEvent(event){
  if(event.type === 'phase-changed'){
    const label = String(event.to || '').replaceAll('-', ' ').toUpperCase();
    dispatchFlow({ type: WING_FLOW_ACTION.PHASE_CHANGE, phaseId: event.to, label });
    phaseOverlayTimer = options.fast ? 0.18 : 1.1;
    flashStatus(label, phaseOverlayTimer);
  } else if(event.type === 'thermal-entered'){
    flashStatus('Thermal lift', 0.7);
    if(!soundMuted) SFX.sweep({ f0: 420, f1: 1180, dur: 0.25, vol: 0.08 });
  } else if(event.type === 'rescue-completed'){
    flashStatus('Climber located', 0.9);
    if(!soundMuted) SFX.notify();
  } else if(event.type === 'precision-drop'){
    flashStatus('Supply drop delivered', 0.9);
    if(!soundMuted) SFX.blip(1120, 0.16, 'triangle', 0.14, 240);
  } else if(event.type === 'stunt-completed'){
    if(typeof event.kind === 'string') completedStuntKinds.add(event.kind);
    stuntCue = {
      label: String(event.kind || 'stunt').replaceAll('-', ' ').toUpperCase(),
      points: flight.stunts?.lastResult?.score || 0,
    };
    stuntCueTimer = 1.05;
    if(!soundMuted) SFX.sweep({ f0: 520, f1: 1460, dur: 0.22, vol: 0.1 });
  } else if(event.type === 'target-destroyed'){
    flashStatus('Target folded', 0.55);
    if(!soundMuted) SFX.thump(180, 0.1, 0.1, -40);
  } else if(event.type === 'boss-phase'){
    flashStatus('Skybreaker phase broken', 1.0);
    if(!soundMuted) SFX.sweep({ f0: 240, f1: 980, dur: 0.34, vol: 0.12 });
  } else if(event.type === 'boss-destroyed'){
    flashStatus('Skybreaker exposed', 1.1);
    if(!soundMuted) SFX.fanfare([392, 523, 659]);
  } else if(event.type === 'hazard-blocked'){
    flashStatus('Shield held', 0.65);
    if(!soundMuted) SFX.blip(720, 0.12, 'sine', 0.12, 260);
  } else if(event.type === 'hazard-hit'){
    flashStatus('Paper torn', 0.8);
    if(!soundMuted) SFX.thump(120, 0.18, 0.15, -50);
  } else if(event.type === 'projectile-fired' && !soundMuted){
    SFX.blip(760, 0.06, 'triangle', 0.07, 220);
  }
}

function drainMissionEvents(dt){
  if(legacyGateMode || !Array.isArray(flight.eventBuffer)) return EMPTY_EVENTS;
  const fresh = flight.eventBuffer.filter(event => !processedMissionEventIds.has(event.id));
  for(const event of fresh){
    processedMissionEventIds.add(event.id);
    handleMissionPresentationEvent(event);
  }
  if(processedMissionEventIds.size > 256){
    const retained = flight.eventBuffer.slice(-96).map(event => event.id);
    processedMissionEventIds.clear();
    for(const id of retained) processedMissionEventIds.add(id);
  }
  if(!fresh.length) return EMPTY_EVENTS;
  world.syncEvents(fresh, flight.time, dt);
  return Object.freeze(fresh.map(event => Object.freeze({ ...event })));
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
    beginTerminal('success', 'route-complete');
  } else if(flight.event === 'failed'){
    beginTerminal('failure', flight.result?.reason || 'miss-limit');
  }
}

function formatTime(seconds){
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

function words(value){
  return String(value || '').replaceAll('-', ' ').toUpperCase();
}

function currentObjective(){
  const objectives = Object.values(flight.objectives?.objectives || {});
  return objectives.find(objective => objective.status === 'active')
    || [...objectives].reverse().find(objective => objective.status === 'completed')
    || null;
}

function nextUnlockedMissionId(){
  const index = WING_MISSION_IDS.indexOf(selectedMissionId);
  for(let cursor = index + 1; cursor < WING_MISSION_IDS.length; cursor += 1){
    if(campaignState.unlockedMissionIds.includes(WING_MISSION_IDS[cursor])) return WING_MISSION_IDS[cursor];
  }
  return null;
}

function resultRank(result){
  if(!result?.completed) return 'D';
  const mission = WING_MISSIONS.find(entry => entry.id === selectedMissionId);
  if(result.score >= mission.medalScores.gold) return 'S';
  if(result.score >= mission.medalScores.silver) return 'A';
  if(result.score >= mission.medalScores.bronze) return 'B';
  return 'C';
}

function completedChallenge(label, complete){
  return Object.freeze({ label, complete: complete === true });
}

function destroyedTargetCount(){
  return (flight.combat?.targets || []).filter(target => target.status === 'destroyed').length;
}

function shortcutCount(){
  const choices = flight.routeTraversal?.branchChoices || {};
  return route.forks.reduce((count, fork) => count + (
    choices[fork.id] && choices[fork.id] !== fork.safeBranchId ? 1 : 0
  ), 0);
}

function encounteredVolumeCount(kind){
  const ids = new Set(flight.encounteredVolumeIds || []);
  return (route.volumes?.[kind] || []).filter(volume => ids.has(volume.id)).length;
}

function resolvedRescueCount(type){
  const records = flight.rescue?.entities || [];
  if(records.length){
    return records.filter(record => record.resolved === true && (
      type === 'drop' ? record.type === 'drop-zone' || String(record.id).startsWith('drop-')
        : record.type === 'pickup' || String(record.id).startsWith('rescue-')
    )).length;
  }
  return (flight.resolvedActionIds || []).filter(id => String(id).startsWith(`${type === 'drop' ? 'drop' : 'rescue'}-`)).length;
}

function missionChallenges(result){
  const completed = result.completed === true;
  const cleanRoute = completed && result.gatesPassed >= route.gates.length;
  const bestScoreChain = Math.max(flight.scoring?.bestCombo || 0, result.bestCombo || 0);
  if(selectedMissionId === 'flight-school') return Object.freeze([
    completedChallenge(`Clear all ${route.gates.length} gates`, cleanRoute),
    completedChallenge('Ride two training thermals', encounteredVolumeCount('thermals') >= 2),
    completedChallenge('Finish with half wind', completed && result.energy >= 50),
  ]);
  if(selectedMissionId === 'ridge-race') return Object.freeze([
    completedChallenge('Finish first', completed && result.rank === 1),
    completedChallenge('Take two shortcuts', shortcutCount() >= 2),
    completedChallenge('Reach a six-action chain', bestScoreChain >= 6),
  ]);
  if(selectedMissionId === 'target-run'){
    const destroyed = destroyedTargetCount();
    const missedShots = Math.max(0, (result.shotsFired || flight.shotsFired || 0) - (result.shotsHit || flight.shotsHit || 0));
    return Object.freeze([
      completedChallenge('Tag all 12 drones', destroyed >= 12),
      completedChallenge('Clear the full route', cleanRoute),
      completedChallenge('Miss no more than two shots', destroyed >= 12 && missedShots <= 2),
    ]);
  }
  if(selectedMissionId === 'stunt-trial') return Object.freeze([
    completedChallenge('Land three stunt types', completedStuntKinds.size >= 3),
    completedChallenge('Reach a ten-stunt chain', (flight.stunts?.bestChain || 0) >= 10),
    completedChallenge('Clear three proximity ribbons', encounteredVolumeCount('proximity') >= 3),
  ]);
  if(selectedMissionId === 'mountain-rescue') return Object.freeze([
    completedChallenge('Rescue every climber', resolvedRescueCount('rescue') >= 3),
    completedChallenge('Make three precision drops', resolvedRescueCount('drop') >= 3),
    completedChallenge('Take no hull damage', completed && (flight.aero?.unshieldedHits || 0) === 0),
  ]);
  if(selectedMissionId === 'storm-escape') return Object.freeze([
    completedChallenge('Reach the safe pass', completed),
    completedChallenge('Block four storm strikes', (flight.aero?.shieldHits || 0) >= 4),
    completedChallenge('Keep one shield pip', completed && result.integrity >= 1),
  ]);
  if(selectedMissionId === 'ace-pursuit') return Object.freeze([
    completedChallenge('Catch the Ace', completed && flight.combat?.boss?.status === 'destroyed'),
    completedChallenge('Break all three weak points', destroyedTargetCount() >= 3),
    completedChallenge('Finish a twelve-action chain', bestScoreChain >= 12),
  ]);
  return Object.freeze([
    completedChallenge('Break Skybreaker', completed && flight.combat?.boss?.status === 'destroyed'),
    completedChallenge('Clear every tower lock', destroyedTargetCount() >= 3),
    completedChallenge('Finish with a shield pip', completed && result.integrity >= 1),
  ]);
}

function threatView(){
  if(!['flight', 'recovery'].includes(activeMode())) return { visible: false };
  const hazard = upcomingThreat();
  return hazard
    ? { visible: true, label: `${words(hazard.kind)} INBOUND`, tone: hazard.damage >= 0.2 ? 'danger' : 'warning' }
    : { visible: false };
}

function actionView(){
  const snapshot = action.snapshot();
  const context = snapshot.actionContext;
  const activeType = snapshot.telegraph?.type || (snapshot.held.shield ? 'shield' : snapshot.held.boost ? 'boost' : null);
  if(activeType) return {
    label: activeType.toUpperCase(),
    hint: snapshot.telegraph?.armed ? 'ACTIVE' : 'HOLD',
    state: snapshot.telegraph?.armed || snapshot.held[activeType] ? 'active' : 'ready',
    enabled: ['flight', 'recovery'].includes(activeMode()) && !wingFlow.paused,
  };
  const enabled = ['flight', 'recovery'].includes(activeMode()) && !wingFlow.paused;
  if(upcomingThreat() && context.hold === 'shield') return { label: 'SHIELD', hint: 'HOLD', state: 'ready', enabled };
  if(selectedMissionId === 'stunt-trial') return { label: 'STUNT', hint: 'FLICK', state: 'ready', enabled: activeMode() === 'flight' };
  if(context.tap === 'fire') return { label: 'FIRE', hint: 'TAP', state: 'ready', enabled };
  if(selectedMissionId === 'mountain-rescue') return { label: 'RESCUE', hint: 'TAP', state: 'ready', enabled };
  return { label: context.hold.toUpperCase(), hint: 'HOLD', state: 'ready', enabled };
}

function buildPresentationInput(nextMode = activeMode()){
  const objective = currentObjective();
  const standing = flightStanding(flight, route);
  const gate = route.gates[Math.min(flight.gateIndex, route.gates.length - 1)];
  const boss = flight.combat?.boss;
  const result = pendingTerminal?.result || terminalFlightResult();
  const success = result.completed === true;
  return {
    mode: nextMode,
    missionId: selectedMissionId,
    objective: objective ? {
      label: words(objective.kind),
      detail: words(flight.phaseId || objective.phaseId),
      current: objective.progress,
      total: objective.target,
    } : {
      label: legacyGateMode ? 'CLEAR THE ROUTE' : 'MISSION READY',
      detail: legacyGateMode ? `${flight.gatesPassed} OF ${route.gates.length} GATES` : words(flight.phaseId || 'awaiting launch'),
      current: flight.gatesPassed,
      total: route.gates.length,
    },
    metric: {
      label: boss?.status === 'active' ? 'BOSS' : 'TIME',
      value: boss?.status === 'active' ? `${Math.ceil(boss.hp)} HP` : formatTime(flight.time),
      bossLabel: words(boss?.kind || 'skybreaker'),
      bossCurrent: boss?.hp || 0,
      bossTotal: boss?.maxHp || 0,
    },
    time: flight.time,
    score: flight.score || 0,
    combo: Math.max(1, flight.combo || 1),
    energy: flight.energy ?? flight.aero?.energy ?? 100,
    shield: flight.integrity ?? flight.aero?.integrity ?? 3,
    speed: Math.round(flight.speed * 5.4),
    position: `${standing.rank} / ${standing.total}`,
    nextGate: gate?.name || 'FINISH LINE',
    action: actionView(),
    threat: threatView(),
    stunt: { visible: stuntCueTimer > 0, label: stuntCue.label, points: stuntCue.points },
    status: { visible: statusTimer > 0 || Boolean(wingFlow.overlay), label: wingFlow.overlay?.label || statusMessage },
    countdown: {
      value: ['3', '2', '1', 'FLY'][Math.min(countdownIndex, 3)],
      label: options.control === 'guided' ? 'HOLD THE LINE' : 'FLY YOUR LINE',
    },
    campaign: campaignPresentation(),
    results: {
      success,
      kicker: success ? (result.rank === 1 ? 'LEAGUE LEADER' : 'MISSION COMPLETE') : 'FLIGHT ENDED',
      headline: success ? (result.misses ? 'Recovered and home.' : 'Clean air.') : 'Take the line again.',
      sub: success ? 'The next mountain route is open.' : 'Your campaign progress is safe. This mission is ready to replay.',
      rank: resultRank(result),
      score: result.score,
      time: formatTime(result.timeMs / 1000),
      gates: `${result.gatesPassed} / ${route.gates.length}`,
      misses: result.misses,
      challenges: missionChallenges(result),
      nextMissionId: success ? nextUnlockedMissionId() : null,
    },
  };
}

function presentationInput(nextMode = activeMode(), force = false, now = performance.now()){
  const modeChanged = cachedPresentationMode !== nextMode;
  const due = now - lastPresentationRefreshAt >= HUD_PRESENTATION_INTERVAL_MS;
  if(!cachedPresentationInput || force || modeChanged || (presentationDirty && (presentationRefreshForced || due))){
    cachedPresentationInput = cloneAndFreezeModel(buildPresentationInput(nextMode));
    cachedPresentationMode = nextMode;
    presentationDirty = false;
    presentationRefreshForced = false;
    lastPresentationRefreshAt = now;
    presentationRevision += 1;
    presentationRefreshCount += 1;
  }
  return cachedPresentationInput;
}

function renderPresentation(nextMode = activeMode(), force = false, now = performance.now()){
  const input = presentationInput(nextMode, force, now);
  if(force || renderedPresentationInput !== input){
    presentation.render(input);
    renderedPresentationInput = input;
  }
  return presentation.snapshot;
}

function showResults(){
  if(!pendingTerminal || pendingTerminal.shown) return false;
  pendingTerminal.shown = true;
  if(pendingTerminal.outcome === 'success'){
    dispatchFlow(flowResultEvent(WING_FLOW_ACTION.MISSION_SUCCESS, pendingTerminal.result));
  } else if(wingFlow.mode === 'fail') {
    dispatchFlow({ type: WING_FLOW_ACTION.SHOW_RESULTS, reason: 'terminal-hold-complete' });
  }
  if(legacyGateMode && legacyMode !== 'results') setLegacyMode('results', 'terminal-hold-complete');
  if(!legacyGateMode && !resultPersisted && wingFlow.mode === 'results'){
    campaignState = applyMissionResult(campaignState, {
      ...pendingTerminal.result,
      stars: starsForResult(pendingTerminal.result),
      combo: pendingTerminal.result.bestCombo,
    }, WING_MISSIONS);
    lastProgressSave = progressStore.save(campaignState);
    campaignState = lastProgressSave.state;
    resultPersisted = true;
  }
  invalidatePresentation();
  renderNavigation(activeMode(), true);
  return true;
}

function autoAxes(){
  const gate = route.gates[Math.min(flight.gateIndex, route.gates.length - 1)];
  if(!gate) return { bank: 0, pitch: 0 };
  return {
    bank: THREE.MathUtils.clamp((gate.x - flight.x) / 11, -1, 1),
    pitch: THREE.MathUtils.clamp((gate.y - flight.y) / 8, -1, 1),
  };
}

const RESCUE_ACTIONS = Object.freeze([
  Object.freeze({ id: 'rescue-1', type: 'pickup', s: 140, key: 'rescueId', requires: null }),
  Object.freeze({ id: 'drop-1', type: 'drop-zone', s: 210, key: 'dropId', requires: 'rescue-1' }),
  Object.freeze({ id: 'rescue-2', type: 'pickup', s: 330, key: 'rescueId', requires: null }),
  Object.freeze({ id: 'drop-2', type: 'drop-zone', s: 390, key: 'dropId', requires: 'rescue-2' }),
  Object.freeze({ id: 'rescue-3', type: 'pickup', s: 520, key: 'rescueId', requires: null }),
  Object.freeze({ id: 'drop-3', type: 'drop-zone', s: 570, key: 'dropId', requires: 'rescue-3' }),
]);

function beginManualStunt(edgeType){
  if(manualStunt || flight.stunts?.active) return false;
  const definition = edgeType === 'roll-left' ? { kind: 'axial-roll', roll: -Math.PI * 2 / 42 }
    : edgeType === 'roll-right' ? { kind: 'axial-roll', roll: Math.PI * 2 / 42 }
      : edgeType === 'loop' ? { kind: 'inside-loop', pitch: Math.PI * 2 / 52 }
        : edgeType === 'dive-flip' ? { kind: 'outside-loop', pitch: -Math.PI * 2 / 52 }
          : null;
  if(!definition) return false;
  manualStuntSequence += 1;
  manualStunt = {
    id: `manual-stunt-${manualStuntSequence.toString(36).padStart(4, '0')}`,
    kind: definition.kind,
    rollDelta: definition.roll,
    pitchDelta: definition.pitch,
    begun: false,
  };
  return true;
}

function manualStuntCommand(){
  if(!manualStunt) return null;
  const command = {
    id: manualStunt.id,
    kind: manualStunt.kind,
    begin: !manualStunt.begun,
    quality: options.loadout === 'stunt' ? 1.2 : 1,
    rollDelta: manualStunt.rollDelta,
    pitchDelta: manualStunt.pitchDelta,
  };
  manualStunt.begun = true;
  return command;
}

const steadyTouchCommands = new Map();
function steadyTouchCommand(boost, shield, branch){
  const key = `${boost ? 1 : 0}:${shield ? 1 : 0}:${branch}`;
  if(!steadyTouchCommands.has(key)){
    steadyTouchCommands.set(key, Object.freeze({ boost: Boolean(boost), shield: Boolean(shield), branch }));
  }
  return steadyTouchCommands.get(key);
}

function rescueCommand(payload){
  const resolved = new Set(flight.resolvedActionIds || []);
  const runtime = flight.rescue?.entities || [];
  const eligible = runtime.length ? runtime.filter(entry => (
    entry.active === true
    && entry.unlocked === true
    && entry.eligible === true
    && entry.resolved !== true
    && ['pickup', 'drop-zone'].includes(entry.type)
  )) : RESCUE_ACTIONS.filter(entry => (
    !resolved.has(entry.id)
    && (!entry.requires || resolved.has(entry.requires))
    && Math.abs(flight.s - entry.s) <= 58
  ));
  const candidate = eligible
    .sort((left, right) => Math.abs(flight.s - left.s) - Math.abs(flight.s - right.s))[0];
  if(candidate) payload[candidate.type === 'drop-zone' ? 'dropId' : 'rescueId'] = candidate.id;
  else flashStatus('Find the rescue ring', 0.6);
}

function commandFromAction(input){
  let payload = null;
  const ensurePayload = () => {
    if(!payload) payload = {
      boost: input.held.boost,
      shield: input.held.shield,
      branch: branchPreference,
    };
    return payload;
  };
  for(const edge of input.commands){
    commandCounts[edge.type] = (commandCounts[edge.type] || 0) + 1;
    commandEvidenceSequence += 1;
    if(edge.type === 'fire') ensurePayload().fire = true;
    else if(edge.type === 'context'){
      if(selectedMissionId === 'mountain-rescue') rescueCommand(ensurePayload());
      else {
        branchPreference = branchPreference === 'shortcut' ? 'safe' : 'shortcut';
        ensurePayload().branch = branchPreference;
        flashStatus(branchPreference === 'shortcut' ? 'Fast line armed' : 'Safe line armed', 0.55);
      }
    } else beginManualStunt(edge.type);
  }
  const stunt = manualStuntCommand();
  if(stunt) ensurePayload().stunt = stunt;
  return payload || steadyTouchCommand(input.held.boost, input.held.shield, branchPreference);
}

function recordCommandEvidence(input, payload, source){
  const edgeChanged = input.commands.length > 0;
  if(edgeChanged) lastCommandEdges = Object.freeze(input.commands.map(edge => Object.freeze({ ...edge })));
  const normalized = payload && typeof payload === 'object' ? payload : EMPTY_COMMAND;
  const payloadChanged = !sameModel(lastFlightCommand, normalized);
  if(payloadChanged) lastFlightCommand = cloneAndFreezeModel(normalized);
  const sourceChanged = lastCommandSource !== source;
  lastCommandSource = source;
  if(source === 'autopilot') commandCounts['auto-step'] = (commandCounts['auto-step'] || 0) + 1;
  return edgeChanged || payloadChanged || sourceChanged;
}

function objectiveProgressChanged(before, after){
  if(before === after) return false;
  if(!before || !after) return before !== after;
  if(before.phaseId !== after.phaseId || before.status !== after.status) return true;
  const beforeObjectives = before.objectives || EMPTY_COMMAND;
  const afterObjectives = after.objectives || EMPTY_COMMAND;
  for(const id in afterObjectives){
    const prior = beforeObjectives[id];
    const next = afterObjectives[id];
    if(!prior || prior.progress !== next.progress || prior.status !== next.status) return true;
  }
  return false;
}

const fixedFrame = {};
const fixed = createFixedStepRunner({
  step: 1 / 120,
  maxFrame: 0.08,
  maxSteps: 10,
  onStep(dt){
    if(!['flight', 'recovery'].includes(activeMode()) || wingFlow.paused || pendingTerminal) return;
    const beforeFlightEventSequence = flight.eventSequence;
    const beforeMissionEventSequence = flight.missionEventSequence;
    const beforeObjectives = flight.objectives;
    const beforeStatus = flight.status;
    const beforeResult = flight.result;
    const beforeIntegrity = flight.integrity;
    const beforeShieldHits = flight.aero?.shieldHits;
    const beforeUnshieldedHits = flight.aero?.unshieldedHits;
    const contextChangedBefore = syncActionContext();
    const actionState = action.fixedStep(dt);
    let axes = actionState;
    let command = null;
    let source = 'touch';
    if(options.auto && legacyGateMode){
      axes = autoAxes();
      source = 'legacy-autopilot';
    } else if(options.auto){
      const output = nextMissionAutopilot(missionAutopilot, flight, route);
      missionAutopilot = output.autopilot;
      axes = output.axes;
      command = output.command;
      source = 'autopilot';
    } else if(!legacyGateMode){
      command = commandFromAction(actionState);
    }
    const commandChanged = recordCommandEvidence(actionState, command, source);
    stepFlight(flight, dt, axes, route, command);
    const contextChangedAfter = syncActionContext();
    const significantChange = commandChanged
      || contextChangedBefore
      || contextChangedAfter
      || flight.eventSequence !== beforeFlightEventSequence
      || flight.missionEventSequence !== beforeMissionEventSequence
      || flight.status !== beforeStatus
      || flight.result !== beforeResult
      || flight.integrity !== beforeIntegrity
      || flight.aero?.shieldHits !== beforeShieldHits
      || flight.aero?.unshieldedHits !== beforeUnshieldedHits
      || objectiveProgressChanged(beforeObjectives, flight.objectives);
    markFlightChanged(significantChange);
    if(manualStunt && !flight.stunts?.active
      && [flight.stunts?.lastResult?.id, ...(flight.stunts?.failedStuntIds || [])].includes(manualStunt.id)) manualStunt = null;
    drainMissionEvents(dt);
    handleFlightEvent();
  },
});

const capturedPointers = new Map();
let orbPointer = null;
let orbX = 0;
let orbY = 0;
let inputSequence = 0;
let inputSamples = 0;
let lastInputEndReason = 'initial';
function clearPointerUi(){
  orbPointer = null;
  $('controlOrb').classList.remove('active');
  $('controlDot').style.transform = 'translate3d(0,0,0)';
}

function releaseCapturedPointer(pointerId){
  const target = capturedPointers.get(pointerId);
  capturedPointers.delete(pointerId);
  try {
    if(target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
  } catch {}
}

function releaseAllCapturedPointers(){
  for(const pointerId of [...capturedPointers.keys()]) releaseCapturedPointer(pointerId);
}

function releasePointer(reason = 'release'){
  action.cancelAll(reason);
  lastInputEndReason = reason;
  releaseAllCapturedPointers();
  clearPointerUi();
  invalidatePresentation(true);
}
function cancelInput(reason = 'cancel'){
  action.cancelAll(reason);
  lastInputEndReason = reason;
  releaseAllCapturedPointers();
  clearPointerUi();
  invalidatePresentation(true);
}
function resetInput(reason = 'reset'){
  action.reset(reason);
  inputSamples = 0;
  lastInputEndReason = reason;
  releaseAllCapturedPointers();
  clearPointerUi();
  invalidatePresentation(true);
}

function updateSteeringUi(event){
  const dx = event.clientX - orbX;
  const dy = event.clientY - orbY;
  const distance = Math.hypot(dx, dy);
  const scale = distance > CONTROL_ORB_RADIUS ? CONTROL_ORB_RADIUS / distance : 1;
  $('controlDot').style.transform = `translate3d(${dx * scale}px,${dy * scale}px,0)`;
}

function pointerDown(event){
  if(!['flight', 'recovery'].includes(activeMode()) || wingFlow.paused || previewPaused || options.auto) return;
  if(!action.begin(event.pointerId, event.clientX, event.clientY)) return;
  invalidatePresentation(true);
  event.preventDefault();
  inputSequence += 1;
  inputSamples += 1;
  lastInputEndReason = null;
  const target = event.currentTarget;
  capturedPointers.set(event.pointerId, target);
  const snapshot = action.snapshot();
  if(snapshot.steeringPointerId === event.pointerId){
    orbPointer = event.pointerId;
    orbX = event.clientX;
    orbY = event.clientY;
    $('controlOrb').style.left = `${orbX}px`;
    $('controlOrb').style.top = `${orbY}px`;
    $('controlOrb').classList.add('active');
  }
  try { target.setPointerCapture?.(event.pointerId); }
  catch {
    action.cancelPointer(event.pointerId, 'capture-failed');
    capturedPointers.delete(event.pointerId);
    if(event.pointerId === orbPointer) clearPointerUi();
  }
}

function pointerMove(event){
  const snapshot = action.snapshot();
  if(![snapshot.steeringPointerId, snapshot.actionPointerId].includes(event.pointerId)) return;
  event.preventDefault();
  if(action.move(event.pointerId, event.clientX, event.clientY)) invalidatePresentation(false);
  inputSamples += 1;
  if(event.pointerId === orbPointer) updateSteeringUi(event);
}

function pointerEnd(event){
  const endedSteering = event.pointerId === orbPointer;
  if(action.end(event.pointerId, 'pointerup')) invalidatePresentation(true);
  lastInputEndReason = 'pointerup';
  releaseCapturedPointer(event.pointerId);
  if(endedSteering) clearPointerUi();
}

function pointerCancel(event, reason = 'pointercancel'){
  const endedSteering = event.pointerId === orbPointer;
  if(action.cancelPointer(event.pointerId, reason)) invalidatePresentation(true);
  lastInputEndReason = reason;
  releaseCapturedPointer(event.pointerId);
  if(endedSteering) clearPointerUi();
}

for(const target of [$('gl'), $('actionButton')]){
  target.addEventListener('pointerdown', pointerDown, { passive: false });
  target.addEventListener('pointermove', pointerMove, { passive: false });
  target.addEventListener('pointerup', pointerEnd, { passive: false });
  target.addEventListener('pointercancel', pointerCancel, { passive: false });
  target.addEventListener('lostpointercapture', event => {
    if(capturedPointers.has(event.pointerId)) pointerCancel(event, 'lostpointercapture');
  });
}
window.addEventListener('blur', () => cancelInput('window-blur'));
window.addEventListener('orientationchange', () => cancelInput('orientationchange'));
window.addEventListener('resize', () => action.setViewportWidth(Math.max(1, window.innerWidth)));
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'hidden') cancelInput('visibility-hidden');
});

function chooseMapMission(missionId){
  if(!campaignState.unlockedMissionIds.includes(missionId)) return false;
  selectedMissionId = missionId;
  invalidatePresentation();
  renderNavigation(activeMode(), true);
  return true;
}

$('beginButton').addEventListener('click', () => {
  unlockSound();
  if(!dispatchFlow({ type: WING_FLOW_ACTION.OPEN_CAMPAIGN, reason: 'title-start' })) return;
  if(legacyGateMode){
    dispatchFlow({ type: WING_FLOW_ACTION.SELECT_MISSION, missionId: selectedMissionId, reason: 'legacy-briefing' });
    resetMission('legacy-briefing');
    renderNavigation(activeMode(), true);
  }
});
for(const missionButton of document.querySelectorAll('[data-mission-id]')){
  missionButton.addEventListener('click', () => chooseMapMission(missionButton.dataset.missionId));
}
$('selectMissionButton').addEventListener('click', () => {
  unlockSound();
  if(!dispatchFlow({ type: WING_FLOW_ACTION.SELECT_MISSION, missionId: selectedMissionId, reason: 'map-selection' })) return;
  resetMission('mission-selected');
  renderNavigation(activeMode(), true);
});
$('flightButton').addEventListener('click', () => {
  unlockSound();
  resetForCountdown('briefing-complete');
});
$('replayButton').addEventListener('click', () => {
  unlockSound();
  if(!dispatchFlow({ type: WING_FLOW_ACTION.REPLAY, reason: 'replay' })) return;
  if(legacyGateMode) resetForCountdown('legacy-replay');
  else resetMission('replay');
  renderNavigation(activeMode(), true);
});
$('nextMissionButton').addEventListener('click', event => {
  unlockSound();
  const missionId = event.currentTarget.dataset.missionId || null;
  if(!dispatchFlow({ type: WING_FLOW_ACTION.NEXT, missionId, reason: 'next-mission' })) return;
  selectedMissionId = wingFlow.activeMissionId;
  resetMission('next-mission');
  renderNavigation(activeMode(), true);
});
$('missionSelectButton').addEventListener('click', () => {
  dispatchFlow({ type: WING_FLOW_ACTION.MAP, reason: 'mission-map' });
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
    options: previewOptions,
    onOpenChange(open){
      previewPaused = open;
      if(open){
        cancelInput('preview-menu-open');
        fixed.setSimulating(false);
        dispatchFlow({ type: WING_FLOW_ACTION.PAUSE, reason: 'preview-menu-open' });
      } else if(wingFlow.paused) {
        dispatchFlow({ type: WING_FLOW_ACTION.RESUME, reason: 'preview-menu-close' });
      }
    },
    onSoundChange(value){
      setSound(value === 'off');
      if(value === 'on') unlockSound();
    },
  });
}
renderNavigation(activeMode(), true);

const perf = { frames: 0, totalMs: 0, maxMs: 0, droppedTime: 0 };
let previous = performance.now();
let totalTime = 0;
let lastWorldSnapshot = null;
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

  if(activeMode() === 'countdown') tickCountdown(dt);
  if(pendingTerminal && !pendingTerminal.shown){
    terminalTimer -= dt;
    if(terminalTimer <= 0) showResults();
  }
  if(statusTimer > 0){
    statusTimer -= dt;
    if(statusTimer <= 0){
      statusMessage = '';
      $('flightStatus').classList.remove('show');
      invalidatePresentation();
    }
  }
  if(stuntCueTimer > 0){
    stuntCueTimer = Math.max(0, stuntCueTimer - dt);
    if(stuntCueTimer === 0) invalidatePresentation();
  }
  if(phaseOverlayTimer > 0){
    phaseOverlayTimer -= dt;
    if(phaseOverlayTimer <= 0 && wingFlow.overlay){
      dispatchFlow({ type: WING_FLOW_ACTION.DISMISS_OVERLAY, reason: 'phase-overlay-complete' });
    }
  }

  const simulating = ['play', 'recovery'].includes(wingFlow.mode)
    && [FLIGHT_STATUS.FLYING, FLIGHT_STATUS.RECOVERING].includes(flight.status)
    && !wingFlow.paused
    && !pendingTerminal;
  fixed.setSimulating(simulating);
  const fixedResult = fixed.advanceInto(dt, {
    simulate: simulating,
    timeScale: options.auto && options.fast ? 4 : 1,
  }, fixedFrame);
  perf.droppedTime += fixedResult.dropped;

  const currentMode = activeMode();
  const snapshot = currentFlightSnapshot(now);
  if(['title', 'campaign', 'briefing'].includes(currentMode)) world.stageTitle(totalTime);
  else world.updateFlight(flight, totalTime, dt);
  if(snapshot !== lastWorldSnapshot){
    world.syncPresentation(snapshot, { time: totalTime, dt });
    lastWorldSnapshot = snapshot;
  }
  renderPresentation(currentMode, false, now);

  if(wind) wind.set(simulating ? 0.5 + flight.speed / 55 : 0.12, 0.035, 620 + flight.speed * 26);

  grade.uniforms.uTime.value = totalTime;
  grade.uniforms.uCA.value = simulating ? Math.min(0.32, flight.speed / 90) : 0.04;
  pipe.govern(rawDt);
  composer.render();
}
requestAnimationFrame(frame);

if(options.auto){
  setTimeout(() => {
    if(activeMode() !== 'title') return;
    $('beginButton').click();
    setTimeout(() => {
      if(activeMode() === 'campaign') $('selectMissionButton').click();
      setTimeout(() => activeMode() === 'briefing' && $('flightButton').click(), options.fast ? 30 : 180);
    }, options.fast ? 30 : 180);
  }, options.fast ? 30 : 250);
}

function gestureDiagnostics(){
  const snapshot = action.snapshot();
  return Object.freeze({
    ...snapshot,
    active: snapshot.steeringActive || snapshot.actionActive,
    pointerId: snapshot.steeringPointerId ?? snapshot.actionPointerId,
    sequence: inputSequence,
    samples: inputSamples,
    lastEndReason: lastInputEndReason,
  });
}

function commandDiagnostics(){
  const actionState = action.snapshot();
  return Object.freeze({
    sequence: commandEvidenceSequence,
    source: lastCommandSource,
    lastEdges: lastCommandEdges,
    lastPayload: lastFlightCommand,
    counts: Object.freeze({ ...commandCounts }),
    held: actionState.held,
    queued: actionState.queuedCommandCount,
    autopilotStep: missionAutopilot?.step || 0,
  });
}

function campaignDiagnostics(){
  if(cachedCampaignRevision !== campaignState.revision || !cachedCampaignDiagnostics){
    cachedCampaignDiagnostics = cloneAndFreezeModel(campaignState);
    cachedCampaignRevision = campaignState.revision;
  }
  return cachedCampaignDiagnostics;
}

function flowDiagnostics(){
  return Object.freeze({ ...wingFlowSnapshot(wingFlow), selectedMissionId });
}

const gp = {};
Object.defineProperties(gp, {
  previewPaused: { enumerable: true, get: () => previewPaused },
  mode: { enumerable: true, get: activeMode },
  legacyGateMode: { enumerable: true, get: () => legacyGateMode },
  missionId: { enumerable: true, get: () => selectedMissionId },
  options: { enumerable: true, get: () => options },
  route: { enumerable: true, get: () => Object.freeze({ id: route.id, gates: route.gates.length, finishS: route.finishS }) },
  flow: { enumerable: true, get: flowDiagnostics },
  campaign: { enumerable: true, get: campaignDiagnostics },
  state: { enumerable: true, get: diagnosticFlightSnapshot },
  gesture: { enumerable: true, get: gestureDiagnostics },
  commands: { enumerable: true, get: commandDiagnostics },
  activeScreens: { enumerable: true, get: () => Object.freeze(screens.filter(id => !$(id).hidden)) },
  transitionSequence: { enumerable: true, get: () => transitionSequence },
  presentation: { enumerable: true, get: () => Object.freeze({ ...presentation.diagnostics() }) },
  progress: { enumerable: true, get: () => Object.freeze({
    persisted: resultPersisted,
    saveCode: lastProgressSave?.code || null,
    revision: campaignState.revision,
  }) },
  visual: { enumerable: true, get: () => world.diagnostics(flight) },
  perf: { enumerable: true, get: () => Object.freeze({
    frames: perf.frames,
    averageMs: perf.frames ? perf.totalMs / perf.frames : 0,
    maxMs: perf.maxMs,
    droppedTime: perf.droppedTime,
    pixelRatio: pipe.PR,
    renderCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    sceneSnapshotHz: 30,
    hudPresentationHz: 15,
    sceneSnapshotRefreshes: flightSnapshotRefreshCount,
    presentationRefreshes: presentationRefreshCount,
    presentationRevision,
  }) },
});
Object.freeze(gp);
Object.defineProperty(window, '__gp', { value: gp, writable: false, configurable: false, enumerable: false });
