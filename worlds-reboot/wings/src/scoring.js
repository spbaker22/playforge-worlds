/* PAPER WINGS - deterministic score, combo, multiplier, and event deduplication reducer. */

export const SCORING_STATE_VERSION = 1;

export const SCORE_ACTION = Object.freeze({
  TICK: 'tick',
  AWARD: 'award',
  BREAK_COMBO: 'break-combo',
});

export const SCORE_VALUES = Object.freeze({
  gate: 100,
  'precision-gate': 160,
  thermal: 80,
  target: 125,
  stunt: 200,
  rescue: 500,
  'precision-drop': 240,
  'near-miss': 75,
  'rival-pass': 250,
  'boss-hit': 300,
  'boss-phase': 1000,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function comboMultiplierFor(combo){
  if(combo >= 15) return 3;
  if(combo >= 10) return 2;
  if(combo >= 6) return 1.5;
  if(combo >= 3) return 1.25;
  return 1;
}

export function createScoreState(options = {}){
  const comboWindowSeconds = Number.isFinite(options.comboWindowSeconds)
    ? clamp(options.comboWindowSeconds, 0.5, 10)
    : 3.5;
  return {
    version: SCORING_STATE_VERSION,
    time: 0,
    score: 0,
    combo: 0,
    bestCombo: 0,
    multiplier: 1,
    comboRemaining: 0,
    comboWindowSeconds,
    awards: 0,
    breaks: 0,
    seenEventIds: [],
    lastAward: null,
    event: null,
    eventSequence: 0,
  };
}

function tick(state, action){
  if(!Number.isFinite(action.dt) || action.dt < 0) throw new RangeError('score tick dt must be non-negative');
  if(action.dt === 0) return { ...state, event: null };
  const remaining = Math.max(0, state.comboRemaining - action.dt);
  const expired = state.combo > 0 && remaining === 0;
  return {
    ...state,
    time: state.time + action.dt,
    combo: expired ? 0 : state.combo,
    multiplier: expired ? 1 : state.multiplier,
    comboRemaining: remaining,
    event: expired ? 'combo-expired' : null,
    eventSequence: expired ? state.eventSequence + 1 : state.eventSequence,
  };
}

function award(state, action){
  if(typeof action.eventId !== 'string' || action.eventId.length === 0) throw new TypeError('score awards require a stable eventId');
  if(state.seenEventIds.includes(action.eventId)) return { ...state, event: null };
  const preset = SCORE_VALUES[action.kind];
  const basePoints = Number.isFinite(action.basePoints) ? Math.max(0, Math.floor(action.basePoints)) : preset;
  if(!Number.isFinite(basePoints)) throw new RangeError(`unknown score kind ${action.kind}`);
  const chainable = action.chainable !== false;
  const combo = chainable ? (state.comboRemaining > 0 ? state.combo + 1 : 1) : state.combo;
  const multiplier = chainable ? comboMultiplierFor(combo) : 1;
  const points = Math.round(basePoints * multiplier);
  const comboWindow = Number.isFinite(action.comboWindowSeconds)
    ? clamp(action.comboWindowSeconds, 0.5, 10)
    : state.comboWindowSeconds;
  return {
    ...state,
    score: state.score + points,
    combo,
    bestCombo: Math.max(state.bestCombo, combo),
    multiplier: chainable ? multiplier : state.multiplier,
    comboRemaining: chainable ? comboWindow : state.comboRemaining,
    awards: state.awards + 1,
    seenEventIds: [...state.seenEventIds, action.eventId],
    lastAward: { eventId: action.eventId, kind: action.kind || 'custom', basePoints, multiplier, points },
    event: 'award',
    eventSequence: state.eventSequence + 1,
  };
}

export function reduceScore(state, action){
  if(!state || state.version !== SCORING_STATE_VERSION) throw new TypeError('valid score state is required');
  if(!action || typeof action.type !== 'string') throw new TypeError('score action is required');
  switch(action.type){
    case SCORE_ACTION.TICK:
      return tick(state, action);
    case SCORE_ACTION.AWARD:
      return award(state, action);
    case SCORE_ACTION.BREAK_COMBO: {
      if(state.combo === 0) return { ...state, event: null };
      return { ...state, combo: 0, multiplier: 1, comboRemaining: 0, breaks: state.breaks + 1, event: action.reason ? `combo-broken:${action.reason}` : 'combo-broken', eventSequence: state.eventSequence + 1 };
    }
    default:
      throw new RangeError(`unknown score action ${action.type}`);
  }
}

export const reduceScoring = reduceScore;

export function scoreSnapshot(state){
  if(!state || state.version !== SCORING_STATE_VERSION) throw new TypeError('valid score state is required');
  return Object.freeze({
    ...state,
    seenEventIds: Object.freeze([...state.seenEventIds]),
    lastAward: state.lastAward ? Object.freeze({ ...state.lastAward }) : null,
  });
}
