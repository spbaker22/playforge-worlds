/* PAPER WINGS - defensive parsing for shared preview preferences. */
import { WING_MISSION_IDS } from './missions.js';

const SOUND_VALUES = new Set(['on', 'off']);
const QUALITY_VALUES = new Set(['auto', 'performance']);
const ROUTE_VALUES = new Set(['quick', 'full']);
const CONTROL_VALUES = new Set(['guided', 'direct']);
const RACE_VALUES = new Set(['solo', 'rivals']);
const MISSION_VALUES = new Set(WING_MISSION_IDS);

export const WING_LOADOUT_VALUES = Object.freeze(['balanced', 'racer', 'stunt', 'guardian']);
const LOADOUT_VALUES = new Set(WING_LOADOUT_VALUES);

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
  if(ROUTE_VALUES.has(parsed.wingsRoute)) safe.wingsRoute = parsed.wingsRoute;
  if(CONTROL_VALUES.has(parsed.wingsControl)) safe.wingsControl = parsed.wingsControl;
  if(RACE_VALUES.has(parsed.wingsRace)) safe.wingsRace = parsed.wingsRace;
  if(MISSION_VALUES.has(parsed.wingsMission)) safe.wingsMission = parsed.wingsMission;
  if(LOADOUT_VALUES.has(parsed.wingsLoadout)) safe.wingsLoadout = parsed.wingsLoadout;
  return safe;
}
