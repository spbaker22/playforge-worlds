/* LOW TIDE — pure UI visibility and outcome-copy decisions. */

const ACTIVE_LAST_FISH_PHASES = new Set(['casting', 'waiting', 'bite', 'reeling']);
const CLEAN_CATCH_COPY = Object.freeze({
  pier: 'A clean line under the pier lights.',
  channel: 'A clean line from the deep channel.',
  breakwater: 'A clean line along the breakwater.',
});

export function tideLastFishVisible({ flow, state } = {}){
  return flow === 'play'
    && state?.status === 'running'
    && state.overtime === true
    && ACTIVE_LAST_FISH_PHASES.has(state.phase);
}

export function tideOutcomeNote(outcome){
  if(!outcome || (outcome.type !== 'catch' && outcome.type !== 'snap')) throw new TypeError('tideOutcomeNote requires an outcome');
  const zoneId = outcome.zone?.id ?? outcome.fish?.zone ?? null;
  const zoneLabel = outcome.zone?.label ?? outcome.fish?.zoneLabel ?? 'HARBOR WATER';
  if(outcome.type === 'catch'){
    const catchCopy = outcome.fish?.tier === 'trophy'
      ? 'The harbor will talk about this one at first light.'
      : CLEAN_CATCH_COPY[zoneId] ?? 'A clean line from the harbor.';
    return `${zoneLabel} · ${catchCopy}`;
  }
  const snapCopy = outcome.reason === 'missed-bite'
    ? 'The float settles. Wait for the cue, then tap once.'
    : 'Release before the tension crosses the white mark.';
  return `${zoneLabel} · ${snapCopy}`;
}
