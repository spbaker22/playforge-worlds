/* LOW TIDE — deterministic fish deck and scoring. */

const TIERS = Object.freeze({
  common: Object.freeze({ order: 0, label: 'HARBOR', color: '#b8c9c6', baseScore: 90 }),
  rare: Object.freeze({ order: 1, label: 'DEEP WATER', color: '#e0c38d', baseScore: 260 }),
  trophy: Object.freeze({ order: 2, label: 'TROPHY', color: '#f0a85f', baseScore: 720 }),
});

export const FISH_TIERS = TIERS;

const ZONES = Object.freeze({
  pier: Object.freeze({ id: 'pier', label: 'PIER LIGHTS', hint: 'SHORT + CENTER', tierShift: -0.10, biteScale: 0.76 }),
  channel: Object.freeze({ id: 'channel', label: 'DEEP CHANNEL', hint: 'LONG + CENTER', tierShift: 0.14, biteScale: 1.10 }),
  breakwater: Object.freeze({ id: 'breakwater', label: 'BREAKWATER', hint: 'PULL SIDEWAYS', tierShift: 0.03, biteScale: 0.90 }),
});

export const HARBOR_ZONES = ZONES;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Three readable harbor waters selected by cast distance and sideways reach. */
export function harborZoneForCast({ castPower = 0.5, castLateral = 0 } = {}){
  if(!Number.isFinite(castPower)) throw new TypeError('castPower must be finite');
  if(!Number.isFinite(castLateral)) throw new TypeError('castLateral must be finite');
  const power = clamp(castPower, 0.08, 1);
  const lateral = clamp(castLateral, -1, 1);
  const sidewaysReach = Math.abs(lateral) * (0.68 + power * 0.32);
  if(sidewaysReach >= 0.50) return ZONES.breakwater;
  if(power >= 0.64) return ZONES.channel;
  return ZONES.pier;
}

export const FISH_CATALOG = Object.freeze([
  Object.freeze({ id: 'mackerel', name: 'Harbor mackerel', tier: 'common', minKg: 0.7, maxKg: 2.2, fight: 0.42, bite: 1.55 }),
  Object.freeze({ id: 'silver-perch', name: 'Silver perch', tier: 'common', minKg: 1.1, maxKg: 3.6, fight: 0.50, bite: 1.85 }),
  Object.freeze({ id: 'red-mullet', name: 'Red mullet', tier: 'common', minKg: 1.4, maxKg: 4.1, fight: 0.56, bite: 2.15 }),
  Object.freeze({ id: 'blue-runner', name: 'Blue runner', tier: 'rare', minKg: 3.8, maxKg: 7.8, fight: 0.69, bite: 2.5 }),
  Object.freeze({ id: 'moon-bass', name: 'Moon bass', tier: 'rare', minKg: 5.2, maxKg: 10.4, fight: 0.76, bite: 2.9 }),
  Object.freeze({ id: 'ghost-tarpon', name: 'Ghost tarpon', tier: 'trophy', minKg: 11.5, maxKg: 24.0, fight: 0.94, bite: 3.35 }),
]);

function mix32(value){
  value = Math.imul(value ^ value >>> 16, 0x21f0aaad);
  value = Math.imul(value ^ value >>> 15, 0x735a2d97);
  return (value ^ value >>> 15) >>> 0;
}

/** Stable replay seed: replay zero preserves the authored seed; later watches vary. */
export function tideRunSeed(baseSeed = 0x10f71de, runIndex = 0){
  if(!Number.isInteger(baseSeed)) throw new TypeError('baseSeed must be an integer');
  if(!Number.isInteger(runIndex) || runIndex < 0) throw new RangeError('runIndex must be a non-negative integer');
  const base = baseSeed >>> 0;
  return runIndex === 0 ? base : mix32(base ^ Math.imul(runIndex, 0x9e3779b1));
}

/** Stable random sample addressed by seed/cast/channel; no mutable RNG state. */
export function tideRandom(seed, castIndex, channel = 0){
  const key = (seed >>> 0) ^ Math.imul((castIndex + 1) >>> 0, 0x9e3779b1) ^ Math.imul((channel + 11) >>> 0, 0x85ebca6b);
  return mix32(key) / 4294967296;
}

function tierForRoll(roll, scoring, castPower, zone){
  const powerBonus = Math.max(0, Math.min(1, castPower) - 0.62);
  const trophyAt = scoring === 'trophy' ? 0.84 - powerBonus * 0.15 : 0.95 - powerBonus * 0.08;
  const rareAt = scoring === 'trophy' ? 0.54 - powerBonus * 0.08 : 0.70 - powerBonus * 0.08;
  const zoneRoll = clamp(roll + zone.tierShift, 0, 1);
  if(zoneRoll >= trophyAt) return 'trophy';
  if(zoneRoll >= rareAt) return 'rare';
  return 'common';
}

export function fishForCast({ seed = 0x10f71de, castIndex = 0, scoring = 'haul', castPower = 0.5, castLateral = 0 } = {}){
  if(scoring !== 'haul' && scoring !== 'trophy') throw new RangeError(`unsupported tideScoring: ${scoring}`);
  if(!Number.isInteger(castIndex) || castIndex < 0) throw new RangeError('castIndex must be a non-negative integer');
  if(!Number.isFinite(castPower)) throw new TypeError('castPower must be finite');
  if(!Number.isFinite(castLateral)) throw new TypeError('castLateral must be finite');
  const zone = harborZoneForCast({ castPower, castLateral });
  const tier = tierForRoll(tideRandom(seed, castIndex, 0), scoring, castPower, zone);
  const pool = FISH_CATALOG.filter(fish => fish.tier === tier);
  const species = pool[Math.min(pool.length - 1, Math.floor(tideRandom(seed, castIndex, 1) * pool.length))];
  const weightT = tideRandom(seed, castIndex, 2);
  const weightKg = species.minKg + (species.maxKg - species.minKg) * (0.18 + weightT * 0.82);
  const temperament = 0.92 + tideRandom(seed, castIndex, 3) * 0.16;
  const biteDelay = species.bite * (0.82 + tideRandom(seed, castIndex, 4) * 0.38) * zone.biteScale;
  return Object.freeze({
    ...species,
    weightKg: Math.round(weightKg * 10) / 10,
    fight: Math.min(1, species.fight * temperament),
    biteDelay,
    surgePhase: tideRandom(seed, castIndex, 5) * Math.PI * 2,
    tierLabel: TIERS[tier].label,
    tierColor: TIERS[tier].color,
    zone: zone.id,
    zoneLabel: zone.label,
  });
}

export function scoreFish(fish, scoring = 'haul'){
  if(!fish || !TIERS[fish.tier] || !Number.isFinite(fish.weightKg)) throw new TypeError('scoreFish requires a valid fish');
  if(scoring !== 'haul' && scoring !== 'trophy') throw new RangeError(`unsupported tideScoring: ${scoring}`);
  const tier = TIERS[fish.tier];
  const weightValue = Math.round(fish.weightKg * (scoring === 'haul' ? 34 : 18));
  const trophyMultiplier = scoring === 'trophy' ? [1, 1.65, 2.8][tier.order] : 1;
  return Math.round((tier.baseScore + weightValue) * trophyMultiplier);
}
