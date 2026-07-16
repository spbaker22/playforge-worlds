import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUTPUT_ROOT = path.join(ROOT, 'preview-dist');
const OFFICIAL = Object.freeze([
  'runner/dist/index.html',
  'runner/gridlock-run-v1.html',
  'golf/dist/index.html',
  'golf/stackyard-golf-v1.html',
]);
const REFERENCE_OUTPUTS = Object.freeze([
  'wings/dist/index.html',
  'tide/dist/index.html',
]);

function hashFile(file){
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function officialManifest(){
  return Object.fromEntries(OFFICIAL.map(relative => [relative, hashFile(path.join(ROOT, relative))]));
}

function referenceManifest(){
  return Object.fromEntries(REFERENCE_OUTPUTS
    .filter(relative => existsSync(path.join(ROOT, relative)))
    .map(relative => [relative, hashFile(path.join(ROOT, relative))]));
}

function assertOfficialUnchanged(before){
  const after = officialManifest();
  for(const relative of OFFICIAL){
    if(after[relative] !== before[relative]) throw new Error(`Official output changed during preview build: ${relative}`);
  }
  return after;
}


function assertReferenceUnchanged(before){
  const after = referenceManifest();
  for(const [relative, digest] of Object.entries(before)){
    if(after[relative] !== digest) throw new Error(`Reference output changed during preview build: ${relative}`);
  }
  return after;
}

function defaultId(){
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function readId(){
  const token = process.argv.slice(2).find(value => value.startsWith('--id='));
  const id = token ? token.slice('--id='.length) : defaultId();
  if(!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(id)) throw new Error('Preview id must be 3-64 letters, numbers, dots, dashes, or underscores');
  return id;
}

const require = createRequire(import.meta.url);
const vitePackage = require.resolve('vite/package.json');
const viteBin = path.join(path.dirname(vitePackage), 'bin', 'vite.js');
if(!existsSync(process.execPath)) throw new Error(`Pinned Node executable is missing: ${process.execPath}`);
if(!existsSync(viteBin)) throw new Error(`Pinned Vite executable is missing: ${viteBin}`);

function runVite({ root, config, outDir, label }){
  const args = [viteBin, 'build', '--config', config, '--outDir', outDir, '--emptyOutDir'];
  process.stdout.write(`\n[preview] ${label}\n`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if(result.stdout) process.stdout.write(result.stdout);
  if(result.stderr) process.stderr.write(result.stderr);
  if(result.error) throw result.error;
  if(result.status !== 0) throw new Error(`${label} failed with status ${result.status}`);
}

const id = readId();
const finalDir = path.join(OUTPUT_ROOT, id);
const stageDir = path.join(OUTPUT_ROOT, `.stage-${id}-${process.pid}`);
if(existsSync(finalDir)) throw new Error(`Preview already exists and will not be overwritten: ${finalDir}`);
if(existsSync(stageDir)) throw new Error(`Unexpected staging path already exists: ${stageDir}`);

mkdirSync(OUTPUT_ROOT, { recursive: true });
mkdirSync(stageDir);
const officialBefore = officialManifest();
const referenceBefore = referenceManifest();

try {
  runVite({
    root: path.join(ROOT, 'preview'),
    config: path.join(ROOT, 'preview', 'vite.config.js'),
    outDir: stageDir,
    label: 'launcher',
  });
  runVite({
    root: path.join(ROOT, 'golf'),
    config: path.join(ROOT, 'golf', 'vite.config.js'),
    outDir: path.join(stageDir, 'golf'),
    label: 'Stackyard Golf',
  });
  runVite({
    root: path.join(ROOT, 'runner'),
    config: path.join(ROOT, 'runner', 'vite.config.js'),
    outDir: path.join(stageDir, 'runner'),
    label: 'Gridlock Run',
  });
  runVite({
    root: path.join(ROOT, 'ashfall'),
    config: path.join(ROOT, 'ashfall', 'vite.config.js'),
    outDir: path.join(stageDir, 'ashfall'),
    label: 'Ashfall',
  });
  runVite({
    root: path.join(ROOT, 'wings'),
    config: path.join(ROOT, 'wings', 'vite.config.js'),
    outDir: path.join(stageDir, 'wings'),
    label: 'Paper Wings',
  });
  runVite({
    root: path.join(ROOT, 'tide'),
    config: path.join(ROOT, 'tide', 'vite.config.js'),
    outDir: path.join(stageDir, 'tide'),
    label: 'Low Tide',
  });

  const previewFiles = ['index.html', 'golf/index.html', 'runner/index.html', 'ashfall/index.html', 'wings/index.html', 'tide/index.html'];
  for(const relative of previewFiles){
    const target = path.join(stageDir, relative);
    if(!existsSync(target) || readFileSync(target).length < 1000) throw new Error(`Preview artifact is missing or empty: ${relative}`);
  }
  const officialAfter = assertOfficialUnchanged(officialBefore);
  const referenceAfter = assertReferenceUnchanged(referenceBefore);
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    node: { executable: process.execPath, sha256: hashFile(process.execPath) },
    vite: { executable: viteBin, sha256: hashFile(viteBin) },
    files: Object.fromEntries(previewFiles.map(relative => [relative, hashFile(path.join(stageDir, relative))])),
    officialBefore,
    officialAfter,
    referenceBefore,
    referenceAfter,
  };
  writeFileSync(path.join(stageDir, 'preview.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  renameSync(stageDir, finalDir);
  process.stdout.write(`\nPREVIEW_READY ${id}\n${finalDir}\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} catch(error){
  try { assertOfficialUnchanged(officialBefore); } catch(officialError){
    error.message += `\n${officialError.message}`;
  }
  try { assertReferenceUnchanged(referenceBefore); } catch(referenceError){
    error.message += `\n${referenceError.message}`;
  }
  if(existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: false });
  throw error;
}
