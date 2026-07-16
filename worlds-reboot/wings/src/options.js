/* PAPER WINGS - defensive parsing for shared preview preferences. */

const SOUND_VALUES = new Set(['on', 'off']);
const QUALITY_VALUES = new Set(['auto', 'performance']);

export function parseStoredSharedOptions(raw){
  if(typeof raw !== 'string') return {};
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return {}; }
  if(parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  if(Object.getPrototypeOf(parsed) !== Object.prototype) return {};

  const safe = {};
  if(SOUND_VALUES.has(parsed.sound)) safe.sound = parsed.sound;
  if(QUALITY_VALUES.has(parsed.quality)) safe.quality = parsed.quality;
  return safe;
}
