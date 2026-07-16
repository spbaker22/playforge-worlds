import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const FROZEN_PHASE4_SOURCE_HASHES = Object.freeze({
  'runner/src/course.js': 'b1fd096f0e0461cbf170b3225c3b49eb8991f006641d0fd19122431594535e2c',
  'runner/src/sim.js': 'e439c8de6f5a105d03e4b235771553c05ed0b3097c165e5c98f627dfdbedba95',
  'runner/src/flow.js': '809f563a6a2b47f5d8f4867697f68bbc56f126af0f02f06ffaae5d97c8e74b72',
  'runner/src/action.js': 'd920c38bf295d6aeb937ad4855ec6fc7e03b82edb0d8262ff59a5a07f84294a8',
  'engine/atmo.js': '54ca50e7fc05dcd24998be5af0e2e3ae78311a32a906dc3374564b4334b80f8c',
  'engine/base.css': 'd03673b51844990dc61833203757022d3e5357dec9fa8f45d1a117b4d4174cd0',
  'engine/cam.js': '7fa8381a21a46443548e2a7480f626dc5759775e830e546f628ca36703125541',
  'engine/fixed-step.js': 'a12fb23e0b611f05c9c875571550a0024e0ecf3a7a1d34124ab1f396cd2905c9',
  'engine/fx.js': '4f4815c816f9ee420772e3beb630442dceb54f79932d5a85d477200cee90867a',
  'engine/gesture.js': 'b4956aebd2c8d69b645ceb61ef261181c795b49444fe35e16ddb8398c941a68c',
  'engine/mode.js': 'e994c1863729f150866b9d5b82dcad7e47fc90581136044fb5e26cae5124a03d',
  'engine/post.js': 'f6726bd3fcca0f785fdf48e3eec92ee8bc34cd1ac08cbcd54389d43e63ffb103',
  'engine/screen.js': 'c232854e05965e9b0350587bd9284c260a59a01e41b0a637bed0be2fa3615d72',
  'engine/sfx.js': 'd0ee84ec0560d9837875736193202bd98ec33bf0cb33efa9f72154f607232ab6',
  'engine/touch.js': '839f24c00965a0ad06169888021f61dbc05fed8033fecb7432b22555836c7b15',
  'engine/trace.js': '619aa9bc0545b80d4171e3d64328e9856e6d038047919206cde179ebcda2144e',
  'engine/util.js': 'ef46e485804086509b55b34fa02767b14fd04c5b61b144b34e3766e9d0a0a285',
});

export async function verifyFrozenPhase4Sources(root){
  const observed = {};
  for(const [relativePath, expected] of Object.entries(FROZEN_PHASE4_SOURCE_HASHES)){
    const actual = createHash('sha256').update(await readFile(path.join(root, relativePath))).digest('hex');
    assert.equal(actual, expected, `frozen source changed: ${relativePath}`);
    observed[relativePath] = actual;
  }
  return observed;
}

const BUILD_INPUT_DIRECTORIES = Object.freeze(['engine', 'runner/src', 'golf/src']);
const BUILD_INPUT_FILES = Object.freeze([
  'runner/index.html',
  'runner/vite.config.js',
  'golf/index.html',
  'golf/vite.config.js',
  'package.json',
  'package-lock.json',
]);

async function regularInputManifestRow(root, relativePath){
  const absolute = path.join(root, relativePath);
  const status = await lstat(absolute);
  assert.equal(status.isSymbolicLink(), false, `build input must not be a symlink: ${relativePath}`);
  assert.equal(status.isFile(), true, `build input must be a regular file: ${relativePath}`);
  const bytes = await readFile(absolute);
  return {
    path: relativePath.split(path.sep).join('/'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function recursiveInputFiles(root, relativeDirectory){
  const absolute = path.join(root, relativeDirectory);
  const status = await lstat(absolute);
  assert.equal(status.isSymbolicLink(), false, `build input directory must not be a symlink: ${relativeDirectory}`);
  assert.equal(status.isDirectory(), true, `build input directory is missing: ${relativeDirectory}`);
  const files = [];
  for(const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))){
    const relativePath = path.join(relativeDirectory, entry.name);
    if(entry.isDirectory()) files.push(...await recursiveInputFiles(root, relativePath));
    else if(entry.isFile()) files.push(relativePath);
    else throw new Error(`unsupported build input entry: ${relativePath}`);
  }
  return files;
}

/** Complete Vite input generation for both games, including add/remove drift. */
export async function buildPhase4InputManifest(root){
  const discovered = [];
  for(const directory of BUILD_INPUT_DIRECTORIES){
    discovered.push(...await recursiveInputFiles(root, directory));
  }
  discovered.push(...BUILD_INPUT_FILES);
  const unique = [...new Set(discovered)].sort();
  assert.equal(unique.length, discovered.length, 'duplicate Phase 4 build input path');
  const files = [];
  for(const relativePath of unique) files.push(await regularInputManifestRow(root, relativePath));
  return { version: 1, files };
}

export async function assertPhase4InputManifestUnchanged(root, expected, label = 'Phase 4 build inputs'){
  const observed = await buildPhase4InputManifest(root);
  assert.deepEqual(observed, expected, `${label} changed after candidate build`);
  return observed;
}

function recursiveInputFilesSync(root, relativeDirectory){
  const absolute = path.join(root, relativeDirectory);
  const status = lstatSync(absolute);
  assert.equal(status.isSymbolicLink(), false, `build input directory must not be a symlink: ${relativeDirectory}`);
  assert.equal(status.isDirectory(), true, `build input directory is missing: ${relativeDirectory}`);
  const files = [];
  for(const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))){
    const relativePath = path.join(relativeDirectory, entry.name);
    if(entry.isDirectory()) files.push(...recursiveInputFilesSync(root, relativePath));
    else if(entry.isFile()) files.push(relativePath);
    else throw new Error(`unsupported build input entry: ${relativePath}`);
  }
  return files;
}

export function buildPhase4InputManifestSync(root){
  const discovered = [];
  for(const directory of BUILD_INPUT_DIRECTORIES){
    discovered.push(...recursiveInputFilesSync(root, directory));
  }
  discovered.push(...BUILD_INPUT_FILES);
  const unique = [...new Set(discovered)].sort();
  assert.equal(unique.length, discovered.length, 'duplicate Phase 4 build input path');
  const files = unique.map(relativePath => {
    const absolute = path.join(root, relativePath);
    const status = lstatSync(absolute);
    assert.equal(status.isSymbolicLink(), false, `build input must not be a symlink: ${relativePath}`);
    assert.equal(status.isFile(), true, `build input must be a regular file: ${relativePath}`);
    const bytes = readFileSync(absolute);
    return {
      path: relativePath.split(path.sep).join('/'),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  return { version: 1, files };
}

export function assertPhase4InputManifestUnchangedSync(root, expected, label = 'Phase 4 build inputs'){
  const observed = buildPhase4InputManifestSync(root);
  assert.deepEqual(observed, expected, `${label} changed after candidate build`);
  return observed;
}
