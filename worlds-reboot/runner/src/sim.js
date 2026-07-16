/* Gridlock Run Phase 3 — deterministic gameplay simulation.
   This module has no DOM, Three, audio, renderer, wall-clock, or flow effects.
   Flow owns shield spending and decides whether a crash recovers or terminates. */

export const RUNNER_ACTIONS = Object.freeze(['jump', 'slide', 'left', 'right']);
export const RUNNER_REPLAY_STATE_VERSION = 2;
export const RUNNER_COMPETITOR_KIND = Object.freeze({ PLAYER: 0, RIVAL: 1 });
export const RUNNER_LOCOMOTION = Object.freeze({
  RUN: 0,
  AIR: 1,
  FALLING: 2,
  SLIDE: 3,
  STUMBLE: 4,
  RECOVERING: 5,
  FROZEN: 6,
});
export const RUNNER_SIM_STATUS = Object.freeze({
  RUNNING: 0,
  RECOVERING: 1,
  CRASH_PENDING: 2,
  FINISH_PENDING: 3,
  FROZEN: 4,
  TERMINAL: 5,
});

const EMPTY_EVENTS = Object.freeze([]);

export const DEFAULT_RUNNER_SIM_CONFIG = Object.freeze({
  startS: 6,
  startSpeed: 8.5,
  recoverySpeed: 8.8,
  maxSpeed: 14.5,
  acceleration: 2.45,
  rivalPaceScale: 1,
  deceleration: 8,
  gravity: 27,
  jumpVelocity: 11.4,
  doubleJumpVelocity: 10.8,
  maxJumps: 2,
  coyoteTime: 0.12,
  jumpBufferTime: 0.14,
  /* Long enough for a prompt-threshold swipe at 90m to remain active through
     the 100–104m tutorial gate at the authored speed. */
  slideDuration: 1.25,
  laneChangeDuration: 0.22,
  fallCrashDepth: -2.35,
  landingCatchDepth: -0.32,
  recoveryDuration: 0.58,
  invulnerabilityTime: 0.75,
  stumbleDuration: 0.55,
  stumbleSpeedFactor: 0.58,
  initialShields: 3,
});

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smoothstep = value => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

function deepFreeze(value){
  if(!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for(const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clonePlain(value){
  if(Array.isArray(value)) return value.map(clonePlain);
  if(value && typeof value === 'object'){
    const copy = {};
    for(const [key, child] of Object.entries(value)) copy[key] = clonePlain(child);
    return copy;
  }
  return value;
}

function finite(name, value){
  const number = Number(value);
  if(!Number.isFinite(number)) throw new TypeError(`${name} must be finite`);
  return number;
}

function nonNegativeInteger(name, value){
  const number = Number(value);
  if(!Number.isInteger(number) || number < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return number;
}

function validateCourse(course){
  const methods = ['hazardsAt', 'hazardsInRange', 'isGapAt', 'checkpointAt', 'safePadBefore', 'safePadById'];
  if(!course || !Number.isFinite(course.length) || course.length <= 0 || !Array.isArray(course.hazards)){
    throw new TypeError('createRunnerSim requires a RunnerCourseModel-compatible course');
  }
  for(const method of methods){
    if(typeof course[method] !== 'function') throw new TypeError(`runner course is missing ${method}()`);
  }
}

function validateConfig(config){
  const positive = [
    'startSpeed', 'recoverySpeed', 'maxSpeed', 'acceleration', 'rivalPaceScale', 'deceleration',
    'gravity', 'jumpVelocity', 'doubleJumpVelocity', 'coyoteTime',
    'jumpBufferTime', 'slideDuration', 'laneChangeDuration', 'recoveryDuration',
    'invulnerabilityTime', 'stumbleDuration',
  ];
  for(const key of positive){
    if(!Number.isFinite(config[key]) || config[key] <= 0) throw new RangeError(`${key} must be greater than zero`);
  }
  if(!Number.isInteger(config.maxJumps) || config.maxJumps < 1) throw new RangeError('maxJumps must be a positive integer');
  if(!Number.isFinite(config.fallCrashDepth) || config.fallCrashDepth >= 0) throw new RangeError('fallCrashDepth must be below zero');
  if(!Number.isFinite(config.landingCatchDepth) || config.landingCatchDepth > 0 || config.landingCatchDepth <= config.fallCrashDepth){
    throw new RangeError('landingCatchDepth must be between fallCrashDepth and zero');
  }
  if(!Number.isFinite(config.stumbleSpeedFactor) || config.stumbleSpeedFactor <= 0 || config.stumbleSpeedFactor > 1){
    throw new RangeError('stumbleSpeedFactor must be in (0, 1]');
  }
  nonNegativeInteger('initialShields', config.initialShields);
}

function copyRival(rival){
  return {
    id: rival.id,
    name: rival.name,
    color: rival.color,
    lane: rival.lane,
    s: rival.s,
    previousS: rival.previousS,
    speed: rival.speed,
    finished: rival.finished,
    finishTime: rival.finishTime,
  };
}

function copyStanding(state, competitorIndex, orderIndex){
  if(competitorIndex === 0){
    return {
      id: 'player', name: 'YOU', kind: RUNNER_COMPETITOR_KIND.PLAYER,
      competitorIndex, rivalIndex: -1, rank: orderIndex + 1,
      s: state.s, finished: state.finishTime >= 0, finishTime: state.finishTime,
    };
  }
  const rivalIndex = competitorIndex - 1;
  const rival = state.rivals[rivalIndex];
  return {
    id: rival.id, name: rival.name, kind: RUNNER_COMPETITOR_KIND.RIVAL,
    competitorIndex, rivalIndex, rank: orderIndex + 1,
    s: rival.s, finished: rival.finishTime >= 0, finishTime: rival.finishTime,
  };
}

function locomotionCode(state){
  if(state.frozen || state.terminal) return RUNNER_LOCOMOTION.FROZEN;
  if(state.status === 'recovering') return RUNNER_LOCOMOTION.RECOVERING;
  if(state.slideRemaining > 0) return RUNNER_LOCOMOTION.SLIDE;
  if(!state.grounded) return state.vy < 0 ? RUNNER_LOCOMOTION.FALLING : RUNNER_LOCOMOTION.AIR;
  if(state.stumbleRemaining > 0) return RUNNER_LOCOMOTION.STUMBLE;
  return RUNNER_LOCOMOTION.RUN;
}

function publicSnapshot(state){
  const previous = {
    time: state.previous.time,
    s: state.previous.s,
    speed: state.previous.speed,
    lanePosition: state.previous.lanePosition,
    y: state.previous.y,
  };
  const code = locomotionCode(state);
  const locomotion = code === RUNNER_LOCOMOTION.SLIDE ? 'slide'
    : code === RUNNER_LOCOMOTION.AIR ? 'air'
      : code === RUNNER_LOCOMOTION.FALLING ? 'falling'
        : code === RUNNER_LOCOMOTION.STUMBLE ? 'stumble'
          : code === RUNNER_LOCOMOTION.RECOVERING ? 'recovering'
            : code === RUNNER_LOCOMOTION.FROZEN ? 'frozen' : 'run';
  return deepFreeze({
    status: state.status,
    frozen: state.frozen,
    terminal: state.terminal,
    freezeReason: state.freezeReason,
    time: state.time,
    simulationTime: state.time,
    s: state.s,
    courseS: state.s,
    previousS: previous.s,
    speed: state.speed,
    spd: state.speed,
    previousSpeed: previous.speed,
    lane: state.lane,
    targetLane: state.lane,
    lanePosition: state.lanePosition,
    previousLanePosition: previous.lanePosition,
    laneChanging: state.laneChanging,
    y: state.y,
    yRel: state.y,
    previousY: previous.y,
    vy: state.vy,
    grounded: state.grounded,
    jumpsUsed: state.jumpsUsed,
    jumps: state.jumpsUsed,
    coyoteRemaining: state.coyoteRemaining,
    jumpBufferRemaining: state.bufferedJump?.remaining ?? 0,
    slideRemaining: state.slideRemaining,
    sliding: state.slideRemaining > 0,
    locomotion,
    locomotionCode: code,
    stumbleRemaining: state.stumbleRemaining,
    invulnerabilityRemaining: state.invulnerabilityRemaining,
    checkpointId: state.checkpointId,
    lastSafePadId: state.lastSafePadId,
    shields: state.shields,
    crashPending: state.crashPending ? { ...state.crashPending } : null,
    recovery: state.recovery ? { ...state.recovery } : null,
    fallHazardId: state.fallHazardId,
    rank: state.rank,
    finishTime: state.finishTime,
    rivals: state.rivals.map(copyRival),
    standings: state.standings.map((competitorIndex, orderIndex) => copyStanding(state, competitorIndex, orderIndex)),
    previous,
  });
}

function canonicalAction(action){
  const aliases = { up: 'jump', down: 'slide' };
  return aliases[action] || action;
}

function statusCode(status){
  if(status === 'recovering') return RUNNER_SIM_STATUS.RECOVERING;
  if(status === 'crash-pending') return RUNNER_SIM_STATUS.CRASH_PENDING;
  if(status === 'finish-pending') return RUNNER_SIM_STATUS.FINISH_PENDING;
  if(status === 'frozen') return RUNNER_SIM_STATUS.FROZEN;
  if(status === 'terminal') return RUNNER_SIM_STATUS.TERMINAL;
  return RUNNER_SIM_STATUS.RUNNING;
}

export function createRunnerSim({ course, config: overrides = {}, initial = {} } = {}){
  validateCourse(course);
  const config = deepFreeze({ ...DEFAULT_RUNNER_SIM_CONFIG, ...overrides });
  validateConfig(config);

  let eventSequence = 0;
  let actionSequence = 0;
  let crashSequence = 0;
  let events = [];
  let pendingActions = [];
  const cuedHazards = new Set();
  const resolvedHazards = new Set();
  const enteredGaps = new Set();

  function makeRivals(startS){
    return (course.rivals || []).map(profile => ({
      id: profile.id,
      name: profile.name,
      color: profile.color,
      lane: profile.lane,
      s: clamp(startS + profile.startOffset, 0, course.length),
      previousS: clamp(startS + profile.startOffset, 0, course.length),
      speed: config.rivalPaceScale === 1 ? profile.baseSpeed : profile.baseSpeed * config.rivalPaceScale,
      baseSpeed: profile.baseSpeed,
      phase: profile.phase,
      finished: false,
      finishTime: -1,
    }));
  }

  function makeState(seed = {}){
    const s = clamp(finite('initial.s', seed.s ?? config.startS), 0, course.length);
    const lane = clamp(Math.round(finite('initial.lane', seed.lane ?? 0)), -1, 1);
    const speed = clamp(finite('initial.speed', seed.speed ?? config.startSpeed), 0, config.maxSpeed);
    const shields = nonNegativeInteger('initial.shields', seed.shields ?? config.initialShields);
    const safePad = seed.lastSafePad
      ? resolveSafePad(seed.lastSafePad, s)
      : course.safePadBefore(s);
    const checkpoint = course.checkpointAt(s);
    const grounded = seed.grounded ?? true;
    return {
      status: 'running',
      frozen: false,
      terminal: false,
      freezeReason: null,
      pausedStatus: null,
      time: finite('initial.time', seed.time ?? 0),
      s,
      speed,
      lane,
      lanePosition: lane,
      laneChanging: false,
      laneFrom: lane,
      laneElapsed: 0,
      laneDuration: config.laneChangeDuration,
      y: finite('initial.y', seed.y ?? 0),
      vy: finite('initial.vy', seed.vy ?? 0),
      grounded,
      jumpsUsed: nonNegativeInteger('initial.jumpsUsed', seed.jumpsUsed ?? 0),
      coyoteRemaining: finite('initial.coyoteRemaining', seed.coyoteRemaining ?? (grounded ? config.coyoteTime : 0)),
      bufferedJump: null,
      slideRemaining: 0,
      stumbleRemaining: 0,
      invulnerabilityRemaining: 0,
      checkpointId: checkpoint?.id ?? null,
      lastSafePadId: safePad?.id ?? null,
      shields,
      crashPending: null,
      recovery: null,
      fallHazardId: null,
      rivals: makeRivals(s),
      finishTime: -1,
      standings: [0, ...(course.rivals || []).map((_, index) => index + 1)],
      rank: 1,
      previous: { time: 0, s, speed, lanePosition: lane, y: finite('initial.y', seed.y ?? 0) },
    };
  }

  let state;
  /* Reused on every step; callers must treat it as an ephemeral status view. */
  const stepResult = {
    ok: true,
    advanced: 0,
    statusCode: RUNNER_SIM_STATUS.RUNNING,
    time: 0,
    s: 0,
    pendingEventCount: 0,
  };

  function competitorFinishTime(competitorIndex){
    return competitorIndex === 0 ? state.finishTime : state.rivals[competitorIndex - 1].finishTime;
  }

  function competitorDistance(competitorIndex){
    return competitorIndex === 0 ? state.s : state.rivals[competitorIndex - 1].s;
  }

  function competitorComesBefore(a, b){
    const aTime = competitorFinishTime(a), bTime = competitorFinishTime(b);
    const aFinished = aTime >= 0, bFinished = bTime >= 0;
    if(aFinished !== bFinished) return aFinished;
    if(aFinished && aTime !== bTime) return aTime < bTime;
    const aDistance = competitorDistance(a), bDistance = competitorDistance(b);
    if(aDistance !== bDistance) return aDistance > bDistance;
    return a < b;
  }

  /* Insertion-sort the one authoritative order in place. Four competitors do
     not justify allocating comparator projections on the 120Hz path. */
  function updateStandings(){
    const order = state.standings;
    for(let index = 1; index < order.length; index += 1){
      const competitor = order[index];
      let cursor = index - 1;
      while(cursor >= 0 && competitorComesBefore(competitor, order[cursor])){
        order[cursor + 1] = order[cursor];
        cursor -= 1;
      }
      order[cursor + 1] = competitor;
    }
    for(let index = 0; index < order.length; index += 1){
      if(order[index] === 0){
        state.rank = index + 1;
        break;
      }
    }
    return order;
  }

  function createStandingsOutput(){
    const output = [];
    for(let index = 0; index < state.standings.length; index += 1){
      output.push({
        id: '', name: '', kind: 0, competitorIndex: 0, rivalIndex: -1,
        rank: index + 1, s: 0, finished: 0, finishTime: -1,
      });
    }
    return writeStandingsInto(output);
  }

  /** Write authoritative time-aware order into caller-owned rows. */
  function writeStandingsInto(out){
    if(!Array.isArray(out) || out.length !== state.standings.length){
      throw new TypeError('writeStandingsInto requires a createStandingsOutput-compatible array');
    }
    for(let orderIndex = 0; orderIndex < state.standings.length; orderIndex += 1){
      const competitorIndex = state.standings[orderIndex];
      const row = out[orderIndex];
      if(!row || typeof row !== 'object') throw new TypeError(`standings row ${orderIndex} output is missing`);
      row.rank = orderIndex + 1;
      row.competitorIndex = competitorIndex;
      if(competitorIndex === 0){
        row.id = 'player';
        row.name = 'YOU';
        row.kind = RUNNER_COMPETITOR_KIND.PLAYER;
        row.rivalIndex = -1;
        row.s = state.s;
        row.finished = state.finishTime >= 0 ? 1 : 0;
        row.finishTime = state.finishTime;
      } else {
        const rivalIndex = competitorIndex - 1;
        const rival = state.rivals[rivalIndex];
        row.id = rival.id;
        row.name = rival.name;
        row.kind = RUNNER_COMPETITOR_KIND.RIVAL;
        row.rivalIndex = rivalIndex;
        row.s = rival.s;
        row.finished = rival.finishTime >= 0 ? 1 : 0;
        row.finishTime = rival.finishTime;
      }
    }
    return out;
  }

  function createPresentationFrame(){
    const frame = {
      time: 0,
      s: 0,
      speed: 0,
      lane: 0,
      lanePosition: 0,
      y: 0,
      vy: 0,
      grounded: 0,
      jumpsUsed: 0,
      coyoteRemaining: 0,
      slideRemaining: 0,
      stumbleRemaining: 0,
      invulnerabilityRemaining: 0,
      shields: 0,
      rank: 0,
      finishTime: -1,
      frozen: 0,
      terminal: 0,
      locomotionCode: 0,
      statusCode: 0,
      previousTime: 0,
      previousS: 0,
      previousSpeed: 0,
      previousLanePosition: 0,
      previousY: 0,
      rivals: state.rivals.map(rival => ({
        id: rival.id,
        s: 0,
        previousS: 0,
        speed: 0,
        lane: 0,
        finished: 0,
        finishTime: -1,
      })),
      standings: createStandingsOutput(),
    };
    return writePresentationFrame(frame);
  }

  /** Mutate a caller-owned frame without creating arrays or nested objects. */
  function writePresentationFrame(out){
    if(!out || typeof out !== 'object' || !Array.isArray(out.rivals) || out.rivals.length !== state.rivals.length){
      throw new TypeError('writePresentationFrame requires a createPresentationFrame-compatible output');
    }
    out.time = state.time;
    out.s = state.s;
    out.speed = state.speed;
    out.lane = state.lane;
    out.lanePosition = state.lanePosition;
    out.y = state.y;
    out.vy = state.vy;
    out.grounded = state.grounded ? 1 : 0;
    out.jumpsUsed = state.jumpsUsed;
    out.coyoteRemaining = state.coyoteRemaining;
    out.slideRemaining = state.slideRemaining;
    out.stumbleRemaining = state.stumbleRemaining;
    out.invulnerabilityRemaining = state.invulnerabilityRemaining;
    out.shields = state.shields;
    out.rank = state.rank;
    out.finishTime = state.finishTime;
    out.frozen = state.frozen ? 1 : 0;
    out.terminal = state.terminal ? 1 : 0;
    out.locomotionCode = locomotionCode(state);
    out.statusCode = statusCode(state.status);
    out.previousTime = state.previous.time;
    out.previousS = state.previous.s;
    out.previousSpeed = state.previous.speed;
    out.previousLanePosition = state.previous.lanePosition;
    out.previousY = state.previous.y;
    for(let index = 0; index < state.rivals.length; index += 1){
      const source = state.rivals[index];
      const target = out.rivals[index];
      if(!target || typeof target !== 'object') throw new TypeError(`presentation rival ${index} output is missing`);
      target.s = source.s;
      target.previousS = source.previousS;
      target.speed = source.speed;
      target.lane = source.lane;
      target.finished = source.finished ? 1 : 0;
      target.finishTime = source.finishTime;
    }
    writeStandingsInto(out.standings);
    return out;
  }

  function writeStepResult(advanced, presentationOut){
    stepResult.advanced = advanced ? 1 : 0;
    stepResult.statusCode = statusCode(state.status);
    stepResult.time = state.time;
    stepResult.s = state.s;
    stepResult.pendingEventCount = events.length;
    if(presentationOut !== undefined && presentationOut !== null) writePresentationFrame(presentationOut);
    return stepResult;
  }

  function emit(type, detail = {}){
    const entry = deepFreeze({
      ...detail,
      id: `event-${++eventSequence}`,
      sequence: eventSequence,
      time: state?.time ?? 0,
      type,
    });
    events.push(entry);
    return entry;
  }

  function capturePrevious(){
    state.previous.time = state.time;
    state.previous.s = state.s;
    state.previous.speed = state.speed;
    state.previous.lanePosition = state.lanePosition;
    state.previous.y = state.y;
    for(const rival of state.rivals) rival.previousS = rival.s;
  }

  function resolveSafePad(value, beforeS = state?.s ?? config.startS){
    if(value === undefined || value === null) return course.safePadBefore(beforeS);
    if(typeof value === 'string'){
      const pad = course.safePadById(value);
      if(!pad) throw new RangeError(`unknown safe pad: ${value}`);
      return pad;
    }
    if(typeof value === 'number'){
      return deepFreeze({ id: `debug-pad-${value}`, resumeS: clamp(finite('safePad', value), 0, course.length), lane: 0 });
    }
    if(typeof value === 'object'){
      const resumeS = clamp(finite('safePad.resumeS', value.resumeS), 0, course.length);
      const lane = clamp(Math.round(finite('safePad.lane', value.lane ?? 0)), -1, 1);
      return deepFreeze({ id: value.id || `custom-pad-${resumeS}`, resumeS, lane });
    }
    throw new TypeError('safePad must be an id, distance, or pad object');
  }

  function rebuildHazardProgress(s){
    cuedHazards.clear();
    resolvedHazards.clear();
    enteredGaps.clear();
    for(const hazard of course.hazards){
      if(hazard.cueStart < s) cuedHazards.add(hazard.id);
      if(hazard.landingEnd < s) resolvedHazards.add(hazard.id);
      if(hazard.kind === 'gap' && hazard.s0 < s && hazard.s1 >= s) enteredGaps.add(hazard.id);
    }
  }

  function rejectAction(action, reason){
    emit('action-rejected', { action: action.action, actionId: action.id, reason });
  }

  function rejectPendingActions(reason){
    for(const action of pendingActions) rejectAction(action, reason);
    pendingActions = [];
    if(state.bufferedJump){
      rejectAction(state.bufferedJump.action, reason);
      state.bufferedJump = null;
    }
  }

  function acceptAction(action, result, detail = {}){
    emit('action-accepted', { action: action.action, actionId: action.id, result, ...detail });
  }

  function executeJump(action, jumpNumber){
    state.grounded = false;
    state.vy = jumpNumber === 1 ? config.jumpVelocity : config.doubleJumpVelocity;
    state.y = Math.max(0, state.y);
    state.jumpsUsed = jumpNumber;
    state.coyoteRemaining = 0;
    state.slideRemaining = 0;
    acceptAction(action, jumpNumber === 1 ? 'jump' : 'double-jump', { jumpNumber });
    emit('jumped', { jumpNumber, actionId: action.id, s: state.s });
  }

  function tryJump(action, allowBuffer = true){
    if(state.grounded || state.coyoteRemaining > 0){
      executeJump(action, 1);
      return true;
    }
    if(state.jumpsUsed > 0 && state.jumpsUsed < config.maxJumps){
      executeJump(action, state.jumpsUsed + 1);
      return true;
    }
    if(allowBuffer && !state.bufferedJump){
      state.bufferedJump = { action, remaining: config.jumpBufferTime };
      emit('jump-buffered', { actionId: action.id, duration: config.jumpBufferTime });
      return false;
    }
    rejectAction(action, state.bufferedJump ? 'jump-buffer-full' : 'jump-unavailable');
    return false;
  }

  function processActions(){
    if(pendingActions.length === 0) return;
    const queue = pendingActions;
    pendingActions = [];
    for(const action of queue){
      if(state.status !== 'running' || state.frozen){
        rejectAction(action, state.status);
        continue;
      }
      if(action.action === 'jump'){
        tryJump(action);
      } else if(action.action === 'slide'){
        if(!state.grounded){
          rejectAction(action, 'not-grounded');
          continue;
        }
        state.slideRemaining = config.slideDuration;
        acceptAction(action, 'slide', { duration: config.slideDuration });
      } else {
        const direction = action.action === 'left' ? -1 : 1;
        const target = clamp(state.lane + direction, -1, 1);
        if(target === state.lane){
          rejectAction(action, 'lane-edge');
          continue;
        }
        const fromLane = state.lane;
        state.lane = target;
        state.laneFrom = state.lanePosition;
        state.laneElapsed = 0;
        state.laneDuration = config.laneChangeDuration * Math.max(1, Math.abs(target - state.lanePosition));
        state.laneChanging = true;
        acceptAction(action, 'lane-change', { fromLane, toLane: target });
      }
    }
  }

  function advanceLane(dt){
    if(!state.laneChanging) return;
    state.laneElapsed += dt;
    const progress = clamp(state.laneElapsed / state.laneDuration, 0, 1);
    state.lanePosition = state.laneFrom + (state.lane - state.laneFrom) * smoothstep(progress);
    if(progress >= 1){
      state.lanePosition = state.lane;
      state.laneChanging = false;
      emit('lane-change-complete', { lane: state.lane });
    }
  }

  function updateRivals(dt){
    for(const rival of state.rivals){
      if(rival.finished) continue;
      const progress = clamp(rival.s / course.length, 0, 1);
      const variation = Math.sin(state.time * 0.72 + rival.phase) * 0.32;
      const standardTarget = rival.baseSpeed + progress * 1.35 + variation;
      // Standard keeps its original arithmetic. Calm scales the complete
      // deterministic rival curve so the gentler player cap stays viable.
      const target = config.rivalPaceScale === 1
        ? standardTarget
        : standardTarget * config.rivalPaceScale;
      rival.speed += clamp(target - rival.speed, -3.5 * dt, 2.2 * dt);
      rival.s = Math.min(course.length, rival.s + rival.speed * dt);
      if(rival.s >= course.length){
        rival.finished = true;
        rival.finishTime = state.time;
      }
    }
  }

  function hazardById(id){
    return course.hazards.find(hazard => hazard.id === id) || null;
  }

  function triggerCrash(hazard, reason){
    if(state.status !== 'running' || state.crashPending || state.invulnerabilityRemaining > 0) return false;
    const safePad = hazard?.safePadId
      ? course.safePadById(hazard.safePadId)
      : course.safePadBefore(state.s);
    const lethal = Boolean(hazard?.lethal);
    const suggestedShieldsRemaining = Math.max(0, state.shields - (lethal ? 1 : 0));
    state.crashPending = deepFreeze({
      id: `crash-${++crashSequence}`,
      hazardId: hazard?.id ?? null,
      kind: hazard?.kind ?? 'fall',
      reason,
      lethal,
      atS: state.s,
      atTime: state.time,
      safePadId: safePad?.id ?? state.lastSafePadId,
      safeS: safePad?.resumeS ?? config.startS,
      shieldsBefore: state.shields,
      shieldsRemaining: state.shields,
      suggestedShieldsRemaining,
    });
    state.status = 'crash-pending';
    state.speed = 0;
    rejectPendingActions('crash-pending');
    emit('crash-pending', { ...state.crashPending });
    return true;
  }

  function cueHazards(fromS, toS){
    for(const hazard of course.hazards){
      if(cuedHazards.has(hazard.id)) continue;
      if(fromS <= hazard.cueStart && toS >= hazard.cueStart){
        cuedHazards.add(hazard.id);
        emit('hazard-cue', {
          hazardId: hazard.id,
          kind: hazard.kind,
          action: hazard.action,
          cueStart: hazard.cueStart,
          actionAt: hazard.actionAt ?? hazard.cueStart,
          s0: hazard.s0,
          landingEnd: hazard.landingEnd,
          label: hazard.label,
        });
      }
    }
  }

  function laneAffected(hazard){
    return hazard.lanes.some(lane => Math.abs(lane - state.lanePosition) <= 0.46);
  }

  function clearHazard(hazard, method){
    if(resolvedHazards.has(hazard.id)) return;
    resolvedHazards.add(hazard.id);
    emit('hazard-cleared', { hazardId: hazard.id, kind: hazard.kind, method, s: state.s });
  }

  function stumble(hazard){
    state.stumbleRemaining = config.stumbleDuration;
    state.speed *= config.stumbleSpeedFactor;
    resolvedHazards.add(hazard.id);
    emit('hazard-hit', { hazardId: hazard.id, kind: hazard.kind, lethal: false, action: hazard.action, s: state.s });
    emit('stumble', { hazardId: hazard.id, duration: config.stumbleDuration });
  }

  function checkSolidHazards(fromS, toS){
    for(const hazard of course.hazards){
      if(hazard.kind === 'gap' || resolvedHazards.has(hazard.id)) continue;
      if(toS < hazard.s0 || fromS > hazard.s1) continue;

      const affected = laneAffected(hazard);
      if(hazard.kind === 'overhead'){
        /* Success is not committed at entry. The required posture must remain
           valid through every simulation sample until the authored exit. */
        if(affected && state.slideRemaining <= 0){
          if(hazard.lethal) triggerCrash(hazard, 'obstacle-hit');
          else stumble(hazard);
        }
      } else if(hazard.kind === 'bar'){
        const clearance = Number.isFinite(hazard.clearanceY) ? hazard.clearanceY
          : Number.isFinite(hazard.h) ? hazard.h : 0.85;
        if(affected && state.y < clearance){
          if(hazard.lethal) triggerCrash(hazard, 'obstacle-hit');
          else stumble(hazard);
        }
      } else if(hazard.kind === 'blocker' && affected){
        if(hazard.lethal) triggerCrash(hazard, 'obstacle-hit');
        else stumble(hazard);
      }
      if(state.status !== 'running') return;
    }

    for(const hazard of course.hazards){
      if(hazard.kind === 'gap' || resolvedHazards.has(hazard.id)) continue;
      if(toS > hazard.s1){
        const method = hazard.kind === 'overhead' ? 'slide'
          : hazard.kind === 'bar' ? 'jump'
            : laneAffected(hazard) ? 'survived' : 'lane';
        clearHazard(hazard, method);
      }
    }
  }

  function updateGapEntry(fromS, toS){
    for(const hazard of course.hazards){
      if(hazard.kind !== 'gap' || enteredGaps.has(hazard.id)) continue;
      if(fromS <= hazard.s0 && toS >= hazard.s0){
        enteredGaps.add(hazard.id);
        emit('hazard-entered', { hazardId: hazard.id, kind: 'gap', s: state.s });
      }
    }
  }

  function land(){
    const fallHazard = hazardById(state.fallHazardId);
    state.y = 0;
    state.vy = 0;
    state.grounded = true;
    state.jumpsUsed = 0;
    state.coyoteRemaining = config.coyoteTime;
    state.fallHazardId = null;
    emit('landed', { s: state.s });
    if(fallHazard && state.s >= fallHazard.s1) clearHazard(fallHazard, 'jump');
    if(state.bufferedJump){
      const buffered = state.bufferedJump;
      state.bufferedJump = null;
      executeJump(buffered.action, 1);
    }
  }

  function updateVertical(dt){
    const gap = course.isGapAt(state.s, state.lanePosition);
    if(state.grounded){
      state.y = 0;
      state.vy = 0;
      if(gap){
        state.grounded = false;
        state.fallHazardId = gap.id;
        state.coyoteRemaining = config.coyoteTime;
        emit('left-ground', { hazardId: gap.id, s: state.s });
      } else {
        state.coyoteRemaining = config.coyoteTime;
      }
      return;
    }

    if(gap && !state.fallHazardId) state.fallHazardId = gap.id;
    state.vy -= config.gravity * dt;
    state.y += state.vy * dt;
    state.coyoteRemaining = Math.max(0, state.coyoteRemaining - dt);

    const fallHazard = hazardById(state.fallHazardId);
    if(state.y <= config.fallCrashDepth){
      triggerCrash(fallHazard, 'fell');
      return;
    }
    if(!gap && state.y <= 0 && state.y >= config.landingCatchDepth) land();
  }

  function updateBufferedJump(dt){
    if(!state.bufferedJump) return;
    state.bufferedJump.remaining -= dt;
    if(state.bufferedJump.remaining <= 0){
      const action = state.bufferedJump.action;
      state.bufferedJump = null;
      rejectAction(action, 'jump-buffer-expired');
    }
  }

  function updateCourseOwnership(){
    const checkpoint = course.checkpointAt(state.s);
    if(checkpoint?.id !== state.checkpointId){
      state.checkpointId = checkpoint?.id ?? null;
      if(checkpoint) emit('checkpoint', { checkpointId: checkpoint.id, s: checkpoint.s, safePadId: checkpoint.safePadId });
    }
    const safePad = course.safePadBefore(state.s);
    if(safePad) state.lastSafePadId = safePad.id;
  }

  function advanceRecovery(dt){
    const recovery = state.recovery;
    recovery.elapsed = Math.min(recovery.duration, recovery.elapsed + dt);
    const progress = recovery.duration === 0 ? 1 : recovery.elapsed / recovery.duration;
    const mix = smoothstep(progress);
    state.s = recovery.fromS + (recovery.toS - recovery.fromS) * mix;
    state.lanePosition = recovery.fromLane + (recovery.toLane - recovery.fromLane) * mix;
    state.lane = recovery.toLane;
    state.y = recovery.fromY * (1 - mix);
    state.vy = 0;
    state.speed = recovery.fromSpeed + (config.recoverySpeed - recovery.fromSpeed) * mix;
    updateRivals(dt);
    updateStandings();
    if(progress < 1) return;

    state.s = recovery.toS;
    state.lanePosition = recovery.toLane;
    state.y = 0;
    state.vy = 0;
    state.speed = config.recoverySpeed;
    state.grounded = true;
    state.jumpsUsed = 0;
    state.coyoteRemaining = config.coyoteTime;
    state.slideRemaining = 0;
    state.stumbleRemaining = 0;
    state.invulnerabilityRemaining = config.invulnerabilityTime;
    state.fallHazardId = null;
    state.recovery = null;
    state.status = 'running';
    updateCourseOwnership();
    emit('recovery-complete', { safePadId: state.lastSafePadId, s: state.s, shields: state.shields });
  }

  function finish(){
    if(state.status !== 'running') return;
    state.s = course.length;
    if(state.finishTime < 0) state.finishTime = state.time;
    updateStandings();
    state.status = 'finish-pending';
    state.frozen = true;
    state.freezeReason = 'course-complete';
    rejectPendingActions('finish-pending');
    emit('finish-pending', { s: state.s, rank: state.rank, finishTime: state.finishTime });
  }

  function input(action, detail = {}){
    const resolved = canonicalAction(action);
    if(!RUNNER_ACTIONS.includes(resolved)) throw new RangeError(`unknown runner action: ${action}`);
    const queued = deepFreeze({
      id: `action-${++actionSequence}`,
      action: resolved,
      sequence: actionSequence,
      queuedAt: state.time,
      detail: detail && typeof detail === 'object' ? { ...detail } : {},
    });
    if(state.status !== 'running' || state.frozen){
      rejectAction(queued, state.terminal ? 'terminal' : state.status);
      return deepFreeze({ ok: false, queued: false, id: queued.id, reason: state.status });
    }
    pendingActions.push(queued);
    emit('action-queued', { action: resolved, actionId: queued.id });
    return deepFreeze({ ok: true, queued: true, id: queued.id, action: resolved });
  }

  function step(dt, presentationOut = null){
    const delta = finite('dt', dt);
    if(delta <= 0) throw new RangeError('dt must be greater than zero');
    if(state.frozen || state.terminal || state.status === 'crash-pending' || state.status === 'finish-pending'){
      return writeStepResult(false, presentationOut);
    }

    capturePrevious();
    state.time += delta;
    if(state.status === 'recovering'){
      advanceRecovery(delta);
      return writeStepResult(true, presentationOut);
    }

    state.invulnerabilityRemaining = Math.max(0, state.invulnerabilityRemaining - delta);
    state.slideRemaining = Math.max(0, state.slideRemaining - delta);
    state.stumbleRemaining = Math.max(0, state.stumbleRemaining - delta);
    processActions();
    if(state.status !== 'running') return writeStepResult(true, presentationOut);
    advanceLane(delta);

    const speedCap = config.maxSpeed * (state.stumbleRemaining > 0 ? 0.72 : 1);
    const targetSpeed = Math.min(speedCap, config.startSpeed + 3.25 + 2.75 * clamp(state.s / course.length, 0, 1));
    if(state.speed < targetSpeed) state.speed = Math.min(targetSpeed, state.speed + config.acceleration * delta);
    else state.speed = Math.max(targetSpeed, state.speed - config.deceleration * delta);
    state.s = Math.min(course.length, state.s + state.speed * delta);

    cueHazards(state.previous.s, state.s);
    updateGapEntry(state.previous.s, state.s);
    updateVertical(delta);
    if(state.status === 'running') checkSolidHazards(state.previous.s, state.s);
    if(state.status === 'running') updateBufferedJump(delta);
    updateCourseOwnership();
    updateRivals(delta);
    if(state.status === 'running' && state.s >= course.length) finish();
    else updateStandings();
    return writeStepResult(true, presentationOut);
  }

  function setShields(shields){
    state.shields = nonNegativeInteger('shields', shields);
    emit('shields-set', { shields: state.shields });
    return state.shields;
  }

  /* Flow calls recover only after deciding whether/how many shields to spend.
     Sim never decrements shields on its own. */
  function recover({ safePad = undefined, shields = state.shields, duration = config.recoveryDuration } = {}){
    if(state.status !== 'crash-pending' || !state.crashPending) return deepFreeze({ ok: false, reason: state.status });
    const pad = resolveSafePad(safePad ?? state.crashPending.safePadId, state.crashPending.atS);
    const recoveryDuration = finite('recovery duration', duration);
    if(recoveryDuration < 0) throw new RangeError('recovery duration cannot be negative');
    state.shields = nonNegativeInteger('shields', shields);
    const crashId = state.crashPending.id;
    const fromSpeed = state.previous.speed;
    state.crashPending = null;
    state.status = 'recovering';
    state.frozen = false;
    state.freezeReason = null;
    state.recovery = {
      crashId,
      safePadId: pad.id,
      fromS: state.s,
      toS: pad.resumeS,
      fromLane: state.lanePosition,
      toLane: pad.lane ?? 0,
      fromY: state.y,
      fromSpeed,
      elapsed: 0,
      duration: recoveryDuration,
    };
    state.lastSafePadId = pad.id;
    rebuildHazardProgress(pad.resumeS);
    emit('recovery-started', { crashId, safePadId: pad.id, toS: pad.resumeS, shields: state.shields, duration: recoveryDuration });
    if(recoveryDuration === 0) advanceRecovery(0);
    return deepFreeze({ ok: true, crashId, safePadId: pad.id, shields: state.shields });
  }

  function freeze(reason = 'manual', { terminal = false } = {}){
    if(typeof reason !== 'string' || !reason) throw new TypeError('freeze reason must be a non-empty string');
    if(state.terminal) return false;
    state.pausedStatus = state.status;
    state.frozen = true;
    state.terminal = Boolean(terminal);
    state.freezeReason = reason;
    state.status = terminal ? 'terminal' : 'frozen';
    rejectPendingActions(terminal ? 'terminal' : 'frozen');
    emit('simulation-frozen', { reason, terminal: state.terminal });
    return true;
  }

  function resume(){
    if(!state.frozen || state.terminal) return false;
    const nextStatus = state.pausedStatus && state.pausedStatus !== 'frozen' ? state.pausedStatus : 'running';
    state.frozen = false;
    state.freezeReason = null;
    state.status = nextStatus;
    state.pausedStatus = null;
    emit('simulation-resumed', { status: nextStatus });
    return true;
  }

  function restore(overrides = {}){
    if(!overrides || typeof overrides !== 'object') throw new TypeError('restore overrides must be an object');
    rejectPendingActions('restore');
    const s = clamp(finite('restore.s', overrides.s ?? state.s), 0, course.length);
    const lane = clamp(Math.round(finite('restore.lane', overrides.lane ?? state.lane)), -1, 1);
    const speed = clamp(finite('restore.speed', overrides.speed ?? config.startSpeed), 0, config.maxSpeed);
    const shields = nonNegativeInteger('restore.shields', overrides.shields ?? state.shields);
    const pad = resolveSafePad(overrides.lastSafePad ?? course.safePadBefore(s), s);

    state.status = 'running';
    state.frozen = false;
    state.terminal = false;
    state.freezeReason = null;
    state.pausedStatus = null;
    state.s = s;
    state.speed = speed;
    state.lane = lane;
    state.lanePosition = lane;
    state.laneChanging = false;
    state.laneFrom = lane;
    state.laneElapsed = 0;
    state.y = finite('restore.y', overrides.y ?? 0);
    state.vy = finite('restore.vy', overrides.vy ?? 0);
    state.grounded = overrides.grounded ?? true;
    state.jumpsUsed = nonNegativeInteger('restore.jumpsUsed', overrides.jumpsUsed ?? 0);
    state.coyoteRemaining = finite('restore.coyoteRemaining', overrides.coyoteRemaining ?? (state.grounded ? config.coyoteTime : 0));
    state.bufferedJump = null;
    state.slideRemaining = 0;
    state.stumbleRemaining = 0;
    state.invulnerabilityRemaining = 0;
    state.shields = shields;
    state.crashPending = null;
    state.recovery = null;
    state.fallHazardId = null;
    state.finishTime = -1;
    state.lastSafePadId = pad?.id ?? null;
    state.checkpointId = course.checkpointAt(s)?.id ?? null;
    state.previous = { time: state.time, s, speed, lanePosition: lane, y: state.y };
    rebuildHazardProgress(s);
    updateStandings();
    emit('simulation-restored', { s, lane, shields, lastSafePadId: state.lastSafePadId });
    return publicSnapshot(state);
  }

  /** Complete serializable deterministic state, including transient hazard
      progress and queued events/actions. Intended for replay/checkpoints, not
      the render loop. */
  function exportState(){
    return deepFreeze({
      version: RUNNER_REPLAY_STATE_VERSION,
      course: {
        length: course.length,
        hazardIds: course.hazards.map(hazard => hazard.id),
        rivalIds: (course.rivals || []).map(rival => rival.id),
      },
      config: clonePlain(config),
      sequences: { event: eventSequence, action: actionSequence, crash: crashSequence },
      state: clonePlain(state),
      pendingActions: clonePlain(pendingActions),
      events: clonePlain(events),
      progress: {
        cuedHazards: [...cuedHazards],
        resolvedHazards: [...resolvedHazards],
        enteredGaps: [...enteredGaps],
      },
    });
  }

  function importState(saved){
    if(!saved || typeof saved !== 'object') throw new TypeError('importState requires an exported replay state');
    if(saved.version !== RUNNER_REPLAY_STATE_VERSION) throw new RangeError(`unsupported runner replay state version: ${saved.version}`);
    if(saved.course?.length !== course.length) throw new RangeError('replay course length does not match');
    const expectedHazards = course.hazards.map(hazard => hazard.id);
    const expectedRivals = (course.rivals || []).map(rival => rival.id);
    if(!Array.isArray(saved.course?.hazardIds) || saved.course.hazardIds.length !== expectedHazards.length
      || saved.course.hazardIds.some((id, index) => id !== expectedHazards[index])){
      throw new RangeError('replay hazard authorship does not match');
    }
    if(!Array.isArray(saved.course?.rivalIds) || saved.course.rivalIds.length !== expectedRivals.length
      || saved.course.rivalIds.some((id, index) => id !== expectedRivals[index])){
      throw new RangeError('replay rival authorship does not match');
    }
    for(const [key, value] of Object.entries(config)){
      if(saved.config?.[key] !== value) throw new RangeError(`replay config does not match at ${key}`);
    }
    if(!saved.state || !Array.isArray(saved.state.rivals) || saved.state.rivals.length !== expectedRivals.length
      || !saved.state.previous || !Array.isArray(saved.state.standings)
      || saved.state.standings.length !== expectedRivals.length + 1 || !Number.isFinite(saved.state.finishTime)){
      throw new TypeError('replay simulation state is incomplete');
    }
    const expectedCompetitors = expectedRivals.length + 1;
    const importedCompetitors = new Set(saved.state.standings);
    if(importedCompetitors.size !== expectedCompetitors
      || saved.state.standings.some(index => !Number.isInteger(index) || index < 0 || index >= expectedCompetitors)){
      throw new RangeError('replay standings must contain each competitor exactly once');
    }
    if(!Array.isArray(saved.pendingActions) || !Array.isArray(saved.events)
      || !Array.isArray(saved.progress?.cuedHazards)
      || !Array.isArray(saved.progress?.resolvedHazards)
      || !Array.isArray(saved.progress?.enteredGaps)){
      throw new TypeError('replay transient state is incomplete');
    }
    const sequences = saved.sequences || {};
    const nextEventSequence = nonNegativeInteger('replay event sequence', sequences.event);
    const nextActionSequence = nonNegativeInteger('replay action sequence', sequences.action);
    const nextCrashSequence = nonNegativeInteger('replay crash sequence', sequences.crash);
    const knownHazards = new Set(expectedHazards);
    for(const collection of [saved.progress.cuedHazards, saved.progress.resolvedHazards, saved.progress.enteredGaps]){
      if(collection.some(id => !knownHazards.has(id))) throw new RangeError('replay contains an unknown hazard id');
    }

    state = clonePlain(saved.state);
    pendingActions = clonePlain(saved.pendingActions);
    events = clonePlain(saved.events);
    for(const event of events) deepFreeze(event);
    for(const action of pendingActions) deepFreeze(action);
    eventSequence = nextEventSequence;
    actionSequence = nextActionSequence;
    crashSequence = nextCrashSequence;
    cuedHazards.clear();
    resolvedHazards.clear();
    enteredGaps.clear();
    for(const id of saved.progress.cuedHazards) cuedHazards.add(id);
    for(const id of saved.progress.resolvedHazards) resolvedHazards.add(id);
    for(const id of saved.progress.enteredGaps) enteredGaps.add(id);
    updateStandings();
    writeStepResult(false, null);
    return publicSnapshot(state);
  }

  function reset(resetOverrides = {}){
    if(!resetOverrides || typeof resetOverrides !== 'object') throw new TypeError('reset overrides must be an object');
    eventSequence = 0;
    actionSequence = 0;
    crashSequence = 0;
    events = [];
    pendingActions = [];
    cuedHazards.clear();
    resolvedHazards.clear();
    enteredGaps.clear();
    state = makeState({ ...initial, ...resetOverrides });
    rebuildHazardProgress(state.s);
    updateStandings();
    emit('simulation-reset', { s: state.s, lane: state.lane, shields: state.shields });
    return publicSnapshot(state);
  }

  function drainEvents(){
    if(events.length === 0) return EMPTY_EVENTS;
    const drained = events;
    events = [];
    return Object.freeze(drained);
  }

  function drainEventsInto(out){
    if(!Array.isArray(out)) throw new TypeError('drainEventsInto requires a reusable array');
    out.length = 0;
    if(events.length === 0) return out;
    for(const event of events) out.push(event);
    events = [];
    return out;
  }

  state = makeState(initial);
  rebuildHazardProgress(state.s);
  updateStandings();
  emit('simulation-reset', { s: state.s, lane: state.lane, shields: state.shields });

  return Object.freeze({
    input,
    step,
    recover,
    restore,
    reset,
    freeze,
    resume,
    setShields,
    createPresentationFrame,
    writePresentationFrame,
    createStandingsOutput,
    writeStandingsInto,
    exportState,
    importState,
    snapshot: () => publicSnapshot(state),
    drainEvents,
    drainEventsInto,
    get pendingEventCount(){ return events.length; },
    get state(){ return publicSnapshot(state); },
    get config(){ return config; },
  });
}
