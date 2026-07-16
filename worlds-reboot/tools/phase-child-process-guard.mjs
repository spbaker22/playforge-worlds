import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import {
  TRUSTED_DESCENDANT_NODE_OPTION,
  TRUSTED_GATE_MODULE_URL,
  assertFreshSpawnGateLaunchToken,
  beginFreshSpawnGateLaunch,
  cancelFreshSpawnGateLaunch,
  completeFreshSpawnGateLaunch,
} from './phase-spawn-capability.mjs';
import {
  decodePhaseNodeCommand,
  PHASE_NODE_COMMAND_PATH,
} from './phase-node-command-spec.mjs';

// This preload executes before phase target code. The symbol is deliberately
// closure-private: only the validated public spawn wrapper can authorize the
// prototype backstop to preserve detached:true for a gated Node child.
const GATED_DETACH_AUTHORITY = Symbol('playforge-gated-detach-authority');
const RECURSIVE_DESCENDANT_MARKER = process.env.PLAYFORGE_INTERNAL_DESCENDANT_MARKER;
const RECURSIVE_RECOVERY_ANCESTOR = process.env.PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER;
assert.match(RECURSIVE_DESCENDANT_MARKER || '', /^[A-Za-z0-9:_-]{8,220}$/,
  'child-process guard descendant marker');
assert.match(RECURSIVE_RECOVERY_ANCESTOR || '', /^[A-Za-z0-9:_-]{8,220}$/,
  'child-process guard recovery ancestor marker');
assert.equal(process.env.NODE_OPTIONS, TRUSTED_DESCENDANT_NODE_OPTION,
  'child-process guard requires the trusted recursive marker preload');
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const original = Object.freeze({
  prototypeSpawn: childProcess.ChildProcess.prototype.spawn,
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync,
  exec: childProcess.exec,
  execSync: childProcess.execSync,
  execFile: childProcess.execFile,
  execFileSync: childProcess.execFileSync,
  fork: childProcess.fork,
});

function cloneDetachedFalse(options){
  assert.ok(options === undefined || options === null || typeof options === 'object',
    'child process options');
  const environment = recursiveChildEnvironment(rawEnvironment(options));
  return { ...(options || {}), env: environment, detached: false };
}

function splitArgsAndOptions(args, options, arity){
  if(Array.isArray(args)) return { args, callArgs: args, options, argsPresent: true };
  if((args === null || args === undefined) && arity >= 3){
    return { args: [], callArgs: args, options, argsPresent: true };
  }
  return { args: [], callArgs: null, options: args, argsPresent: false };
}

function gateArgumentShape(args){
  if(!Array.isArray(args)) return null;
  const title = args[0];
  if(typeof title !== 'string' || !title.startsWith('--title=')) return null;
  const descendantMarker = title.slice('--title='.length);
  if(!/^[A-Za-z0-9:_-]{8,220}$/.test(descendantMarker)) return null;
  if(args[1] !== '--import' || args[2] !== TRUSTED_GATE_MODULE_URL) return null;
  if(args.length !== 6 || args[3] !== '--' || args[4] !== PHASE_NODE_COMMAND_PATH) return null;
  const commandPayload = args[5];
  if(!/^[A-Za-z0-9_-]{1,32768}$/.test(commandPayload || '')) return null;
  decodePhaseNodeCommand(commandPayload);
  return { descendantMarker, commandPayload };
}

function hasGateIntent(args, environment){
  if(Array.isArray(args) && args.some((argument, index) =>
    argument === `--import=${TRUSTED_GATE_MODULE_URL}`
      || (argument === TRUSTED_GATE_MODULE_URL && args[index - 1] === '--import'))) return true;
  return environment.PLAYFORGE_INTERNAL_SPAWN_GATE_FD !== undefined
    || environment.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE !== undefined;
}

function rawEnvironment(options){
  const environment = options?.env || process.env;
  assert.ok(environment && typeof environment === 'object', 'spawn environment');
  return environment;
}

function sensitiveEnvironment(environment){
  const values = {};
  const wanted = new Set([
    'NODE_OPTIONS',
    'PLAYFORGE_INTERNAL_DESCENDANT_MARKER',
    'PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER',
    'PLAYFORGE_INTERNAL_SPAWN_GATE_FD',
    'PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE',
  ]);
  for(const [name, value] of Object.entries(environment)){
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    if(!wanted.has(key)) continue;
    assert.equal(Object.hasOwn(values, key), false, `duplicate spawn environment ${key}`);
    values[key] = value === undefined ? undefined : String(value);
  }
  return values;
}

function recursiveChildEnvironment(environment){
  const snapshot = { ...environment };
  const sensitive = sensitiveEnvironment(snapshot);
  assert.equal(sensitive.PLAYFORGE_INTERNAL_SPAWN_GATE_FD, undefined,
    'ordinary child environment carried spawn gate fd authority');
  assert.equal(sensitive.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE, undefined,
    'ordinary child environment carried spawn gate nonce authority');
  assert.ok(sensitive.NODE_OPTIONS === undefined || sensitive.NODE_OPTIONS === ''
    || sensitive.NODE_OPTIONS === TRUSTED_DESCENDANT_NODE_OPTION,
  'ordinary child refuses conflicting NODE_OPTIONS executable authority');
  assert.ok(sensitive.PLAYFORGE_INTERNAL_DESCENDANT_MARKER === undefined
    || sensitive.PLAYFORGE_INTERNAL_DESCENDANT_MARKER === ''
    || sensitive.PLAYFORGE_INTERNAL_DESCENDANT_MARKER === RECURSIVE_DESCENDANT_MARKER,
  'ordinary child refuses a conflicting descendant marker');
  assert.ok(sensitive.PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER === undefined
    || sensitive.PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER === ''
    || sensitive.PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER === RECURSIVE_RECOVERY_ANCESTOR,
  'ordinary child refuses a conflicting recovery ancestor marker');
  snapshot.NODE_OPTIONS = TRUSTED_DESCENDANT_NODE_OPTION;
  snapshot.PLAYFORGE_INTERNAL_DESCENDANT_MARKER = RECURSIVE_DESCENDANT_MARKER;
  snapshot.PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER = RECURSIVE_RECOVERY_ANCESTOR;
  return snapshot;
}

function environmentPairs(pairs){
  assert.ok(Array.isArray(pairs), 'normalized spawn envPairs');
  const environment = {};
  const wanted = new Set([
    'NODE_OPTIONS',
    'PLAYFORGE_INTERNAL_DESCENDANT_MARKER',
    'PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER',
    'PLAYFORGE_INTERNAL_SPAWN_GATE_FD',
    'PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE',
  ]);
  for(const pair of pairs){
    assert.equal(typeof pair, 'string', 'normalized spawn environment pair');
    const separator = pair.indexOf('=');
    if(separator < 1) continue;
    const rawName = pair.slice(0, separator);
    const name = process.platform === 'win32' ? rawName.toUpperCase() : rawName;
    if(!wanted.has(name)) continue;
    assert.equal(Object.hasOwn(environment, name), false, `duplicate spawn environment ${name}`);
    environment[name] = pair.slice(separator + 1);
  }
  return environment;
}

function recursiveEnvironmentPairs(pairs){
  const snapshot = [...pairs];
  const sensitive = environmentPairs(snapshot);
  assert.equal(sensitive.PLAYFORGE_INTERNAL_SPAWN_GATE_FD, undefined,
    'ordinary normalized child environment carried spawn gate fd authority');
  assert.equal(sensitive.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE, undefined,
    'ordinary normalized child environment carried spawn gate nonce authority');
  assert.ok(sensitive.NODE_OPTIONS === undefined || sensitive.NODE_OPTIONS === ''
    || sensitive.NODE_OPTIONS === TRUSTED_DESCENDANT_NODE_OPTION,
  'ordinary normalized child refuses conflicting NODE_OPTIONS executable authority');
  assert.ok(sensitive.PLAYFORGE_INTERNAL_DESCENDANT_MARKER === undefined
    || sensitive.PLAYFORGE_INTERNAL_DESCENDANT_MARKER === ''
    || sensitive.PLAYFORGE_INTERNAL_DESCENDANT_MARKER === RECURSIVE_DESCENDANT_MARKER,
  'ordinary normalized child refuses a conflicting descendant marker');
  assert.ok(sensitive.PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER === undefined
    || sensitive.PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER === ''
    || sensitive.PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER === RECURSIVE_RECOVERY_ANCESTOR,
  'ordinary normalized child refuses a conflicting recovery ancestor marker');
  const filtered = snapshot.filter(pair => {
    const separator = pair.indexOf('=');
    const rawName = separator < 0 ? pair : pair.slice(0, separator);
    const name = process.platform === 'win32' ? rawName.toUpperCase() : rawName;
    return name !== 'NODE_OPTIONS'
      && name !== 'PLAYFORGE_INTERNAL_DESCENDANT_MARKER'
      && name !== 'PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER';
  });
  filtered.push(
    `NODE_OPTIONS=${TRUSTED_DESCENDANT_NODE_OPTION}`,
    `PLAYFORGE_INTERNAL_DESCENDANT_MARKER=${RECURSIVE_DESCENDANT_MARKER}`,
    `PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER=${RECURSIVE_RECOVERY_ANCESTOR}`,
  );
  return filtered;
}

function assertGateEnvironment(environment, shape){
  assert.equal(environment.NODE_OPTIONS, undefined,
    'detached gated Node refuses NODE_OPTIONS executable authority');
  assert.equal(environment.PLAYFORGE_INTERNAL_SPAWN_GATE_FD, '3',
    'detached gated Node requires gate fd 3');
  assert.match(environment.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE || '', /^[0-9a-f]{48}$/,
    'detached gated Node nonce');
  assert.equal(environment.PLAYFORGE_INTERNAL_DESCENDANT_MARKER, shape.descendantMarker,
    'detached gated Node title/marker mismatch');
  assert.match(environment.PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER || '',
    /^[A-Za-z0-9:_-]{8,220}$/, 'detached gated Node recovery ancestor marker');
  assert.ok(shape.descendantMarker.includes(environment.PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER),
    'detached gated Node title omitted its recovery ancestor marker');
}

function assertGateStdio(stdio){
  assert.ok(Array.isArray(stdio) && stdio.length > 4
    && stdio[3] === 'pipe' && stdio[4] === 'ipc',
  'detached gated Node requires a dedicated fd 3 pipe and supervisor IPC');
}

function guardedSpawnOptions(file, args, options){
  assert.ok(options === undefined || options === null || typeof options === 'object',
    'spawn options');
  const requestedDetached = options?.detached === true;
  const environmentSnapshot = { ...rawEnvironment(options) };
  const environment = sensitiveEnvironment(environmentSnapshot);
  const shape = gateArgumentShape(args);
  const gateIntent = Boolean(shape) || hasGateIntent(args, environment);
  if(!gateIntent || options?.shell){
    assert.equal(hasGateIntent([], environment), false,
      'ordinary spawn carried gated Node environment authority');
    return {
      options: {
        ...(options || {}),
        env: recursiveChildEnvironment(environmentSnapshot),
        detached: false,
      },
      token: null,
    };
  }
  assert.ok(shape, 'malformed gated Node invocation');
  assert.equal(file, process.execPath,
    'gated launch requires exact process.execPath');
  assert.ok(options?.shell === undefined || options.shell === false,
    'gated Node launch cannot use a shell');
  assertGateEnvironment(environment, shape);
  assertGateStdio(options?.stdio);
  const token = beginFreshSpawnGateLaunch({
    nonce: environment.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE,
    fd: Number(environment.PLAYFORGE_INTERNAL_SPAWN_GATE_FD),
    descendantMarker: environment.PLAYFORGE_INTERNAL_DESCENDANT_MARKER,
    commandPayload: shape.commandPayload,
  });
  try {
    const guarded = {
      ...(options || {}),
      env: environmentSnapshot,
      detached: requestedDetached,
    };
    Object.defineProperty(guarded, GATED_DETACH_AUTHORITY, {
      value: token,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    return { options: guarded, token };
  } catch(error){
    cancelFreshSpawnGateLaunch(token);
    throw error;
  }
}

function assertNormalizedGateAuthority(options, token){
  assert.equal(options.file, process.execPath,
    'normalized detached gated launch changed process.execPath');
  const shape = gateArgumentShape(options.args?.slice(1));
  assert.ok(shape, 'normalized detached gated launch changed trusted argv');
  const environment = environmentPairs(options.envPairs);
  assertGateEnvironment(environment, shape);
  assertGateStdio(options.stdio);
  assert.equal(token.nonce, environment.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE,
    'normalized detached gated launch changed nonce');
  assert.equal(token.commandPayload, shape.commandPayload,
    'normalized gated launch changed command payload');
  assertFreshSpawnGateLaunchToken(token, {
    nonce: environment.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE,
    fd: Number(environment.PLAYFORGE_INTERNAL_SPAWN_GATE_FD),
    descendantMarker: environment.PLAYFORGE_INTERNAL_DESCENDANT_MARKER,
    commandPayload: shape.commandPayload,
  });
}

function guardedPrototypeSpawn(options){
  assert.ok(options && typeof options === 'object', 'ChildProcess spawn options');
  const token = options[GATED_DETACH_AUTHORITY];
  if(!token){
    const sourcePairs = options.envPairs === undefined
      ? Object.entries(process.env).map(([name, value]) => `${name}=${value}`)
      : options.envPairs;
    return original.prototypeSpawn.call(this, {
      ...options,
      envPairs: recursiveEnvironmentPairs(sourcePairs),
      detached: false,
    });
  }
  try {
    // Snapshot every authority-bearing nested value, then validate the exact
    // plain copies passed to native spawn. Getters/Proxies cannot change argv,
    // envPairs, fd 3, or the IPC descriptor between validation and native spawn.
    const args = [...options.args];
    const envPairs = [...options.envPairs];
    const stdio = [...options.stdio];
    const nativeOptions = {
      ...options,
      file: options.file,
      args,
      envPairs,
      stdio,
      detached: options.detached === true,
    };
    delete nativeOptions[GATED_DETACH_AUTHORITY];
    assertNormalizedGateAuthority(nativeOptions, token);
    const result = original.prototypeSpawn.call(this, nativeOptions);
    if(Number.isSafeInteger(this.pid) && this.pid > 0) completeFreshSpawnGateLaunch(token, this.pid);
    else cancelFreshSpawnGateLaunch(token);
    return result;
  } catch(error){
    cancelFreshSpawnGateLaunch(token);
    throw error;
  }
}

function spawn(file, args, options){
  const split = splitArgsAndOptions(args, options, arguments.length);
  const guarded = guardedSpawnOptions(file, split.args, split.options);
  try {
    return split.argsPresent
      ? original.spawn(file, split.callArgs, guarded.options)
      : original.spawn(file, guarded.options);
  } catch(error){
    if(guarded.token) cancelFreshSpawnGateLaunch(guarded.token);
    throw error;
  }
}

function spawnSync(file, args, options){
  const split = splitArgsAndOptions(args, options, arguments.length);
  const environment = sensitiveEnvironment(rawEnvironment(split.options));
  const shape = gateArgumentShape(split.args);
  if(shape || hasGateIntent(split.args, environment)){
    throw new Error('synchronous gated Node cannot prove capture before GO');
  }
  const guarded = cloneDetachedFalse(split.options);
  return split.argsPresent
    ? original.spawnSync(file, split.callArgs, guarded)
    : original.spawnSync(file, guarded);
}

function exec(command, options, callback){
  if(typeof options === 'function') return original.exec(command, cloneDetachedFalse(undefined), options);
  return original.exec(command, cloneDetachedFalse(options), callback);
}

function execSync(command, options){
  return original.execSync(command, cloneDetachedFalse(options));
}

function execFile(file, args, options, callback){
  if(Array.isArray(args)){
    if(typeof options === 'function'){
      return original.execFile(file, args, cloneDetachedFalse(undefined), options);
    }
    const environment = sensitiveEnvironment(rawEnvironment(options));
    if(gateArgumentShape(args) || hasGateIntent(args, environment)){
      throw new Error('gated Node is allowed only through public spawn');
    }
    return original.execFile(file, args, cloneDetachedFalse(options), callback);
  }
  if((args === null || args === undefined) && arguments.length >= 3){
    if(typeof options === 'function'){
      return original.execFile(file, args, cloneDetachedFalse(undefined), options);
    }
    const environment = sensitiveEnvironment(rawEnvironment(options));
    if(hasGateIntent([], environment)) throw new Error('gated Node is allowed only through public spawn');
    return original.execFile(file, args, cloneDetachedFalse(options), callback);
  }
  if(typeof args === 'function') return original.execFile(file, cloneDetachedFalse(undefined), args);
  if(args === undefined && arguments.length < 3){
    return original.execFile(file, cloneDetachedFalse(undefined), options);
  }
  const environment = sensitiveEnvironment(rawEnvironment(args));
  if(hasGateIntent([], environment)){
    throw new Error('gated Node is allowed only through public spawn');
  }
  return original.execFile(file, cloneDetachedFalse(args), options);
}

function execFileSync(file, args, options){
  const split = splitArgsAndOptions(args, options, arguments.length);
  const environment = sensitiveEnvironment(rawEnvironment(split.options));
  if(gateArgumentShape(split.args) || hasGateIntent(split.args, environment)){
    throw new Error('synchronous gated Node cannot prove capture before GO');
  }
  const guarded = cloneDetachedFalse(split.options);
  return split.argsPresent
    ? original.execFileSync(file, split.callArgs, guarded)
    : original.execFileSync(file, guarded);
}

function fork(modulePath, args, options){
  const split = splitArgsAndOptions(args, options, arguments.length);
  const environment = sensitiveEnvironment(rawEnvironment(split.options));
  if(hasGateIntent(split.args, environment)){
    throw new Error('gated Node is allowed only through public spawn');
  }
  const guarded = cloneDetachedFalse(split.options);
  return split.argsPresent
    ? original.fork(modulePath, split.callArgs, guarded)
    : original.fork(modulePath, guarded);
}

function guardedPromisifyCustom(wrapper){
  const custom = (...args) => {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    promise.child = wrapper(...args, (error, stdout, stderr) => {
      if(error !== null){
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    return promise;
  };
  // util.promisify defines its own custom symbol on the returned function on
  // every lookup, so this function must remain extensible. The guarded exec
  // wrapper and its custom-property descriptor are frozen below.
  return custom;
}

Object.defineProperty(exec, promisify.custom, {
  value: guardedPromisifyCustom(exec),
  enumerable: false,
  writable: false,
  configurable: false,
});
Object.defineProperty(execFile, promisify.custom, {
  value: guardedPromisifyCustom(execFile),
  enumerable: false,
  writable: false,
  configurable: false,
});
for(const wrapper of [spawn, spawnSync, exec, execSync, execFile, execFileSync, fork, guardedPrototypeSpawn]){
  Object.freeze(wrapper);
}

Object.defineProperty(childProcess.ChildProcess.prototype, 'spawn', {
  value: guardedPrototypeSpawn,
  enumerable: true,
  writable: false,
  configurable: false,
});
for(const [name, value] of Object.entries({
  spawn,
  spawnSync,
  exec,
  execSync,
  execFile,
  execFileSync,
  fork,
})){
  Object.defineProperty(childProcess, name, {
    value,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}

// Built-in ESM named bindings otherwise retain the pre-patch CJS values.
syncBuiltinESMExports();
