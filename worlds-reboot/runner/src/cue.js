/* Gridlock Run — pure cue copy and one-shot early-input buffering.
   The renderer owns display and the simulation owns physics; this module only
   decides which authored cue is active and when one matching action may fire. */

const clampLane = lane => Math.max(-1, Math.min(1, Math.round(Number(lane) || 0)));

export function canonicalRunnerAction(action){
  const value = typeof action === 'string' ? action : action?.type;
  if(value === 'up') return 'jump';
  if(value === 'down') return 'slide';
  return value;
}

function hazardActionRequirement(hazard, lane){
  if(!hazard) return null;
  if(hazard.action === 'jump' || hazard.action === 'double-jump') return 'jump';
  if(hazard.action === 'slide') return 'slide';
  if(hazard.action === 'lane-left') return 'left';
  if(hazard.action === 'lane-right') return 'right';
  if(hazard.action !== 'lane') return canonicalRunnerAction(hazard.action);

  const current = clampLane(lane);
  const safeLanes = Array.isArray(hazard.safeLanes) ? hazard.safeLanes : [];
  if(safeLanes.some(safe => Math.abs(safe - current) <= 0.46)) return null;
  const leftSafe = safeLanes.some(safe => safe < current);
  const rightSafe = safeLanes.some(safe => safe > current);
  if(leftSafe && rightSafe) return 'either-lane';
  if(leftSafe) return 'left';
  if(rightSafe) return 'right';
  return null;
}

/** Pick an overlapping later cue once the earlier lane requirement is already
 * safe. This lets the final jump become visible while HOLD CENTER remains true. */
export function activeRunnerCue(course, s, lane = 0){
  const courseS = Number(s);
  if(!course || !Array.isArray(course.hazards) || !Number.isFinite(courseS)) return null;
  const active = course.hazards.filter(hazard => (
    courseS >= hazard.cueStart && courseS <= hazard.s1
  ));
  if(active.length === 0) return null;
  for(const hazard of active){
    if(hazardActionRequirement(hazard, lane) !== null) return hazard;
  }
  return active[active.length - 1];
}

export function runnerCueRequirement(hazard, lane = 0){
  return hazardActionRequirement(hazard, lane);
}

export function runnerActionMatchesCue(action, hazard, lane = 0){
  const required = hazardActionRequirement(hazard, lane);
  const actual = canonicalRunnerAction(action);
  if(required === 'either-lane') return actual === 'left' || actual === 'right';
  return required !== null && actual === required;
}

function actionLabel(requirement, hazard, lane){
  if(requirement === 'jump') return '↑ SWIPE UP';
  if(requirement === 'slide') return '↓ SWIPE DOWN';
  if(requirement === 'left'){
    return hazard?.safeLanes?.includes(0) ? '← SWIPE LEFT TO CENTER' : '← SWIPE LEFT';
  }
  if(requirement === 'right'){
    return hazard?.safeLanes?.includes(0) ? '→ SWIPE RIGHT TO CENTER' : '→ SWIPE RIGHT';
  }
  if(requirement === 'either-lane') return '← OR → SWIPE TO A CLEAR LANE';
  return clampLane(lane) === 0 && hazard?.safeLanes?.includes(0) ? 'HOLD CENTER' : 'HOLD CLEAR LANE';
}

function armedLabel(requirement){
  if(requirement === 'jump') return 'READY · JUMP ARMED';
  if(requirement === 'slide') return 'READY · SLIDE ARMED';
  return 'READY · LANE CHANGE ARMED';
}

export function runnerCuePresentation(course, s, lane = 0, { armed = null } = {}){
  const courseS = Number(s);
  if(!Number.isFinite(courseS)) throw new TypeError('runner cue distance must be finite');
  const hazard = activeRunnerCue(course, courseS, lane);
  if(!hazard){
    const firstCueStart = course?.hazards?.[0]?.cueStart ?? Infinity;
    const opening = courseS < firstCueStart;
    return {
      id: opening ? 'opening-orientation' : 'between-cues',
      hazard: null,
      text: opening ? 'FOLLOW THE GLOWING ROUTE' : 'NEXT CUE AHEAD',
      label: opening ? 'FOLLOW THE GLOWING ROUTE' : 'NEXT CUE AHEAD',
      stage: 'orientation',
      requirement: null,
      actionReady: false,
      actionAt: -1,
      cueStart: opening ? 0 : -1,
      s0: opening ? firstCueStart : -1,
      distance: opening ? Math.max(0, firstCueStart - courseS) : 0,
      armed: false,
    };
  }

  const requirement = hazardActionRequirement(hazard, lane);
  const actionAt = hazard.actionAt ?? hazard.cueStart;
  const isArmed = Boolean(armed && armed.hazardId === hazard.id);
  const ready = courseS >= actionAt;
  const label = actionLabel(requirement, hazard, lane);
  /* READY owns one rendered frame even when a slow RAF batch has already
     crossed actionAt. Physics fires on the following fixed-step frame. */
  const stage = isArmed ? 'armed' : ready ? 'ready' : 'anticipation';
  const text = stage === 'armed' ? armedLabel(requirement)
    : stage === 'ready' ? `NOW · ${label}`
      : `WAIT · PREPARE ${label}`;
  return {
    id: hazard.id,
    hazard,
    text,
    label,
    stage,
    requirement,
    actionReady: ready,
    actionAt,
    cueStart: hazard.cueStart,
    s0: hazard.s0,
    distance: Math.max(0, hazard.s0 - courseS),
    lethal: Boolean(hazard.lethal),
    armed: isArmed,
  };
}

function copyArmed(armed){
  return armed ? { ...armed, action: { ...armed.action } } : null;
}

export function createRunnerCueInputBuffer(){
  let armed = null;
  let armedCount = 0;
  let firedCount = 0;
  let ignoredCount = 0;
  let armedPresented = false;
  let presentedCount = 0;
  let lastClearReason = 'initial';
  let lastRoute = null;
  const firedHazards = new Set();

  function result(kind, reason, detail = {}){
    lastRoute = { kind, reason, ...detail };
    return { ...lastRoute };
  }

  function route({ course, s, lane = 0, action } = {}){
    const courseS = Number(s);
    if(!Number.isFinite(courseS)) throw new TypeError('cue input distance must be finite');
    const hazard = activeRunnerCue(course, courseS, lane);
    if(!hazard){
      ignoredCount += 1;
      return result('ignored', 'no-active-cue');
    }
    if(!runnerActionMatchesCue(action, hazard, lane)){
      ignoredCount += 1;
      const reason = hazardActionRequirement(hazard, lane) === null ? 'safe-lane-hold' : 'wrong-action';
      return result('ignored', reason, { hazardId: hazard.id });
    }
    if(firedHazards.has(hazard.id)){
      ignoredCount += 1;
      return result('ignored', 'already-fired', { hazardId: hazard.id });
    }

    const type = canonicalRunnerAction(action);
    const actionRecord = typeof action === 'string' ? { type, direction: action } : { ...action, type };
    const actionAt = hazard.actionAt ?? hazard.cueStart;
    if(courseS < actionAt){
      if(armed){
        ignoredCount += 1;
        return result('ignored', 'already-armed', { hazardId: armed.hazardId });
      }
      armed = Object.freeze({
        hazardId: hazard.id,
        actionAt,
        armedAtS: courseS,
        type,
        action: Object.freeze(actionRecord),
      });
      armedPresented = false;
      armedCount += 1;
      return result('armed', 'before-action-window', { hazardId: hazard.id, actionAt, action: actionRecord });
    }

    firedHazards.add(hazard.id);
    firedCount += 1;
    return result('fire', 'action-window-open', { hazardId: hazard.id, action: actionRecord });
  }

  function takeReady({ course, s } = {}){
    if(!armed) return null;
    const courseS = Number(s);
    if(!Number.isFinite(courseS)) throw new TypeError('cue input distance must be finite');
    const hazard = course?.hazards?.find(candidate => candidate.id === armed.hazardId) || null;
    if(!hazard){
      armed = null;
      armedPresented = false;
      ignoredCount += 1;
      result('ignored', 'missing-armed-hazard');
      return null;
    }
    if(courseS < armed.actionAt || !armedPresented) return null;
    const ready = armed;
    armed = null;
    armedPresented = false;
    if(firedHazards.has(ready.hazardId)) return null;
    firedHazards.add(ready.hazardId);
    firedCount += 1;
    result('fire', 'armed-action-window-open', {
      hazardId: ready.hazardId,
      action: { ...ready.action },
      armedAtS: ready.armedAtS,
      firedAtS: courseS,
    });
    return { ...ready, action: { ...ready.action }, firedAtS: courseS };
  }

  /** Called by the presentation after READY has been assigned for one render.
   * The next fixed-step frame may fire, never the same frame that armed it. */
  function markPresented(hazardId){
    if(!armed || armed.hazardId !== hazardId || armedPresented) return false;
    armedPresented = true;
    presentedCount += 1;
    return true;
  }

  function clear(reason = 'manual', { clearFired = false } = {}){
    const hadArmed = Boolean(armed);
    armed = null;
    armedPresented = false;
    if(clearFired) firedHazards.clear();
    lastClearReason = reason;
    return hadArmed;
  }

  function snapshot(){
    return {
      armed: copyArmed(armed),
      armedPresented,
      armedCount,
      firedCount,
      ignoredCount,
      presentedCount,
      firedHazards: [...firedHazards],
      lastClearReason,
      lastRoute: lastRoute ? { ...lastRoute, action: lastRoute.action ? { ...lastRoute.action } : undefined } : null,
    };
  }

  return Object.freeze({
    route,
    takeReady,
    markPresented,
    clear,
    snapshot,
    get armed(){ return armed; },
    get armedPresented(){ return armedPresented; },
    get state(){ return snapshot(); },
  });
}
