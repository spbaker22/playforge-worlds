import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LEGACY_IDS = Object.freeze([
  'previewMenu',
  'previewSheet',
  'previewReset',
  'previewSound',
  'previewQuality',
  'previewToggle',
]);

const sourceFiles = [
  path.join(ROOT, 'wings', 'index.html'),
  ...readdirSync(path.join(ROOT, 'wings', 'src'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.join(ROOT, 'wings', 'src', entry.name)),
];
const artifacts = process.argv.slice(2).map(value => path.resolve(process.cwd(), value));

for(const file of [...sourceFiles, ...artifacts]){
  const contents = readFileSync(file, 'utf8');
  for(const id of LEGACY_IDS){
    assert.equal(contents.includes(id), false, `${path.relative(ROOT, file)} still contains obsolete legacy preview id ${id}`);
  }
}

process.stdout.write(`WINGS_LEGACY_CHROME_OK ${sourceFiles.length + artifacts.length} files\n`);
