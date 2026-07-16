/* LOW TIDE — format-specific rival targets and standings. */

const FORMAT_DURATION = Object.freeze({ quick: 45, full: 90 });
const TARGETS = Object.freeze({
  quick: Object.freeze({
    haul: Object.freeze({ mara: 12.5, elias: 10.5 }),
    trophy: Object.freeze({ mara: 1400, elias: 1150 }),
  }),
  full: Object.freeze({
    haul: Object.freeze({ mara: 21.5, elias: 18.5 }),
    trophy: Object.freeze({ mara: 2250, elias: 1850 }),
  }),
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function assertFormat(session, scoring){
  if(!Object.hasOwn(TARGETS, session)) throw new RangeError(`unsupported tideSession: ${session}`);
  if(!Object.hasOwn(TARGETS[session], scoring)) throw new RangeError(`unsupported tideScoring: ${scoring}`);
}

export function tideRivalTargets({ session = 'full', scoring = 'haul' } = {}){
  assertFormat(session, scoring);
  return TARGETS[session][scoring];
}

export function tideRivalTotals({ session = 'full', scoring = 'haul', time = 0, duration = FORMAT_DURATION[session] } = {}){
  assertFormat(session, scoring);
  if(!Number.isFinite(time)) throw new TypeError('time must be finite');
  if(!Number.isFinite(duration) || duration <= 0) throw new RangeError('duration must be positive');
  const targets = tideRivalTargets({ session, scoring });
  const progress = clamp(time / duration, 0, 1);
  const round = scoring === 'trophy'
    ? value => Math.round(value)
    : value => Math.round(value * 10) / 10;
  return Object.freeze({
    mara: round(targets.mara * progress),
    elias: round(targets.elias * progress),
  });
}

export function tideStanding(player, rivals){
  if(!Number.isFinite(player)) throw new TypeError('player total must be finite');
  if(!Number.isFinite(rivals?.mara) || !Number.isFinite(rivals?.elias)) throw new TypeError('rival totals must be finite');
  return Object.freeze({
    rank: 1 + [rivals.mara, rivals.elias].filter(total => total > player).length,
    total: 3,
  });
}

export function tideScoreboard({ scoring = 'haul', haulKg = 0, score = 0 } = {}){
  if(scoring !== 'haul' && scoring !== 'trophy') throw new RangeError(`unsupported tideScoring: ${scoring}`);
  if(!Number.isFinite(haulKg) || !Number.isFinite(score)) throw new TypeError('player totals must be finite');
  const kilograms = Object.freeze({ value: haulKg, unit: 'KG' });
  const points = Object.freeze({ value: score, unit: 'PTS' });
  return Object.freeze(scoring === 'trophy'
    ? { primary: points, secondary: kilograms }
    : { primary: kilograms, secondary: points });
}

/** One authoritative metric/standing snapshot for both live HUD and results. */
export function tideCompetition({ session = 'full', scoring = 'haul', time = 0, duration = FORMAT_DURATION[session], haulKg = 0, score = 0 } = {}){
  const metrics = tideScoreboard({ scoring, haulKg, score });
  const rivals = tideRivalTotals({ session, scoring, time, duration });
  const player = metrics.primary.value;
  const standing = tideStanding(player, rivals);
  return Object.freeze({ player, metrics, rivals, rank: standing.rank, total: standing.total });
}
