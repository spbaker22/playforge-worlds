import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  PREVIEW_DEFAULTS,
  WINGS_LOADOUT_VALUES,
  WINGS_MISSION_VALUES,
  createPreviewMenuOpenState,
  normalizePreviewOptions,
  previewGameHref,
  readPreviewOptions,
  setPreviewOption,
  writePreviewOptions,
} from './options.js';

function memoryStorage(initial = null){
  let value = initial;
  return {
    getItem(){ return value; },
    setItem(_key, next){ value = next; },
    value(){ return value; },
  };
}

test('five-game defaults are normalized without sharing mutable groups', () => {
  const first = normalizePreviewOptions(PREVIEW_DEFAULTS);
  const second = normalizePreviewOptions(PREVIEW_DEFAULTS);
  assert.deepEqual(first.ashfall, { mode: 'full', intensity: 'standard' });
  assert.deepEqual(first.wings, {
    mission: 'flight-school', loadout: 'balanced', route: 'full', control: 'guided', race: 'rivals',
  });
  assert.deepEqual(first.tide, { session: 'full', tension: 'standard', scoring: 'haul' });
  assert.notEqual(first.ashfall, second.ashfall);
  assert.notEqual(first.wings, second.wings);
  assert.notEqual(first.tide, second.tide);
});

test('invalid stored and URL values fail closed to typed defaults', () => {
  const storage = memoryStorage(JSON.stringify({
    sound: 'loud', quality: 'ultra',
    ashfall: { mode: 'endless', intensity: 'impossible' },
    wings: { mission: 'free-flight', loadout: 'tank', route: 'random', control: 'tilt', race: 'online' },
    tide: { session: 'forever', tension: 'snapping', scoring: 'money' },
  }));
  const state = readPreviewOptions({
    storage,
    url: new URL('https://preview.invalid/?ashMode=nope&wingsMission=nope&wingsLoadout=nope&wingsControl=nope&tideScoring=nope'),
  });
  assert.deepEqual(state, normalizePreviewOptions(PREVIEW_DEFAULTS));
});

test('URL overrides and immutable setter cover all five game groups', () => {
  const original = normalizePreviewOptions(PREVIEW_DEFAULTS);
  let state = setPreviewOption(original, 'ashfall.mode', 'quick');
  state = setPreviewOption(state, 'ashfall.intensity', 'inferno');
  state = setPreviewOption(state, 'wings.mission', 'storm-escape');
  state = setPreviewOption(state, 'wings.loadout', 'guardian');
  state = setPreviewOption(state, 'wings.route', 'quick');
  state = setPreviewOption(state, 'wings.control', 'direct');
  state = setPreviewOption(state, 'wings.race', 'solo');
  state = setPreviewOption(state, 'tide.session', 'quick');
  state = setPreviewOption(state, 'tide.tension', 'relaxed');
  state = setPreviewOption(state, 'tide.scoring', 'trophy');
  assert.equal(original.ashfall.mode, 'full');
  assert.deepEqual(state.ashfall, { mode: 'quick', intensity: 'inferno' });
  assert.deepEqual(state.wings, {
    mission: 'storm-escape', loadout: 'guardian', route: 'quick', control: 'direct', race: 'solo',
  });
  assert.deepEqual(state.tide, { session: 'quick', tension: 'relaxed', scoring: 'trophy' });
});

test('each game href carries only same-game typed options plus shared options', () => {
  const state = normalizePreviewOptions({
    sound: 'off', quality: 'performance',
    ashfall: { mode: 'quick', intensity: 'calm' },
    wings: { mission: 'ace-pursuit', loadout: 'racer', route: 'quick', control: 'direct', race: 'solo' },
    tide: { session: 'quick', tension: 'relaxed', scoring: 'trophy' },
  });
  const ashfall = new URL(previewGameHref('ashfall', state, { base: 'https://preview.invalid/ashfall/index.html' }));
  const wings = new URL(previewGameHref('wings', state, { base: 'https://preview.invalid/wings/index.html' }));
  const tide = new URL(previewGameHref('tide', state, { base: 'https://preview.invalid/tide/index.html' }));
  for(const url of [ashfall, wings, tide]){
    assert.equal(url.searchParams.get('preview'), '1');
    assert.equal(url.searchParams.get('sound'), 'off');
    assert.equal(url.searchParams.get('quality'), 'performance');
    assert.equal(url.searchParams.has('hub'), false);
  }
  assert.equal(ashfall.searchParams.get('ashMode'), 'quick');
  assert.equal(ashfall.searchParams.get('ashIntensity'), 'calm');
  assert.equal(ashfall.searchParams.has('wingsMission'), false);
  assert.equal(ashfall.searchParams.has('wingsLoadout'), false);
  assert.equal(wings.searchParams.get('wingsMission'), 'ace-pursuit');
  assert.equal(wings.searchParams.get('wingsLoadout'), 'racer');
  assert.equal(wings.searchParams.get('wingsRoute'), 'quick');
  assert.equal(wings.searchParams.get('wingsControl'), 'direct');
  assert.equal(wings.searchParams.get('wingsRace'), 'solo');
  assert.equal(tide.searchParams.get('tideSession'), 'quick');
  assert.equal(tide.searchParams.get('tideTension'), 'relaxed');
  assert.equal(tide.searchParams.get('tideScoring'), 'trophy');
  assert.equal(tide.searchParams.has('wingsMission'), false);
  assert.equal(tide.searchParams.has('wingsLoadout'), false);
});

test('all authored Paper Wings missions and loadouts round-trip through URLs', () => {
  assert.deepEqual(WINGS_MISSION_VALUES, [
    'flight-school', 'ridge-race', 'target-run', 'stunt-trial',
    'mountain-rescue', 'storm-escape', 'ace-pursuit', 'skybreaker-finale',
  ]);
  assert.deepEqual(WINGS_LOADOUT_VALUES, ['balanced', 'racer', 'stunt', 'guardian']);

  for(const mission of WINGS_MISSION_VALUES){
    const state = readPreviewOptions({
      storage: null,
      url: new URL(`https://preview.invalid/?wingsMission=${mission}`),
    });
    assert.equal(state.wings.mission, mission);
    const href = new URL(previewGameHref('wings', state, { base: 'https://preview.invalid/wings/index.html' }));
    assert.equal(href.searchParams.get('wingsMission'), mission);
  }

  for(const loadout of WINGS_LOADOUT_VALUES){
    const state = readPreviewOptions({
      storage: null,
      url: new URL(`https://preview.invalid/?wingsLoadout=${loadout}`),
    });
    assert.equal(state.wings.loadout, loadout);
    const href = new URL(previewGameHref('wings', state, { base: 'https://preview.invalid/wings/index.html' }));
    assert.equal(href.searchParams.get('wingsLoadout'), loadout);
  }
});

test('legacy Paper Wings URLs keep their route, control, and race behavior', () => {
  const state = readPreviewOptions({
    storage: null,
    url: new URL('https://preview.invalid/?wingsRoute=quick&wingsControl=direct&wingsRace=solo'),
  });
  assert.deepEqual(state.wings, {
    mission: 'flight-school', loadout: 'balanced', route: 'quick', control: 'direct', race: 'solo',
  });
});

test('launcher offers every Paper Wings mission and loadout without disabling locked missions', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const labels = new Map([
    ['flight-school', 'FLIGHT SCHOOL'], ['ridge-race', 'RIDGE RACE'],
    ['target-run', 'TARGET RUN'], ['stunt-trial', 'STUNT TRIAL'],
    ['mountain-rescue', 'MOUNTAIN RESCUE'], ['storm-escape', 'STORM ESCAPE'],
    ['ace-pursuit', 'ACE PURSUIT'], ['skybreaker-finale', 'SKYBREAKER FINALE'],
    ['balanced', 'BALANCED'], ['racer', 'RACER'], ['stunt', 'STUNT'], ['guardian', 'GUARDIAN'],
  ]);
  for(const [value, label] of labels){
    assert.ok(html.includes(`<button data-value="${value}">${label}</button>`), `${label} selector is missing`);
  }
  assert.equal(html.match(/data-option="wings\.mission"/g)?.length, 2);
  assert.equal(html.match(/data-option="wings\.loadout"/g)?.length, 1);
  assert.doesNotMatch(html, /<button[^>]+data-value="(?:flight-school|ridge-race|target-run|stunt-trial|mountain-rescue|storm-escape|ace-pursuit|skybreaker-finale)"[^>]*disabled/);
});

test('writes preserve the complete typed schema', () => {
  const storage = memoryStorage();
  const saved = writePreviewOptions(setPreviewOption(PREVIEW_DEFAULTS, 'wings.race', 'solo'), { storage });
  assert.deepEqual(JSON.parse(storage.value()), saved);
  assert.deepEqual(readPreviewOptions({ storage, url: null }), saved);
});

test('preview menu open state reports each real transition exactly once', () => {
  const transitions = [];
  const state = createPreviewMenuOpenState({ onOpenChange: open => transitions.push(open) });
  assert.equal(state.open, false);
  assert.equal(state.set(false), false);
  assert.equal(state.set(true), true);
  assert.equal(state.set(true), false);
  assert.equal(state.set(false), true);
  assert.equal(state.set(false), false);
  assert.deepEqual(transitions, [true, false]);
});

test('preview menu open state rejects a non-function callback', () => {
  assert.throws(() => createPreviewMenuOpenState({ onOpenChange: true }), /function or null/);
});
