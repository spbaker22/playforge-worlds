import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const sha256FileSync = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function regularExecutable(file, label){
  assert.equal(path.isAbsolute(file), true, `${label} must be absolute`);
  const status = lstatSync(file);
  assert.equal(status.isFile(), true, `${label} must be a regular file`);
  assert.equal(status.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.notEqual(status.mode & 0o111, 0, `${label} must be executable`);
  return status;
}

function regularFile(file, label){
  assert.equal(path.isAbsolute(file), true, `${label} must be absolute`);
  const status = lstatSync(file);
  assert.equal(status.isFile(), true, `${label} must be a regular file`);
  assert.equal(status.isSymbolicLink(), false, `${label} must not be a symlink`);
  return status;
}

const identity = status => Object.freeze({
  dev: String(status.dev),
  ino: String(status.ino),
  size: status.size,
  mode: status.mode,
  mtimeMs: status.mtimeMs,
  birthtimeMs: status.birthtimeMs,
});

function assertSameIdentity(actual, expected, label){
  assert.deepEqual(identity(actual), expected, `${label} file identity changed`);
}

/**
 * Capture the Node executable and the npm CLI shipped beside that exact Node
 * installation. Release phases use direct Node entry points, but validating
 * npm_execpath prevents an inherited package-manager shim from becoming an
 * ambient authority and gives direct-node invocations a deterministic fallback.
 */
export function capturePinnedRuntimeSync({
  execPath = process.execPath,
  environment = process.env,
} = {}){
  assert.equal(path.isAbsolute(execPath), true, 'process.execPath must be absolute');
  const nodePath = realpathSync(execPath);
  const nodeStatus = regularExecutable(nodePath, 'pinned Node runtime');
  const runtimeRoot = path.resolve(path.dirname(nodePath), '..');
  const derivedNpm = path.join(runtimeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmCliPath = realpathSync(derivedNpm);
  assert.equal(path.relative(runtimeRoot, npmCliPath).startsWith(`..${path.sep}`), false,
    'derived npm CLI escaped the pinned Node runtime');
  const npmStatus = regularFile(npmCliPath, 'derived npm CLI');
  const npmSha256 = sha256FileSync(npmCliPath);

  const inheritedNpm = environment.npm_execpath;
  let npmSource = 'derived-direct-node-fallback';
  if(inheritedNpm !== undefined && inheritedNpm !== ''){
    assert.equal(path.isAbsolute(inheritedNpm), true, 'npm_execpath must be absolute');
    regularFile(inheritedNpm, 'npm_execpath');
    const inheritedRealpath = realpathSync(inheritedNpm);
    assert.equal(inheritedRealpath, npmCliPath,
      'npm_execpath must resolve to the npm CLI shipped with process.execPath');
    assert.equal(sha256FileSync(inheritedRealpath), npmSha256, 'npm_execpath hash mismatch');
    npmSource = 'validated-npm-invocation';
  }
  const inheritedNode = environment.npm_node_execpath;
  if(inheritedNode !== undefined && inheritedNode !== ''){
    assert.equal(path.isAbsolute(inheritedNode), true, 'npm_node_execpath must be absolute');
    regularExecutable(realpathSync(inheritedNode), 'npm_node_execpath');
    assert.equal(realpathSync(inheritedNode), nodePath,
      'npm_node_execpath must resolve to process.execPath');
  }

  return Object.freeze({
    nodePath,
    nodeSha256: sha256FileSync(nodePath),
    nodeIdentity: identity(nodeStatus),
    npmCliPath,
    npmSha256,
    npmIdentity: identity(npmStatus),
    npmSource,
    safePath: `${path.dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  });
}

export function assertPinnedRuntimeUnchangedSync(runtime){
  assert.ok(runtime && typeof runtime === 'object', 'pinned runtime is required');
  assert.equal(realpathSync(runtime.nodePath), runtime.nodePath, 'pinned Node realpath changed');
  assertSameIdentity(regularExecutable(runtime.nodePath, 'pinned Node runtime'),
    runtime.nodeIdentity, 'pinned Node runtime');
  assert.equal(sha256FileSync(runtime.nodePath), runtime.nodeSha256, 'pinned Node runtime bytes changed');
  assert.equal(realpathSync(runtime.npmCliPath), runtime.npmCliPath, 'pinned npm CLI realpath changed');
  assertSameIdentity(regularFile(runtime.npmCliPath, 'pinned npm CLI'),
    runtime.npmIdentity, 'pinned npm CLI');
  assert.equal(sha256FileSync(runtime.npmCliPath), runtime.npmSha256, 'pinned npm CLI bytes changed');
  return runtime;
}
