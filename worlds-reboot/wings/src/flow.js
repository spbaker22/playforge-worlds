/* PAPER WINGS - pure guarded campaign flow with one authoritative mode. */
import { createCampaignState, restoreCampaignState } from './campaign.js';
import { WING_MISSIONS, missionById } from './missions.js';

export const WING_FLOW_VERSION = 1;

export const WING_FLOW_MODES = Object.freeze([
  'title',
  'campaign',
  'briefing',
  'countdown',
  'play',
  'recovery',
  'fail',
  'results',
]);

export const WING_FLOW_ACTION = Object.freeze({
  OPEN_CAMPAIGN: 'open-campaign',
  SELECT_MISSION: 'select-mission',
  CONFIRM_BRIEFING: 'confirm-briefing',
  COUNTDOWN_COMPLETE: 'countdown-complete',
  PHASE_CHANGE: 'phase-change',
  DISMISS_OVERLAY: 'dismiss-overlay',
  BEGIN_RECOVERY: 'begin-recovery',
  COMPLETE_RECOVERY: 'complete-recovery',
  MISSION_SUCCESS: 'mission-success',
  MISSION_FAIL: 'mission-fail',
  SHOW_RESULTS: 'show-results',
  REPLAY: 'replay',
  NEXT: 'next',
  MAP: 'map',
  PAUSE: 'pause',
  RESUME: 'resume',
  ACK_SIGNALS: 'ack-signals',
  RESET_TITLE: 'reset-title',
});

const PAUSABLE_MODES = new Set(['briefing', 'countdown', 'play', 'recovery']);
const GAMEPLAY_MODES = new Set(['play', 'recovery']);

function safeCampaign(value, catalog){
  try { return restoreCampaignState(value || createCampaignState(catalog), catalog); }
  catch { return createCampaignState(catalog); }
}

function transitionRecord(state, action, accepted, code, from = state.mode, to = state.mode){
  return {
    sequence: state.decisionSequence + 1,
    action,
    accepted,
    code,
    from,
    to,
  };
}

function reject(state, event, code){
  return {
    ...state,
    decisionSequence: state.decisionSequence + 1,
    lastDecision: transitionRecord(state, event.type, false, code),
  };
}

function accept(state, event, mode, patch = {}, { keepOverlay = false } = {}){
  return {
    ...state,
    ...patch,
    mode,
    decisionSequence: state.decisionSequence + 1,
    lastDecision: transitionRecord(state, event.type, true, 'ok', state.mode, mode),
    overlay: Object.hasOwn(patch, 'overlay') ? patch.overlay : keepOverlay ? state.overlay : null,
  };
}

function signal(state, type, reason){
  const entry = {
    id: `flow-signal-${state.signalSequence.toString(36).padStart(5, '0')}`,
    type,
    reason,
  };
  return {
    signals: [...state.signals, entry],
    signalSequence: state.signalSequence + 1,
  };
}

function resultFromEvent(state, event, outcome){
  return {
    outcome,
    missionId: state.activeMissionId,
    reason: typeof event.reason === 'string' ? event.reason : outcome === 'success' ? 'mission-complete' : 'mission-failed',
    score: Math.max(0, Number.isFinite(event.score) ? Math.floor(event.score) : 0),
    stars: Math.min(3, Math.max(0, Number.isFinite(event.stars) ? Math.floor(event.stars) : 0)),
    timeMs: Number.isFinite(event.timeMs) && event.timeMs > 0 ? Math.floor(event.timeMs) : null,
    combo: Math.max(0, Number.isFinite(event.combo) ? Math.floor(event.combo) : 0),
    completedObjectiveIds: Array.isArray(event.completedObjectiveIds) ? [...new Set(event.completedObjectiveIds.filter(id => typeof id === 'string'))] : [],
  };
}

function nextUnlockedMission(currentMissionId, campaign, catalog){
  const index = catalog.findIndex(mission => mission.id === currentMissionId);
  if(index < 0) return null;
  for(let offset = 1; offset < catalog.length; offset += 1){
    const mission = catalog[index + offset];
    if(mission && campaign.unlockedMissionIds.includes(mission.id)) return mission.id;
  }
  return null;
}

export function createWingFlowState(){
  return {
    version: WING_FLOW_VERSION,
    mode: 'title',
    paused: false,
    selectedMissionId: null,
    activeMissionId: null,
    overlay: null,
    overlaySequence: 0,
    recovery: null,
    result: null,
    signals: [],
    signalSequence: 0,
    decisionSequence: 0,
    lastDecision: null,
  };
}

export function canSelectWingMission(campaignState, missionId, catalog = WING_MISSIONS){
  const campaign = safeCampaign(campaignState, catalog);
  return missionById(missionId, catalog) !== null && campaign.unlockedMissionIds.includes(missionId);
}

export function reduceWingFlow(state, event, { campaign: campaignState, catalog = WING_MISSIONS } = {}){
  if(!state || state.version !== WING_FLOW_VERSION || !WING_FLOW_MODES.includes(state.mode)) throw new TypeError('valid Wings flow state is required');
  if(!event || typeof event.type !== 'string') throw new TypeError('Wings flow event is required');
  const campaign = safeCampaign(campaignState, catalog);

  if(state.paused && ![WING_FLOW_ACTION.RESUME, WING_FLOW_ACTION.ACK_SIGNALS, WING_FLOW_ACTION.RESET_TITLE].includes(event.type)){
    return reject(state, event, 'flow-paused');
  }

  switch(event.type){
    case WING_FLOW_ACTION.OPEN_CAMPAIGN:
      return state.mode === 'title' ? accept(state, event, 'campaign') : reject(state, event, 'wrong-mode');

    case WING_FLOW_ACTION.SELECT_MISSION: {
      if(state.mode !== 'campaign') return reject(state, event, 'wrong-mode');
      if(!missionById(event.missionId, catalog)) return reject(state, event, 'unknown-mission');
      if(!campaign.unlockedMissionIds.includes(event.missionId)) return reject(state, event, 'mission-locked');
      return accept(state, event, 'briefing', {
        selectedMissionId: event.missionId,
        activeMissionId: event.missionId,
        recovery: null,
        result: null,
      });
    }

    case WING_FLOW_ACTION.CONFIRM_BRIEFING:
      return state.mode === 'briefing' && state.selectedMissionId
        ? accept(state, event, 'countdown')
        : reject(state, event, 'wrong-mode');

    case WING_FLOW_ACTION.COUNTDOWN_COMPLETE:
      return state.mode === 'countdown' && state.activeMissionId
        ? accept(state, event, 'play')
        : reject(state, event, 'wrong-mode');

    case WING_FLOW_ACTION.PHASE_CHANGE: {
      if(!GAMEPLAY_MODES.has(state.mode)) return reject(state, event, 'wrong-mode');
      if(typeof event.phaseId !== 'string' || event.phaseId.length === 0) return reject(state, event, 'invalid-phase');
      const overlaySequence = state.overlaySequence + 1;
      return accept(state, event, state.mode, {
        overlaySequence,
        overlay: {
          id: `phase-overlay-${overlaySequence.toString(36).padStart(4, '0')}`,
          type: 'phase-change',
          phaseId: event.phaseId,
          label: typeof event.label === 'string' ? event.label : event.phaseId,
        },
      }, { keepOverlay: true });
    }

    case WING_FLOW_ACTION.DISMISS_OVERLAY:
      return state.overlay ? accept(state, event, state.mode, { overlay: null }, { keepOverlay: true }) : reject(state, event, 'no-overlay');

    case WING_FLOW_ACTION.BEGIN_RECOVERY:
      return state.mode === 'play'
        ? accept(state, event, 'recovery', { recovery: { reason: event.reason || 'miss', checkpointId: typeof event.checkpointId === 'string' ? event.checkpointId : null } })
        : reject(state, event, 'wrong-mode');

    case WING_FLOW_ACTION.COMPLETE_RECOVERY:
      return state.mode === 'recovery'
        ? accept(state, event, 'play', { recovery: null })
        : reject(state, event, 'wrong-mode');

    case WING_FLOW_ACTION.MISSION_SUCCESS:
      return GAMEPLAY_MODES.has(state.mode)
        ? accept(state, event, 'results', { paused: false, recovery: null, result: resultFromEvent(state, event, 'success') })
        : reject(state, event, 'wrong-mode');

    case WING_FLOW_ACTION.MISSION_FAIL:
      return GAMEPLAY_MODES.has(state.mode)
        ? accept(state, event, 'fail', { paused: false, recovery: null, result: resultFromEvent(state, event, 'failure') })
        : reject(state, event, 'wrong-mode');

    case WING_FLOW_ACTION.SHOW_RESULTS:
      return state.mode === 'fail' ? accept(state, event, 'results') : reject(state, event, 'wrong-mode');

    case WING_FLOW_ACTION.REPLAY:
      return ['results', 'fail'].includes(state.mode) && state.activeMissionId
        ? accept(state, event, 'briefing', { paused: false, recovery: null, result: null, selectedMissionId: state.activeMissionId })
        : reject(state, event, 'wrong-mode');

    case WING_FLOW_ACTION.NEXT: {
      if(state.mode !== 'results' || state.result?.outcome !== 'success') return reject(state, event, 'next-unavailable');
      const missionId = event.missionId || nextUnlockedMission(state.activeMissionId, campaign, catalog);
      if(!missionId) return reject(state, event, 'campaign-complete');
      if(!missionById(missionId, catalog)) return reject(state, event, 'unknown-mission');
      if(!campaign.unlockedMissionIds.includes(missionId)) return reject(state, event, 'mission-locked');
      return accept(state, event, 'briefing', { selectedMissionId: missionId, activeMissionId: missionId, result: null, recovery: null });
    }

    case WING_FLOW_ACTION.MAP:
      return ['briefing', 'countdown', 'fail', 'results'].includes(state.mode)
        ? accept(state, event, 'campaign', { paused: false, recovery: null, result: null })
        : reject(state, event, 'wrong-mode');

    case WING_FLOW_ACTION.PAUSE:
      if(state.paused) return reject(state, event, 'already-paused');
      if(!PAUSABLE_MODES.has(state.mode)) return reject(state, event, 'not-pausable');
      return accept(state, event, state.mode, {
        paused: true,
        ...signal(state, 'cancel-pointers', event.reason || 'pause'),
      }, { keepOverlay: true });

    case WING_FLOW_ACTION.RESUME:
      return state.paused
        ? accept(state, event, state.mode, { paused: false }, { keepOverlay: true })
        : reject(state, event, 'not-paused');

    case WING_FLOW_ACTION.ACK_SIGNALS:
      return state.signals.length
        ? accept(state, event, state.mode, { signals: [] }, { keepOverlay: true })
        : reject(state, event, 'no-signals');

    case WING_FLOW_ACTION.RESET_TITLE: {
      const cancellation = PAUSABLE_MODES.has(state.mode) || state.paused
        ? signal(state, 'cancel-pointers', event.reason || 'reset-title')
        : {};
      return accept(state, event, 'title', {
        paused: false,
        selectedMissionId: null,
        activeMissionId: null,
        recovery: null,
        result: null,
        ...cancellation,
      });
    }

    default:
      return reject(state, event, 'unknown-action');
  }
}

export function wingFlowSnapshot(state){
  if(!state || state.version !== WING_FLOW_VERSION) throw new TypeError('valid Wings flow state is required');
  return Object.freeze(JSON.parse(JSON.stringify(state)));
}
