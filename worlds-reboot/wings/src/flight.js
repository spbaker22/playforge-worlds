/* PAPER WINGS - fixed-step legacy flight plus authoritative mission orchestration. */
import { AERO_ACTION, createAeroState, reduceAero } from './aero.js';
import { COMBAT_ACTION, createCombatState, reduceCombat } from './combat.js';
import { missionById } from './missions.js';
import { createMissionObjectiveState, missionObjectiveSummary, reduceMissionObjectives } from './objectives.js';
import { createRivalField, rankRace, stepRivalField } from './rivals.js';
import {
  createRouteTraversalState,
  evaluateGate,
  lockRouteBranch,
  queryHazardVolumes,
  queryProximityVolumes,
  queryThermalVolumes,
  raceStanding,
  routePointAtS,
} from './route.js';
import { SCORE_ACTION, createScoreState, reduceScore } from './scoring.js';
import { STUNT_ACTION, STUNT_DEFINITIONS, createStuntState, reduceStunts } from './stunts.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const approach = (current, target, rate, dt) => target + (current - target) * Math.exp(-rate * dt);

export const FLIGHT_STATUS = Object.freeze({
  READY: 'ready',
  FLYING: 'flying',
  RECOVERING: 'recovering',
  FINISHED: 'finished',
  FAILED: 'failed',
});

export const MISSION_STEP_ORDER = Object.freeze([
  'command', 'route', 'aero', 'movement', 'gates-and-volumes',
  'stunts', 'combat', 'rivals', 'objectives', 'scoring', 'terminal',
]);

export const MISSION_FLIGHT_PLANS = Object.freeze({
  'flight-school': Object.freeze({
    id: 'flight-school', title: 'FLIGHT SCHOOL',
    phases: Object.freeze([
      Object.freeze({ id: 'school-lift', timeLimit: 55, objectives: Object.freeze([
        Object.freeze({ id: 'school-basics', kind: 'gates', target: 3, required: true }),
        Object.freeze({ id: 'school-first-thermal', kind: 'thermals', target: 1, required: true }),
      ]) }),
      Object.freeze({ id: 'school-mastery', timeLimit: 95, objectives: Object.freeze([
        Object.freeze({ id: 'school-gates', kind: 'gates', target: 5, required: true }),
        Object.freeze({ id: 'school-thermals', kind: 'thermals', target: 1, required: true }),
        Object.freeze({ id: 'school-finish', kind: 'finish', target: 1, required: true }),
        Object.freeze({ id: 'school-clean', kind: 'clean-finish', target: 1, required: false }),
      ]) }),
    ]),
  }),
  'ridge-race': Object.freeze({
    id: 'ridge-race', title: 'RIDGE RACE',
    phases: Object.freeze([
      Object.freeze({ id: 'ridge-pack', timeLimit: 55, objectives: Object.freeze([
        Object.freeze({ id: 'ridge-opening-gates', kind: 'gates', target: 3, required: true }),
      ]) }),
      Object.freeze({ id: 'ridge-forks', timeLimit: 65, objectives: Object.freeze([
        Object.freeze({ id: 'ridge-shortcut', kind: 'shortcuts', target: 1, required: true }),
      ]) }),
      Object.freeze({ id: 'ridge-sprint', timeLimit: 75, objectives: Object.freeze([
        Object.freeze({ id: 'ridge-finish', kind: 'finish', target: 1, required: true }),
        Object.freeze({ id: 'ridge-podium', kind: 'maximum-rank', target: 1, required: false }),
      ]) }),
    ]),
  }),
  'target-run': Object.freeze({
    id: 'target-run', title: 'TARGET RUN',
    phases: Object.freeze([
      Object.freeze({ id: 'target-acquire', timeLimit: 65, objectives: Object.freeze([
        Object.freeze({ id: 'target-first-wave', kind: 'targets', target: 4, required: true }),
      ]) }),
      Object.freeze({ id: 'target-breach', timeLimit: 80, objectives: Object.freeze([
        Object.freeze({ id: 'target-drones', kind: 'targets', target: 8, required: true }),
      ]) }),
      Object.freeze({ id: 'target-escape', timeLimit: 70, objectives: Object.freeze([
        Object.freeze({ id: 'target-finish', kind: 'finish', target: 1, required: true }),
        Object.freeze({ id: 'target-accuracy', kind: 'clean-shots', target: 1, required: false }),
      ]) }),
    ]),
  }),
  'stunt-trial': Object.freeze({
    id: 'stunt-trial', title: 'STUNT TRIAL',
    phases: Object.freeze([
      Object.freeze({ id: 'stunt-basics', timeLimit: 65, objectives: Object.freeze([
        Object.freeze({ id: 'stunt-types', kind: 'stunts', target: 2, required: true }),
      ]) }),
      Object.freeze({ id: 'stunt-chain-phase', timeLimit: 85, objectives: Object.freeze([
        Object.freeze({ id: 'stunt-chain', kind: 'stunt-chain', target: 4, required: true }),
      ]) }),
      Object.freeze({ id: 'stunt-home', timeLimit: 70, objectives: Object.freeze([
        Object.freeze({ id: 'stunt-finish', kind: 'finish', target: 1, required: true }),
        Object.freeze({ id: 'stunt-proximity', kind: 'proximity', target: 1, required: false }),
      ]) }),
    ]),
  }),
  'mountain-rescue': Object.freeze({
    id: 'mountain-rescue', title: 'MOUNTAIN RESCUE',
    phases: Object.freeze([
      Object.freeze({ id: 'rescue-search', timeLimit: 75, objectives: Object.freeze([
        Object.freeze({ id: 'rescue-first-signal', kind: 'rescues', target: 1, required: true }),
      ]) }),
      Object.freeze({ id: 'rescue-drops-phase', timeLimit: 105, objectives: Object.freeze([
        Object.freeze({ id: 'rescue-climbers', kind: 'rescues', target: 2, required: true }),
        Object.freeze({ id: 'rescue-drops', kind: 'precision-drops', target: 3, required: true }),
      ]) }),
      Object.freeze({ id: 'rescue-return', timeLimit: 75, objectives: Object.freeze([
        Object.freeze({ id: 'rescue-finish', kind: 'finish', target: 1, required: true }),
        Object.freeze({ id: 'rescue-no-damage', kind: 'clean-finish', target: 1, required: false }),
      ]) }),
    ]),
  }),
  'storm-escape': Object.freeze({
    id: 'storm-escape', title: 'STORM ESCAPE',
    phases: Object.freeze([
      Object.freeze({ id: 'storm-front', timeLimit: 75, objectives: Object.freeze([
        Object.freeze({ id: 'storm-front-cells', kind: 'storm-cells', target: 2, required: true }),
      ]) }),
      Object.freeze({ id: 'storm-heart', timeLimit: 85, objectives: Object.freeze([
        Object.freeze({ id: 'storm-cells', kind: 'storm-cells', target: 2, required: true }),
      ]) }),
      Object.freeze({ id: 'storm-safe-pass', timeLimit: 75, objectives: Object.freeze([
        Object.freeze({ id: 'storm-escape', kind: 'finish', target: 1, required: true }),
        Object.freeze({ id: 'storm-shields', kind: 'shield-blocks', target: 3, required: false }),
      ]) }),
    ]),
  }),
  'ace-pursuit': Object.freeze({
    id: 'ace-pursuit', title: 'ACE PURSUIT',
    phases: Object.freeze([
      Object.freeze({ id: 'ace-chase', timeLimit: 75, objectives: Object.freeze([
        Object.freeze({ id: 'ace-locks', kind: 'targets', target: 3, required: true }),
      ]) }),
      Object.freeze({ id: 'ace-duel', timeLimit: 95, objectives: Object.freeze([
        Object.freeze({ id: 'ace-defeat', kind: 'ace-defeat', target: 1, required: true }),
      ]) }),
      Object.freeze({ id: 'ace-home', timeLimit: 75, objectives: Object.freeze([
        Object.freeze({ id: 'ace-finish', kind: 'finish', target: 1, required: true }),
        Object.freeze({ id: 'ace-combo', kind: 'stunt-chain', target: 4, required: false }),
      ]) }),
    ]),
  }),
  'skybreaker-finale': Object.freeze({
    id: 'skybreaker-finale', title: 'SKYBREAKER FINALE',
    phases: Object.freeze([
      Object.freeze({ id: 'skybreaker-locks', timeLimit: 85, objectives: Object.freeze([
        Object.freeze({ id: 'skybreaker-tower-locks', kind: 'targets', target: 3, required: true }),
      ]) }),
      Object.freeze({ id: 'skybreaker-storm', timeLimit: 115, objectives: Object.freeze([
        Object.freeze({ id: 'skybreaker-phases', kind: 'boss-phases', target: 3, required: true }),
      ]) }),
      Object.freeze({ id: 'skybreaker-core', timeLimit: 90, objectives: Object.freeze([
        Object.freeze({ id: 'skybreaker-defeat', kind: 'boss-defeat', target: 1, required: true }),
        Object.freeze({ id: 'skybreaker-finish', kind: 'finish', target: 1, required: true }),
        Object.freeze({ id: 'skybreaker-shield', kind: 'clean-finish', target: 1, required: false }),
      ]) }),
    ]),
  }),
});

const MISSION_EVENT_LIMIT = 96;
const RESCUE_ACTION_RADIUS = 58;

const RESCUE_ENTITY_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'rescue-1', type: 'pickup', kind: 'signal-balloon', s: 140, offsetX: -8, offsetY: 7, radius: 1.5, requires: null }),
  Object.freeze({ id: 'drop-1', type: 'drop-zone', kind: 'rescue-ring', s: 210, offsetX: 10, offsetY: -3, radius: 4.3, requires: 'rescue-1' }),
  Object.freeze({ id: 'rescue-2', type: 'pickup', kind: 'signal-balloon', s: 330, offsetX: 9, offsetY: 6, radius: 1.5, requires: null }),
  Object.freeze({ id: 'drop-2', type: 'drop-zone', kind: 'rescue-ring', s: 390, offsetX: -9, offsetY: -4, radius: 4.3, requires: 'rescue-2' }),
  Object.freeze({ id: 'rescue-3', type: 'pickup', kind: 'signal-balloon', s: 520, offsetX: -7, offsetY: 7, radius: 1.5, requires: null }),
  Object.freeze({ id: 'drop-3', type: 'drop-zone', kind: 'rescue-ring', s: 570, offsetX: 8, offsetY: -3, radius: 4.3, requires: 'rescue-3' }),
]);

function immutableRescueModel(missionId, entities = [], parcels = []){
  const canonical = Object.freeze(entities.map(entity => Object.freeze({ ...entity })));
  return Object.freeze({
    missionId,
    entities: canonical,
    pickups: Object.freeze(canonical.filter(entity => entity.type === 'pickup')),
    dropZones: Object.freeze(canonical.filter(entity => entity.type === 'drop-zone')),
    parcels: Object.freeze(parcels.map(parcel => Object.freeze({ ...parcel }))),
  });
}

function createMissionRescue(route, missionId){
  if(missionId !== 'mountain-rescue') return immutableRescueModel(missionId);
  const entities = RESCUE_ENTITY_DEFINITIONS.map(definition => {
    const point = routePointAtS(route, definition.s);
    return {
      id: definition.id,
      type: definition.type,
      kind: definition.kind,
      s: definition.s,
      x: point.x + definition.offsetX,
      y: point.y + definition.offsetY,
      radius: definition.radius,
      requires: definition.requires,
      active: true,
      unlocked: false,
      eligible: false,
      resolved: false,
    };
  });
  return immutableRescueModel(missionId, entities);
}

function syncRescueModel(state){
  if(!state.rescue?.entities?.length) return state.rescue;
  const resolved = new Set(state.resolvedActionIds);
  let changed = false;
  const entities = state.rescue.entities.map(entity => {
    const isResolved = resolved.has(entity.id);
    const prerequisiteMet = !entity.requires || resolved.has(entity.requires);
    const unlocked = prerequisiteMet && (entity.unlocked || state.s >= entity.s - RESCUE_ACTION_RADIUS);
    const eligible = !isResolved && unlocked && Math.abs(state.s - entity.s) <= RESCUE_ACTION_RADIUS;
    const active = !isResolved;
    if(entity.resolved === isResolved && entity.unlocked === unlocked && entity.eligible === eligible && entity.active === active) return entity;
    changed = true;
    return { ...entity, active, unlocked, eligible, resolved: isResolved };
  });
  if(changed) state.rescue = immutableRescueModel(state.missionId, entities, state.rescue.parcels);
  return state.rescue;
}

function hashMissionSeed(missionId){
  let value = 0x811c9dc5;
  for(const character of missionId){
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0) || 1;
}

function normalizeMissionSeed(missionId, seed){
  return Number.isInteger(seed) ? ((seed >>> 0) || 1) : hashMissionSeed(missionId);
}

function resolveMissionPlan(missionId){
  const catalogMission = missionById(missionId);
  const plan = MISSION_FLIGHT_PLANS[missionId];
  if(!catalogMission || !plan) throw new RangeError(`unknown Paper Wings mission ${missionId}`);
  return plan;
}

function spawnMissionTarget(combat, route, id, s, kind = 'drone'){
  const point = routePointAtS(route, s);
  return reduceCombat(combat, {
    type: COMBAT_ACTION.SPAWN_TARGET,
    targetId: id,
    kind,
    x: point.x,
    y: point.y,
    s,
    radius: 4,
    hp: 1,
  });
}

function createMissionCombat(missionId, route, seed){
  let combat = createCombatState({ seed });
  if(missionId === 'target-run'){
    for(let index = 0; index < 12; index += 1){
      combat = spawnMissionTarget(combat, route, `target-drone-${index + 1}`, 70 + index * 43);
    }
  }
  if(missionId === 'ace-pursuit' || missionId === 'skybreaker-finale'){
    const prefix = missionId === 'ace-pursuit' ? 'ace-lock' : 'tower-lock';
    for(let index = 0; index < 3; index += 1){
      combat = spawnMissionTarget(combat, route, `${prefix}-${index + 1}`, 105 + index * 72, 'weak-point');
    }
    const bossS = missionId === 'ace-pursuit' ? 500 : 470;
    const point = routePointAtS(route, bossS);
    combat = reduceCombat(combat, {
      type: COMBAT_ACTION.SPAWN_BOSS,
      bossId: missionId === 'ace-pursuit' ? 'league-ace' : 'skybreaker',
      kind: missionId === 'ace-pursuit' ? 'ace' : 'skybreaker',
      x: point.x,
      y: point.y,
      s: bossS,
      radius: 7,
      hp: missionId === 'ace-pursuit' ? 6 : 12,
      phases: [
        { id: 'armor', startsAt: 1, damageMultiplier: 1 },
        { id: 'storm', startsAt: 0.66, damageMultiplier: 1 },
        { id: 'core', startsAt: 0.33, damageMultiplier: 1 },
      ],
    });
  }
  return combat;
}

function createMissionExtension(route, options, race){
  const missionId = options.missionId || (typeof options.mission === 'string' ? options.mission : null);
  if(!missionId) return null;
  const plan = resolveMissionPlan(missionId);
  const seed = normalizeMissionSeed(missionId, options.seed);
  const aero = createAeroState({ altitude: 33, speed: 18, energy: 72, integrity: 3 });
  const objectives = createMissionObjectiveState(plan);
  const scoring = createScoreState();
  return {
    missionId,
    missionSeed: seed,
    missionStep: 0,
    routeTraversal: createRouteTraversalState(route),
    aero,
    objectives,
    stunts: createStuntState(),
    scoring,
    combat: createMissionCombat(missionId, route, seed),
    rescue: createMissionRescue(route, missionId),
    rivals: race === 'rivals' ? createRivalField(route) : [],
    eventBuffer: [],
    pendingObjectiveEvents: [],
    missionEventSequence: 0,
    encounteredVolumeIds: [],
    resolvedActionIds: [],
    fireCooldown: 0,
    shotsFired: 0,
    shotsHit: 0,
    score: 0,
    combo: 0,
    bestCombo: 0,
    energy: aero.energy,
    integrity: aero.integrity,
    phaseId: objectives.phaseId,
    result: null,
  };
}

function emitMissionEvent(state, type, data = {}){
  if(!state.missionId) return;
  const id = `f-${state.missionSeed.toString(16).padStart(8, '0')}-${state.missionEventSequence.toString(36).padStart(5, '0')}`;
  const event = { ...data, id, type, step: state.missionStep, time: state.time };
  state.missionEventSequence += 1;
  state.eventBuffer = [...state.eventBuffer, event].slice(-MISSION_EVENT_LIMIT);
}

function syncMissionMirrors(state){
  syncRescueModel(state);
  state.energy = state.aero.energy;
  state.integrity = state.aero.integrity;
  state.score = state.scoring.score;
  state.combo = state.scoring.combo;
  state.bestCombo = state.scoring.bestCombo;
  state.phaseId = state.objectives.phaseId;
}

export function createFlightState(route, options = {}){
  if(!route?.gates?.length) throw new TypeError('createFlightState requires a route');
  const control = options.control === 'direct' ? 'direct' : 'guided';
  const race = options.race === 'solo' ? 'solo' : 'rivals';
  const state = {
    status: FLIGHT_STATUS.READY,
    time: 0,
    s: 0,
    x: 0,
    y: 33,
    bank: 0,
    pitch: 0,
    speed: 0,
    gateIndex: 0,
    gatesPassed: 0,
    misses: 0,
    retriesAtGate: 0,
    recoveryRemaining: 0,
    recoveryFromX: 0,
    recoveryFromY: 33,
    event: null,
    eventSequence: 0,
    finishTime: null,
    rank: race === 'rivals' ? 4 : 1,
    control,
    race,
  };
  const mission = createMissionExtension(route, options, race);
  if(mission) Object.assign(state, mission);
  return state;
}

export function startFlight(state){
  if(state.status !== FLIGHT_STATUS.READY) return false;
  state.status = FLIGHT_STATUS.FLYING;
  state.speed = 18;
  state.event = 'start';
  state.eventSequence += 1;
  if(state.missionId) emitMissionEvent(state, 'mission-started', { missionId: state.missionId });
  return true;
}

function triggerEvent(state, event){
  state.event = event;
  state.eventSequence += 1;
}

function beginRecovery(state, gate){
  state.misses += 1;
  state.retriesAtGate += 1;
  if(state.retriesAtGate >= 3){
    state.status = FLIGHT_STATUS.FAILED;
    state.speed = 0;
    triggerEvent(state, 'failed');
    return;
  }
  state.status = FLIGHT_STATUS.RECOVERING;
  state.recoveryRemaining = 1.15;
  state.recoveryFromX = state.x;
  state.recoveryFromY = state.y;
  state.s = Math.max(0, gate.s - 40);
  state.speed = 9;
  triggerEvent(state, 'miss');
}

function tickRecovery(state, dt, route){
  const gate = route.gates[state.gateIndex];
  state.recoveryRemaining = Math.max(0, state.recoveryRemaining - dt);
  const t = 1 - state.recoveryRemaining / 1.15;
  const eased = t * t * (3 - 2 * t);
  const lead = routePointAtS(route, Math.max(0, gate.s - 40));
  state.x = state.recoveryFromX + (lead.x - state.recoveryFromX) * eased;
  state.y = state.recoveryFromY + (lead.y - state.recoveryFromY) * eased;
  state.bank = approach(state.bank, 0, 7, dt);
  state.pitch = approach(state.pitch, 0, 7, dt);
  if(state.recoveryRemaining <= 0){
    state.status = FLIGHT_STATUS.FLYING;
    state.speed = 15;
    triggerEvent(state, 'recovered');
  }
}

function finishFlight(state, route){
  state.status = FLIGHT_STATUS.FINISHED;
  state.finishTime = state.time;
  state.speed = 0;
  const standing = raceStanding(route.finishS, state.time, route, state.race);
  state.rank = state.race === 'solo'
    ? 1
    : 1 + standing.entries.filter(entry => entry.s >= route.finishS - 0.01).length;
  triggerEvent(state, 'finished');
}

function stepLegacyFlight(state, dt, axes, route){
  if(!state || !route) throw new TypeError('stepFlight requires state and route');
  if(!Number.isFinite(dt) || dt < 0) throw new RangeError('dt must be non-negative');
  state.event = null;
  if(state.status === FLIGHT_STATUS.RECOVERING){
    state.time += dt;
    tickRecovery(state, dt, route);
    return state;
  }
  if(state.status !== FLIGHT_STATUS.FLYING) return state;

  state.time += dt;
  const bankInput = clamp(Number.isFinite(axes?.bank) ? axes.bank : 0, -1, 1);
  const pitchInput = clamp(Number.isFinite(axes?.pitch) ? axes.pitch : 0, -1, 1);
  state.bank = approach(state.bank, bankInput, 10, dt);
  state.pitch = approach(state.pitch, pitchInput, 10, dt);

  const guided = state.control === 'guided';
  const cruise = guided ? 21.2 : 22.2;
  state.speed = approach(state.speed, cruise - Math.abs(state.bank) * 1.4 + Math.max(0, -state.pitch) * 0.8, 2.4, dt);
  const previousS = state.s;
  state.s += state.speed * dt;
  const routePoint = routePointAtS(route, state.s);
  state.x += state.bank * (guided ? 15.5 : 19.5) * dt;
  state.y += state.pitch * (guided ? 10.5 : 13.5) * dt;

  if(guided){
    const assist = Math.min(1, dt * 0.75);
    state.x += (routePoint.x - state.x) * assist * 0.18;
    state.y += (routePoint.y - state.y) * assist * 0.12;
  }
  state.x = clamp(state.x, -78, 78);
  state.y = clamp(state.y, 13, 65);

  const gate = route.gates[state.gateIndex];
  if(gate && previousS < gate.s && state.s >= gate.s){
    const verdict = evaluateGate(gate, state.x, state.y, state.control);
    if(verdict.passed){
      state.gateIndex += 1;
      state.gatesPassed += 1;
      state.retriesAtGate = 0;
      triggerEvent(state, 'gate');
    } else {
      beginRecovery(state, gate);
      return state;
    }
  }

  if(state.gateIndex >= route.gates.length && state.s >= route.finishS){
    finishFlight(state, route);
  } else {
    state.rank = raceStanding(state.s, state.time, route, state.race).rank;
  }
  return state;
}

function missionCommand(axes, command){
  const embedded = axes?.command && typeof axes.command === 'object' ? axes.command : {};
  return command && typeof command === 'object' ? { ...embedded, ...command } : embedded;
}

function progressMissionObjective(state, event){
  state.pendingObjectiveEvents = [...state.pendingObjectiveEvents, event];
  return true;
}

function flushMissionObjectives(state, dt){
  const queued = [...state.pendingObjectiveEvents, { type: 'tick', dt }];
  state.pendingObjectiveEvents = [];
  for(const event of queued){
    const before = state.objectives;
    const beforePhase = before.phaseId;
    const beforeStatus = before.status;
    const next = reduceMissionObjectives(before, event);
    if(next === before) continue;
    state.objectives = next;
    if(next.phaseId !== beforePhase) emitMissionEvent(state, 'phase-changed', { from: beforePhase, to: next.phaseId });
    if(next.status !== beforeStatus) emitMissionEvent(state, 'objectives-terminal', { outcome: next.verdict?.outcome, reason: next.verdict?.reason });
  }
}

function awardMissionScore(state, kind, eventId, options = {}){
  const prior = state.scoring;
  state.scoring = reduceScore(prior, {
    type: SCORE_ACTION.AWARD,
    kind,
    eventId,
    basePoints: options.basePoints,
    chainable: options.chainable,
  });
  if(state.scoring !== prior && state.scoring.lastAward?.eventId === eventId){
    emitMissionEvent(state, 'score-awarded', { kind, points: state.scoring.lastAward.points, eventId });
  }
}

function resolveMissionAction(state, id, expectedEntityType, type, objectiveKind, scoreKind){
  if(typeof id !== 'string' || state.resolvedActionIds.includes(id)) return false;
  syncRescueModel(state);
  const entity = state.rescue?.entities?.find(candidate => candidate.id === id);
  if(!entity || entity.type !== expectedEntityType || !entity.active || !entity.unlocked || !entity.eligible || entity.resolved) return false;
  state.resolvedActionIds = [...state.resolvedActionIds, id];
  syncRescueModel(state);
  progressMissionObjective(state, { type: 'progress', kind: objectiveKind, amount: 1 });
  if(scoreKind) awardMissionScore(state, scoreKind, `${type}:${id}`);
  emitMissionEvent(state, type, { actionId: id, kind: entity.kind, s: entity.s, x: entity.x, y: entity.y });
  return true;
}

function applyMissionCommand(state, payload){
  state.aero = reduceAero(state.aero, { type: AERO_ACTION.SET_BOOST, active: payload.boost === true });
  state.aero = reduceAero(state.aero, { type: AERO_ACTION.SET_SHIELD, active: payload.shield === true });
  if(payload.rescueId) resolveMissionAction(state, payload.rescueId, 'pickup', 'rescue-completed', 'rescues', 'rescue');
  if(payload.dropId) resolveMissionAction(state, payload.dropId, 'drop-zone', 'precision-drop', 'precision-drops', 'precision-drop');
  if(payload.impact === true || Number.isFinite(payload.impact)){
    state.aero = reduceAero(state.aero, { type: AERO_ACTION.IMPACT, damage: Number.isFinite(payload.impact) ? payload.impact : 1 });
  }
  if(payload.objective && typeof payload.objective.kind === 'string'){
    progressMissionObjective(state, {
      type: 'progress',
      kind: payload.objective.kind,
      amount: payload.objective.amount,
      value: payload.objective.value,
    });
  }
}

function lockMissionForks(state, route, payload){
  for(const fork of route.forks || []){
    if(state.routeTraversal.branchChoices[fork.id] || state.s < fork.decisionS) continue;
    const requested = payload.branchChoices?.[fork.id] || payload.branch || fork.safeBranchId;
    state.routeTraversal = lockRouteBranch(state.routeTraversal, route, fork.id, requested);
    const branchId = state.routeTraversal.branchChoices[fork.id];
    emitMissionEvent(state, 'branch-locked', { forkId: fork.id, branchId });
    if(branchId !== fork.safeBranchId){
      progressMissionObjective(state, { type: 'progress', kind: 'shortcuts', amount: 1 });
      awardMissionScore(state, 'rival-pass', `shortcut:${fork.id}`);
    }
  }
}

function thermalInfluence(state, route){
  const hits = queryThermalVolumes(route, { s: state.s, x: state.x, y: state.y });
  return hits[0]?.influence || 0;
}

function moveMissionFlight(state, dt, axes, route){
  const bankInput = clamp(Number.isFinite(axes?.bank) ? axes.bank : 0, -1, 1);
  const pitchInput = clamp(Number.isFinite(axes?.pitch) ? axes.pitch : 0, -1, 1);
  state.bank = approach(state.bank, bankInput, 10, dt);
  state.pitch = approach(state.pitch, pitchInput, 10, dt);
  state.aero = reduceAero(state.aero, {
    type: AERO_ACTION.TICK,
    dt,
    pitch: state.pitch,
    thermal: thermalInfluence(state, route),
  });
  state.speed = state.aero.speed;
  const previousS = state.s;
  state.s = Math.min(route.finishS, state.s + state.speed * dt);
  const routePoint = routePointAtS(route, state.s, { x: 0, y: 33 }, state.routeTraversal);
  const guided = state.control === 'guided';
  state.x += state.bank * (guided ? 15.5 : 19.5) * dt;
  state.y = state.aero.altitude;
  if(guided){
    const assist = Math.min(1, dt * 0.75);
    state.x += (routePoint.x - state.x) * assist * 0.18;
    state.y += (routePoint.y - state.y) * assist * 0.12;
  }
  state.x = clamp(state.x, -78, 78);
  state.y = clamp(state.y, 13, 65);
  state.aero = { ...state.aero, altitude: state.y };
  return previousS;
}

function passMissionGate(state, gate){
  state.gateIndex += 1;
  state.gatesPassed += 1;
  state.retriesAtGate = 0;
  triggerEvent(state, 'gate');
  state.aero = reduceAero(state.aero, { type: AERO_ACTION.ADD_ENERGY, amount: 4, source: 'gate' });
  progressMissionObjective(state, { type: 'progress', kind: 'gates', amount: 1 });
  awardMissionScore(state, 'gate', `gate:${gate.id}`);
  emitMissionEvent(state, 'gate-passed', { gateId: gate.id, gateIndex: state.gateIndex });
}

function processMissionGates(state, previousS, route){
  const gate = route.gates[state.gateIndex];
  if(!gate || previousS >= gate.s || state.s < gate.s) return;
  const verdict = evaluateGate(gate, state.x, state.y, state.control);
  if(verdict.passed) passMissionGate(state, gate);
  else {
    beginRecovery(state, gate);
    state.scoring = reduceScore(state.scoring, { type: SCORE_ACTION.BREAK_COMBO, reason: 'missed-gate' });
    emitMissionEvent(state, 'gate-missed', { gateId: gate.id, distance: verdict.distance });
  }
}

function markVolumeEncounter(state, id){
  if(state.encounteredVolumeIds.includes(id)) return false;
  state.encounteredVolumeIds = [...state.encounteredVolumeIds, id];
  return true;
}

function processMissionVolumes(state, previousS, route){
  for(const hit of queryThermalVolumes(route, { s: state.s, x: state.x, y: state.y })){
    if(hit.influence < 0.12 || !markVolumeEncounter(state, hit.id)) continue;
    state.aero = reduceAero(state.aero, { type: AERO_ACTION.ADD_ENERGY, amount: hit.energy * 100, source: hit.id });
    progressMissionObjective(state, { type: 'progress', kind: 'thermals', amount: 1 });
    awardMissionScore(state, 'thermal', `thermal:${hit.id}`);
    emitMissionEvent(state, 'thermal-entered', { volumeId: hit.id, influence: hit.influence });
  }

  for(const hit of queryProximityVolumes(route, { s: state.s, x: state.x, y: state.y })){
    if(hit.influence < 0.28 || !markVolumeEncounter(state, hit.id)) continue;
    const stuntId = `proximity:${hit.id}`;
    const before = state.stunts.eventSequence;
    state.stunts = reduceStunts(state.stunts, { type: STUNT_ACTION.REGISTER, stuntId, kind: 'proximity-thread', quality: 1 + hit.influence * 0.4 });
    if(state.stunts.eventSequence !== before){
      progressMissionObjective(state, { type: 'progress', kind: 'proximity', amount: 1 });
      progressMissionObjective(state, { type: 'progress', kind: 'stunt-chain', value: state.stunts.chain });
      state.aero = reduceAero(state.aero, { type: AERO_ACTION.ADD_ENERGY, amount: state.stunts.lastResult.energy, source: 'proximity' });
      awardMissionScore(state, 'near-miss', stuntId);
      emitMissionEvent(state, 'proximity-thread', { volumeId: hit.id, chain: state.stunts.chain });
    }
  }

  if(!['storm-escape', 'skybreaker-finale'].includes(state.missionId)) return;
  const spatialHits = new Map(queryHazardVolumes(route, { s: state.s, x: state.x, y: state.y })
    .map(hit => [hit.id, hit]));
  for(const hazard of route.volumes.hazards){
    const crossed = previousS < hazard.s && state.s >= hazard.s;
    const spatialHit = spatialHits.get(hazard.id);
    const unavoidableCrossing = hazard.unavoidable === true && crossed;
    if(!crossed && !spatialHit) continue;
    if(!markVolumeEncounter(state, hazard.id)) continue;
    progressMissionObjective(state, { type: 'progress', kind: 'storm-cells', amount: 1 });
    if(!spatialHit && !unavoidableCrossing){
      awardMissionScore(state, 'near-miss', `hazard-dodge:${hazard.id}`);
      emitMissionEvent(state, 'hazard-dodged', { volumeId: hazard.id, kind: hazard.kind });
      continue;
    }
    state.aero = reduceAero(state.aero, { type: AERO_ACTION.IMPACT, damage: 1 });
    const shielded = state.aero.event === 'shielded-impact';
    if(shielded) progressMissionObjective(state, { type: 'progress', kind: 'shield-blocks', amount: 1 });
    else state.scoring = reduceScore(state.scoring, { type: SCORE_ACTION.BREAK_COMBO, reason: hazard.kind });
    emitMissionEvent(state, shielded ? 'hazard-blocked' : 'hazard-hit', {
      volumeId: hazard.id,
      kind: hazard.kind,
      influence: spatialHit?.influence || 0,
      unavoidable: unavoidableCrossing,
    });
  }
}

function processMissionStunts(state, dt, payload){
  const command = payload.stunt && typeof payload.stunt === 'object' ? payload.stunt : null;
  if(command?.begin && !state.stunts.active){
    const stuntId = command.id || `stunt-${state.missionSeed.toString(16)}-${state.missionStep.toString(36)}`;
    state.stunts = reduceStunts(state.stunts, {
      type: STUNT_ACTION.BEGIN,
      stuntId,
      kind: command.kind,
      altitude: state.y,
    });
    emitMissionEvent(state, 'stunt-began', { stuntId, kind: command.kind });
  }
  const priorSequence = state.stunts.eventSequence;
  state.stunts = reduceStunts(state.stunts, {
    type: STUNT_ACTION.TICK,
    dt,
    altitude: state.y,
    rollDelta: command?.rollDelta,
    pitchDelta: command?.pitchDelta,
    yawDelta: command?.yawDelta,
    quality: command?.quality,
  });
  if(state.stunts.eventSequence === priorSequence) return;
  if(state.stunts.event?.startsWith('completed:')){
    const result = state.stunts.lastResult;
    progressMissionObjective(state, { type: 'progress', kind: 'stunts', amount: 1 });
    progressMissionObjective(state, { type: 'progress', kind: 'stunt-chain', value: result.chain });
    state.aero = reduceAero(state.aero, { type: AERO_ACTION.ADD_ENERGY, amount: result.energy, source: result.kind });
    awardMissionScore(state, 'stunt', `stunt:${result.id}`, { basePoints: result.score });
    emitMissionEvent(state, 'stunt-completed', { stuntId: result.id, kind: result.kind, chain: result.chain });
  } else if(state.stunts.event?.startsWith('failed:')){
    state.scoring = reduceScore(state.scoring, { type: SCORE_ACTION.BREAK_COMBO, reason: 'stunt-failed' });
    emitMissionEvent(state, 'stunt-failed', { ...state.stunts.lastResult });
  }
}

function combatAimTarget(state, requestedId){
  const activeTargets = state.combat.targets.filter(target => target.status === 'active' && target.s > state.s + 1);
  if(requestedId){
    const requested = activeTargets.find(target => target.id === requestedId);
    if(requested) return requested;
    if(state.combat.boss?.id === requestedId && state.combat.boss.status === 'active' && state.combat.boss.s > state.s + 1) return state.combat.boss;
  }
  activeTargets.sort((left, right) => left.s - right.s || left.id.localeCompare(right.id));
  if(activeTargets[0]) return activeTargets[0];
  const boss = state.combat.boss;
  return boss?.status === 'active' && boss.s > state.s + 1 ? boss : null;
}

function fireMissionProjectile(state, payload){
  const fire = payload.fire === true ? {} : payload.fire;
  if(!fire || typeof fire !== 'object' || state.fireCooldown > 0) return;
  const target = combatAimTarget(state, fire.targetId);
  if(!target) return;
  const projectileId = `player-shot-${state.missionSeed.toString(16)}-${state.shotsFired.toString(36).padStart(4, '0')}`;
  state.combat = reduceCombat(state.combat, {
    type: COMBAT_ACTION.FIRE,
    projectileId,
    ownerId: 'player',
    x: state.x,
    y: state.y,
    s: state.s,
    dx: target.x - state.x,
    dy: target.y - state.y,
    ds: target.s - state.s,
    speed: 120,
    damage: Number.isFinite(fire.damage) ? fire.damage : 1,
    spread: Number.isFinite(fire.spread) ? fire.spread : 0,
    ttl: 2,
  });
  state.shotsFired += 1;
  state.fireCooldown = 0.18;
  emitMissionEvent(state, 'projectile-fired', { projectileId, targetId: target.id });
}

function processCombatEvents(state){
  for(const event of state.combat.events){
    if(event.type === 'target-hit' || event.type === 'boss-hit') state.shotsHit += 1;
    if(event.type === 'target-destroyed'){
      progressMissionObjective(state, { type: 'progress', kind: 'targets', amount: 1 });
      awardMissionScore(state, 'target', `combat:${event.id}`);
    }
    if(event.type === 'boss-hit') awardMissionScore(state, 'boss-hit', `combat:${event.id}`);
    if(event.type === 'boss-phase') awardMissionScore(state, 'boss-phase', `combat:${event.id}`);
    if(event.type === 'boss-destroyed'){
      const kind = state.missionId === 'ace-pursuit' ? 'ace-defeat' : 'boss-defeat';
      progressMissionObjective(state, { type: 'complete', kind });
    }
    if(['target-destroyed', 'boss-phase', 'boss-destroyed'].includes(event.type)) emitMissionEvent(state, event.type, event);
  }
  if(state.missionId === 'skybreaker-finale' && state.combat.boss){
    progressMissionObjective(state, { type: 'progress', kind: 'boss-phases', value: state.combat.boss.phaseIndex + 1 });
  }
}

function processMissionCombat(state, dt, payload){
  state.fireCooldown = Math.max(0, state.fireCooldown - dt);
  fireMissionProjectile(state, payload);
  state.combat = reduceCombat(state.combat, { type: COMBAT_ACTION.TICK, dt });
  processCombatEvents(state);
}

function processMissionRivals(state, dt, route){
  if(state.race !== 'rivals'){
    state.rank = 1;
    return;
  }
  const targets = state.combat.targets.map(target => ({
    id: target.id,
    s: target.s,
    value: target.scoreValue / 125,
    difficulty: 0.5,
    active: target.status === 'active',
    destroyed: target.status !== 'active',
  }));
  state.rivals = stepRivalField(state.rivals, dt, route, {
    playerS: state.s,
    thermal: thermalInfluence(state, route),
    targets,
  });
  state.rank = rankRace({ id: 'player', name: 'YOU', s: state.s }, state.rivals).rank;
}

function queueFinishObjectives(state){
  if(state.rank <= 3) progressMissionObjective(state, { type: 'complete', kind: 'maximum-rank' });
  if(state.misses === 0 && state.aero.unshieldedHits === 0) progressMissionObjective(state, { type: 'complete', kind: 'clean-finish' });
  if(state.shotsFired > 0 && state.shotsHit >= state.shotsFired) progressMissionObjective(state, { type: 'complete', kind: 'clean-shots' });
  progressMissionObjective(state, { type: 'complete', kind: 'finish' });
}

function missionResult(state, outcome, reason){
  const summary = missionObjectiveSummary(state.objectives);
  return {
    missionId: state.missionId,
    completed: outcome === 'success',
    outcome,
    reason,
    timeMs: Math.round(state.time * 1000),
    score: state.scoring.score,
    bestCombo: state.scoring.bestCombo,
    rank: state.rank,
    gatesPassed: state.gatesPassed,
    misses: state.misses,
    energy: state.aero.energy,
    integrity: state.aero.integrity,
    shotsFired: state.shotsFired,
    shotsHit: state.shotsHit,
    completedObjectiveIds: summary.completedObjectiveIds,
    optionalCompleted: summary.optionalCompleted,
    optionalTotal: summary.optionalTotal,
    branchChoices: { ...state.routeTraversal.branchChoices },
  };
}

function finishMissionFlight(state, route){
  const standing = state.race === 'rivals'
    ? rankRace({ id: 'player', name: 'YOU', s: route.finishS, finished: true, finishElapsed: state.time }, state.rivals)
    : { rank: 1 };
  state.status = FLIGHT_STATUS.FINISHED;
  state.finishTime = state.time;
  state.speed = 0;
  state.rank = standing.rank;
  state.result = missionResult(state, 'success', state.objectives.verdict?.reason || 'mission-complete');
  triggerEvent(state, 'finished');
  emitMissionEvent(state, 'mission-finished', { rank: state.rank, score: state.score });
}

function failMissionFlight(state, reason){
  if(state.objectives.status === 'active'){
    progressMissionObjective(state, { type: 'mission-fail', reason });
    flushMissionObjectives(state, 0);
  }
  state.status = FLIGHT_STATUS.FAILED;
  state.speed = 0;
  state.result = missionResult(state, 'failure', reason);
  triggerEvent(state, 'failed');
  emitMissionEvent(state, 'mission-failed', { reason });
}

function stepMissionRecovery(state, dt, axes, route, payload){
  state.time += dt;
  applyMissionCommand(state, payload);
  state.aero = reduceAero(state.aero, { type: AERO_ACTION.TICK, dt, pitch: 0, thermal: 0 });
  tickRecovery(state, dt, route);
  if(state.status === FLIGHT_STATUS.FLYING){
    state.aero = { ...state.aero, speed: 15, altitude: state.y };
  }
  processMissionStunts(state, dt, payload);
  processMissionCombat(state, dt, payload);
  processMissionRivals(state, dt, route);
  flushMissionObjectives(state, dt);
  state.scoring = reduceScore(state.scoring, { type: SCORE_ACTION.TICK, dt });
  syncMissionMirrors(state);
  if(state.aero.status === 'disabled') failMissionFlight(state, 'hull-disabled');
  return state;
}

function stepMissionFlight(state, dt, axes, route, command){
  if(!state || !route) throw new TypeError('stepFlight requires state and route');
  if(!Number.isFinite(dt) || dt < 0) throw new RangeError('dt must be non-negative');
  state.event = null;
  if(![FLIGHT_STATUS.FLYING, FLIGHT_STATUS.RECOVERING].includes(state.status)) return state;
  state.missionStep += 1;
  const payload = missionCommand(axes, command);
  if(state.status === FLIGHT_STATUS.RECOVERING) return stepMissionRecovery(state, dt, axes, route, payload);

  state.time += dt;
  applyMissionCommand(state, payload);
  lockMissionForks(state, route, payload);
  const previousS = moveMissionFlight(state, dt, axes, route);
  processMissionGates(state, previousS, route);
  processMissionVolumes(state, previousS, route);
  processMissionStunts(state, dt, payload);
  processMissionCombat(state, dt, payload);
  processMissionRivals(state, dt, route);

  const reachedFinish = state.s >= route.finishS && state.gateIndex >= route.gates.length;
  if(reachedFinish) queueFinishObjectives(state);
  flushMissionObjectives(state, dt);
  state.scoring = reduceScore(state.scoring, { type: SCORE_ACTION.TICK, dt });
  syncMissionMirrors(state);

  if(state.status === FLIGHT_STATUS.FAILED) failMissionFlight(state, 'gate-failure');
  else if(state.aero.status === 'disabled') failMissionFlight(state, 'hull-disabled');
  else if(state.objectives.status === 'failed') failMissionFlight(state, state.objectives.verdict?.reason || 'objectives-failed');
  else if(reachedFinish && state.objectives.status === 'completed') finishMissionFlight(state, route);
  else if(reachedFinish) failMissionFlight(state, 'objectives-incomplete');
  return state;
}

export function stepFlight(state, dt, axes, route, command = null){
  return state?.missionId
    ? stepMissionFlight(state, dt, axes, route, command)
    : stepLegacyFlight(state, dt, axes, route);
}

export function flightStanding(state, route){
  if(!state || !route) throw new TypeError('flightStanding requires state and route');
  if(state.missionId){
    if(state.race !== 'rivals') return Object.freeze({ rank: 1, total: 1, entries: Object.freeze([]) });
    const standing = rankRace({
      id: 'player',
      name: 'YOU',
      s: state.s,
      finished: state.status === FLIGHT_STATUS.FINISHED,
      finishElapsed: state.finishTime,
    }, state.rivals);
    return Object.freeze({ ...standing, rank: state.status === FLIGHT_STATUS.FINISHED ? state.rank : standing.rank });
  }
  const standing = raceStanding(state.s, state.time, route, state.race);
  if(state.status !== FLIGHT_STATUS.FINISHED) return standing;
  return Object.freeze({ ...standing, rank: state.rank });
}

function copyFrozenSnapshotGraph(value, copies){
  if(value === null || typeof value !== 'object') return value;
  const existing = copies.get(value);
  if(existing) return existing;
  if(Array.isArray(value)){
    const copy = new Array(value.length);
    copies.set(value, copy);
    for(let index = 0; index < value.length; index += 1){
      copy[index] = copyFrozenSnapshotGraph(value[index], copies);
    }
    return Object.freeze(copy);
  }
  const copy = {};
  copies.set(value, copy);
  for(const key of Object.keys(value)) copy[key] = copyFrozenSnapshotGraph(value[key], copies);
  return Object.freeze(copy);
}

export function flightSnapshot(state){
  const snapshot = {
    status: state.status,
    time: state.time,
    s: state.s,
    x: state.x,
    y: state.y,
    bank: state.bank,
    pitch: state.pitch,
    speed: state.speed,
    gateIndex: state.gateIndex,
    gatesPassed: state.gatesPassed,
    misses: state.misses,
    retriesAtGate: state.retriesAtGate,
    recoveryRemaining: state.recoveryRemaining,
    event: state.event,
    eventSequence: state.eventSequence,
    finishTime: state.finishTime,
    rank: state.rank,
    control: state.control,
    race: state.race,
  };
  if(state.missionId){
    const copies = new WeakMap();
    Object.assign(snapshot, {
      missionId: state.missionId,
      missionSeed: state.missionSeed,
      missionStep: state.missionStep,
      energy: state.energy,
      integrity: state.integrity,
      score: state.score,
      combo: state.combo,
      bestCombo: state.bestCombo,
      phaseId: state.phaseId,
      shotsFired: state.shotsFired,
      shotsHit: state.shotsHit,
      routeTraversal: copyFrozenSnapshotGraph(state.routeTraversal, copies),
      aero: copyFrozenSnapshotGraph(state.aero, copies),
      objectives: copyFrozenSnapshotGraph(state.objectives, copies),
      stunts: copyFrozenSnapshotGraph(state.stunts, copies),
      scoring: copyFrozenSnapshotGraph(state.scoring, copies),
      combat: copyFrozenSnapshotGraph(state.combat, copies),
      rescue: copyFrozenSnapshotGraph(state.rescue, copies),
      rivals: copyFrozenSnapshotGraph(state.rivals, copies),
      eventBuffer: copyFrozenSnapshotGraph(state.eventBuffer, copies),
      encounteredVolumeIds: copyFrozenSnapshotGraph(state.encounteredVolumeIds, copies),
      resolvedActionIds: copyFrozenSnapshotGraph(state.resolvedActionIds, copies),
      result: copyFrozenSnapshotGraph(state.result, copies),
    });
    return Object.freeze(snapshot);
  }
  return Object.freeze(snapshot);
}
