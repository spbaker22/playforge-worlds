import assert from 'node:assert/strict';
import test from 'node:test';
import { createGolfRivalRound, createGolfRivalRoundKey } from './rivals.js';

const PARS = [2, 3, 2, 3, 3, 3];
const HOLES = PARS.map((_, index) => index);

function roundKey(overrides = {}){
  return createGolfRivalRoundKey({
    preview: true,
    format: 'front-six',
    practiceHole: 1,
    cupAssist: 'standard',
    rivals: 'standard',
    holes: HOLES,
    ...overrides,
  });
}

function playCard(round){
  return PARS.flatMap(par => [
    round.nextStrokes(par),
    round.nextStrokes(par),
    round.nextStrokes(par),
  ]);
}

test('identical options and play order produce identical rival cards without Math.random', () => {
  const key = roundKey();
  const first = createGolfRivalRound({ roundKey: key, mode: 'standard' });
  const second = createGolfRivalRound({ roundKey: key, mode: 'standard' });
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('rival scoring touched Math.random'); };
  try {
    assert.deepEqual(playCard(first), playCard(second));
  } finally {
    Math.random = originalRandom;
  }
  assert.equal(first.snapshot().draws, PARS.length * 3);
});

test('replay reset restores the round-local sequence', () => {
  const key = roundKey({ format: 'quick-three', holes: [0, 1, 2] });
  const round = createGolfRivalRound({ roundKey: key, mode: 'standard' });
  const first = playCard(round);
  const consumed = round.snapshot();
  const reset = round.reset({ roundKey: key, mode: 'standard' });
  const replay = playCard(round);
  assert.equal(consumed.draws, PARS.length * 3);
  assert.equal(reset.draws, 0);
  assert.equal(reset.seed, consumed.seed);
  assert.deepEqual(replay, first);
});

test('round key follows options and relaxed rivals remain meaningfully gentler', () => {
  assert.notEqual(roundKey(), roundKey({ cupAssist: 'family' }));
  assert.notEqual(roundKey(), roundKey({ rivals: 'relaxed' }));
  assert.notEqual(roundKey(), roundKey({ format: 'practice', practiceHole: 4, holes: [3] }));

  let standardTotal = 0;
  let relaxedTotal = 0;
  for(let sample = 0; sample < 256; sample += 1){
    const key = `${roundKey()}|sample:${sample}`;
    const standard = createGolfRivalRound({ roundKey: key, mode: 'standard' });
    const relaxed = createGolfRivalRound({ roundKey: key, mode: 'relaxed' });
    standardTotal += playCard(standard).reduce((sum, strokes) => sum + strokes, 0);
    relaxedTotal += playCard(relaxed).reduce((sum, strokes) => sum + strokes, 0);
  }
  assert.ok(relaxedTotal > standardTotal + 1_000, `relaxed ${relaxedTotal} must score above standard ${standardTotal}`);
});
