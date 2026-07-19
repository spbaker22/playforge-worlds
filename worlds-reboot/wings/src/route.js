/* PAPER WINGS - authored route data and deterministic course queries. */
import {
  WING_RIVALS,
  legacyRaceStanding,
  legacyRivalFinishTime,
  legacyRivalProgress,
} from './rivals.js';

const FULL_GATES = Object.freeze([
  Object.freeze({ id: 'needles', name: 'THE NEEDLES', s: 58, x: 0, y: 31, radius: 7.2 }),
  Object.freeze({ id: 'ice-chute', name: 'ICE CHUTE', s: 112, x: -18, y: 36, radius: 7.0 }),
  Object.freeze({ id: 'glacier-eye', name: 'GLACIER EYE', s: 168, x: 12, y: 40, radius: 6.8 }),
  Object.freeze({ id: 'sun-shelf', name: 'SUN SHELF', s: 224, x: 28, y: 34, radius: 7.2 }),
  Object.freeze({ id: 'bell-pass', name: 'BELL PASS', s: 282, x: -4, y: 29, radius: 6.6 }),
  Object.freeze({ id: 'larch-gap', name: 'LARCH GAP', s: 338, x: -31, y: 38, radius: 7.3 }),
  Object.freeze({ id: 'switchback', name: 'SWITCHBACK', s: 396, x: -8, y: 46, radius: 6.7 }),
  Object.freeze({ id: 'blue-wall', name: 'BLUE WALL', s: 454, x: 24, y: 43, radius: 7.0 }),
  Object.freeze({ id: 'eagle-turn', name: 'EAGLE TURN', s: 514, x: 38, y: 34, radius: 6.9 }),
  Object.freeze({ id: 'whitewater', name: 'WHITEWATER', s: 574, x: 6, y: 28, radius: 7.4 }),
  Object.freeze({ id: 'summit-door', name: 'SUMMIT DOOR', s: 636, x: -28, y: 41, radius: 6.8 }),
  Object.freeze({ id: 'homewind', name: 'HOMEWIND', s: 700, x: 0, y: 34, radius: 8.0 }),
]);

export { WING_RIVALS };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const AUTHORED_SEGMENTS = Object.freeze([
  Object.freeze({ id: 'launch', name: 'LAUNCH RIDGE', type: 'race', startS: 0, endS: 112, phase: 'opening' }),
  Object.freeze({ id: 'ice-fork', name: 'ICE FORK', type: 'fork', startS: 112, endS: 224, phase: 'choice' }),
  Object.freeze({ id: 'sun-run', name: 'SUN RUN', type: 'targets', startS: 224, endS: 338, phase: 'pressure' }),
  Object.freeze({ id: 'storm-switchback', name: 'STORM SWITCHBACK', type: 'hazards', startS: 338, endS: 454, phase: 'reversal' }),
  Object.freeze({ id: 'eagle-line', name: 'EAGLE LINE', type: 'stunts', startS: 454, endS: 574, phase: 'mastery' }),
  Object.freeze({ id: 'summit-assault', name: 'SUMMIT ASSAULT', type: 'combat', startS: 574, endS: 700, phase: 'finale' }),
  Object.freeze({ id: 'homewind', name: 'HOMEWIND', type: 'finish', startS: 700, endS: 748, phase: 'finish' }),
]);

const AUTHORED_FORKS = Object.freeze([
  Object.freeze({
    id: 'ice-chute', name: 'ICE CHUTE', decisionS: 100, startS: 112, rejoinS: 224, safeBranchId: 'safe',
    branches: Object.freeze([
      Object.freeze({ id: 'safe', name: 'SUNWARD ARC', offsetX: 0, offsetY: 0, speedFactor: 1, risk: 0.15, reward: 0.2 }),
      Object.freeze({ id: 'shortcut', name: 'BLUE ICE SLOT', offsetX: -20, offsetY: -7, speedFactor: 1.12, risk: 0.72, reward: 0.88 }),
    ]),
  }),
  Object.freeze({
    id: 'storm-gap', name: 'STORM GAP', decisionS: 326, startS: 338, rejoinS: 454, safeBranchId: 'safe',
    branches: Object.freeze([
      Object.freeze({ id: 'safe', name: 'LARCH SHELTER', offsetX: 0, offsetY: 0, speedFactor: 0.98, risk: 0.2, reward: 0.25 }),
      Object.freeze({ id: 'shortcut', name: 'THUNDER LINE', offsetX: 24, offsetY: 9, speedFactor: 1.15, risk: 0.82, reward: 1 }),
    ]),
  }),
  Object.freeze({
    id: 'summit-door', name: 'SUMMIT DOOR', decisionS: 562, startS: 574, rejoinS: 636, safeBranchId: 'safe',
    branches: Object.freeze([
      Object.freeze({ id: 'safe', name: 'VALLEY DOOR', offsetX: 0, offsetY: 0, speedFactor: 1, risk: 0.18, reward: 0.2 }),
      Object.freeze({ id: 'shortcut', name: 'EAGLE KEYHOLE', offsetX: -17, offsetY: 12, speedFactor: 1.1, risk: 0.67, reward: 0.82 }),
    ]),
  }),
]);

const AUTHORED_VOLUMES = Object.freeze({
  thermals: Object.freeze([
    Object.freeze({ id: 'glacier-lift', kind: 'thermal', s: 148, x: 2, y: 38, radiusS: 24, radiusX: 13, radiusY: 15, lift: 11, energy: 0.22 }),
    Object.freeze({ id: 'larch-lift', kind: 'thermal', s: 312, x: -23, y: 40, radiusS: 22, radiusX: 12, radiusY: 14, lift: 9, energy: 0.18 }),
    Object.freeze({ id: 'eagle-lift', kind: 'thermal', s: 494, x: 31, y: 38, radiusS: 26, radiusX: 14, radiusY: 17, lift: 12, energy: 0.24 }),
    Object.freeze({ id: 'summit-lift', kind: 'thermal', s: 624, x: -22, y: 43, radiusS: 20, radiusX: 11, radiusY: 15, lift: 13, energy: 0.25 }),
  ]),
  proximity: Object.freeze([
    Object.freeze({ id: 'needle-thread', kind: 'cliff', s: 72, x: 0, y: 29, radiusS: 25, radiusX: 9, radiusY: 10, scoreRate: 45 }),
    Object.freeze({ id: 'blue-wall-skim', kind: 'ice-wall', s: 438, x: 20, y: 42, radiusS: 31, radiusX: 10, radiusY: 13, scoreRate: 62 }),
    Object.freeze({ id: 'whitewater-skim', kind: 'river', s: 560, x: 8, y: 27, radiusS: 28, radiusX: 15, radiusY: 8, scoreRate: 52 }),
  ]),
  hazards: Object.freeze([
    Object.freeze({ id: 'ice-shear', kind: 'downdraft', s: 184, x: -19, y: 30, radiusS: 20, radiusX: 12, radiusY: 11, damage: 0.08, turbulence: 0.55 }),
    Object.freeze({ id: 'storm-cell-a', kind: 'lightning', s: 372, x: 12, y: 43, radiusS: 24, radiusX: 15, radiusY: 14, damage: 0.22, turbulence: 0.72 }),
    Object.freeze({ id: 'storm-cell-b', kind: 'debris', s: 421, x: 29, y: 39, radiusS: 21, radiusX: 13, radiusY: 12, damage: 0.16, turbulence: 0.64 }),
    Object.freeze({ id: 'summit-rotor', kind: 'rotor', s: 605, x: -18, y: 45, radiusS: 18, radiusX: 12, radiusY: 13, damage: 0.12, turbulence: 0.82 }),
  ]),
});

function trimSegments(finishS){
  return Object.freeze(AUTHORED_SEGMENTS
    .filter(segment => segment.startS < finishS)
    .map(segment => Object.freeze({ ...segment, endS: Math.min(segment.endS, finishS) })));
}

function trimVolumes(volumes, finishS){
  return Object.freeze(volumes.filter(volume => volume.s - volume.radiusS <= finishS));
}

export function createWingRoute(kind = 'full'){
  const normalized = kind === 'quick' ? 'quick' : 'full';
  const gates = normalized === 'quick' ? FULL_GATES.slice(0, 6) : FULL_GATES.slice();
  const finishS = gates[gates.length - 1].s + 48;
  const forks = Object.freeze(AUTHORED_FORKS.filter(fork => fork.rejoinS <= finishS));
  const volumes = Object.freeze({
    thermals: trimVolumes(AUTHORED_VOLUMES.thermals, finishS),
    proximity: trimVolumes(AUTHORED_VOLUMES.proximity, finishS),
    hazards: trimVolumes(AUTHORED_VOLUMES.hazards, finishS),
  });
  return Object.freeze({
    id: normalized,
    name: normalized === 'quick' ? 'RIDGELINE SIX' : 'ALPINE TWELVE',
    gates: Object.freeze(gates),
    segments: trimSegments(finishS),
    forks,
    volumes,
    finishS,
    length: finishS,
  });
}

export function createRouteTraversalState(route){
  if(!route?.id) throw new TypeError('createRouteTraversalState requires a route');
  return { routeId: route.id, branchChoices: {} };
}

export function lockRouteBranch(state, route, forkId, requestedBranchId){
  if(!state || !route) throw new TypeError('lockRouteBranch requires state and route');
  const fork = route.forks?.find(entry => entry.id === forkId);
  if(!fork) throw new RangeError(`unknown route fork ${forkId}`);
  if(Object.prototype.hasOwnProperty.call(state.branchChoices || {}, forkId)) return state;
  const branchId = fork.branches.some(branch => branch.id === requestedBranchId)
    ? requestedBranchId
    : fork.safeBranchId;
  return {
    ...state,
    branchChoices: { ...(state.branchChoices || {}), [forkId]: branchId },
  };
}

export function routeBranchAtS(route, s, state = null){
  if(!route) throw new TypeError('routeBranchAtS requires a route');
  const bounded = clamp(Number.isFinite(s) ? s : 0, 0, route.finishS);
  const fork = route.forks?.find(entry => bounded >= entry.startS && bounded < entry.rejoinS);
  if(!fork) return null;
  const lockedId = state?.branchChoices?.[fork.id];
  const branchId = fork.branches.some(branch => branch.id === lockedId) ? lockedId : fork.safeBranchId;
  return {
    forkId: fork.id,
    branchId,
    locked: Boolean(lockedId),
    branch: fork.branches.find(entry => entry.id === branchId),
    startS: fork.startS,
    rejoinS: fork.rejoinS,
  };
}

export function routeSegmentAtS(route, s){
  if(!route) throw new TypeError('routeSegmentAtS requires a route');
  const bounded = clamp(Number.isFinite(s) ? s : 0, 0, route.finishS);
  return route.segments?.find(segment => bounded >= segment.startS
    && (bounded < segment.endS || segment.endS === route.finishS)) || null;
}

function baseRoutePointAtS(route, s, out){
  if(!route?.gates?.length) throw new TypeError('routePointAtS requires a route');
  const bounded = clamp(Number.isFinite(s) ? s : 0, 0, route.finishS);
  let previous = { s: 0, x: 0, y: 33 };
  for(const gate of route.gates){
    if(bounded <= gate.s){
      const span = Math.max(1, gate.s - previous.s);
      const t = clamp((bounded - previous.s) / span, 0, 1);
      const eased = t * t * (3 - 2 * t);
      out.x = previous.x + (gate.x - previous.x) * eased;
      out.y = previous.y + (gate.y - previous.y) * eased;
      return out;
    }
    previous = gate;
  }
  const tail = clamp((bounded - previous.s) / Math.max(1, route.finishS - previous.s), 0, 1);
  out.x = previous.x * (1 - tail);
  out.y = previous.y + (36 - previous.y) * tail;
  return out;
}

export function routePointAtS(route, s, out = { x: 0, y: 33 }, state = null){
  const bounded = clamp(Number.isFinite(s) ? s : 0, 0, route?.finishS || 0);
  baseRoutePointAtS(route, bounded, out);
  const active = routeBranchAtS(route, bounded, state);
  if(!active) return out;
  const phase = clamp((bounded - active.startS) / Math.max(1, active.rejoinS - active.startS), 0, 1);
  const blend = Math.sin(Math.PI * phase);
  out.x += active.branch.offsetX * blend;
  out.y += active.branch.offsetY * blend;
  return out;
}

function volumeSample(sample){
  if(Number.isFinite(sample)) return { s: sample, x: 0, y: 33 };
  return {
    s: Number.isFinite(sample?.s) ? sample.s : 0,
    x: Number.isFinite(sample?.x) ? sample.x : 0,
    y: Number.isFinite(sample?.y) ? sample.y : 33,
  };
}

export function queryRouteVolumes(route, collection, sample){
  if(!route?.volumes) throw new TypeError('queryRouteVolumes requires a route');
  const volumes = route.volumes[collection];
  if(!Array.isArray(volumes)) throw new RangeError(`unknown route volume collection ${collection}`);
  const point = volumeSample(sample);
  return volumes.map(volume => {
    const ds = (point.s - volume.s) / Math.max(0.001, volume.radiusS);
    const dx = (point.x - volume.x) / Math.max(0.001, volume.radiusX);
    const dy = (point.y - volume.y) / Math.max(0.001, volume.radiusY);
    const normalizedDistance = Math.sqrt(ds * ds + dx * dx + dy * dy);
    return { ...volume, normalizedDistance, influence: clamp(1 - normalizedDistance, 0, 1) };
  }).filter(hit => hit.influence > 0)
    .sort((left, right) => right.influence - left.influence || left.id.localeCompare(right.id));
}

export const queryThermalVolumes = (route, sample) => queryRouteVolumes(route, 'thermals', sample);
export const queryProximityVolumes = (route, sample) => queryRouteVolumes(route, 'proximity', sample);
export const queryHazardVolumes = (route, sample) => queryRouteVolumes(route, 'hazards', sample);

export function queryForkVolumes(route, sample){
  if(!route) throw new TypeError('queryForkVolumes requires a route');
  const point = volumeSample(sample);
  const hits = [];
  for(const fork of route.forks || []){
    if(point.s < fork.startS || point.s >= fork.rejoinS) continue;
    const phase = clamp((point.s - fork.startS) / Math.max(1, fork.rejoinS - fork.startS), 0, 1);
    const blend = Math.sin(Math.PI * phase);
    const center = baseRoutePointAtS(route, point.s, { x: 0, y: 33 });
    for(const branch of fork.branches){
      const dx = (point.x - center.x - branch.offsetX * blend) / 12;
      const dy = (point.y - center.y - branch.offsetY * blend) / 12;
      const normalizedDistance = Math.sqrt(dx * dx + dy * dy);
      if(normalizedDistance < 1){
        hits.push({
          forkId: fork.id,
          branchId: branch.id,
          safe: branch.id === fork.safeBranchId,
          normalizedDistance,
          influence: 1 - normalizedDistance,
        });
      }
    }
  }
  return hits.sort((left, right) => right.influence - left.influence
    || left.forkId.localeCompare(right.forkId) || left.branchId.localeCompare(right.branchId));
}

export function gateDistance(gate, x, y){
  if(!gate) return Number.POSITIVE_INFINITY;
  return Math.hypot(x - gate.x, y - gate.y);
}

export function gateRadius(gate, control = 'guided'){
  const multiplier = control === 'direct' ? 1 : 1.26;
  return gate.radius * multiplier;
}

export function evaluateGate(gate, x, y, control = 'guided'){
  const distance = gateDistance(gate, x, y);
  const radius = gateRadius(gate, control);
  return Object.freeze({ passed: distance <= radius, distance, radius, margin: radius - distance });
}

export function rivalFinishTime(profile, route){
  return legacyRivalFinishTime(profile, route);
}

export function rivalProgress(profile, time, route){
  return legacyRivalProgress(profile, time, route);
}

export function raceStanding(playerS, time, route, race = 'rivals'){
  return legacyRaceStanding(playerS, time, route, race);
}
