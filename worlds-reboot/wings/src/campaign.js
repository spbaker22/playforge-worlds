/* PAPER WINGS - storage-agnostic, versioned campaign progression. */
import { MISSION_CATALOG_VERSION, WING_MISSIONS, assertValidMissionCatalog, getUnlockedMissionIds, missionById } from './missions.js';

export const CAMPAIGN_STATE_VERSION = 1;

const clampInt = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value) : min));
const maxInt = value => clampInt(value, 0, Number.MAX_SAFE_INTEGER);

function emptyRecord(){
  return {
    attempts: 0,
    completions: 0,
    completed: false,
    bestScore: 0,
    bestStars: 0,
    bestTimeMs: null,
    bestCombo: 0,
    completedObjectiveIds: [],
  };
}

function orderedValidIds(ids, catalog){
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  return catalog.filter(mission => wanted.has(mission.id)).map(mission => mission.id);
}

function normalizeTime(value){
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function normalizeRecord(raw, mission){
  const source = raw && typeof raw === 'object' ? raw : {};
  const objectiveIds = new Set(mission.objectives.map(objective => objective.id));
  const completedObjectiveIds = Array.isArray(source.completedObjectiveIds)
    ? source.completedObjectiveIds.filter((id, index, all) => objectiveIds.has(id) && all.indexOf(id) === index)
    : [];
  return {
    attempts: maxInt(source.attempts),
    completions: maxInt(source.completions),
    completed: source.completed === true || maxInt(source.completions) > 0,
    bestScore: maxInt(source.bestScore),
    bestStars: clampInt(source.bestStars, 0, 3),
    bestTimeMs: normalizeTime(source.bestTimeMs),
    bestCombo: maxInt(source.bestCombo),
    completedObjectiveIds,
  };
}

function totalStars(records){
  return Object.values(records).reduce((sum, record) => sum + record.bestStars, 0);
}

export function createCampaignState(catalog = WING_MISSIONS){
  assertValidMissionCatalog(catalog);
  return {
    version: CAMPAIGN_STATE_VERSION,
    catalogVersion: MISSION_CATALOG_VERSION,
    revision: 0,
    unlockedMissionIds: [...getUnlockedMissionIds([], catalog)],
    completedMissionIds: [],
    totalStars: 0,
    missions: Object.fromEntries(catalog.map(mission => [mission.id, emptyRecord()])),
  };
}

export function restoreCampaignState(raw, catalog = WING_MISSIONS){
  assertValidMissionCatalog(catalog);
  let source = raw;
  if(typeof source === 'string'){
    try { source = JSON.parse(source); }
    catch { throw new TypeError('campaign payload is not valid JSON'); }
  }
  if(!source || typeof source !== 'object' || Array.isArray(source)) return createCampaignState(catalog);
  const version = Number.isInteger(source.version) ? source.version : 0;
  if(version > CAMPAIGN_STATE_VERSION) throw new RangeError(`unsupported campaign version ${version}`);

  const missions = {};
  for(const mission of catalog) missions[mission.id] = normalizeRecord(source.missions?.[mission.id], mission);
  const explicitCompleted = new Set(orderedValidIds(source.completedMissionIds, catalog));
  for(const mission of catalog){
    if(explicitCompleted.has(mission.id)) missions[mission.id].completed = true;
    if(missions[mission.id].completed && missions[mission.id].completions === 0) missions[mission.id].completions = 1;
  }
  const completedMissionIds = catalog.filter(mission => missions[mission.id].completed).map(mission => mission.id);
  const derivedUnlocks = getUnlockedMissionIds(completedMissionIds, catalog);
  const preservedUnlocks = orderedValidIds(source.unlockedMissionIds, catalog);
  const unlocked = new Set([...derivedUnlocks, ...preservedUnlocks]);
  return {
    version: CAMPAIGN_STATE_VERSION,
    catalogVersion: MISSION_CATALOG_VERSION,
    revision: maxInt(source.revision),
    unlockedMissionIds: catalog.filter(mission => unlocked.has(mission.id)).map(mission => mission.id),
    completedMissionIds,
    totalStars: totalStars(missions),
    missions,
  };
}

export function applyMissionResult(state, result, catalog = WING_MISSIONS){
  if(!result || typeof result !== 'object') throw new TypeError('mission result is required');
  const current = restoreCampaignState(state, catalog);
  const mission = missionById(result.missionId, catalog);
  if(!mission) throw new RangeError(`unknown mission ${result.missionId}`);
  if(!current.unlockedMissionIds.includes(mission.id)) throw new RangeError(`mission ${mission.id} is locked`);

  const prior = current.missions[mission.id];
  const completed = result.completed === true;
  const objectiveIds = new Set(mission.objectives.map(objective => objective.id));
  const newObjectives = Array.isArray(result.completedObjectiveIds) ? result.completedObjectiveIds.filter(id => objectiveIds.has(id)) : [];
  const bestTime = normalizeTime(result.timeMs);
  const record = {
    attempts: prior.attempts + 1,
    completions: prior.completions + (completed ? 1 : 0),
    completed: prior.completed || completed,
    bestScore: Math.max(prior.bestScore, maxInt(result.score)),
    bestStars: Math.max(prior.bestStars, clampInt(result.stars, 0, 3)),
    bestTimeMs: bestTime === null ? prior.bestTimeMs : prior.bestTimeMs === null ? bestTime : Math.min(prior.bestTimeMs, bestTime),
    bestCombo: Math.max(prior.bestCombo, maxInt(result.combo)),
    completedObjectiveIds: mission.objectives.map(objective => objective.id).filter(id => prior.completedObjectiveIds.includes(id) || newObjectives.includes(id)),
  };
  const missions = { ...current.missions, [mission.id]: record };
  const completedMissionIds = catalog.filter(entry => missions[entry.id].completed).map(entry => entry.id);
  const unlocked = new Set([...current.unlockedMissionIds, ...getUnlockedMissionIds(completedMissionIds, catalog)]);
  return {
    ...current,
    revision: current.revision + 1,
    unlockedMissionIds: catalog.filter(entry => unlocked.has(entry.id)).map(entry => entry.id),
    completedMissionIds,
    totalStars: totalStars(missions),
    missions,
  };
}

export function mergeCampaignStates(left, right, catalog = WING_MISSIONS){
  const a = restoreCampaignState(left, catalog);
  const b = restoreCampaignState(right, catalog);
  const missions = {};
  for(const mission of catalog){
    const x = a.missions[mission.id];
    const y = b.missions[mission.id];
    missions[mission.id] = {
      attempts: Math.max(x.attempts, y.attempts),
      completions: Math.max(x.completions, y.completions),
      completed: x.completed || y.completed,
      bestScore: Math.max(x.bestScore, y.bestScore),
      bestStars: Math.max(x.bestStars, y.bestStars),
      bestTimeMs: x.bestTimeMs === null ? y.bestTimeMs : y.bestTimeMs === null ? x.bestTimeMs : Math.min(x.bestTimeMs, y.bestTimeMs),
      bestCombo: Math.max(x.bestCombo, y.bestCombo),
      completedObjectiveIds: mission.objectives.map(objective => objective.id).filter(id => x.completedObjectiveIds.includes(id) || y.completedObjectiveIds.includes(id)),
    };
  }
  const completedMissionIds = catalog.filter(mission => missions[mission.id].completed).map(mission => mission.id);
  const unlocked = new Set([...a.unlockedMissionIds, ...b.unlockedMissionIds, ...getUnlockedMissionIds(completedMissionIds, catalog)]);
  return {
    version: CAMPAIGN_STATE_VERSION,
    catalogVersion: MISSION_CATALOG_VERSION,
    revision: Math.max(a.revision, b.revision),
    unlockedMissionIds: catalog.filter(mission => unlocked.has(mission.id)).map(mission => mission.id),
    completedMissionIds,
    totalStars: totalStars(missions),
    missions,
  };
}

export function campaignMissionRecord(state, missionId, catalog = WING_MISSIONS){
  const restored = restoreCampaignState(state, catalog);
  return restored.missions[missionId] ? Object.freeze({ ...restored.missions[missionId], completedObjectiveIds: Object.freeze([...restored.missions[missionId].completedObjectiveIds]) }) : null;
}

export function serializeCampaignState(state, catalog = WING_MISSIONS){
  return JSON.stringify(restoreCampaignState(state, catalog));
}
