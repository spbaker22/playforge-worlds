import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argument = name => process.argv.slice(2)
  .find(value => value.startsWith(`--${name}=`))
  ?.slice(name.length + 3) || null;
const chrome = argument('chrome') || process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(existsSync);
if(!chrome) throw new Error('Chrome was not found; pass --chrome=/absolute/path/to/Chrome');

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const screenshots = argument('screenshots') || path.join(repoRoot, 'preview-evidence', 'launcher-readability-20260715');
mkdirSync(screenshots, { recursive: true });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function startPreviewServer(port = 4205){
  const vite = path.join(repoRoot, 'node_modules', '.bin', 'vite');
  const child = spawn(vite, [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--strictPort',
    '--base', '/preview/',
  ], {
    cwd: path.join(repoRoot, 'preview'),
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const url = `http://127.0.0.1:${port}/preview/index.html`;
  const deadline = Date.now() + 20_000;
  while(Date.now() < deadline){
    if(child.exitCode !== null) throw new Error(`Launcher Vite exited early (${child.exitCode}): ${output}`);
    try {
      const response = await fetch(url);
      if(response.ok) return { child, url };
    } catch {}
    await sleep(80);
  }
  child.kill('SIGTERM');
  throw new Error(`Launcher Vite did not become ready: ${output}`);
}

async function stopServer(child){
  if(!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(3_000)]);
  if(child.exitCode === null) child.kill('SIGKILL');
}

function auditLauncherLayout(){
  const rgb = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const luminance = color => {
    const channels = rgb(color).map(channel => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const contrast = (foreground, background) => {
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const wordLineCounts = element => {
    const node = [...element.childNodes].find(child => child.nodeType === Node.TEXT_NODE);
    const text = node?.textContent || '';
    return [...text.matchAll(/\S+/g)].map(match => {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const lines = new Set([...range.getClientRects()]
        .filter(rect => rect.width > 0 && rect.height > 0)
        .map(rect => Math.round(rect.top * 2) / 2));
      return { word: match[0], lines: lines.size };
    });
  };
  const optionButtons = [...document.querySelectorAll('[data-option] button[data-value]')];
  const selected = optionButtons.filter(button => button.classList.contains('active')).map(button => {
    const style = getComputedStyle(button);
    return {
      option: button.closest('[data-option]').dataset.option,
      value: button.dataset.value,
      foreground: style.color,
      background: style.backgroundColor,
      contrast: contrast(style.color, style.backgroundColor),
    };
  });
  const controls = optionButtons.map(button => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      option: button.closest('[data-option]').dataset.option,
      value: button.dataset.value,
      text: button.textContent.trim(),
      width: rect.width,
      height: rect.height,
      overflowX: button.scrollWidth - button.clientWidth,
      overflowY: button.scrollHeight - button.clientHeight,
      overflowWrap: style.overflowWrap,
      wordBreak: style.wordBreak,
      words: wordLineCounts(button),
    };
  });
  const shell = document.querySelector('.shell').getBoundingClientRect();
  const topbar = document.querySelector('.topbar').getBoundingClientRect();
  const cards = [...document.querySelectorAll('.gameCard')].map(card => {
    const rect = card.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  });
  return {
    viewport: { width: innerWidth, height: innerHeight },
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    shell: { left: shell.left, right: shell.right },
    topbar: { left: topbar.left, right: topbar.right },
    controls,
    selected,
    cards,
    gameColumns: getComputedStyle(document.querySelector('.games')).gridTemplateColumns.split(' ').length,
  };
}

function assertLayout(layout, { portrait = false } = {}){
  assert.ok(layout.documentWidth <= layout.viewport.width, `document overflows ${layout.viewport.width}px viewport`);
  assert.ok(layout.bodyWidth <= layout.viewport.width, `body overflows ${layout.viewport.width}px viewport`);
  assert.ok(layout.shell.left >= 0 && layout.shell.right <= layout.viewport.width, 'launcher shell escapes viewport');
  assert.ok(layout.topbar.left >= 0 && layout.topbar.right <= layout.viewport.width, 'launcher topbar escapes viewport');
  assert.ok(layout.controls.every(control => control.width >= 44 && control.height >= 44), 'every option target must remain at least 44x44');
  assert.deepEqual(
    layout.controls.filter(control => control.overflowX > 1 || control.overflowY > 1)
      .map(control => ({ option: control.option, value: control.value, text: control.text, overflowX: control.overflowX, overflowY: control.overflowY })),
    [],
    'option text must fit its target',
  );
  assert.ok(layout.controls.every(control => control.overflowWrap !== 'anywhere' && control.wordBreak !== 'break-all'), 'arbitrary word breaking must stay disabled');
  assert.deepEqual(
    layout.controls.flatMap(control => control.words.filter(word => word.lines !== 1).map(word => `${control.option}:${control.value}:${word.word}`)),
    [],
    'no word may split across rendered lines',
  );
  assert.ok(layout.selected.length >= 14, 'every option group must retain one selected state');
  assert.ok(layout.selected.every(entry => entry.contrast >= 4.5), 'selected option text must retain WCAG AA contrast');
  assert.ok(layout.cards.every(card => card.left >= 0 && card.right <= layout.viewport.width), 'game cards must remain inside the viewport');
  assert.equal(layout.gameColumns, portrait ? 1 : 2, `launcher must use ${portrait ? 'one' : 'two'} game column(s)`);
}

let browser;
let server;
try {
  server = await startPreviewServer();
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chrome,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => {
    if(message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(`console: ${message.text()}`);
  });

  await page.setViewport({ width: 1194, height: 834, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__previewLauncher, { timeout: 20_000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__previewLauncher, { timeout: 20_000 });

  const labels = await page.evaluate(() => ({
    performance: document.querySelector('[data-option="quality"] [data-value="performance"]').textContent.trim(),
    training: document.querySelector('[data-option="runner.format"] [data-value="full-training"]').textContent.trim(),
    relay: document.querySelector('[data-option="runner.format"] [data-value="final-relay"]').textContent.trim(),
  }));
  assert.deepEqual(labels, { performance: 'FAST', training: 'TRAINING', relay: 'RELAY' });

  const routed = await page.evaluate(() => {
    window.__previewLauncher.set('quality', 'performance');
    window.__previewLauncher.set('runner.format', 'final-relay');
    window.__previewLauncher.set('runner.pace', 'calm');
    window.__previewLauncher.set('golf.format', 'quick-three');
    const runner = new URL(document.getElementById('playRunner').href);
    const golf = new URL(document.getElementById('playGolf').href);
    return {
      runner: {
        quality: runner.searchParams.get('quality'),
        format: runner.searchParams.get('runnerFormat'),
        pace: runner.searchParams.get('runnerPace'),
      },
      golf: {
        quality: golf.searchParams.get('quality'),
        format: golf.searchParams.get('golfFormat'),
      },
      stored: JSON.parse(localStorage.getItem('playforge.preview.options.v1')),
    };
  });
  assert.deepEqual(routed.runner, { quality: 'performance', format: 'final-relay', pace: 'calm' });
  assert.deepEqual(routed.golf, { quality: 'performance', format: 'quick-three' });
  assert.equal(routed.stored.quality, 'performance');
  assert.equal(routed.stored.runner.format, 'final-relay');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__previewLauncher, { timeout: 20_000 });
  const persisted = await page.evaluate(() => ({
    options: window.__previewLauncher.options,
    performanceActive: document.querySelector('[data-option="quality"] [data-value="performance"]').classList.contains('active'),
    relayActive: document.querySelector('[data-option="runner.format"] [data-value="final-relay"]').classList.contains('active'),
  }));
  assert.equal(persisted.options.quality, 'performance');
  assert.equal(persisted.options.runner.format, 'final-relay');
  assert.equal(persisted.performanceActive, true);
  assert.equal(persisted.relayActive, true);

  const viewports = [
    { width: 1194, height: 834, name: 'launcher-1194x834', portrait: false },
    { width: 1024, height: 768, name: 'launcher-1024x768', portrait: false },
    { width: 834, height: 1194, name: 'launcher-834x1194-portrait', portrait: true },
  ];
  const layouts = {};
  for(const viewport of viewports){
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await sleep(120);
    const layout = await page.evaluate(auditLauncherLayout);
    assertLayout(layout, viewport);
    layouts[viewport.name] = layout;
    await page.screenshot({ path: path.join(screenshots, `${viewport.name}.png`) });
    await page.screenshot({ path: path.join(screenshots, `${viewport.name}-full.png`), fullPage: true });
  }
  assert.deepEqual(errors, [], `Browser errors: ${errors.join(' | ')}`);
  const layoutSummary = Object.fromEntries(Object.entries(layouts).map(([name, layout]) => [name, {
    viewport: layout.viewport,
    documentWidth: layout.documentWidth,
    gameColumns: layout.gameColumns,
    optionTargets: layout.controls.length,
    minimumTarget: {
      width: Math.min(...layout.controls.map(control => control.width)),
      height: Math.min(...layout.controls.map(control => control.height)),
    },
    minimumSelectedContrast: Math.min(...layout.selected.map(entry => entry.contrast)),
    splitWords: layout.controls.flatMap(control => control.words.filter(word => word.lines !== 1)).length,
  }]));
  process.stdout.write(`${JSON.stringify({ labels, routed: { runner: routed.runner, golf: routed.golf }, layouts: layoutSummary, screenshots }, null, 2)}\n`);
  process.stdout.write('LAUNCHER_READABILITY_OK\n');
} finally {
  if(browser) await browser.close();
  await stopServer(server?.child);
}
