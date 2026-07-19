/* PAPER WINGS - deterministic mission command tapes for tests and ?auto playback. */
import { flightSnapshot, createFlightState, startFlight, stepFlight, FLIGHT_STATUS } from './flight.js';
import { WING_MISSION_IDS } from './missions.js';
import { createWingRoute, routePointAtS } from './route.js';

export const AUTOPILOT_STATE_VERSION = 1;
const TAU = Math.PI * 2;
const TERMINAL = new Set([FLIGHT_STATUS.FINISHED, FLIGHT_STATUS.FAILED]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function knownMission(missionId){
  if(!WING_MISSION_IDS.includes(missionId)) throw new RangeError(`unknown Paper Wings mission ${missionId}`);
  return missionId;
}

export function createMissionAutopilot(missionId){
  return {
    version: AUTOPILOT_STATE_VERSION,
    missionId: knownMission(missionId),
    step: 0,
  };
}

function activeObjectiveKind(flight, kind){
  return Object.values(flight.objectives?.objectives || {}).some(objective => objective.status === 'active' && objective.kind === kind);
}

function steeringTarget(flight, route){
  const gate = route.gates[Math.min(flight.gateIndex, route.gates.length - 1)];
  if(flight.missionId === 'flight-school' && activeObjectiveKind(flight, 'thermals')){
    const thermal = route.volumes.thermals.find(volume => !flight.encounteredVolumeIds.includes(volume.id)
      && volume.s > flight.s + 1 && (!gate || volume.s < gate.s - 2));
    if(thermal) return thermal;
  }
  return gate || routePointAtS(route, Math.min(route.finishS, flight.s + 40));
}

function upcomingHazard(flight, route){
  if(!['storm-escape', 'skybreaker-finale'].includes(flight.missionId)) return null;
  return route.volumes.hazards.find(hazard => !flight.encounteredVolumeIds.includes(hazard.id)
    && hazard.s >= flight.s - 1 && hazard.s - flight.s <= 34) || null;
}

function combatTarget(flight){
  const target = flight.combat.targets
    .filter(entry => entry.status === 'active' && entry.s > flight.s + 2 && entry.s - flight.s <= 110)
    .sort((left, right) => left.s - right.s || left.id.localeCompare(right.id))[0];
  if(target) return target;
  const boss = flight.combat.boss;
  return boss?.status === 'active' && boss.s > flight.s + 2 && boss.s - flight.s <= 125 ? boss : null;
}

function stuntDeltas(kind){
  if(kind === 'inside-loop') return { pitchDelta: TAU / 52 };
  if(kind === 'wingover') return { rollDelta: Math.PI / 42, yawDelta: Math.PI / 42 };
  if(kind === 'barrel-roll') return { rollDelta: TAU / 58, pitchDelta: Math.PI / 58 };
  return { rollDelta: TAU / 42 };
}

function stuntCommand(flight){
  if(flight.missionId !== 'stunt-trial' || flight.stunts.completions >= 4) return null;
  const kinds = ['axial-roll', 'inside-loop', 'wingover', 'barrel-roll'];
  const kind = flight.stunts.active?.kind || kinds[flight.stunts.completions];
  const id = flight.stunts.active?.id || `auto-stunt-${flight.stunts.completions + 1}`;
  return {
    id,
    kind,
    begin: !flight.stunts.active,
    quality: 1,
    ...stuntDeltas(kind),
  };
}

function firstUnresolvedAt(flight, prefix, thresholds){
  for(let index = 0; index < thresholds.length; index += 1){
    const id = `${prefix}-${index + 1}`;
    if(flight.s >= thresholds[index] && !flight.resolvedActionIds.includes(id)) return id;
  }
  return null;
}

export function nextMissionAutopilot(autopilot, flight, route){
  if(!autopilot || autopilot.version !== AUTOPILOT_STATE_VERSION) throw new TypeError('valid autopilot state is required');
  if(!flight?.missionId || flight.missionId !== autopilot.missionId) throw new TypeError('autopilot mission does not match flight');
  const target = steeringTarget(flight, route);
  const bank = clamp((target.x - flight.x) / 10, -1, 1);
  const pitch = clamp((target.y - flight.y) / 7, -1, 1);
  const hazard = upcomingHazard(flight, route);
  const enemy = combatTarget(flight);
  const command = {
    branch: 'shortcut',
    boost: false,
    shield: Boolean(hazard && flight.energy > 19),
  };
  if(enemy) command.fire = { targetId: enemy.id };
  const stunt = stuntCommand(flight);
  if(stunt) command.stunt = stunt;
  if(flight.missionId === 'mountain-rescue'){
    const rescueId = firstUnresolvedAt(flight, 'rescue', [140, 330, 520]);
    const dropId = firstUnresolvedAt(flight, 'drop', [210, 390, 570]);
    if(rescueId) command.rescueId = rescueId;
    if(dropId) command.dropId = dropId;
  }
  return {
    autopilot: { ...autopilot, step: autopilot.step + 1 },
    axes: { bank, pitch },
    command,
  };
}

function missionRace(missionId){
  return ['ridge-race', 'ace-pursuit', 'skybreaker-finale'].includes(missionId) ? 'rivals' : 'solo';
}

export function buildMissionCommandTape(missionId, options = {}){
  knownMission(missionId);
  const dt = Number.isFinite(options.dt) && options.dt > 0 ? options.dt : 1 / 60;
  const maxSeconds = Number.isFinite(options.maxSeconds) && options.maxSeconds > 0 ? options.maxSeconds : 180;
  const routeId = options.routeId === 'quick' ? 'quick' : 'full';
  const route = createWingRoute(routeId);
  const flightOptions = {
    missionId,
    control: options.control === 'direct' ? 'direct' : 'guided',
    race: options.race || missionRace(missionId),
    seed: Number.isInteger(options.seed) ? options.seed : undefined,
  };
  const flight = createFlightState(route, flightOptions);
  startFlight(flight);
  let autopilot = createMissionAutopilot(missionId);
  const frames = [];
  const maxSteps = Math.ceil(maxSeconds / dt);
  for(let step = 0; step < maxSteps && !TERMINAL.has(flight.status); step += 1){
    const output = nextMissionAutopilot(autopilot, flight, route);
    autopilot = output.autopilot;
    frames.push({ axes: output.axes, command: output.command });
    stepFlight(flight, dt, output.axes, route, output.command);
  }
  return {
    version: 1,
    missionId,
    routeId,
    dt,
    flightOptions,
    frames,
    autopilot,
    finalSnapshot: flightSnapshot(flight),
  };
}

export function replayMissionCommandTape(tape){
  if(!tape || tape.version !== 1 || !Array.isArray(tape.frames)) throw new TypeError('valid mission command tape is required');
  const route = createWingRoute(tape.routeId);
  const flight = createFlightState(route, tape.flightOptions);
  startFlight(flight);
  for(const frame of tape.frames) stepFlight(flight, tape.dt, frame.axes, route, frame.command);
  return flightSnapshot(flight);
}

export const buildAutopilotTape = buildMissionCommandTape;
export const replayAutopilotTape = replayMissionCommandTape;
