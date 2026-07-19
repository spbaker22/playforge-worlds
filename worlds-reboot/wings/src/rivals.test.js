import test from 'node:test';
import assert from 'node:assert/strict';
import { createWingRoute } from './route.js';
import {
  WING_RIVALS,
  chooseRivalAction,
  chooseRivalBranch,
  chooseRivalTarget,
  createRivalField,
  createRivalState,
  rankRace,
  stepRival,
  stepRivalField,
} from './rivals.js';

test('rival profiles and initial state are stable plain serializable data', () => {
  const route = createWingRoute('quick');
  const field = createRivalField(route);
  assert.deepEqual(field.map(rival => rival.id), ['sora', 'vale', 'pip']);
  assert.equal(new Set(WING_RIVALS.map(profile => profile.style)).size, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(field)), field);
  assert.deepEqual(createRivalState('sora', route), createRivalState(WING_RIVALS[0], route));
});

test('rivals make deterministic personality-driven route and target choices', () => {
  const route = createWingRoute('full');
  const fork = route.forks[0];
  const sora = createRivalState('sora', route);
  const pip = createRivalState('pip', route);
  assert.equal(chooseRivalBranch('sora', sora, fork), 'shortcut');
  assert.equal(chooseRivalBranch('pip', pip, fork), 'safe');

  const targets = [
    { id: 'near', s: 30, value: 1, difficulty: 0.5, active: true },
    { id: 'valuable', s: 42, value: 2, difficulty: 0.8, active: true },
    { id: 'gone', s: 20, value: 9, destroyed: true },
  ];
  const vale = { ...createRivalState('vale', route), s: 10, energy: 0.7 };
  assert.equal(chooseRivalTarget('vale', vale, targets), 'valuable');
  assert.equal(chooseRivalAction('vale', { ...vale, targetId: 'valuable' }, route, { targets }), 'attack');
});

test('kinematic rivals advance deterministically and keep branch decisions locked', () => {
  const route = createWingRoute('quick');
  const simulate = () => {
    let field = createRivalField(route);
    for(let frame = 0; frame < 720; frame += 1){
      field = stepRivalField(field, 1 / 60, route, { playerS: frame * 0.22, targets: [] });
    }
    return field;
  };
  const first = simulate();
  const second = simulate();
  assert.deepEqual(first, second);
  assert.ok(first.every(rival => rival.s > 0));
  assert.equal(first[0].branchChoices['ice-chute'], 'shortcut');
  assert.equal(first[2].branchChoices['ice-chute'], 'safe');

  const relocked = stepRival({ ...first[0], branchChoices: { 'ice-chute': 'safe' } }, 0.2, route);
  assert.equal(relocked.branchChoices['ice-chute'], 'safe');
});

test('race ranking uses finish time, then global progress, with stable ties', () => {
  const ranking = rankRace(
    { id: 'player', name: 'YOU', s: 300, finished: false },
    [
      { id: 'sora', name: 'SORA', s: 380, finished: true, finishElapsed: 21 },
      { id: 'vale', name: 'VALE', s: 300, finished: false },
      { id: 'pip', name: 'PIP', s: 210, finished: false },
    ],
  );
  assert.equal(ranking.rank, 2);
  assert.deepEqual(ranking.entries.map(entry => entry.id), ['sora', 'player', 'vale', 'pip']);
  assert.deepEqual(JSON.parse(JSON.stringify(ranking)), ranking);
});
