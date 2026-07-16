import {
  ASHFALL_BOUNDS,
  ASHFALL_SCORE,
  ASHFALL_WAVE,
  ashfallCompletionBonus,
  ashfallWaveSchedule,
} from './rules.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const approach = (value, target, maxDelta) => value < target
  ? Math.min(target, value + maxDelta)
  : Math.max(target, value - maxDelta);

const MODES = Object.freeze({ quick: 30, full: 60 });
export const ASHFALL_INTENSITY = Object.freeze({
  calm: Object.freeze({ telegraphLead: 1.65, cadence: 1.48, meteorSpeed: 14, hitRadius: 0.82, nearRadius: 1.75 }),
  standard: Object.freeze({ telegraphLead: 1.28, cadence: 1.05, meteorSpeed: 19, hitRadius: 0.88, nearRadius: 1.9 }),
  inferno: Object.freeze({ telegraphLead: 1.02, cadence: 0.74, meteorSpeed: 24, hitRadius: 0.94, nearRadius: 2.05 }),
});

export function ashfallDuration(mode){
  return MODES[mode] ?? MODES.full;
}

function mulberry32(seed){
  let value = seed >>> 0;
  return () => {
    value |= 0;
    value = value + 0x6D2B79F5 | 0;
    let out = Math.imul(value ^ value >>> 15, 1 | value);
    out = out + Math.imul(out ^ out >>> 7, 61 | out) ^ out;
    return ((out ^ out >>> 14) >>> 0) / 4294967296;
  };
}

function copyHazard(hazard){
  return {
    id: hazard.id,
    x: hazard.x,
    z: hazard.z,
    spawnedAt: hazard.spawnedAt,
    impactAt: hazard.impactAt,
    lead: hazard.lead,
    meteorSpeed: hazard.meteorSpeed,
    kind: hazard.kind,
    waveId: hazard.waveId,
    gapIndex: hazard.gapIndex,
    radiusScale: hazard.radiusScale,
    resolved: hazard.resolved,
    outcome: hazard.outcome,
    ageAfterImpact: hazard.ageAfterImpact,
  };
}

function copyState(state){
  return Object.freeze({
    status: state.status,
    time: state.time,
    duration: state.duration,
    remaining: Math.max(0, state.duration - state.time),
    hearts: state.hearts,
    score: Math.floor(state.score),
    survivalScore: Math.floor(state.survivalScore),
    completionBonus: state.completionBonus,
    evades: state.evades,
    nearMisses: state.nearMisses,
    hits: state.hits,
    invulnerable: state.invulnerable,
    dashCooldown: state.dashCooldown,
    dashDuration: state.dashDuration,
    dashReady: state.dashCooldown <= 0,
    x: state.x,
    z: state.z,
    targetX: state.targetX,
    targetZ: state.targetZ,
    vx: state.vx,
    vz: state.vz,
    facingX: state.facingX,
    facingZ: state.facingZ,
    spawnCount: state.spawnCount,
    waveCount: state.waveCount,
    hazards: Object.freeze(state.hazards.map(copyHazard).map(Object.freeze)),
  });
}

/** Fixed-step volcanic survival simulation. Rendering and wall time never own gameplay. */
export function createAshfallSim({
  mode = 'full',
  intensity = 'standard',
  seed = 0xA5F411,
  duration = null,
  hazardPlan = null,
  initialSpawnDelay = 0.55,
} = {}){
  if(!Object.hasOwn(MODES, mode)) throw new RangeError(`unsupported ashMode: ${mode}`);
  if(!Object.hasOwn(ASHFALL_INTENSITY, intensity)) throw new RangeError(`unsupported ashIntensity: ${intensity}`);
  if(duration !== null && (!Number.isFinite(duration) || duration <= 0)) throw new RangeError('duration must be positive');
  if(hazardPlan !== null && typeof hazardPlan !== 'function') throw new TypeError('hazardPlan must be a function');
  if(!Number.isFinite(initialSpawnDelay) || initialSpawnDelay < 0) throw new RangeError('initialSpawnDelay must be non-negative');

  const profile = ASHFALL_INTENSITY[intensity];
  const config = Object.freeze({
    mode,
    intensity,
    seed: seed >>> 0,
    duration: duration ?? ashfallDuration(mode),
    bounds: ASHFALL_BOUNDS,
    moveSpeed: 7.1,
    acceleration: 26,
    dashSpeed: 18,
    dashSeconds: 0.24,
    dashCooldown: 1.28,
    invulnerability: 1.25,
    impactLife: 0.74,
    waveSchedule: ashfallWaveSchedule(duration ?? ashfallDuration(mode)),
    ...profile,
  });
  let rng = mulberry32(config.seed);
  let waveRng = mulberry32(config.seed ^ 0x9E3779B9);
  let events = [];
  let state;

  function initialState(){
    return {
      status: 'running',
      time: 0,
      duration: config.duration,
      hearts: 3,
      score: 0,
      survivalScore: 0,
      completionBonus: 0,
      evades: 0,
      nearMisses: 0,
      hits: 0,
      invulnerable: 0,
      dashCooldown: 0,
      dashDuration: 0,
      x: 0,
      z: 1.2,
      targetX: 0,
      targetZ: 1.2,
      vx: 0,
      vz: 0,
      facingX: 0,
      facingZ: -1,
      spawnCount: 0,
      regularSpawnCount: 0,
      waveCount: 0,
      nextWaveIndex: 0,
      nextSpawnAt: initialSpawnDelay,
      hazards: [],
    };
  }

  function emit(type, detail = {}){
    events.push(Object.freeze({ type, time: state.time, ...detail }));
  }

  function planHazard(index){
    if(hazardPlan){
      const planned = hazardPlan(Object.freeze({ index, time: state.time, player: Object.freeze({ x: state.x, z: state.z }) }));
      if(planned && Number.isFinite(planned.x) && Number.isFinite(planned.z)) return planned;
    }
    const angle = rng() * Math.PI * 2;
    const aimed = index % 4 === 0;
    const radius = aimed ? 0.35 + rng() * 1.15 : 1.35 + rng() * 5.1;
    const focusX = aimed ? state.targetX : state.x;
    const focusZ = aimed ? state.targetZ : state.z;
    return {
      x: focusX + Math.cos(angle) * radius,
      z: focusZ + Math.sin(angle) * radius,
      leadScale: 0.92 + rng() * 0.16,
    };
  }

  function addHazard(planned, {
    kind = 'meteor',
    waveId = null,
    gapIndex = null,
    leadOverride = null,
    radiusScale = 1,
  } = {}){
    const lead = leadOverride ?? config.telegraphLead * (planned.leadScale ?? 1);
    const hazard = {
      id: ++state.spawnCount,
      x: clamp(planned.x, config.bounds.minX, config.bounds.maxX),
      z: clamp(planned.z, config.bounds.minZ, config.bounds.maxZ),
      spawnedAt: state.time,
      impactAt: state.time + lead,
      lead,
      meteorSpeed: config.meteorSpeed,
      resolved: false,
      outcome: 'pending',
      ageAfterImpact: 0,
      kind,
      waveId,
      gapIndex,
      radiusScale,
    };
    state.hazards.push(hazard);
    emit('telegraph', { id: hazard.id, x: hazard.x, z: hazard.z, lead, kind, waveId, radiusScale });
    return hazard;
  }

  function spawnHazard(){
    const index = ++state.regularSpawnCount;
    const planned = planHazard(index);
    addHazard(planned);
    const cadenceJitter = 0.84 + rng() * 0.32;
    state.nextSpawnAt += config.cadence * cadenceJitter;
  }

  function spawnPerimeterWave(waveIndex){
    const waveId = `perimeter-${waveIndex + 1}`;
    const phase = waveRng() * Math.PI * 2;
    const gapIndex = Math.floor(waveRng() * ASHFALL_WAVE.slots);
    const lead = Math.max(config.telegraphLead, ASHFALL_WAVE.minimumLead);
    const gapAngle = phase + gapIndex / ASHFALL_WAVE.slots * Math.PI * 2;
    state.waveCount += 1;
    emit('wave-telegraph', {
      waveId,
      gapIndex,
      lead,
      gapX: Math.cos(gapAngle) * ASHFALL_WAVE.radiusX,
      gapZ: ASHFALL_WAVE.centerZ + Math.sin(gapAngle) * ASHFALL_WAVE.radiusZ,
    });
    for(let slot = 0; slot < ASHFALL_WAVE.slots; slot += 1){
      if(slot === gapIndex) continue;
      const angle = phase + slot / ASHFALL_WAVE.slots * Math.PI * 2;
      addHazard({
        x: Math.cos(angle) * ASHFALL_WAVE.radiusX,
        z: ASHFALL_WAVE.centerZ + Math.sin(angle) * ASHFALL_WAVE.radiusZ,
      }, {
        kind: 'perimeter-wave',
        waveId,
        gapIndex,
        leadOverride: lead,
        radiusScale: ASHFALL_WAVE.radiusScale,
      });
    }
  }

  function setTarget(x, z){
    if(!Number.isFinite(x) || !Number.isFinite(z)) return false;
    state.targetX = clamp(x, config.bounds.minX, config.bounds.maxX);
    state.targetZ = clamp(z, config.bounds.minZ, config.bounds.maxZ);
    return true;
  }

  function dash(){
    if(state.status !== 'running' || state.dashCooldown > 0) return false;
    let dx = state.targetX - state.x;
    let dz = state.targetZ - state.z;
    const distance = Math.hypot(dx, dz);
    if(distance > 0.12){ dx /= distance; dz /= distance; }
    else { dx = state.facingX; dz = state.facingZ; }
    const facingLength = Math.hypot(dx, dz) || 1;
    state.facingX = dx / facingLength;
    state.facingZ = dz / facingLength;
    state.targetX = clamp(state.x + state.facingX * 4.2, config.bounds.minX, config.bounds.maxX);
    state.targetZ = clamp(state.z + state.facingZ * 4.2, config.bounds.minZ, config.bounds.maxZ);
    state.dashDuration = config.dashSeconds;
    state.dashCooldown = config.dashCooldown;
    emit('dash', { x: state.x, z: state.z, facingX: state.facingX, facingZ: state.facingZ });
    return true;
  }

  function movePlayer(dt){
    const dx = state.targetX - state.x;
    const dz = state.targetZ - state.z;
    const distance = Math.hypot(dx, dz);
    let desiredX = 0;
    let desiredZ = 0;
    if(distance > 0.025){
      const speed = state.dashDuration > 0 ? config.dashSpeed : Math.min(config.moveSpeed, distance * 5.4);
      desiredX = dx / distance * speed;
      desiredZ = dz / distance * speed;
      state.facingX = dx / distance;
      state.facingZ = dz / distance;
    }
    const acceleration = state.dashDuration > 0 ? config.acceleration * 3.2 : config.acceleration;
    state.vx = approach(state.vx, desiredX, acceleration * dt);
    state.vz = approach(state.vz, desiredZ, acceleration * dt);
    state.x = clamp(state.x + state.vx * dt, config.bounds.minX, config.bounds.maxX);
    state.z = clamp(state.z + state.vz * dt, config.bounds.minZ, config.bounds.maxZ);
  }

  function resolveHazard(hazard){
    const distance = Math.hypot(state.x - hazard.x, state.z - hazard.z);
    const hitRadius = config.hitRadius * (hazard.radiusScale ?? 1);
    hazard.resolved = true;
    if(distance <= hitRadius){
      if(state.invulnerable > 0){
        hazard.outcome = 'shielded';
        emit('shielded', { id: hazard.id, x: hazard.x, z: hazard.z, distance });
      } else {
        state.hearts -= 1;
        state.hits += 1;
        state.invulnerable = config.invulnerability;
        state.score = Math.max(0, state.score - ASHFALL_SCORE.hitPenalty);
        hazard.outcome = 'hit';
        emit('hit', { id: hazard.id, x: hazard.x, z: hazard.z, hearts: state.hearts, distance });
        if(state.hearts <= 0){
          state.status = 'lost';
          state.vx = state.vz = 0;
          emit('failed', { score: Math.floor(state.score), survival: state.time });
        }
      }
      return;
    }
    if(hazard.kind === 'perimeter-wave'){
      hazard.outcome = 'clear';
      emit('impact', { id: hazard.id, x: hazard.x, z: hazard.z, distance, kind: hazard.kind, waveId: hazard.waveId });
      return;
    }
    if(distance <= config.nearRadius){
      state.nearMisses += 1;
      state.score += ASHFALL_SCORE.nearMiss;
      hazard.outcome = 'near-miss';
      emit('near-miss', { id: hazard.id, x: hazard.x, z: hazard.z, distance });
      return;
    }
    if(distance <= config.nearRadius + 2.4){
      state.evades += 1;
      state.score += ASHFALL_SCORE.evade;
      hazard.outcome = 'evade';
      emit('evade', { id: hazard.id, x: hazard.x, z: hazard.z, distance });
      return;
    }
    hazard.outcome = 'clear';
    emit('impact', { id: hazard.id, x: hazard.x, z: hazard.z, distance });
  }

  function step(dt){
    if(!Number.isFinite(dt) || dt <= 0) throw new RangeError('dt must be positive');
    if(state.status !== 'running') return snapshot();
    state.time = Math.min(state.duration, state.time + dt);
    state.invulnerable = Math.max(0, state.invulnerable - dt);
    state.dashCooldown = Math.max(0, state.dashCooldown - dt);
    state.dashDuration = Math.max(0, state.dashDuration - dt);
    state.survivalScore += dt * ASHFALL_SCORE.survivalPerSecond;
    state.score += dt * ASHFALL_SCORE.survivalPerSecond;
    movePlayer(dt);

    while(state.nextSpawnAt <= state.time && state.nextSpawnAt < state.duration) spawnHazard();
    while(state.nextWaveIndex < config.waveSchedule.length && config.waveSchedule[state.nextWaveIndex] <= state.time){
      spawnPerimeterWave(state.nextWaveIndex);
      state.nextWaveIndex += 1;
    }
    for(const hazard of state.hazards){
      if(!hazard.resolved && state.time >= hazard.impactAt) resolveHazard(hazard);
      if(hazard.resolved) hazard.ageAfterImpact += dt;
    }
    state.hazards = state.hazards.filter(hazard => !hazard.resolved || hazard.ageAfterImpact <= config.impactLife);

    if(state.status === 'running' && state.time >= state.duration){
      state.status = 'won';
      state.vx = state.vz = 0;
      state.completionBonus = ashfallCompletionBonus(state.duration, state.hearts);
      state.score += state.completionBonus;
      emit('finished', { score: Math.floor(state.score), hearts: state.hearts, completionBonus: state.completionBonus });
    }
    return snapshot();
  }

  function drainEvents(){
    if(events.length === 0) return Object.freeze([]);
    const drained = Object.freeze(events);
    events = [];
    return drained;
  }

  function reset(){
    rng = mulberry32(config.seed);
    waveRng = mulberry32(config.seed ^ 0x9E3779B9);
    state = initialState();
    events = [];
    emit('reset', { mode, intensity, duration: state.duration });
    return snapshot();
  }

  function snapshot(){ return copyState(state); }

  state = initialState();
  emit('reset', { mode, intensity, duration: state.duration });

  return Object.freeze({
    setTarget,
    dash,
    step,
    reset,
    snapshot,
    drainEvents,
    config,
    get state(){ return snapshot(); },
  });
}
