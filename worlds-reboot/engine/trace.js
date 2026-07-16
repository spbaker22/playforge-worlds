/* Playforge engine — bounded, serializable runtime diagnostics. */

const defaultClock = () => globalThis.performance?.now?.() ?? Date.now();

function clone(value){
  try { return globalThis.structuredClone(value); }
  catch(error){ throw new TypeError(`trace details must be structured-cloneable: ${error?.message || error}`); }
}

function cloneDetail(detail){
  if(detail === null || detail === undefined) return {};
  if(typeof detail !== 'object' || Array.isArray(detail)) throw new TypeError('trace detail must be an object');
  return clone(detail);
}

/** Create a bounded state/event trace suitable for exposing through __gp. */
export function createStateTrace({ limit = 200, clock = defaultClock } = {}){
  if(!Number.isInteger(limit) || limit < 1) throw new RangeError('trace limit must be a positive integer');
  if(typeof clock !== 'function') throw new TypeError('trace clock must be a function');
  let sequence = 0;
  const entries = [];

  function record(type, detail = {}){
    if(typeof type !== 'string' || !type) throw new TypeError('trace event type must be a non-empty string');
    const safeDetail = cloneDetail(detail);
    const time = clock();
    if(typeof time !== 'number' || !Number.isFinite(time)) throw new TypeError('trace clock must return a finite number');
    // Reserved identity fields are written last so callers cannot forge them.
    const entry = { ...safeDetail, sequence: ++sequence, time, type };
    entries.push(entry);
    if(entries.length > limit) entries.splice(0, entries.length - limit);
    return clone(entry);
  }

  function transition(from, to, reason, detail = {}){
    // Transition identity is also reserved; diagnostic details cannot replace it.
    return record('transition', { ...cloneDetail(detail), from, to, reason });
  }

  function snapshot(){
    return clone(entries);
  }

  function clear(){
    entries.length = 0;
  }

  return {
    record,
    transition,
    snapshot,
    clear,
    get size(){ return entries.length; },
    get last(){ return entries.length ? clone(entries.at(-1)) : null; },
  };
}
