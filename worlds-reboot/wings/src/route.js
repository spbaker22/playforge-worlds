/* PAPER WINGS - authored route data and deterministic course queries. */

const FULL_GATES = Object.freeze([
  Object.freeze({ id: 'needles', name: 'THE NEEDLES', s: 58, x: 0, y: 31, radius: 7.2 }),
  Object.freeze({ id: 'ice-chute', name: 'ICE CHUTE', s: 112, x: -18, y: 36, radius: 7.0 }),
  Object.freeze({ id: 'glacier-eye', name: 'GLACIER EYE', s: 168, x: 12, y: 40, radius: 6.8 }),
  Object.freeze({ id: 'sun-shelf', name: 'SUN SHELF', s: 224, x: 28, y: 34, radius: 7.2 }),
  Object.freeze({ id: 'bell-pass', name: 'BELL PASS', s: 282, x: -4, y: 29, radius: 6.6 }),
  Object.freeze({ id: 'larch-gap', name: 'LARCH GAP', s: 338, x: -31, y: 38, radius: 7.3 }),
  Object.freeze({ id: 'switchback', name: 'SWITCHBACK', s: 396, x: -8, y: 46, radius: 6.7 }),
  Object.freeze({ id: 'blue-wall', name: 'BLUE WALL', s: 454, x: 24, y: 43, radius: 7.0 }),
  Object.freeze({ id: 'eagle-turn', name: 'EAGLE TURN', s: 514, x: 38, y: 34, radius: 6.9 }),
  Object.freeze({ id: 'whitewater', name: 'WHITEWATER', s: 574, x: 6, y: 28, radius: 7.4 }),
  Object.freeze({ id: 'summit-door', name: 'SUMMIT DOOR', s: 636, x: -28, y: 41, radius: 6.8 }),
  Object.freeze({ id: 'homewind', name: 'HOMEWIND', s: 700, x: 0, y: 34, radius: 8.0 }),
]);

export const WING_RIVALS = Object.freeze([
  Object.freeze({ id: 'sora', name: 'SORA', color: 0xd95b45, style: 'swept', finishTime: 37.8, quickFinishTime: 19.5, lane: -8.5, altitude: 2.1 }),
  Object.freeze({ id: 'vale', name: 'VALE', color: 0xe2ad45, style: 'biplane', finishTime: 40.4, quickFinishTime: 21.5, lane: 8.2, altitude: -1.6 }),
  Object.freeze({ id: 'pip', name: 'PIP', color: 0x325f8f, style: 'delta', finishTime: 43.1, quickFinishTime: 23.5, lane: 2.8, altitude: 4.0 }),
]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createWingRoute(kind = 'full'){
  const normalized = kind === 'quick' ? 'quick' : 'full';
  const gates = normalized === 'quick' ? FULL_GATES.slice(0, 6) : FULL_GATES.slice();
  const finishS = gates[gates.length - 1].s + 48;
  return Object.freeze({
    id: normalized,
    name: normalized === 'quick' ? 'RIDGELINE SIX' : 'ALPINE TWELVE',
    gates: Object.freeze(gates),
    finishS,
    length: finishS,
  });
}

export function routePointAtS(route, s, out = { x: 0, y: 33 }){
  if(!route?.gates?.length) throw new TypeError('routePointAtS requires a route');
  const bounded = clamp(Number.isFinite(s) ? s : 0, 0, route.finishS);
  let previous = { s: 0, x: 0, y: 33 };
  for(const gate of route.gates){
    if(bounded <= gate.s){
      const span = Math.max(1, gate.s - previous.s);
      const t = clamp((bounded - previous.s) / span, 0, 1);
      const eased = t * t * (3 - 2 * t);
      out.x = previous.x + (gate.x - previous.x) * eased;
      out.y = previous.y + (gate.y - previous.y) * eased;
      return out;
    }
    previous = gate;
  }
  const tail = clamp((bounded - previous.s) / Math.max(1, route.finishS - previous.s), 0, 1);
  out.x = previous.x * (1 - tail);
  out.y = previous.y + (36 - previous.y) * tail;
  return out;
}

export function gateDistance(gate, x, y){
  if(!gate) return Number.POSITIVE_INFINITY;
  return Math.hypot(x - gate.x, y - gate.y);
}

export function gateRadius(gate, control = 'guided'){
  const multiplier = control === 'direct' ? 1 : 1.26;
  return gate.radius * multiplier;
}

export function evaluateGate(gate, x, y, control = 'guided'){
  const distance = gateDistance(gate, x, y);
  const radius = gateRadius(gate, control);
  return Object.freeze({ passed: distance <= radius, distance, radius, margin: radius - distance });
}

export function rivalFinishTime(profile, route){
  if(!profile || !route) throw new TypeError('rivalFinishTime requires a profile and route');
  return route.id === 'quick' ? profile.quickFinishTime : profile.finishTime;
}

export function rivalProgress(profile, time, route){
  if(!profile || !route) throw new TypeError('rivalProgress requires a profile and route');
  const phase = WING_RIVALS.indexOf(profile) * 1.7;
  const base = clamp(time / rivalFinishTime(profile, route), 0, 1) * route.finishS;
  const launchBlend = clamp(time / 2.5, 0, 1);
  const weave = Math.sin(time * 0.72 + phase) * 2.4 * launchBlend * (1 - Math.min(1, base / route.finishS));
  return clamp(base + weave, 0, route.finishS);
}

export function raceStanding(playerS, time, route, race = 'rivals'){
  if(race !== 'rivals') return Object.freeze({ rank: 1, total: 1, entries: Object.freeze([]) });
  const entries = WING_RIVALS.map(profile => Object.freeze({
    id: profile.id,
    name: profile.name,
    s: rivalProgress(profile, time, route),
  }));
  const rank = 1 + entries.filter(entry => entry.s > playerS + 0.01).length;
  return Object.freeze({ rank, total: 4, entries: Object.freeze(entries) });
}
