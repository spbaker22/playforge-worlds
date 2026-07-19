import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createPresentationViewModel,
  createWingsPresentation,
  formatPresentationScore,
  formatPresentationTime,
  normalizePresentationMode,
  presentationScreenState,
} from './presentation.js';

class FakeElement {
  constructor(id, ownerDocument){
    this.id = id;
    this.ownerDocument = ownerDocument;
    this.textContent = '';
    this.hidden = false;
    this.inert = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = new Map();
    this.style = { values: new Map(), setProperty: (name, value) => this.style.values.set(name, value) };
    this.classList = { toggle(){} };
  }

  setAttribute(name, value){ this.attributes.set(name, String(value)); }
  getAttribute(name){ return this.attributes.get(name) ?? null; }
  toggleAttribute(name, force){
    if(force) this.attributes.set(name, '');
    else this.attributes.delete(name);
  }
  contains(){ return false; }
  querySelector(){ return null; }
}

function presentationDocument(){
  const elements = new Map();
  const doc = {
    activeElement: null,
    getElementById(id){
      if(!elements.has(id)) elements.set(id, new FakeElement(id, doc));
      return elements.get(id);
    },
    querySelectorAll(selector){
      if(selector === '[data-energy-segment]') return energy;
      if(selector === '[data-shield-pip]') return shields;
      return [];
    },
  };
  doc.body = doc.getElementById('body');
  doc.getElementById('energyProgress').setAttribute('role', 'progressbar');
  const energy = Array.from({ length: 5 }, (_, index) => doc.getElementById(`energy-segment-${index}`));
  const shields = Array.from({ length: 3 }, (_, index) => doc.getElementById(`shield-pip-${index}`));
  return { doc, elements };
}

test('presentation modes fail closed and expose one authoritative screen', () => {
  assert.equal(normalizePresentationMode('mission-select'), 'campaign');
  assert.equal(normalizePresentationMode('unknown'), 'title');
  assert.deepEqual(presentationScreenState('campaign'), {
    mode: 'campaign', activeScreen: 'campaign', hud: false, terminal: false,
  });
  assert.deepEqual(presentationScreenState('flight'), {
    mode: 'flight', activeScreen: null, hud: true, terminal: false,
  });
  assert.deepEqual(presentationScreenState('fail'), {
    mode: 'fail', activeScreen: null, hud: true, terminal: true,
  });
});

test('view model clamps cockpit resources and derives fixed feedback segments', () => {
  const view = createPresentationViewModel({
    mode: 'flight', missionId: 'storm-escape',
    objective: { label: 'Cross the storm', current: 7, total: 5 },
    energy: 47, shield: 9, combo: 3.5, score: 12840,
  });
  assert.equal(view.mission.id, 'storm-escape');
  assert.equal(view.objective.current, 5);
  assert.equal(view.objective.progress, 1);
  assert.deepEqual(view.energySegments.map(segment => segment.state), ['full', 'full', 'partial', 'empty', 'empty']);
  assert.deepEqual(view.shieldPips, [true, true, true]);
  assert.equal(view.combo, 3.5);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.energySegments), true);
});

test('campaign normalization filters unknown ids without freezing caller data', () => {
  const source = { 'flight-school': 2, 'ridge-race': 8 };
  const view = createPresentationViewModel({
    missionId: 'ridge-race',
    campaign: {
      selectedMissionId: 'ridge-race',
      unlockedMissionIds: ['flight-school', 'missing', 'ridge-race'],
      completedMissionIds: ['flight-school', 'missing'],
      missionStars: source,
    },
  });
  assert.deepEqual(view.campaign.unlockedMissionIds, ['flight-school', 'ridge-race']);
  assert.deepEqual(view.campaign.completedMissionIds, ['flight-school']);
  assert.equal(view.campaign.missionStars['flight-school'], 2);
  assert.equal(view.campaign.missionStars['ridge-race'], 3);
  assert.equal(Object.isFrozen(source), false);
});

test('results always expose three immutable mission challenge rows', () => {
  const view = createPresentationViewModel({
    missionId: 'target-run',
    results: { challenges: [true, { label: 'Open the fast line', complete: true }, false] },
  });
  assert.equal(view.results.challenges.length, 3);
  assert.deepEqual(view.results.challenges.map(challenge => challenge.complete), [true, true, false]);
  assert.equal(view.results.challenges[1].label, 'Open the fast line');
  assert.equal(Object.isFrozen(view.results.challenges[0]), true);
});

test('presentation number formatting is deterministic', () => {
  assert.equal(formatPresentationTime(0), '0:00');
  assert.equal(formatPresentationTime(125.8), '2:05');
  assert.equal(formatPresentationTime(-5), '0:00');
  assert.equal(formatPresentationScore(12840.9), '12,840');
  assert.equal(formatPresentationScore(Number.NaN), '0');
});

test('energy progress exposes value and visible text at empty, partial, and full states', () => {
  const { doc } = presentationDocument();
  const presentation = createWingsPresentation({ root: doc });
  const progress = doc.getElementById('energyProgress');
  const visible = doc.getElementById('energyValue');

  for(const [energy, expectedText] of [[0, '0%'], [47, '47%'], [100, '100%']]){
    presentation.render({ mode: 'flight', energy });
    assert.equal(progress.getAttribute('role'), 'progressbar');
    assert.equal(progress.getAttribute('aria-valuemin'), '0');
    assert.equal(progress.getAttribute('aria-valuemax'), '100');
    assert.equal(progress.getAttribute('aria-valuenow'), String(energy));
    assert.equal(progress.getAttribute('aria-valuetext'), `${energy} percent wind energy remaining`);
    assert.equal(visible.textContent, expectedText);
  }
});

test('renderer keeps every inactive screen hidden, inert, and aria-hidden', () => {
  const { doc } = presentationDocument();
  const presentation = createWingsPresentation({ root: doc });

  for(const activeId of ['title', 'campaign', 'briefing', 'countdown', 'results']){
    presentation.render({ mode: activeId });
    for(const id of ['title', 'campaign', 'briefing', 'countdown', 'results']){
      const screen = doc.getElementById(id);
      const active = id === activeId;
      assert.equal(screen.hidden, !active, `${id} hidden state in ${activeId}`);
      assert.equal(screen.inert, !active, `${id} inert state in ${activeId}`);
      assert.equal(screen.getAttribute('aria-hidden'), String(!active), `${id} aria-hidden state in ${activeId}`);
    }
  }
});

test('shield, combo, and threat feedback retain non-color text cues', () => {
  const { doc } = presentationDocument();
  const presentation = createWingsPresentation({ root: doc });
  presentation.render({
    mode: 'flight', shield: 1, combo: 3,
    threat: { visible: true, label: 'LIGHTNING INBOUND', tone: 'danger' },
  });

  assert.equal(doc.getElementById('shieldValue').textContent, '1 / 3');
  assert.equal(doc.getElementById('comboValue').textContent, 'x3');
  assert.equal(doc.getElementById('threatLabel').textContent, 'LIGHTNING INBOUND');
  assert.equal(doc.getElementById('threatCue').hidden, false);
});

test('game shell exposes the complete campaign and cockpit contract', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  for(const id of [
    'title', 'campaign', 'briefing', 'countdown', 'results', 'hud',
    'objectiveProgress', 'missionMetricValue', 'bossProgress', 'scoreValue', 'comboValue',
    'energyProgress', 'energyValue', 'shieldValue', 'actionButton', 'threatCue', 'stuntCue', 'terminalFlag',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.equal((html.match(/data-mission-id=/g) || []).length, 8);
  assert.equal((html.match(/data-energy-segment/g) || []).length, 5);
  assert.equal((html.match(/data-shield-pip/g) || []).length, 3);
  assert.match(html, /id="energyProgress" role="progressbar"[^>]+aria-valuemin="0"[^>]+aria-valuemax="100"[^>]+aria-valuenow="100"/);
  assert.match(html, /id="threatCue" role="alert"/);
  for(const id of ['campaign', 'briefing', 'countdown', 'results']){
    assert.match(html, new RegExp(`<section[^>]+id="${id}"[^>]+hidden inert[^>]+aria-hidden="true"`));
  }
  assert.equal(html.includes('—'), false);
  assert.equal(html.includes('–'), false);
});
