export const ASHFALL_BOUNDS = Object.freeze({
  minX: -6.2,
  maxX: 6.2,
  minZ: -4.4,
  maxZ: 4.6,
});

export const ASHFALL_SCORE = Object.freeze({
  survivalPerSecond: 10,
  nearMiss: 90,
  evade: 28,
  hitPenalty: 35,
  completionPerSecond: 160,
  heartBonus: 600,
});

export const ASHFALL_WAVE = Object.freeze({
  firstAt: 6,
  interval: 8,
  slots: 12,
  radiusX: 5.4,
  radiusZ: 3.8,
  centerZ: 0.1,
  radiusScale: 1.2,
  minimumLead: 1.45,
});

const MODE_LABELS = Object.freeze({ quick: 'QUICK RUN', full: 'FULL RUN' });
const INTENSITY_LABELS = Object.freeze({ calm: 'CALM ASH', standard: 'STANDARD ASH', inferno: 'INFERNO ASH' });

export function ashfallRunLabel(mode, intensity){
  const modeLabel = MODE_LABELS[mode];
  const intensityLabel = INTENSITY_LABELS[intensity];
  if(!modeLabel) throw new RangeError(`unsupported ashMode: ${mode}`);
  if(!intensityLabel) throw new RangeError(`unsupported ashIntensity: ${intensity}`);
  return `${modeLabel} · ${intensityLabel}`;
}

export function ashfallCompletionBonus(duration, hearts){
  if(!Number.isFinite(duration) || duration <= 0) throw new RangeError('duration must be positive');
  if(!Number.isInteger(hearts) || hearts < 1 || hearts > 3) throw new RangeError('hearts must be between 1 and 3');
  return Math.floor(duration * ASHFALL_SCORE.completionPerSecond + hearts * ASHFALL_SCORE.heartBonus);
}

export function ashfallWaveSchedule(duration){
  if(!Number.isFinite(duration) || duration <= 0) throw new RangeError('duration must be positive');
  const starts = [];
  for(let at = ASHFALL_WAVE.firstAt; at < duration - ASHFALL_WAVE.minimumLead; at += ASHFALL_WAVE.interval){
    starts.push(at);
  }
  return Object.freeze(starts);
}

/** Stable per-replay seeds: run zero preserves the authored baseline, later runs vary deterministically. */
export function ashfallSeedForRun(baseSeed, runIndex){
  if(!Number.isInteger(baseSeed)) throw new TypeError('baseSeed must be an integer');
  if(!Number.isInteger(runIndex) || runIndex < 0) throw new RangeError('runIndex must be a non-negative integer');
  const base = baseSeed >>> 0;
  if(runIndex === 0) return base;
  let value = (base + Math.imul(runIndex, 0x9E3779B9)) >>> 0;
  value = Math.imul(value ^ value >>> 16, 0x21F0AAAD) >>> 0;
  value = Math.imul(value ^ value >>> 15, 0x735A2D97) >>> 0;
  return (value ^ value >>> 15) >>> 0;
}
