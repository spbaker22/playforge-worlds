/* PAPER WINGS - immutable presentation dressing for the eight-mission campaign. */

function deepFreeze(value){
  if(value && typeof value === 'object' && !Object.isFrozen(value)){
    for(const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const RAW_MISSIONS = [
  {
    id: 'flight-school', order: 1, name: 'FLIGHT SCHOOL', shortName: 'SCHOOL', kind: 'training',
    mapPosition: { x: 10, y: 72 },
    briefing: {
      kicker: 'FIRST LIFT', headline: 'Learn the mountain wind.',
      objective: 'Clear the ribbon course and wake three training kites.',
      controlTip: 'Left thumb steers. Hold the right action to turn wind into boost.',
    },
    palette: { skyTop: 0x82aab8, skyHorizon: 0xc1d6d5, fog: 0xaec8c9, terrain: 0x4f6e68, snow: 0xf2f0e7, water: 0x659da6, signal: 0xff795c, ink: 0x15292e },
    atmosphere: { exposure: 1.04, fogDensity: 0.00175, cloudCover: 0.18, wind: 0.32, sunAzimuth: -0.72, sunElevation: 0.86 },
    route: { gateStyle: 'cloth-ribbon', trailStyle: 'chalk', forkStyle: 'none', shortcutColor: 0xff795c },
    landmarks: [
      { id: 'clubhouse', kind: 'timber-clubhouse', s: 48, side: -1, scale: 1 },
      { id: 'wind-tower', kind: 'weather-vane', s: 210, side: 1, scale: 1.2 },
      { id: 'practice-bell', kind: 'ridge-bell', s: 430, side: -1, scale: 0.9 },
    ],
    props: [
      { kind: 'windsock', count: 12, band: 'course-edge' },
      { kind: 'training-kite', count: 3, band: 'objective' },
      { kind: 'paper-flag', count: 24, band: 'gate' },
    ],
    hazards: [{ kind: 'soft-gust', count: 4, severity: 0.2 }],
    targeting: { reticle: 'rounded-corners', projectile: 'paper-pulse', impact: 'confetti-fold' },
    challenges: ['Clear every ribbon', 'Wake all training kites', 'Finish with half wind'],
  },
  {
    id: 'ridge-race', order: 2, name: 'RIDGE RACE', shortName: 'RIDGE', kind: 'race',
    mapPosition: { x: 25, y: 57 },
    briefing: {
      kicker: 'LEAGUE HEAT', headline: 'Choose the faster sky.',
      objective: 'Outfly three rivals through two high-risk route forks.',
      controlTip: 'Dive to build speed. Save wind for the final climb.',
    },
    palette: { skyTop: 0x7197ab, skyHorizon: 0xbacfd1, fog: 0x9bb6bc, terrain: 0x415b5b, snow: 0xeff2ec, water: 0x4e8998, signal: 0xff795c, ink: 0x14272d },
    atmosphere: { exposure: 1, fogDensity: 0.0019, cloudCover: 0.3, wind: 0.48, sunAzimuth: -0.48, sunElevation: 0.67 },
    route: { gateStyle: 'league-hoop', trailStyle: 'wind-streamer', forkStyle: 'split-banner', shortcutColor: 0xff795c },
    landmarks: [
      { id: 'needle-spires', kind: 'snow-spires', s: 180, side: -1, scale: 1.5 },
      { id: 'league-bridge', kind: 'banner-bridge', s: 390, side: 1, scale: 1.1 },
      { id: 'summit-grandstand', kind: 'ridge-grandstand', s: 690, side: 0, scale: 1.3 },
    ],
    props: [
      { kind: 'league-banner', count: 30, band: 'fork' },
      { kind: 'wind-ribbon', count: 18, band: 'shortcut' },
      { kind: 'spectator-kite', count: 20, band: 'finish' },
    ],
    hazards: [{ kind: 'rock-pinch', count: 5, severity: 0.45 }, { kind: 'crosswind', count: 4, severity: 0.38 }],
    targeting: { reticle: 'league-diamond', projectile: 'paper-pulse', impact: 'ribbon-burst' },
    challenges: ['Finish first', 'Take both shortcuts', 'Hold a six-action chain'],
  },
  {
    id: 'target-run', order: 3, name: 'TARGET RUN', shortName: 'TARGETS', kind: 'targets',
    mapPosition: { x: 39, y: 69 },
    briefing: {
      kicker: 'GLACIER RANGE', headline: 'Open the hidden line.',
      objective: 'Tag moving kite drones and break the seals guarding a glacier shortcut.',
      controlTip: 'Tap the right action to fire. A steady line tightens the target lock.',
    },
    palette: { skyTop: 0x688ea3, skyHorizon: 0xb8d0d3, fog: 0x91b2bd, terrain: 0x4b6470, snow: 0xe9f2f0, water: 0x4c93a7, signal: 0xff795c, ink: 0x13272f },
    atmosphere: { exposure: 1.02, fogDensity: 0.00205, cloudCover: 0.34, wind: 0.42, sunAzimuth: -0.3, sunElevation: 0.58 },
    route: { gateStyle: 'glacier-cut', trailStyle: 'blue-draft', forkStyle: 'sealed-shortcut', shortcutColor: 0xff795c },
    landmarks: [
      { id: 'ice-arch', kind: 'glacier-arch', s: 150, side: 0, scale: 1.5 },
      { id: 'range-station', kind: 'kite-station', s: 330, side: -1, scale: 1.1 },
      { id: 'blue-door', kind: 'breakable-ice-door', s: 570, side: 1, scale: 1.2 },
    ],
    props: [
      { kind: 'kite-drone', count: 14, band: 'target-wave' },
      { kind: 'shortcut-seal', count: 4, band: 'fork' },
      { kind: 'range-marker', count: 20, band: 'course-edge' },
    ],
    hazards: [{ kind: 'ice-shear', count: 5, severity: 0.5 }, { kind: 'drone-sweep', count: 3, severity: 0.42 }],
    targeting: { reticle: 'paper-corners', projectile: 'folded-dart', impact: 'ice-paper-shard' },
    challenges: ['Tag every drone', 'Open the glacier door', 'Miss no more than two shots'],
  },
  {
    id: 'stunt-trial', order: 4, name: 'STUNT TRIAL', shortName: 'STUNTS', kind: 'stunts',
    mapPosition: { x: 51, y: 48 },
    briefing: {
      kicker: 'GOLDEN VALLEY', headline: 'Turn height into style.',
      objective: 'Chain rolls, loops, and dive-flips through the thermal arches.',
      controlTip: 'Flick the right action to perform a stunt. Link tricks before the chain fades.',
    },
    palette: { skyTop: 0x7898a7, skyHorizon: 0xd4c5a6, fog: 0xb5ad98, terrain: 0x65705b, snow: 0xeee8d8, water: 0x688f8f, signal: 0xff795c, ink: 0x1b2d2e },
    atmosphere: { exposure: 1.08, fogDensity: 0.00165, cloudCover: 0.16, wind: 0.54, sunAzimuth: 0.05, sunElevation: 0.44 },
    route: { gateStyle: 'stunt-arch', trailStyle: 'gold-thermal', forkStyle: 'score-lane', shortcutColor: 0xff795c },
    landmarks: [
      { id: 'terrace-farms', kind: 'alpine-terraces', s: 100, side: -1, scale: 1.4 },
      { id: 'thermal-organ', kind: 'wind-organ', s: 360, side: 1, scale: 1.2 },
      { id: 'festival-ridge', kind: 'kite-festival', s: 620, side: 0, scale: 1.4 },
    ],
    props: [
      { kind: 'thermal-column', count: 10, band: 'stunt-zone' },
      { kind: 'stunt-arch', count: 12, band: 'course' },
      { kind: 'proximity-ribbon', count: 18, band: 'terrain-edge' },
    ],
    hazards: [{ kind: 'thermal-kick', count: 6, severity: 0.35 }, { kind: 'banner-thread', count: 5, severity: 0.4 }],
    targeting: { reticle: 'score-brackets', projectile: 'paper-pulse', impact: 'ticket-burst' },
    challenges: ['Land four stunt types', 'Reach a ten-action chain', 'Clear three proximity ribbons'],
  },
  {
    id: 'mountain-rescue', order: 5, name: 'MOUNTAIN RESCUE', shortName: 'RESCUE', kind: 'rescue',
    mapPosition: { x: 64, y: 60 },
    briefing: {
      kicker: 'DUSK CALL', headline: 'Bring the ridge home.',
      objective: 'Find three signal balloons and deliver supplies to stranded climbers.',
      controlTip: 'Tap the right action inside a rescue ring to release a supply parcel.',
    },
    palette: { skyTop: 0x4f7085, skyHorizon: 0xb18f82, fog: 0x806f70, terrain: 0x3d5152, snow: 0xdeddd5, water: 0x456d78, signal: 0xff795c, ink: 0x14242a },
    atmosphere: { exposure: 0.96, fogDensity: 0.00225, cloudCover: 0.46, wind: 0.58, sunAzimuth: 0.42, sunElevation: 0.25 },
    route: { gateStyle: 'rescue-beacon', trailStyle: 'signal-smoke', forkStyle: 'search-sector', shortcutColor: 0xff795c },
    landmarks: [
      { id: 'dusk-village', kind: 'lit-mountain-village', s: 80, side: -1, scale: 1.3 },
      { id: 'cable-station', kind: 'cable-station', s: 350, side: 1, scale: 1.1 },
      { id: 'rescue-shelf', kind: 'climber-camp', s: 610, side: -1, scale: 1 },
    ],
    props: [
      { kind: 'signal-balloon', count: 3, band: 'search' },
      { kind: 'supply-drop', count: 6, band: 'objective' },
      { kind: 'cabin-light', count: 18, band: 'valley' },
    ],
    hazards: [{ kind: 'downdraft', count: 5, severity: 0.56 }, { kind: 'low-cloud', count: 4, severity: 0.45 }],
    targeting: { reticle: 'rescue-ring', projectile: 'supply-parcel', impact: 'signal-bloom' },
    challenges: ['Rescue every climber', 'Make three perfect drops', 'Take no shield damage'],
  },
  {
    id: 'storm-escape', order: 6, name: 'STORM ESCAPE', shortName: 'STORM', kind: 'survival',
    mapPosition: { x: 75, y: 38 },
    briefing: {
      kicker: 'BLACK CLOUD', headline: 'Read the storm first.',
      objective: 'Cross the thunder shelf before lightning closes the mountain passes.',
      controlTip: 'Hold the right action during a warning to raise your paper shield.',
    },
    palette: { skyTop: 0x344b5b, skyHorizon: 0x71858c, fog: 0x536870, terrain: 0x334747, snow: 0xbfc9c5, water: 0x365a66, signal: 0xff795c, ink: 0x101e24 },
    atmosphere: { exposure: 0.86, fogDensity: 0.0028, cloudCover: 0.86, wind: 0.82, sunAzimuth: 0.3, sunElevation: 0.12 },
    route: { gateStyle: 'storm-lantern', trailStyle: 'lightning-draft', forkStyle: 'closing-pass', shortcutColor: 0xff795c },
    landmarks: [
      { id: 'thunder-shelf', kind: 'storm-wall', s: 130, side: 0, scale: 1.6 },
      { id: 'broken-lift', kind: 'broken-chairlift', s: 380, side: -1, scale: 1.2 },
      { id: 'safe-pass', kind: 'lantern-pass', s: 680, side: 1, scale: 1.3 },
    ],
    props: [
      { kind: 'storm-lantern', count: 16, band: 'safe-line' },
      { kind: 'wind-debris', count: 28, band: 'hazard' },
      { kind: 'lightning-rod', count: 9, band: 'telegraph' },
    ],
    hazards: [
      { kind: 'lightning', count: 8, severity: 0.82 },
      { kind: 'debris-wave', count: 6, severity: 0.66 },
      { kind: 'hard-downdraft', count: 5, severity: 0.72 },
    ],
    targeting: { reticle: 'warning-brackets', projectile: 'shield-ripple', impact: 'paper-tear' },
    challenges: ['Reach the safe pass', 'Block four lightning strikes', 'Keep one shield pip'],
  },
  {
    id: 'ace-pursuit', order: 7, name: 'ACE PURSUIT', shortName: 'PURSUIT', kind: 'pursuit',
    mapPosition: { x: 87, y: 52 },
    briefing: {
      kicker: 'SUNSET CHASE', headline: 'Catch the rogue kite.',
      objective: 'Chase the Ace through canyon reversals and expose three moving weak points.',
      controlTip: 'Use stunts to refill wind, then boost into range for a clean target lock.',
    },
    palette: { skyTop: 0x526d82, skyHorizon: 0xca927c, fog: 0x96766f, terrain: 0x574e4b, snow: 0xd9d4c9, water: 0x4b6e77, signal: 0xff795c, ink: 0x18252a },
    atmosphere: { exposure: 1, fogDensity: 0.00195, cloudCover: 0.38, wind: 0.68, sunAzimuth: 0.76, sunElevation: 0.18 },
    route: { gateStyle: 'pursuit-chevron', trailStyle: 'ace-ribbon', forkStyle: 'canyon-reversal', shortcutColor: 0xff795c },
    landmarks: [
      { id: 'canyon-mouth', kind: 'red-stone-gate', s: 120, side: 0, scale: 1.5 },
      { id: 'mirror-turn', kind: 'mirror-cliff', s: 390, side: 1, scale: 1.4 },
      { id: 'ace-nest', kind: 'kite-hangar', s: 690, side: -1, scale: 1.2 },
    ],
    props: [
      { kind: 'ace-ribbon', count: 20, band: 'pursuit-line' },
      { kind: 'weak-point', count: 3, band: 'boss' },
      { kind: 'canyon-marker', count: 18, band: 'reversal' },
    ],
    hazards: [
      { kind: 'ace-pulse', count: 7, severity: 0.64 },
      { kind: 'canyon-pinch', count: 6, severity: 0.62 },
      { kind: 'wake-turbulence', count: 5, severity: 0.56 },
    ],
    targeting: { reticle: 'pursuit-lock', projectile: 'folded-dart', impact: 'rival-ribbon-cut' },
    challenges: ['Catch the Ace', 'Break all weak points', 'Finish a twelve-action chain'],
  },
  {
    id: 'skybreaker-finale', order: 8, name: 'SKYBREAKER FINALE', shortName: 'FINALE', kind: 'boss',
    mapPosition: { x: 94, y: 23 },
    briefing: {
      kicker: 'LEAGUE FINAL', headline: 'Break the weather machine.',
      objective: 'Race the storm, open the tower, and escape before the eye collapses.',
      controlTip: 'Every flight skill matters. Save wind and shield for the final climb.',
    },
    palette: { skyTop: 0x283d4e, skyHorizon: 0x7b777d, fog: 0x4e6069, terrain: 0x2c4143, snow: 0xc9d0cc, water: 0x304f5b, signal: 0xff795c, ink: 0x0f1d23 },
    atmosphere: { exposure: 0.9, fogDensity: 0.00265, cloudCover: 0.92, wind: 0.9, sunAzimuth: 0.52, sunElevation: 0.08 },
    route: { gateStyle: 'tower-lock', trailStyle: 'storm-eye', forkStyle: 'phase-route', shortcutColor: 0xff795c },
    landmarks: [
      { id: 'outer-engine', kind: 'weather-engine', s: 150, side: 0, scale: 1.7 },
      { id: 'skybreaker-tower', kind: 'storm-tower', s: 430, side: 0, scale: 2 },
      { id: 'collapsing-eye', kind: 'storm-eye', s: 720, side: 0, scale: 2.2 },
    ],
    props: [
      { kind: 'tower-lock', count: 6, band: 'boss-phase' },
      { kind: 'storm-vane', count: 18, band: 'tower' },
      { kind: 'escape-ribbon', count: 14, band: 'finale' },
    ],
    hazards: [
      { kind: 'tower-barrage', count: 8, severity: 0.82 },
      { kind: 'storm-ring', count: 6, severity: 0.86 },
      { kind: 'collapse-wave', count: 4, severity: 0.94 },
    ],
    targeting: { reticle: 'tower-lock', projectile: 'charged-fold', impact: 'machine-shard' },
    challenges: ['Break Skybreaker', 'Clear every tower lock', 'Finish with a shield pip'],
  },
];

export const MISSION_DRESSING = deepFreeze(RAW_MISSIONS);
export const MISSION_IDS = Object.freeze(MISSION_DRESSING.map(mission => mission.id));

const MISSION_BY_ID = new Map(MISSION_DRESSING.map(mission => [mission.id, mission]));

export function getMissionDressing(id = MISSION_IDS[0]){
  const mission = MISSION_BY_ID.get(id);
  if(!mission) throw new RangeError(`Unknown Paper Wings mission: ${id}`);
  return mission;
}

export function missionDressingIndex(id){
  return MISSION_IDS.indexOf(id);
}
