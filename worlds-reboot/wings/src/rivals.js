/* PAPER WINGS - deterministic kinematic rival pilots and race ranking. */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export const WING_RIVALS = Object.freeze([
  Object.freeze({
    id: 'sora', name: 'SORA', color: 0xd95b45, style: 'swept',
    finishTime: 37.8, quickFinishTime: 19.5, lane: -8.5, altitude: 2.1,
    pace: 1.04, acceleration: 13.5, boostAt: 0.54, recoverAt: 0.22,
    risk: 0.88, aim: 0.78, targetBias: 1.2,
  }),
  Object.freeze({
    id: 'vale', name: 'VALE', color: 0xe2ad45, style: 'biplane',
    finishTime: 40.4, quickFinishTime: 21.5, lane: 8.2, altitude: -1.6,
    pace: 1, acceleration: 11.5, boostAt: 0.66, recoverAt: 0.28,
    risk: 0.52, aim: 0.9, targetBias: 1.45,
  }),
  Object.freeze({
    id: 'pip', name: 'PIP', color: 0x325f8f, style: 'delta',
    finishTime: 43.1, quickFinishTime: 23.5, lane: 2.8, altitude: 4,
    pace: 0.96, acceleration: 10.5, boostAt: 0.72, recoverAt: 0.34,
    risk: 0.28, aim: 0.66, targetBias: 0.9,
  }),
]);

export function legacyRivalFinishTime(profile, route){
  if(!profile || !route) throw new TypeError('rivalFinishTime requires a profile and route');
  return route.id === 'quick' ? profile.quickFinishTime : profile.finishTime;
}

export function legacyRivalProgress(profile, time, route){
  if(!profile || !route) throw new TypeError('rivalProgress requires a profile and route');
  const phase = WING_RIVALS.indexOf(profile) * 1.7;
  const base = clamp(finite(time) / legacyRivalFinishTime(profile, route), 0, 1) * route.finishS;
  const launchBlend = clamp(finite(time) / 2.5, 0, 1);
  const weave = Math.sin(finite(time) * 0.72 + phase) * 2.4 * launchBlend * (1 - Math.min(1, base / route.finishS));
  return clamp(base + weave, 0, route.finishS);
}

export function legacyRaceStanding(playerS, time, route, race = 'rivals'){
  if(race !== 'rivals') return Object.freeze({ rank: 1, total: 1, entries: Object.freeze([]) });
  const entries = WING_RIVALS.map(profile => Object.freeze({
    id: profile.id,
    name: profile.name,
    s: legacyRivalProgress(profile, time, route),
  }));
  const rank = 1 + entries.filter(entry => entry.s > finite(playerS) + 0.01).length;
  return Object.freeze({ rank, total: 4, entries: Object.freeze(entries) });
}

function profileById(profile){
  if(typeof profile === 'string') return WING_RIVALS.find(entry => entry.id === profile) || null;
  if(profile && typeof profile === 'object') return profile;
  return null;
}

function routeBaseSpeed(profile, route){
  return route.finishS / legacyRivalFinishTime(profile, route) * profile.pace;
}

export function createRivalState(profile, route){
  const resolved = profileById(profile);
  if(!resolved || !route?.finishS) throw new TypeError('createRivalState requires a rival profile and route');
  return {
    id: resolved.id,
    name: resolved.name,
    s: 0,
    speed: 0,
    energy: 0.58 + resolved.risk * 0.16,
    lateral: resolved.lane,
    altitude: resolved.altitude,
    elapsed: 0,
    finished: false,
    finishElapsed: null,
    action: 'launch',
    targetId: null,
    branchChoices: {},
    targetsHit: 0,
  };
}

export function createRivalField(route, profiles = WING_RIVALS){
  if(!Array.isArray(profiles)) throw new TypeError('profiles must be an array');
  return profiles.map(profile => createRivalState(profile, route));
}

function availableBranches(fork){
  return Array.isArray(fork?.branches) ? fork.branches : [];
}

export function chooseRivalBranch(profile, state, fork, context = {}){
  const resolved = profileById(profile);
  if(!resolved || !state || !fork) return fork?.safeBranchId || 'safe';
  const branches = availableBranches(fork);
  const safe = branches.find(branch => branch.id === fork.safeBranchId) || branches[0];
  const risky = branches
    .filter(branch => branch.id !== safe?.id)
    .sort((left, right) => finite(right.reward) - finite(right.risk) - (finite(left.reward) - finite(left.risk)))[0];
  if(!risky) return safe?.id || 'safe';
  const hazard = clamp(finite(context.hazard, finite(fork.hazard)), 0, 1);
  const energy = clamp(finite(state.energy), 0, 1);
  const urgency = clamp((finite(context.playerS) - finite(state.s)) / 90, -1, 1);
  const appetite = resolved.risk + energy * 0.24 + Math.max(0, urgency) * 0.16;
  const cost = finite(risky.risk, hazard) + hazard * (1 - resolved.risk) * 0.45;
  return appetite >= cost ? risky.id : safe?.id || fork.safeBranchId || 'safe';
}

export function chooseRivalTarget(profile, state, targets = []){
  const resolved = profileById(profile);
  if(!resolved || !state || !Array.isArray(targets)) return null;
  const viable = targets.filter(target => target && target.active !== false && !target.destroyed
    && Number.isFinite(target.s) && target.s >= state.s - 4 && target.s <= state.s + 150);
  if(!viable.length) return null;
  const prior = viable.find(target => target.id === state.targetId);
  if(prior) return prior.id;
  viable.sort((left, right) => {
    const leftScore = finite(left.value, 1) * resolved.targetBias - Math.abs(left.s - state.s) / 100;
    const rightScore = finite(right.value, 1) * resolved.targetBias - Math.abs(right.s - state.s) / 100;
    return rightScore - leftScore || String(left.id).localeCompare(String(right.id));
  });
  return viable[0]?.id || null;
}

export function chooseRivalAction(profile, state, route, context = {}){
  const resolved = profileById(profile);
  if(!resolved || !state || !route) return 'cruise';
  const target = Array.isArray(context.targets)
    ? context.targets.find(entry => entry?.id === state.targetId)
    : null;
  if(target && target.s - state.s <= 48 && state.energy >= 0.16 && resolved.aim >= finite(target.difficulty, 0.5)) return 'attack';
  if(state.energy <= resolved.recoverAt) return 'recover';
  const finalPush = route.finishS - state.s < 130;
  const behind = finite(context.playerS, state.s) > state.s + 18;
  if(state.energy >= resolved.boostAt && (finalPush || behind || resolved.risk > 0.75)) return 'boost';
  return 'cruise';
}

function lockForkChoices(profile, state, route, context){
  const choices = { ...state.branchChoices };
  for(const fork of route.forks || []){
    if(choices[fork.id]) continue;
    const decisionS = finite(fork.decisionS, fork.startS);
    if(state.s < decisionS) continue;
    choices[fork.id] = chooseRivalBranch(profile, state, fork, context);
  }
  return choices;
}

function activeBranch(route, state){
  const fork = (route.forks || []).find(entry => state.s >= entry.startS && state.s < entry.rejoinS);
  if(!fork) return null;
  const branchId = state.branchChoices[fork.id] || fork.safeBranchId;
  return availableBranches(fork).find(branch => branch.id === branchId) || availableBranches(fork)[0] || null;
}

function stepSlice(state, dt, profile, route, context){
  if(state.finished) return state;
  const next = { ...state };
  next.elapsed += dt;
  next.branchChoices = lockForkChoices(profile, next, route, context);
  next.targetId = chooseRivalTarget(profile, next, context.targets || []);
  next.action = chooseRivalAction(profile, next, route, { ...context, targets: context.targets || [] });

  const baseSpeed = routeBaseSpeed(profile, route);
  const speedFactor = next.action === 'boost' ? 1.3 : next.action === 'recover' ? 0.84 : next.action === 'attack' ? 0.96 : 1;
  const branch = activeBranch(route, next);
  const desiredSpeed = baseSpeed * speedFactor * finite(branch?.speedFactor, 1);
  const change = clamp(desiredSpeed - next.speed, -profile.acceleration * dt, profile.acceleration * dt);
  next.speed = Math.max(0, next.speed + change);

  const thermal = clamp(finite(context.thermal), 0, 1);
  const energyRate = next.action === 'boost' ? -0.2
    : next.action === 'attack' ? -0.11
      : next.action === 'recover' ? 0.17
        : 0.055;
  next.energy = clamp(next.energy + (energyRate + thermal * 0.14) * dt, 0, 1);
  const priorS = next.s;
  const travel = next.speed * dt;
  next.s = Math.min(route.finishS, next.s + travel);

  const lateralTarget = profile.lane + finite(branch?.offsetX, finite(branch?.lateralOffset));
  const altitudeTarget = profile.altitude + finite(branch?.offsetY, finite(branch?.altitudeOffset));
  const blend = clamp(dt * 2.8, 0, 1);
  next.lateral += (lateralTarget - next.lateral) * blend;
  next.altitude += (altitudeTarget - next.altitude) * blend;

  if(next.s >= route.finishS){
    const fraction = clamp((route.finishS - priorS) / Math.max(0.000001, travel), 0, 1);
    next.finished = true;
    next.finishElapsed = state.elapsed + dt * fraction;
    next.action = 'finished';
    next.speed = 0;
  }
  return next;
}

export function stepRival(state, dt, route, context = {}){
  if(!state || !route) throw new TypeError('stepRival requires state and route');
  const profile = profileById(state.id);
  if(!profile) throw new RangeError(`unknown rival ${state.id}`);
  let remaining = clamp(finite(dt), 0, 1);
  let next = { ...state, branchChoices: { ...(state.branchChoices || {}) } };
  while(remaining > 0.0000001){
    const slice = Math.min(1 / 30, remaining);
    next = stepSlice(next, slice, profile, route, context);
    remaining -= slice;
  }
  return next;
}

export function stepRivalField(states, dt, route, context = {}){
  if(!Array.isArray(states)) throw new TypeError('states must be an array');
  return states.map(state => stepRival(state, dt, route, context));
}

function rankEntry(entry, isPlayer = false){
  return {
    id: entry.id || (isPlayer ? 'player' : 'rival'),
    name: entry.name || (isPlayer ? 'YOU' : entry.id),
    s: finite(entry.s),
    finished: entry.finished === true,
    finishElapsed: Number.isFinite(entry.finishElapsed) ? entry.finishElapsed : null,
    isPlayer,
  };
}

export function rankRace(player, rivals = []){
  if(!player || !Array.isArray(rivals)) throw new TypeError('rankRace requires a player and rivals');
  const playerEntry = rankEntry(player, true);
  const entries = [playerEntry, ...rivals.map(entry => rankEntry(entry, false))];
  entries.sort((left, right) => {
    if(left.finished !== right.finished) return left.finished ? -1 : 1;
    if(left.finished) return left.finishElapsed - right.finishElapsed || left.id.localeCompare(right.id);
    return right.s - left.s || left.id.localeCompare(right.id);
  });
  return {
    rank: entries.findIndex(entry => entry.isPlayer) + 1,
    total: entries.length,
    entries,
  };
}
