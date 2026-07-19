/* PAPER WINGS - pure mission phase and objective state reducer. */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

function normalizeObjective(objective, phaseId){
  if(!objective || typeof objective.id !== 'string') throw new TypeError(`phase ${phaseId} has an invalid objective`);
  const target = Math.max(0.000001, finite(objective.target, 1));
  return {
    id: objective.id,
    phaseId,
    kind: objective.kind || 'progress',
    target,
    required: objective.required !== false && objective.optional !== true,
    label: objective.label || objective.id,
  };
}

function normalizePlan(mission){
  if(!mission || typeof mission.id !== 'string') throw new TypeError('mission definition requires an id');
  const sourcePhases = Array.isArray(mission.phases) && mission.phases.length
    ? mission.phases
    : [{ id: `${mission.id}-run`, name: mission.title || mission.id, timeLimit: mission.durationSeconds, objectives: mission.objectives }];
  const objectiveIds = new Set();
  const phaseIds = new Set();
  const phases = sourcePhases.map((phase, index) => {
    const id = typeof phase?.id === 'string' ? phase.id : `${mission.id}-phase-${index + 1}`;
    if(phaseIds.has(id)) throw new TypeError(`duplicate phase ${id}`);
    phaseIds.add(id);
    if(!Array.isArray(phase?.objectives) || !phase.objectives.length) throw new TypeError(`phase ${id} needs objectives`);
    const objectives = phase.objectives.map(objective => normalizeObjective(objective, id));
    for(const objective of objectives){
      if(objectiveIds.has(objective.id)) throw new TypeError(`duplicate objective ${objective.id}`);
      objectiveIds.add(objective.id);
    }
    return {
      id,
      name: phase.name || id,
      timeLimit: Number.isFinite(phase.timeLimit) && phase.timeLimit > 0 ? phase.timeLimit : null,
      objectives,
    };
  });
  return { missionId: mission.id, phases };
}

function initialObjectiveState(objective, active){
  return {
    id: objective.id,
    phaseId: objective.phaseId,
    kind: objective.kind,
    target: objective.target,
    required: objective.required,
    progress: 0,
    status: active ? 'active' : 'locked',
  };
}

export function createMissionObjectiveState(mission){
  const plan = normalizePlan(mission);
  return {
    missionId: plan.missionId,
    status: 'active',
    phaseIndex: 0,
    phaseId: plan.phases[0].id,
    phaseElapsed: 0,
    elapsed: 0,
    plan,
    objectives: Object.fromEntries(plan.phases.flatMap((phase, index) => phase.objectives
      .map(objective => [objective.id, initialObjectiveState(objective, index === 0)]))),
    completedPhaseIds: [],
    verdict: null,
  };
}

function objectiveCounts(state){
  const values = Object.values(state.objectives);
  const completed = values.filter(objective => objective.status === 'completed');
  const optional = values.filter(objective => !objective.required);
  return {
    completedObjectiveIds: completed.map(objective => objective.id),
    requiredCompleted: completed.filter(objective => objective.required).length,
    requiredTotal: values.filter(objective => objective.required).length,
    optionalCompleted: completed.filter(objective => !objective.required).length,
    optionalTotal: optional.length,
  };
}

function terminalState(state, outcome, reason){
  const counts = objectiveCounts(state);
  return {
    ...state,
    status: outcome === 'success' ? 'completed' : 'failed',
    verdict: {
      outcome,
      reason,
      missionId: state.missionId,
      phaseId: state.phaseId,
      elapsed: state.elapsed,
      ...counts,
    },
  };
}

function phaseObjectives(state){
  const phase = state.plan.phases[state.phaseIndex];
  return phase ? phase.objectives.map(objective => state.objectives[objective.id]) : [];
}

function settlePhase(state){
  let next = state;
  while(next.status === 'active'){
    const phase = next.plan.phases[next.phaseIndex];
    if(!phase) return terminalState(next, 'success', 'mission-complete');
    const objectives = phaseObjectives(next);
    if(objectives.some(objective => objective.required && objective.status === 'failed')){
      return terminalState(next, 'failure', 'required-objective-failed');
    }
    const required = objectives.filter(objective => objective.required);
    if(!required.every(objective => objective.status === 'completed')) return next;

    const settled = { ...next.objectives };
    for(const objective of objectives){
      if(!objective.required && objective.status === 'active') settled[objective.id] = { ...objective, status: 'missed' };
    }
    const completedPhaseIds = next.completedPhaseIds.includes(phase.id)
      ? next.completedPhaseIds
      : [...next.completedPhaseIds, phase.id];
    const phaseIndex = next.phaseIndex + 1;
    if(phaseIndex >= next.plan.phases.length){
      next = { ...next, objectives: settled, completedPhaseIds };
      return terminalState(next, 'success', 'mission-complete');
    }
    const upcoming = next.plan.phases[phaseIndex];
    for(const objective of upcoming.objectives){
      settled[objective.id] = { ...settled[objective.id], status: 'active' };
    }
    next = {
      ...next,
      phaseIndex,
      phaseId: upcoming.id,
      phaseElapsed: 0,
      objectives: settled,
      completedPhaseIds,
    };
  }
  return next;
}

function objectiveIdsForEvent(state, event){
  const explicit = event.objectiveId || event.id;
  if(explicit) return state.objectives[explicit]?.status === 'active' ? [explicit] : [];
  if(!event.kind) return [];
  return Object.values(state.objectives)
    .filter(objective => objective.status === 'active' && objective.kind === event.kind)
    .map(objective => objective.id);
}

function reduceObjectiveEvent(state, event, operation){
  const ids = objectiveIdsForEvent(state, event);
  if(!ids.length) return state;
  const objectives = { ...state.objectives };
  for(const id of ids){
    const objective = objectives[id];
    if(operation === 'fail'){
      objectives[id] = { ...objective, status: 'failed' };
      continue;
    }
    const progress = operation === 'complete'
      ? objective.target
      : Number.isFinite(event.value)
        ? clamp(event.value, 0, objective.target)
        : clamp(objective.progress + finite(event.amount, 1), 0, objective.target);
    objectives[id] = {
      ...objective,
      progress,
      status: progress >= objective.target ? 'completed' : 'active',
    };
  }
  return settlePhase({ ...state, objectives });
}

function timeoutPhase(state){
  const objectives = { ...state.objectives };
  for(const objective of phaseObjectives(state)){
    if(objective.status !== 'active') continue;
    objectives[objective.id] = { ...objective, status: objective.required ? 'failed' : 'missed' };
  }
  return terminalState({ ...state, objectives }, 'failure', 'phase-timeout');
}

export function reduceMissionObjectives(state, event){
  if(!state || !event || typeof event.type !== 'string') throw new TypeError('reduceMissionObjectives requires state and event');
  if(state.status !== 'active') return state;
  switch(event.type){
    case 'progress':
    case 'objective-progress':
      return reduceObjectiveEvent(state, event, 'progress');
    case 'complete':
    case 'objective-complete':
      return reduceObjectiveEvent(state, event, 'complete');
    case 'fail':
    case 'objective-fail':
      return reduceObjectiveEvent(state, event, 'fail');
    case 'tick': {
      const dt = clamp(finite(event.dt), 0, 60);
      if(dt === 0) return state;
      const next = { ...state, elapsed: state.elapsed + dt, phaseElapsed: state.phaseElapsed + dt };
      const phase = next.plan.phases[next.phaseIndex];
      return phase?.timeLimit !== null && next.phaseElapsed >= phase.timeLimit ? timeoutPhase(next) : next;
    }
    case 'phase-complete':
    case 'mission-complete':
      return settlePhase(state);
    case 'phase-fail':
    case 'mission-fail':
      return terminalState(state, 'failure', event.reason || event.type);
    default:
      return state;
  }
}

export function missionObjectiveSummary(state){
  if(!state) throw new TypeError('missionObjectiveSummary requires state');
  return {
    missionId: state.missionId,
    status: state.status,
    phaseId: state.phaseId,
    phaseIndex: state.phaseIndex,
    phaseCount: state.plan.phases.length,
    elapsed: state.elapsed,
    ...objectiveCounts(state),
    verdict: state.verdict ? { ...state.verdict } : null,
  };
}

export const createObjectiveState = createMissionObjectiveState;
export const reduceObjectiveState = reduceMissionObjectives;
