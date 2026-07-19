/* PAPER WINGS - seeded stable-ID projectile, target, and multi-phase boss reducer. */

export const COMBAT_STATE_VERSION = 1;

export const COMBAT_ACTION = Object.freeze({
  SPAWN_TARGET: 'spawn-target',
  SPAWN_BOSS: 'spawn-boss',
  SET_BOSS_VULNERABLE: 'set-boss-vulnerable',
  FIRE: 'fire',
  TICK: 'tick',
  DAMAGE_TARGET: 'damage-target',
  DAMAGE_BOSS: 'damage-boss',
});

const DEFAULT_BOSS_PHASES = Object.freeze([
  Object.freeze({ id: 'armor', startsAt: 1, damageMultiplier: 1 }),
  Object.freeze({ id: 'storm', startsAt: 0.66, damageMultiplier: 0.85 }),
  Object.freeze({ id: 'core', startsAt: 0.33, damageMultiplier: 1.25 }),
]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;

function normalizeSeed(seed){
  if(!Number.isInteger(seed)) throw new TypeError('combat seed must be an integer');
  return (seed >>> 0) || 0x6d2b79f5;
}

export function nextCombatSeed(seed){
  let value = normalizeSeed(seed);
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) || 0x6d2b79f5;
}

function seededUnit(seed){
  const next = nextCombatSeed(seed);
  return [next, next / 0x100000000];
}

function namespace(seed){
  return seed.toString(16).padStart(8, '0');
}

function stableId(state, kind, explicitId){
  if(explicitId !== undefined){
    if(typeof explicitId !== 'string' || explicitId.length === 0) throw new TypeError(`${kind} id must be a non-empty string`);
    return [explicitId, state[`${kind}Sequence`]];
  }
  const sequence = state[`${kind}Sequence`];
  const prefix = kind === 'projectile' ? 'p' : kind === 'target' ? 't' : 'b';
  return [`${prefix}-${namespace(state.initialSeed)}-${sequence.toString(36).padStart(4, '0')}`, sequence + 1];
}

function makeEmitter(state){
  let sequence = state.eventSequence;
  const events = [];
  return {
    emit(type, data = {}){
      events.push({ id: `e-${namespace(state.initialSeed)}-${sequence.toString(36).padStart(5, '0')}`, type, ...data });
      sequence += 1;
    },
    finish(next){ return { ...next, events, eventSequence: sequence }; },
  };
}

function assertUniqueEntityId(state, id){
  if(state.projectiles.some(entity => entity.id === id) || state.targets.some(entity => entity.id === id) || state.boss?.id === id) throw new RangeError(`duplicate combat entity id ${id}`);
}

export function createCombatState({ seed = 1 } = {}){
  const initialSeed = normalizeSeed(seed);
  return {
    version: COMBAT_STATE_VERSION,
    time: 0,
    step: 0,
    initialSeed,
    rngSeed: initialSeed,
    projectileSequence: 0,
    targetSequence: 0,
    bossSequence: 0,
    projectiles: [],
    targets: [],
    boss: null,
    events: [],
    eventSequence: 0,
  };
}

function spawnTarget(state, action){
  const [id, targetSequence] = stableId(state, 'target', action.targetId);
  assertUniqueEntityId(state, id);
  const hp = positive(action.hp, 1);
  const target = {
    id,
    kind: typeof action.kind === 'string' ? action.kind : 'drone',
    team: typeof action.team === 'string' ? action.team : 'enemy',
    x: finite(action.x), y: finite(action.y), s: finite(action.s),
    vx: finite(action.vx), vy: finite(action.vy), vs: finite(action.vs),
    radius: positive(action.radius, 1.5),
    hp,
    maxHp: hp,
    status: 'active',
    scoreValue: Math.max(0, Math.floor(finite(action.scoreValue, 125))),
  };
  const emitter = makeEmitter(state);
  emitter.emit('target-spawned', { targetId: id });
  return emitter.finish({ ...state, targetSequence, targets: [...state.targets, target] });
}

function normalizePhases(phases){
  const source = phases === undefined ? DEFAULT_BOSS_PHASES : phases;
  if(!Array.isArray(source) || source.length === 0) throw new TypeError('boss phases must be a non-empty array');
  const ids = new Set();
  const normalized = source.map((phase, index) => {
    if(!phase || typeof phase.id !== 'string' || phase.id.length === 0 || ids.has(phase.id)) throw new TypeError('boss phase ids must be unique strings');
    ids.add(phase.id);
    const startsAt = finite(phase.startsAt, index === 0 ? 1 : NaN);
    if(!Number.isFinite(startsAt) || startsAt < 0 || startsAt > 1) throw new RangeError(`invalid threshold for boss phase ${phase.id}`);
    return { id: phase.id, startsAt, damageMultiplier: positive(phase.damageMultiplier, 1) };
  });
  if(normalized[0].startsAt !== 1) throw new RangeError('first boss phase must start at 1');
  for(let i = 1; i < normalized.length; i += 1){
    if(normalized[i].startsAt >= normalized[i - 1].startsAt) throw new RangeError('boss phase thresholds must descend');
  }
  return normalized;
}

function spawnBoss(state, action){
  if(state.boss && state.boss.status === 'active') throw new RangeError('an active boss already exists');
  const [id, bossSequence] = stableId(state, 'boss', action.bossId);
  assertUniqueEntityId(state, id);
  const hp = positive(action.hp, 100);
  const phases = normalizePhases(action.phases);
  const boss = {
    id,
    kind: typeof action.kind === 'string' ? action.kind : 'skybreaker',
    team: typeof action.team === 'string' ? action.team : 'enemy',
    x: finite(action.x), y: finite(action.y), s: finite(action.s),
    vx: finite(action.vx), vy: finite(action.vy), vs: finite(action.vs),
    radius: positive(action.radius, 5),
    hp,
    maxHp: hp,
    vulnerable: action.vulnerable !== false,
    status: 'active',
    phaseIndex: 0,
    phases,
  };
  const emitter = makeEmitter(state);
  emitter.emit('boss-spawned', { bossId: id, phaseId: phases[0].id });
  return emitter.finish({ ...state, bossSequence, boss });
}

function fire(state, action){
  const [id, projectileSequence] = stableId(state, 'projectile', action.projectileId);
  assertUniqueEntityId(state, id);
  let dx = finite(action.dx, 0);
  let dy = finite(action.dy, 0);
  let ds = finite(action.ds, 1);
  let rngSeed = state.rngSeed;
  const spread = Math.max(0, finite(action.spread, 0));
  if(spread > 0){
    let unit;
    [rngSeed, unit] = seededUnit(rngSeed);
    dx += (unit * 2 - 1) * spread;
    [rngSeed, unit] = seededUnit(rngSeed);
    dy += (unit * 2 - 1) * spread;
  }
  const length = Math.hypot(dx, dy, ds);
  if(length === 0) throw new RangeError('projectile direction cannot be zero');
  const speed = positive(action.speed, 90);
  const projectile = {
    id,
    ownerId: typeof action.ownerId === 'string' ? action.ownerId : 'player',
    team: typeof action.team === 'string' ? action.team : 'player',
    x: finite(action.x), y: finite(action.y), s: finite(action.s),
    vx: dx / length * speed, vy: dy / length * speed, vs: ds / length * speed,
    radius: positive(action.radius, 0.2),
    damage: positive(action.damage, 1),
    ttl: positive(action.ttl, 3),
  };
  const emitter = makeEmitter(state);
  emitter.emit('projectile-fired', { projectileId: id, ownerId: projectile.ownerId });
  return emitter.finish({ ...state, rngSeed, projectileSequence, projectiles: [...state.projectiles, projectile] });
}

export function segmentSphereHitTime(start, end, sphere, combinedRadius = sphere.radius){
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const ds = end.s - start.s;
  const ox = start.x - sphere.x;
  const oy = start.y - sphere.y;
  const os = start.s - sphere.s;
  const a = dx * dx + dy * dy + ds * ds;
  const radius = positive(combinedRadius, 0.001);
  if(a === 0) return ox * ox + oy * oy + os * os <= radius * radius ? 0 : null;
  const t = clamp(-(ox * dx + oy * dy + os * ds) / a, 0, 1);
  const x = ox + dx * t;
  const y = oy + dy * t;
  const s = os + ds * t;
  return x * x + y * y + s * s <= radius * radius ? t : null;
}

function applyTargetDamage(target, damage, emitter, projectileId = null){
  if(target.status !== 'active') return target;
  const hp = Math.max(0, target.hp - positive(damage, 1));
  emitter.emit('target-hit', { targetId: target.id, projectileId, damage: target.hp - hp });
  if(hp === 0) emitter.emit('target-destroyed', { targetId: target.id, scoreValue: target.scoreValue });
  return { ...target, hp, status: hp === 0 ? 'destroyed' : 'active' };
}

function applyBossDamage(boss, damage, emitter, projectileId = null){
  if(!boss || boss.status !== 'active') return boss;
  if(!boss.vulnerable){
    emitter.emit('boss-blocked', { bossId: boss.id, projectileId });
    return boss;
  }
  const phase = boss.phases[boss.phaseIndex];
  const applied = positive(damage, 1) * phase.damageMultiplier;
  const hp = Math.max(0, boss.hp - applied);
  let phaseIndex = boss.phaseIndex;
  emitter.emit('boss-hit', { bossId: boss.id, projectileId, damage: boss.hp - hp, phaseId: phase.id });
  const ratio = hp / boss.maxHp;
  while(phaseIndex + 1 < boss.phases.length && ratio <= boss.phases[phaseIndex + 1].startsAt){
    phaseIndex += 1;
    emitter.emit('boss-phase', { bossId: boss.id, phaseId: boss.phases[phaseIndex].id, phaseIndex });
  }
  if(hp === 0) emitter.emit('boss-destroyed', { bossId: boss.id });
  return { ...boss, hp, phaseIndex, status: hp === 0 ? 'destroyed' : 'active' };
}

function tick(state, action){
  if(!Number.isFinite(action.dt) || action.dt < 0) throw new RangeError('combat tick dt must be non-negative');
  const dt = action.dt;
  const emitter = makeEmitter(state);
  let targets = state.targets.map(target => target.status === 'active' ? { ...target, x: target.x + target.vx * dt, y: target.y + target.vy * dt, s: target.s + target.vs * dt } : target);
  let boss = state.boss?.status === 'active' ? { ...state.boss, x: state.boss.x + state.boss.vx * dt, y: state.boss.y + state.boss.vy * dt, s: state.boss.s + state.boss.vs * dt } : state.boss;
  const survivors = [];
  for(const projectile of [...state.projectiles].sort((a, b) => a.id.localeCompare(b.id))){
    const end = { x: projectile.x + projectile.vx * dt, y: projectile.y + projectile.vy * dt, s: projectile.s + projectile.vs * dt };
    const ttl = projectile.ttl - dt;
    if(ttl <= 0){ emitter.emit('projectile-expired', { projectileId: projectile.id }); continue; }
    const candidates = [];
    for(const target of targets){
      if(target.status !== 'active' || target.team === projectile.team) continue;
      const hitTime = segmentSphereHitTime(projectile, end, target, projectile.radius + target.radius);
      if(hitTime !== null) candidates.push({ type: 'target', id: target.id, hitTime });
    }
    if(boss?.status === 'active' && boss.team !== projectile.team){
      const hitTime = segmentSphereHitTime(projectile, end, boss, projectile.radius + boss.radius);
      if(hitTime !== null) candidates.push({ type: 'boss', id: boss.id, hitTime });
    }
    candidates.sort((a, b) => a.hitTime - b.hitTime || a.id.localeCompare(b.id));
    const hit = candidates[0];
    if(!hit){ survivors.push({ ...projectile, ...end, ttl }); continue; }
    if(hit.type === 'target') targets = targets.map(target => target.id === hit.id ? applyTargetDamage(target, projectile.damage, emitter, projectile.id) : target);
    else boss = applyBossDamage(boss, projectile.damage, emitter, projectile.id);
  }
  return emitter.finish({ ...state, time: state.time + dt, step: state.step + 1, targets, boss, projectiles: survivors });
}

export function reduceCombat(state, action){
  if(!state || state.version !== COMBAT_STATE_VERSION) throw new TypeError('valid combat state is required');
  if(!action || typeof action.type !== 'string') throw new TypeError('combat action is required');
  switch(action.type){
    case COMBAT_ACTION.SPAWN_TARGET: return spawnTarget(state, action);
    case COMBAT_ACTION.SPAWN_BOSS: return spawnBoss(state, action);
    case COMBAT_ACTION.FIRE: return fire(state, action);
    case COMBAT_ACTION.TICK: return tick(state, action);
    case COMBAT_ACTION.SET_BOSS_VULNERABLE: {
      if(!state.boss) throw new RangeError('no boss exists');
      const emitter = makeEmitter(state);
      const vulnerable = action.vulnerable === true;
      if(vulnerable !== state.boss.vulnerable) emitter.emit(vulnerable ? 'boss-vulnerable' : 'boss-shielded', { bossId: state.boss.id });
      return emitter.finish({ ...state, boss: { ...state.boss, vulnerable } });
    }
    case COMBAT_ACTION.DAMAGE_TARGET: {
      const index = state.targets.findIndex(target => target.id === action.targetId);
      if(index < 0) throw new RangeError(`unknown target ${action.targetId}`);
      const emitter = makeEmitter(state);
      const targets = state.targets.map((target, i) => i === index ? applyTargetDamage(target, action.damage, emitter, action.sourceId || null) : target);
      return emitter.finish({ ...state, targets });
    }
    case COMBAT_ACTION.DAMAGE_BOSS: {
      if(!state.boss) throw new RangeError('no boss exists');
      const emitter = makeEmitter(state);
      return emitter.finish({ ...state, boss: applyBossDamage(state.boss, action.damage, emitter, action.sourceId || null) });
    }
    default: throw new RangeError(`unknown combat action ${action.type}`);
  }
}

export function combatSnapshot(state){
  if(!state || state.version !== COMBAT_STATE_VERSION) throw new TypeError('valid combat state is required');
  return Object.freeze(JSON.parse(JSON.stringify(state)));
}
