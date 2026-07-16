const UINT32_RANGE = 0x1_0000_0000;
const ROUND_KEY_VERSION = 'stackyard-golf-rivals-v1';

function hashRoundKey(value){
  let hash = 0x811c9dc5;
  for(const character of String(value)){
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function normalizeMode(mode){
  return mode === 'relaxed' ? 'relaxed' : 'standard';
}

/**
 * Stable identity for one selectable round. Replays reset to this same key, so
 * the same options and play order always produce the same rival card.
 */
export function createGolfRivalRoundKey({
  preview = false,
  format = 'front-six',
  practiceHole = 1,
  cupAssist = 'standard',
  rivals = 'standard',
  holes = [],
} = {}){
  const holeKey = [...holes].map(hole => Number(hole) | 0).join(',');
  return [
    ROUND_KEY_VERSION,
    `preview:${preview ? 1 : 0}`,
    `format:${String(format)}`,
    `practice:${Number(practiceHole) | 0}`,
    `cup:${String(cupAssist)}`,
    `rivals:${normalizeMode(rivals)}`,
    `holes:${holeKey}`,
  ].join('|');
}

/** Round-local deterministic rival scorer. It intentionally owns its RNG. */
export function createGolfRivalRound({ roundKey, mode = 'standard' } = {}){
  let key = String(roundKey || ROUND_KEY_VERSION);
  let rivalMode = normalizeMode(mode);
  let seed = 0;
  let state = 0;
  let draws = 0;

  function reset({ roundKey: nextKey = key, mode: nextMode = rivalMode } = {}){
    key = String(nextKey || ROUND_KEY_VERSION);
    rivalMode = normalizeMode(nextMode);
    seed = hashRoundKey(`${key}|mode:${rivalMode}`);
    state = seed;
    draws = 0;
    return snapshot();
  }

  function nextUnit(){
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    draws += 1;
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
  }

  function nextStrokes(par){
    if(!Number.isInteger(par) || par < 1) throw new RangeError('par must be a positive integer');
    const value = nextUnit();
    if(rivalMode === 'relaxed'){
      if(value < 0.05) return Math.max(1, par - 1);
      if(value < 0.45) return par;
      if(value < 0.82) return par + 1;
      return par + 2;
    }
    if(value < 0.15) return Math.max(1, par - 1);
    if(value < 0.66) return par;
    if(value < 0.90) return par + 1;
    return par + 2;
  }

  function snapshot(){
    return { roundKey: key, mode: rivalMode, seed, draws };
  }

  reset();
  return { reset, nextStrokes, snapshot };
}
