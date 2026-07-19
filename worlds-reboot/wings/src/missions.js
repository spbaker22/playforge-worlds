/* PAPER WINGS - authored campaign catalog and deterministic unlock graph. */

export const MISSION_CATALOG_VERSION = 1;

const freezeMission = mission => Object.freeze({
  ...mission,
  prerequisites: Object.freeze([...mission.prerequisites]),
  mechanics: Object.freeze([...mission.mechanics]),
  objectives: Object.freeze(mission.objectives.map(objective => Object.freeze({ ...objective }))),
  medalScores: Object.freeze({ ...mission.medalScores }),
});

const authored = [
  {
    id: 'flight-school', order: 1, title: 'FLIGHT SCHOOL', type: 'training', durationSeconds: 105,
    premise: 'Learn gates, altitude trading, and thermals above the launch peak.', prerequisites: [],
    mechanics: ['gates', 'altitude', 'dive-climb', 'thermals'],
    objectives: [{ id: 'school-gates', kind: 'gates', target: 8, required: true }, { id: 'school-thermals', kind: 'thermals', target: 2, required: true }],
    medalScores: { bronze: 1200, silver: 2100, gold: 3200 },
  },
  {
    id: 'ridge-race', order: 2, title: 'RIDGE RACE', type: 'race', durationSeconds: 150,
    premise: 'Outfly the Sky League through forks, shortcuts, and overtaking lanes.', prerequisites: ['flight-school'],
    mechanics: ['rivals', 'route-forks', 'shortcuts', 'wind-energy', 'boost'],
    objectives: [{ id: 'ridge-finish', kind: 'finish', target: 1, required: true }, { id: 'ridge-podium', kind: 'maximum-rank', target: 3, required: false }],
    medalScores: { bronze: 2200, silver: 3700, gold: 5400 },
  },
  {
    id: 'target-run', order: 3, title: 'TARGET RUN', type: 'target', durationSeconds: 165,
    premise: 'Break moving drones to open the fast line without abandoning the course.', prerequisites: ['ridge-race'],
    mechanics: ['projectiles', 'moving-targets', 'precision', 'combat-shortcuts'],
    objectives: [{ id: 'target-finish', kind: 'finish', target: 1, required: true }, { id: 'target-drones', kind: 'targets', target: 12, required: true }],
    medalScores: { bronze: 2800, silver: 4600, gold: 6800 },
  },
  {
    id: 'stunt-trial', order: 4, title: 'STUNT TRIAL', type: 'stunt', durationSeconds: 150,
    premise: 'Chain rolls, loops, and proximity lines while protecting airspeed.', prerequisites: ['ridge-race'],
    mechanics: ['rolls', 'loops', 'proximity', 'stunt-combos'],
    objectives: [{ id: 'stunt-finish', kind: 'finish', target: 1, required: true }, { id: 'stunt-chain', kind: 'stunt-chain', target: 4, required: true }],
    medalScores: { bronze: 3000, silver: 5000, gold: 7500 },
  },
  {
    id: 'mountain-rescue', order: 5, title: 'MOUNTAIN RESCUE', type: 'rescue', durationSeconds: 210,
    premise: 'Find stranded climbers, collect supplies, and make precision drops.', prerequisites: ['target-run'],
    mechanics: ['search', 'supply-pickup', 'precision-drop', 'rescue'],
    objectives: [{ id: 'rescue-climbers', kind: 'rescues', target: 3, required: true }, { id: 'rescue-drops', kind: 'precision-drops', target: 3, required: true }],
    medalScores: { bronze: 3600, silver: 5900, gold: 8700 },
  },
  {
    id: 'storm-escape', order: 6, title: 'STORM ESCAPE', type: 'escape', durationSeconds: 195,
    premise: 'Cross a collapsing storm front through lightning, debris, and downdrafts.', prerequisites: ['stunt-trial'],
    mechanics: ['lightning', 'debris', 'downdrafts', 'shield', 'collapsing-route'],
    objectives: [{ id: 'storm-escape', kind: 'finish', target: 1, required: true }, { id: 'storm-cells', kind: 'storm-cells', target: 4, required: true }],
    medalScores: { bronze: 3800, silver: 6200, gold: 9200 },
  },
  {
    id: 'ace-pursuit', order: 7, title: 'ACE PURSUIT', type: 'pursuit', durationSeconds: 210,
    premise: 'Chase the league ace through an unscripted aerial duel.', prerequisites: ['target-run', 'storm-escape'],
    mechanics: ['pursuit', 'rival-attacks', 'projectiles', 'shield', 'route-forks'],
    objectives: [{ id: 'ace-defeat', kind: 'ace-defeat', target: 1, required: true }, { id: 'ace-finish', kind: 'finish', target: 1, required: true }],
    medalScores: { bronze: 4500, silver: 7300, gold: 10800 },
  },
  {
    id: 'skybreaker-finale', order: 8, title: 'SKYBREAKER FINALE', type: 'boss', durationSeconds: 270,
    premise: 'Race the storm engine, expose its weak points, and survive every phase.', prerequisites: ['mountain-rescue', 'ace-pursuit'],
    mechanics: ['race', 'targets', 'stunts', 'rescue', 'multi-phase-boss'],
    objectives: [{ id: 'skybreaker-phases', kind: 'boss-phases', target: 3, required: true }, { id: 'skybreaker-defeat', kind: 'boss-defeat', target: 1, required: true }],
    medalScores: { bronze: 6000, silver: 9800, gold: 14500 },
  },
];

export const WING_MISSIONS = Object.freeze(authored.map(freezeMission));
export const WING_MISSION_IDS = Object.freeze(WING_MISSIONS.map(mission => mission.id));

function completedSet(value){
  if(value instanceof Set || Array.isArray(value)) return new Set(value);
  if(value && Array.isArray(value.completedMissionIds)) return new Set(value.completedMissionIds);
  if(value?.missions && typeof value.missions === 'object') return new Set(Object.entries(value.missions).filter(([, record]) => record?.completed).map(([id]) => id));
  return new Set();
}

export function validateMissionCatalog(catalog = WING_MISSIONS){
  const errors = [];
  if(!Array.isArray(catalog) || catalog.length === 0) return Object.freeze({ valid: false, errors: Object.freeze(['catalog must be a non-empty array']), roots: Object.freeze([]), topologicalOrder: Object.freeze([]) });
  const byId = new Map();
  const orders = new Set();
  for(const [index, mission] of catalog.entries()){
    const label = mission?.id || `catalog[${index}]`;
    if(!mission || typeof mission !== 'object'){ errors.push(`${label} must be an object`); continue; }
    if(typeof mission.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mission.id)) errors.push(`${label} has an invalid id`);
    else if(byId.has(mission.id)) errors.push(`${mission.id} is duplicated`);
    else byId.set(mission.id, mission);
    if(!Number.isInteger(mission.order) || mission.order < 1) errors.push(`${label} has an invalid order`);
    else if(orders.has(mission.order)) errors.push(`order ${mission.order} is duplicated`);
    else orders.add(mission.order);
    if(!Array.isArray(mission.prerequisites)) errors.push(`${label} prerequisites must be an array`);
    if(!Array.isArray(mission.mechanics) || mission.mechanics.length === 0) errors.push(`${label} needs mechanics`);
    if(!Array.isArray(mission.objectives) || mission.objectives.length === 0) errors.push(`${label} needs objectives`);
    const medals = mission.medalScores;
    if(!medals || !Number.isFinite(medals.bronze) || !(medals.bronze < medals.silver && medals.silver < medals.gold)) errors.push(`${label} has invalid medal scores`);
  }
  for(const mission of catalog){
    if(!Array.isArray(mission?.prerequisites)) continue;
    const seen = new Set();
    for(const prerequisite of mission.prerequisites){
      if(prerequisite === mission.id) errors.push(`${mission.id} cannot require itself`);
      if(seen.has(prerequisite)) errors.push(`${mission.id} duplicates prerequisite ${prerequisite}`);
      seen.add(prerequisite);
      if(!byId.has(prerequisite)) errors.push(`${mission.id} requires missing mission ${prerequisite}`);
    }
  }
  const roots = catalog.filter(mission => mission?.prerequisites?.length === 0).map(mission => mission.id);
  if(roots.length === 0) errors.push('catalog needs at least one root mission');
  const visiting = new Set();
  const visited = new Set();
  const topologicalOrder = [];
  function visit(id, path){
    if(visited.has(id)) return;
    if(visiting.has(id)){ errors.push(`mission graph contains a cycle: ${[...path, id].join(' -> ')}`); return; }
    const mission = byId.get(id);
    if(!mission) return;
    visiting.add(id);
    for(const prerequisite of mission.prerequisites || []) visit(prerequisite, [...path, id]);
    visiting.delete(id);
    visited.add(id);
    topologicalOrder.push(id);
  }
  for(const mission of [...catalog].sort((a, b) => (a?.order || 0) - (b?.order || 0))) visit(mission?.id, []);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), roots: Object.freeze(roots), topologicalOrder: Object.freeze(topologicalOrder) });
}

export function assertValidMissionCatalog(catalog = WING_MISSIONS){
  const verdict = validateMissionCatalog(catalog);
  if(!verdict.valid) throw new TypeError(`invalid mission catalog: ${verdict.errors.join('; ')}`);
  return catalog;
}

export function missionById(id, catalog = WING_MISSIONS){
  return typeof id === 'string' ? catalog.find(mission => mission.id === id) || null : null;
}

export function isMissionUnlocked(id, completedMissionIds = [], catalog = WING_MISSIONS){
  const mission = missionById(id, catalog);
  if(!mission) return false;
  const completed = completedSet(completedMissionIds);
  return mission.prerequisites.every(prerequisite => completed.has(prerequisite));
}

export function getUnlockedMissionIds(completedMissionIds = [], catalog = WING_MISSIONS){
  assertValidMissionCatalog(catalog);
  const completed = completedSet(completedMissionIds);
  return Object.freeze(catalog.filter(mission => mission.prerequisites.every(id => completed.has(id))).map(mission => mission.id));
}

export function getNewlyUnlockedMissionIds(beforeCompleted = [], afterCompleted = [], catalog = WING_MISSIONS){
  const before = new Set(getUnlockedMissionIds(beforeCompleted, catalog));
  return Object.freeze(getUnlockedMissionIds(afterCompleted, catalog).filter(id => !before.has(id)));
}

assertValidMissionCatalog(WING_MISSIONS);
