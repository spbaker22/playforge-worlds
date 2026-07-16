/* Gridlock Run Phase 3 — one authored 0–150m course coordinate model.
   Every world-space consumer must come through RunnerCourseModel; the raw
   spline's at() method is intentionally private to this module. */
import * as THREE from 'three';

export const RUNNER_TUTORIAL_LENGTH = 150;
export const RUNNER_LANES = Object.freeze([-1, 0, 1]);

function deepFreeze(value){
  if(!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for(const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clonePlain(value){
  if(Array.isArray(value)) return value.map(clonePlain);
  if(value && typeof value === 'object'){
    const copy = {};
    for(const [key, child] of Object.entries(value)) copy[key] = clonePlain(child);
    return copy;
  }
  return value;
}

function cloneVector(value, label = 'vector'){
  const x = Number(value?.x), y = Number(value?.y), z = Number(value?.z);
  if(!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)){
    throw new TypeError(`${label} must expose finite x, y, and z values`);
  }
  return { x, y, z };
}

function copyVectorInto(out, value, label = 'vector'){
  if(!out || typeof out !== 'object') throw new TypeError(`${label} output must be an object`);
  const x = Number(value?.x), y = Number(value?.y), z = Number(value?.z);
  if(!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)){
    throw new TypeError(`${label} must expose finite x, y, and z values`);
  }
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

function normalizeInto(out, label){
  const magnitude = Math.hypot(out.x, out.y, out.z);
  if(magnitude <= 1e-9) throw new RangeError(`${label} cannot be a zero vector`);
  out.x /= magnitude;
  out.y /= magnitude;
  out.z /= magnitude;
  return out;
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Allocate one reusable pose buffer. Hot rendering paths should create this
 * once and pass it to poseAtInto() every frame. */
export function createRunnerPoseOutput(){
  return {
    s: 0,
    requestedS: 0,
    rawS: 0,
    lane: 0,
    lateral: 0,
    position: { x: 0, y: 0, z: 0 },
    center: { x: 0, y: 0, z: 0 },
    tangent: { x: 0, y: 0, z: 1 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    yaw: 0,
  };
}

function requirePoseOutput(out){
  if(!out || typeof out !== 'object' || !out.position || !out.center || !out.tangent || !out.right || !out.up){
    throw new TypeError('poseAtInto requires a createRunnerPoseOutput-compatible object');
  }
  return out;
}

/* Kept private so main, city, rivals, cameras, and diagnostics cannot acquire
   a second interpretation of course distance. Tests may still inject a tiny
   raw path through the constructor/factory. */
function buildAuthoredRawPath(){
  const controls = [
    [0, -60], [0, 0], [5, 48], [-3, 92], [6, 142], [-5, 194],
    [4, 250], [-2, 310], [0, 380],
  ];
  const curve = new THREE.CatmullRomCurve3(
    controls.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'catmullrom',
    0.5,
  );
  const points = curve.getSpacedPoints(420);
  for(let index = 0; index < points.length; index += 1){
    const u = index / (points.length - 1);
    points[index].y = 14 + 1.6 * Math.sin(u * 7.6 + 1.2) + 0.55 * Math.sin(u * 18 + 2.4);
  }
  const tangents = [], rights = [], cumulative = [0];
  for(let index = 0; index < points.length; index += 1){
    const ahead = points[Math.min(index + 1, points.length - 1)];
    const behind = points[Math.max(index - 1, 0)];
    const tangent = new THREE.Vector3().subVectors(ahead, behind).normalize();
    tangents.push(tangent);
    rights.push(new THREE.Vector3(tangent.z, 0, -tangent.x).normalize());
    if(index > 0) cumulative.push(cumulative[index - 1] + points[index].distanceTo(points[index - 1]));
  }
  const total = cumulative.at(-1);
  function atInto(rawDistance, out){
    requirePoseOutput(out);
    const target = clamp(rawDistance, 0, total - 0.000001);
    let low = 0, high = cumulative.length - 1;
    while(high - low > 1){
      const middle = (low + high) >> 1;
      if(cumulative[middle] <= target) low = middle;
      else high = middle;
    }
    const span = Math.max(cumulative[high] - cumulative[low], 1e-9);
    const mix = (target - cumulative[low]) / span;
    const a = points[low], b = points[high];
    out.center.x = a.x + (b.x - a.x) * mix;
    out.center.y = a.y + (b.y - a.y) * mix;
    out.center.z = a.z + (b.z - a.z) * mix;
    const ta = tangents[low], tb = tangents[high];
    out.tangent.x = ta.x + (tb.x - ta.x) * mix;
    out.tangent.y = ta.y + (tb.y - ta.y) * mix;
    out.tangent.z = ta.z + (tb.z - ta.z) * mix;
    normalizeInto(out.tangent, 'path tangent');
    const ra = rights[low], rb = rights[high];
    out.right.x = ra.x + (rb.x - ra.x) * mix;
    out.right.y = ra.y + (rb.y - ra.y) * mix;
    out.right.z = ra.z + (rb.z - ra.z) * mix;
    normalizeInto(out.right, 'path right');
    return out;
  }
  return {
    total,
    atInto,
    at(rawDistance){
      const pose = atInto(rawDistance, createRunnerPoseOutput());
      return { pos: pose.center, tan: pose.tangent, right: pose.right };
    },
  };
}

export const RUNNER_COURSE_SECTIONS = deepFreeze([
  { id: 'safe-launch', label: 'SAFE LAUNCH', s0: 0, s1: 25, lesson: 'move' },
  /* Sections are contiguous presentation authority. Safe checkpoint approach
     distance belongs to the preceding lesson rather than an unowned gap. */
  { id: 'jump-lesson', label: 'JUMP', s0: 25, s1: 60, lesson: 'jump' },
  { id: 'lane-lesson', label: 'CHOOSE A LANE', s0: 60, s1: 90, lesson: 'lane' },
  { id: 'slide-lesson', label: 'SLIDE', s0: 90, s1: 112, lesson: 'slide' },
  { id: 'combined-test', label: 'LINK THE MOVES', s0: 112, s1: 150, lesson: 'combined' },
]);

export const RUNNER_TUTORIAL_HAZARDS = deepFreeze([
  {
    id: 'tutorial-gap-01', kind: 'gap', s0: 34, s1: 38.2,
    lanes: [-1, 0, 1], lethal: false, action: 'jump',
    cueStart: 25, actionAt: 29.5, landingEnd: 50, safePadId: 'jump-takeoff',
    forgiving: true, label: 'JUMP',
  },
  {
    id: 'lane-blocker-01', kind: 'blocker', s0: 70, s1: 75,
    lanes: [0], safeLanes: [-1, 1], lethal: false, action: 'lane',
    cueStart: 60, actionAt: 61.5, landingEnd: 85, safePadId: 'checkpoint-55-pad',
    forgiving: true, label: 'SWIPE TO A CLEAR LANE',
  },
  {
    id: 'slide-gate-01', kind: 'overhead', s0: 100, s1: 104,
    lanes: [-1, 0, 1], lethal: false, action: 'slide',
    cueStart: 90, actionAt: 92, landingEnd: 114, safePadId: 'checkpoint-55-pad',
    /* Canonical lower edge of the visible/collision gate body. */
    boundaryHeight: 1.58,
    forgiving: true, label: 'SLIDE',
  },
  {
    id: 'combined-lane-gate', kind: 'blocker', s0: 127, s1: 131,
    lanes: [-1, 1], safeLanes: [0], lethal: true, action: 'lane',
    /* 15m leaves 0.854s at the 14.5m/s runtime maximum after the 0.18s
       presentation fade. Keep this aligned with the final section boundary. */
    cueStart: 112, actionAt: 121.5, landingEnd: 135, safePadId: 'checkpoint-120-pad',
    forgiving: false, label: 'CENTER LANE',
  },
  {
    id: 'final-gap-01', kind: 'gap', s0: 138, s1: 144,
    lanes: [-1, 0, 1], lethal: true, action: 'jump',
    cueStart: 130, actionAt: 134, landingEnd: 149, safePadId: 'checkpoint-120-pad',
    forgiving: false, label: 'JUMP',
  },
]);

export const RUNNER_CHECKPOINTS = deepFreeze([
  { id: 'checkpoint-start', s: 0, resumeS: 8, safePadId: 'start-pad', visible: false },
  { id: 'checkpoint-55', s: 55, resumeS: 57, safePadId: 'checkpoint-55-pad', visible: true },
  { id: 'checkpoint-120', s: 120, resumeS: 121.5, safePadId: 'checkpoint-120-pad', visible: true },
]);

export const RUNNER_SAFE_PADS = deepFreeze([
  { id: 'start-pad', s0: 0, s1: 20, resumeS: 8, lane: 0, checkpointId: 'checkpoint-start' },
  /* A missed practice jump rewinds far enough to see the cue again and arm
     one swipe. The old 29m resume point left only half a metre and looped. */
  { id: 'jump-takeoff', s0: 20, s1: 32, resumeS: 23, lane: 0, checkpointId: 'checkpoint-start' },
  { id: 'checkpoint-55-pad', s0: 52, s1: 59, resumeS: 57, lane: 0, checkpointId: 'checkpoint-55' },
  { id: 'checkpoint-120-pad', s0: 114, s1: 124, resumeS: 121.5, lane: 0, checkpointId: 'checkpoint-120' },
]);

/* The original three named rivals remain part of the authored world. Their
   motion is deterministic in sim.js; rendering obtains their poses here. */
export const RUNNER_RIVALS = deepFreeze([
  { id: 'volt', name: 'VOLT', color: 0x36E7FF, lane: -1, startOffset: 1.8, baseSpeed: 11.7, phase: 0.4 },
  { id: 'nyx', name: 'NYX', color: 0xFF49CE, lane: 1, startOffset: 0.2, baseSpeed: 12.15, phase: 2.2 },
  { id: 'jet', name: 'JET', color: 0xFFC24B, lane: 0, startOffset: -1.8, baseSpeed: 12.55, phase: 4.1 },
]);

function validateRange(item, length, label){
  if(typeof item.id !== 'string' || !item.id) throw new TypeError(`${label} requires a stable id`);
  if(!Number.isFinite(item.s0) || !Number.isFinite(item.s1) || item.s0 < 0 || item.s1 <= item.s0 || item.s1 > length){
    throw new RangeError(`${label} ${item.id} has an invalid course range`);
  }
}

function validateAuthoredData({ length, hazards, checkpoints, safePads, sections }){
  const ids = new Set();
  for(let index = 0; index < sections.length; index += 1){
    const section = sections[index];
    validateRange(section, length, 'section');
    if(index === 0 && section.s0 !== 0) throw new RangeError('course sections must begin at zero');
    if(index > 0 && section.s0 !== sections[index - 1].s1) throw new RangeError(`course sections must be contiguous at ${section.id}`);
    if(index === sections.length - 1 && section.s1 !== length) throw new RangeError('course sections must end at course length');
  }
  for(const hazard of hazards){
    validateRange(hazard, length, 'hazard');
    if(ids.has(hazard.id)) throw new Error(`duplicate hazard id: ${hazard.id}`);
    ids.add(hazard.id);
    if(!Array.isArray(hazard.lanes) || !hazard.lanes.length || hazard.lanes.some(lane => !RUNNER_LANES.includes(lane))){
      throw new RangeError(`hazard ${hazard.id} must use authored runner lanes`);
    }
    if(!Number.isFinite(hazard.cueStart) || hazard.cueStart > hazard.s0) throw new RangeError(`hazard ${hazard.id} has an invalid cueStart`);
    if(hazard.actionAt !== undefined
      && (!Number.isFinite(hazard.actionAt) || hazard.actionAt < hazard.cueStart || hazard.actionAt >= hazard.s0)){
      throw new RangeError(`hazard ${hazard.id} has an invalid actionAt`);
    }
    if(hazard.boundaryHeight !== undefined
      && (!Number.isFinite(hazard.boundaryHeight) || hazard.boundaryHeight < 0)){
      throw new RangeError(`hazard ${hazard.id} has an invalid boundaryHeight`);
    }
    if(!Number.isFinite(hazard.landingEnd) || hazard.landingEnd < hazard.s1) throw new RangeError(`hazard ${hazard.id} has an invalid landingEnd`);
  }
  for(const checkpoint of checkpoints){
    if(typeof checkpoint.id !== 'string' || !checkpoint.id || !Number.isFinite(checkpoint.s) || checkpoint.s < 0 || checkpoint.s > length){
      throw new RangeError('checkpoint has invalid authored data');
    }
  }
  for(const pad of safePads){
    validateRange(pad, length, 'safe pad');
    if(!Number.isFinite(pad.resumeS) || pad.resumeS < pad.s0 || pad.resumeS > pad.s1) throw new RangeError(`safe pad ${pad.id} has invalid resumeS`);
    if(!RUNNER_LANES.includes(pad.lane)) throw new RangeError(`safe pad ${pad.id} has an invalid lane`);
  }
}

function laneOverlaps(hazard, lane){
  if(lane === null || lane === undefined) return true;
  const lateral = Number(lane);
  if(!Number.isFinite(lateral)) throw new TypeError('lane must be a finite number');
  return hazard.lanes.some(authoredLane => Math.abs(authoredLane - lateral) <= 0.46);
}

function resolveObserved(group, key, fallback, required){
  if(!required) return { found: true, value: { ...fallback } };
  const found = group instanceof Map
    ? group.has(key)
    : Boolean(group && Object.prototype.hasOwnProperty.call(group, key));
  if(!found) return { found: false, value: null };
  const value = group instanceof Map ? group.get(key) : group[key];
  return { found: true, value: cloneVector(value, `observed anchor ${key}`) };
}

function distance(a, b){
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class RunnerCourseModel {
  #rawPath;
  #pathOffset;

  constructor(rawPath = buildAuthoredRawPath(), {
    length = RUNNER_TUTORIAL_LENGTH,
    laneSpacing = 2.35,
    pathOffset = 22,
    sections = RUNNER_COURSE_SECTIONS,
    hazards = RUNNER_TUTORIAL_HAZARDS,
    checkpoints = RUNNER_CHECKPOINTS,
    safePads = RUNNER_SAFE_PADS,
    rivals = RUNNER_RIVALS,
  } = {}){
    if(!rawPath || (typeof rawPath.atInto !== 'function' && typeof rawPath.at !== 'function')){
      throw new TypeError('RunnerCourseModel requires a raw path with atInto(s,out) or at(s)');
    }
    if(!Number.isFinite(length) || length <= 0) throw new RangeError('course length must be greater than zero');
    if(!Number.isFinite(laneSpacing) || laneSpacing <= 0) throw new RangeError('laneSpacing must be greater than zero');
    if(!Number.isFinite(pathOffset)) throw new TypeError('pathOffset must be finite');

    const authored = {
      length,
      sections: deepFreeze(clonePlain(sections)),
      hazards: deepFreeze(clonePlain(hazards)),
      checkpoints: deepFreeze(clonePlain(checkpoints).sort((a, b) => a.s - b.s)),
      safePads: deepFreeze(clonePlain(safePads).sort((a, b) => a.resumeS - b.resumeS)),
      rivals: deepFreeze(clonePlain(rivals)),
    };
    validateAuthoredData(authored);

    this.#rawPath = rawPath;
    this.#pathOffset = pathOffset;
    this.length = length;
    this.laneSpacing = laneSpacing;
    this.lanes = RUNNER_LANES;
    this.sections = authored.sections;
    this.hazards = authored.hazards;
    this.checkpoints = authored.checkpoints;
    this.safePads = authored.safePads;
    this.rivals = authored.rivals;
    Object.freeze(this);
  }

  #sampleRawPathInto(courseS, out){
    const rawS = this.#pathOffset + clamp(courseS, 0, this.length);
    if(typeof this.#rawPath.atInto === 'function'){
      this.#rawPath.atInto(rawS, out);
    } else {
      const sample = this.#rawPath.at(rawS);
      if(!sample?.pos || !sample?.tan || !sample?.right){
        throw new TypeError('raw path at(s) must return {pos, tan, right}');
      }
      copyVectorInto(out.center, sample.pos, 'path position');
      copyVectorInto(out.tangent, sample.tan, 'path tangent');
      normalizeInto(out.tangent, 'path tangent');
      copyVectorInto(out.right, sample.right, 'path right');
      normalizeInto(out.right, 'path right');
    }
    out.rawS = rawS;
    return out;
  }

  poseAtInto(s, lane = 0, out){
    requirePoseOutput(out);
    const requestedS = Number(s), lateralLane = Number(lane);
    if(!Number.isFinite(requestedS)) throw new TypeError('course distance must be finite');
    if(!Number.isFinite(lateralLane)) throw new TypeError('lane must be finite');
    const courseS = clamp(requestedS, 0, this.length);
    const clampedLane = clamp(lateralLane, RUNNER_LANES[0], RUNNER_LANES.at(-1));
    this.#sampleRawPathInto(courseS, out);
    const lateral = clampedLane * this.laneSpacing;
    out.s = courseS;
    out.requestedS = requestedS;
    out.lane = clampedLane;
    out.lateral = lateral;
    out.position.x = out.center.x + out.right.x * lateral;
    out.position.y = out.center.y + out.right.y * lateral;
    out.position.z = out.center.z + out.right.z * lateral;
    out.up.x = 0;
    out.up.y = 1;
    out.up.z = 0;
    out.yaw = Math.atan2(out.tangent.x, out.tangent.z);
    return out;
  }

  poseAt(s, lane = 0){
    return deepFreeze(this.poseAtInto(s, lane, createRunnerPoseOutput()));
  }

  hazardsAt(s, lane = null, margin = 0){
    const courseS = Number(s), padding = Number(margin);
    if(!Number.isFinite(courseS) || !Number.isFinite(padding) || padding < 0) throw new TypeError('hazardsAt requires finite distance and non-negative margin');
    return Object.freeze(this.hazards.filter(hazard =>
      courseS >= hazard.s0 - padding && courseS <= hazard.s1 + padding && laneOverlaps(hazard, lane)
    ));
  }

  hazardsInRange(s0, s1, lane = null){
    const low = Number(s0), high = Number(s1);
    if(!Number.isFinite(low) || !Number.isFinite(high) || high < low) throw new RangeError('hazardsInRange requires an ordered finite range');
    return Object.freeze(this.hazards.filter(hazard => hazard.s1 >= low && hazard.s0 <= high && laneOverlaps(hazard, lane)));
  }

  nextHazardAfter(s, lane = null){
    const courseS = Number(s);
    if(!Number.isFinite(courseS)) throw new TypeError('course distance must be finite');
    return this.hazards.find(hazard => hazard.s1 >= courseS && laneOverlaps(hazard, lane)) || null;
  }

  hazardById(id){
    return this.hazards.find(hazard => hazard.id === id) || null;
  }

  /** The authored cue currently visible at course distance s. Overlapping cue
      bands preserve authored hazard order so the in-progress action wins. */
  cueAt(s){
    const courseS = Number(s);
    if(!Number.isFinite(courseS)) throw new TypeError('course distance must be finite');
    for(const hazard of this.hazards){
      if(courseS >= hazard.cueStart && courseS <= hazard.s1) return hazard;
    }
    return null;
  }

  nextCueAfter(s){
    const courseS = Number(s);
    if(!Number.isFinite(courseS)) throw new TypeError('course distance must be finite');
    for(const hazard of this.hazards){
      if(hazard.s1 >= courseS) return hazard;
    }
    return null;
  }

  decisionWindowFor(hazardOrId, speed){
    const hazard = typeof hazardOrId === 'string' ? this.hazardById(hazardOrId) : hazardOrId;
    if(!hazard || !this.hazards.includes(hazard)) throw new RangeError(`unknown authored hazard: ${hazardOrId}`);
    const metresPerSecond = Number(speed);
    if(!Number.isFinite(metresPerSecond) || metresPerSecond <= 0) throw new RangeError('decision speed must be greater than zero');
    return Math.max(0, hazard.s0 - hazard.cueStart) / metresPerSecond;
  }

  /** Usable decision time after presentation latency such as a cue fade. */
  decisionSecondsFor(hazardOrId, speed, presentationDelay = 0){
    const delay = Number(presentationDelay);
    if(!Number.isFinite(delay) || delay < 0) throw new RangeError('presentation delay must be non-negative');
    return Math.max(0, this.decisionWindowFor(hazardOrId, speed) - delay);
  }

  isGapAt(s, lane = 0, margin = 0){
    const courseS = Number(s), padding = Number(margin);
    if(!Number.isFinite(courseS) || !Number.isFinite(padding) || padding < 0) throw new TypeError('isGapAt requires finite distance and non-negative margin');
    for(const hazard of this.hazards){
      if(hazard.kind === 'gap'
        && courseS >= hazard.s0 - padding
        && courseS <= hazard.s1 + padding
        && laneOverlaps(hazard, lane)) return hazard;
    }
    return null;
  }

  checkpointAt(s){
    const courseS = Number(s);
    if(!Number.isFinite(courseS)) throw new TypeError('course distance must be finite');
    let match = this.checkpoints[0] || null;
    for(const checkpoint of this.checkpoints){
      if(checkpoint.s > courseS) break;
      match = checkpoint;
    }
    return match;
  }

  checkpointById(id){
    return this.checkpoints.find(checkpoint => checkpoint.id === id) || null;
  }

  safePadBefore(s){
    const courseS = Number(s);
    if(!Number.isFinite(courseS)) throw new TypeError('course distance must be finite');
    let match = this.safePads[0] || null;
    for(const pad of this.safePads){
      if(pad.resumeS > courseS) break;
      match = pad;
    }
    return match;
  }

  safePadById(id){
    return this.safePads.find(pad => pad.id === id) || null;
  }

  sectionAt(s){
    const courseS = Number(s);
    if(!Number.isFinite(courseS)) throw new TypeError('course distance must be finite');
    for(let index = 0; index < this.sections.length; index += 1){
      const section = this.sections[index];
      if(courseS >= section.s0 && (courseS < section.s1 || (index === this.sections.length - 1 && courseS <= section.s1))) return section;
    }
    return null;
  }

  nextSectionAfter(s){
    const courseS = Number(s);
    if(!Number.isFinite(courseS)) throw new TypeError('course distance must be finite');
    const current = this.sectionAt(courseS);
    if(current){
      const index = this.sections.indexOf(current);
      return this.sections[index + 1] || null;
    }
    return this.sections.find(section => section.s0 > courseS) || null;
  }

  sectionBoundaryAfter(s){
    return this.nextSectionAfter(s)?.s0 ?? null;
  }

  rivalPoseAt(rival, s, lane = undefined){
    const profile = typeof rival === 'string'
      ? this.rivals.find(entry => entry.id === rival || entry.name === rival)
      : rival;
    if(!profile) throw new RangeError(`unknown rival: ${rival}`);
    const pose = this.poseAt(s, lane ?? profile.lane);
    return deepFreeze({ ...pose, rivalId: profile.id, rivalName: profile.name, color: profile.color });
  }

  /**
   * Return canonical geometry/collider anchors. Observed positions may be
   * supplied as `{geometry, colliders}` objects or Maps keyed by anchor id.
   * With no argument, canonical definitions compare to themselves. Once an
   * observation object is supplied, every missing geometry/collider key is an
   * explicit failed observation rather than a canonical fallback.
   */
  debugAnchors(observed = undefined, tolerance = 1e-6){
    if(!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError('anchor tolerance must be non-negative');
    const definitions = [];
    for(const hazard of this.hazards){
      const points = [
        ['cue', hazard.cueStart], ['start', hazard.s0], ['end', hazard.s1], ['landing', hazard.landingEnd],
      ];
      for(const lane of hazard.lanes){
        for(const [part, courseS] of points){
          definitions.push({
            key: `hazard:${hazard.id}:${part}:lane:${lane}`,
            kind: 'hazard', sourceId: hazard.id, part, courseS, lane,
            boundaryHeight: part === 'start' || part === 'end' ? hazard.boundaryHeight ?? 0 : 0,
          });
        }
      }
    }
    for(const checkpoint of this.checkpoints){
      definitions.push({ key: `checkpoint:${checkpoint.id}`, kind: 'checkpoint', sourceId: checkpoint.id, part: 'center', courseS: checkpoint.s, lane: 0 });
    }
    for(const pad of this.safePads){
      definitions.push({ key: `safe-pad:${pad.id}`, kind: 'safe-pad', sourceId: pad.id, part: 'resume', courseS: pad.resumeS, lane: pad.lane });
    }

    const observationsRequired = observed !== undefined && observed !== null;
    let maxDelta = 0, missingCount = 0;
    const anchors = definitions.map(definition => {
      const posePosition = this.poseAt(definition.courseS, definition.lane).position;
      const canonical = {
        x: posePosition.x,
        y: posePosition.y + (definition.boundaryHeight ?? 0),
        z: posePosition.z,
      };
      const geometryResult = resolveObserved(observed?.geometry, definition.key, canonical, observationsRequired);
      const colliderResult = resolveObserved(observed?.colliders ?? observed?.collider, definition.key, canonical, observationsRequired);
      const missing = [];
      if(!geometryResult.found) missing.push('geometry');
      if(!colliderResult.found) missing.push('collider');
      missingCount += missing.length;
      const geometry = geometryResult.value;
      const collider = colliderResult.value;
      const delta = missing.length ? Infinity : distance(geometry, collider);
      maxDelta = Math.max(maxDelta, delta);
      return deepFreeze({ ...definition, canonical: { ...canonical }, geometry, collider, missing, delta, aligned: delta <= tolerance });
    });
    return deepFreeze({ tolerance, maxDelta, missingCount, aligned: missingCount === 0 && maxDelta <= tolerance, anchors });
  }
}

export function createRunnerCourseModel(rawPathOrOptions = undefined, options = undefined){
  if(rawPathOrOptions?.at || rawPathOrOptions?.atInto) return new RunnerCourseModel(rawPathOrOptions, options);
  return new RunnerCourseModel(buildAuthoredRawPath(), rawPathOrOptions);
}
