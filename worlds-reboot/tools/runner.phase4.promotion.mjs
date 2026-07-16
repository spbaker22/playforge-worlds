import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  chmod,
  chown,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

export const PHASE4_SHOT_VIEWPORTS = Object.freeze({
  '1366x1024': Object.freeze({ width: 1366, height: 1024 }),
  '1024x768': Object.freeze({ width: 1024, height: 768 }),
});
export const PHASE4_SHOT_NAMES = Object.freeze([
  'opening', 'hero-s14', 'gameplay-s60', 'slide-s90-92', 'genuine-recovery', 'finish',
]);
export const PHASE4_BOARD_SIZE = Object.freeze({ width: 1440, height: 900 });
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROMOTION_JOURNAL_NAME = '.phase4-promotion-journal.json';
const PROMOTION_JOURNAL_PENDING_NAME = '.phase4-promotion-journal.pending.json';
const MACOS_XATTR = '/usr/bin/xattr';
const MACOS_LS = '/bin/ls';
const MACOS_STAT = '/usr/bin/stat';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function exactKeys(value, expected, label){
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has missing or extra keys`);
}

/** Strictly bind reported promoted parity to independently hashed fresh builds. */
export function validateStrictParityReport(parity, trustedFreshHashes){
  exactKeys(parity, ['skipped', 'runner', 'golf'], 'release parity');
  assert.equal(parity.skipped, false, 'release parity must explicitly run');
  exactKeys(trustedFreshHashes, ['runner', 'golf'], 'trusted fresh hashes');
  const surfaces = ['fresh', 'dist', 'standalone', 'localhost', 'lan'];
  const normalized = {};
  for(const world of ['runner', 'golf']){
    exactKeys(parity[world], surfaces, `${world} parity`);
    const row = {};
    for(const surface of surfaces){
      const hash = parity[world][surface];
      assert.equal(typeof hash, 'string', `${world} ${surface} hash must be a string`);
      assert.match(hash, SHA256_PATTERN, `${world} ${surface} hash must be lowercase SHA-256`);
      row[surface] = hash;
    }
    assert.match(trustedFreshHashes[world], SHA256_PATTERN, `${world} trusted fresh hash`);
    assert.equal(row.fresh, trustedFreshHashes[world], `${world} report fresh hash is stale or untrusted`);
    for(const surface of surfaces.slice(1)){
      assert.equal(row[surface], row.fresh, `${world} ${surface} does not equal fresh`);
    }
    normalized[world] = row;
  }
  return normalized;
}

export function validateCandidateHashChain(candidateFresh, trustedFreshHashes, gameplayTestedHashes = null){
  exactKeys(candidateFresh, ['runner', 'golf'], 'candidateFresh');
  exactKeys(trustedFreshHashes, ['runner', 'golf'], 'trusted fresh hashes');
  if(gameplayTestedHashes !== null) exactKeys(gameplayTestedHashes, ['runner', 'golf'], 'gameplay-tested hashes');
  const validated = {};
  for(const world of ['runner', 'golf']){
    assert.match(candidateFresh[world], SHA256_PATTERN, `${world} candidateFresh hash`);
    assert.match(trustedFreshHashes[world], SHA256_PATTERN, `${world} trusted fresh hash`);
    assert.equal(candidateFresh[world], trustedFreshHashes[world],
      `${world} worker candidateFresh does not match independently hashed artifact`);
    if(gameplayTestedHashes){
      assert.match(gameplayTestedHashes[world], SHA256_PATTERN, `${world} gameplay-tested hash`);
      assert.equal(candidateFresh[world], gameplayTestedHashes[world],
        `${world} Phase 4 candidate was not the gameplay-tested candidate`);
    }
    validated[world] = candidateFresh[world];
  }
  return validated;
}

export function validateBaselineOldReport(baselineOld){
  exactKeys(baselineOld, ['skipped', 'runner', 'golf'], 'baselineOld');
  assert.equal(baselineOld.skipped, false, 'release baselineOld must explicitly run');
  const validated = {};
  for(const world of ['runner', 'golf']){
    exactKeys(baselineOld[world], ['dist', 'standalone', 'localhost', 'lan'], `${world} baselineOld`);
    const authority = baselineOld[world].dist;
    assert.match(authority, SHA256_PATTERN, `${world} baselineOld dist hash`);
    for(const surface of ['standalone', 'localhost', 'lan']){
      assert.match(baselineOld[world][surface], SHA256_PATTERN, `${world} baselineOld ${surface} hash`);
      assert.equal(baselineOld[world][surface], authority,
        `${world} old baseline ${surface} does not match old dist`);
    }
    validated[world] = { ...baselineOld[world] };
  }
  return { skipped: false, ...validated };
}

export function validateDevSkipReport(skips){
  const names = ['parity', 'screenshots', 'frameBoard', 'replay', 'promotion'];
  exactKeys(skips, names, 'development skips');
  for(const name of names){
    exactKeys(skips[name], ['skipped', 'reason'], `development ${name} skip`);
    assert.equal(skips[name].skipped, true, `development ${name} must be skipped`);
    assert.equal(typeof skips[name].reason, 'string', `development ${name} skip reason`);
    assert.ok(skips[name].reason.trim(), `development ${name} skip reason must not be empty`);
  }
  return skips;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for(let value = 0; value < 256; value += 1){
    let crc = value;
    for(let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(parts){
  let crc = 0xffffffff;
  for(const part of parts){
    for(let index = 0; index < part.length; index += 1){
      crc = CRC_TABLE[(crc ^ part[index]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Parse chunks, verify every CRC, inflate the complete pixel stream, and
 * validate each scanline filter. This rejects signature-only and truncated
 * files while keeping decoding bounded to the exact expected raster size.
 */
export function decodeAndValidatePng(bytes, expected, label = 'PNG'){
  assert.ok(Buffer.isBuffer(bytes), `${label} must be a Buffer`);
  assert.ok(bytes.length >= 45, `${label} is truncated`);
  assert.equal(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), true, `${label} signature`);
  assert.ok(Number.isSafeInteger(expected?.width) && expected.width > 0, `${label} expected width`);
  assert.ok(Number.isSafeInteger(expected?.height) && expected.height > 0, `${label} expected height`);

  let offset = PNG_SIGNATURE.length;
  let ihdr = null;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;
  const compressed = [];
  while(offset < bytes.length){
    assert.ok(offset + 12 <= bytes.length, `${label} has a truncated chunk header`);
    const length = bytes.readUInt32BE(offset);
    assert.ok(length <= 64 * 1024 * 1024, `${label} chunk is unreasonably large`);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    assert.ok(crcOffset + 4 <= bytes.length, `${label} has a truncated chunk body`);
    const typeBytes = bytes.subarray(typeStart, dataStart);
    const type = typeBytes.toString('ascii');
    assert.match(type, /^[A-Za-z]{4}$/, `${label} chunk type`);
    const data = bytes.subarray(dataStart, dataEnd);
    assert.equal(bytes.readUInt32BE(crcOffset), crc32([typeBytes, data]), `${label} ${type} CRC mismatch`);

    if(type === 'IHDR'){
      assert.equal(offset, PNG_SIGNATURE.length, `${label} IHDR must be first`);
      assert.equal(ihdr, null, `${label} has duplicate IHDR`);
      assert.equal(length, 13, `${label} IHDR length`);
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], compression: data[10], filter: data[11], interlace: data[12],
      };
    } else if(type === 'IDAT'){
      assert.ok(ihdr, `${label} IDAT before IHDR`);
      assert.equal(idatEnded, false, `${label} IDAT chunks must be contiguous`);
      sawIdat = true;
      compressed.push(data);
    } else if(type === 'IEND'){
      assert.equal(length, 0, `${label} IEND length`);
      sawIend = true;
      offset = crcOffset + 4;
      assert.equal(offset, bytes.length, `${label} has trailing bytes after IEND`);
      break;
    } else if(sawIdat){
      idatEnded = true;
    }
    offset = crcOffset + 4;
  }

  assert.ok(ihdr, `${label} is missing IHDR`);
  assert.equal(sawIdat, true, `${label} is missing IDAT`);
  assert.equal(sawIend, true, `${label} is missing IEND`);
  assert.equal(ihdr.width, expected.width, `${label} width`);
  assert.equal(ihdr.height, expected.height, `${label} height`);
  assert.equal(ihdr.bitDepth, 8, `${label} must be an 8-bit browser screenshot`);
  assert.ok(ihdr.colorType === 2 || ihdr.colorType === 6, `${label} must be RGB or RGBA`);
  assert.equal(ihdr.compression, 0, `${label} compression method`);
  assert.equal(ihdr.filter, 0, `${label} filter method`);
  assert.equal(ihdr.interlace, 0, `${label} must be non-interlaced`);
  const channels = ihdr.colorType === 6 ? 4 : 3;
  const rowBytes = ihdr.width * channels;
  const expectedInflatedBytes = (rowBytes + 1) * ihdr.height;
  const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedInflatedBytes + 1 });
  assert.equal(inflated.length, expectedInflatedBytes, `${label} decoded raster length`);
  for(let row = 0; row < ihdr.height; row += 1){
    assert.ok(inflated[row * (rowBytes + 1)] <= 4, `${label} row ${row} has invalid filter byte`);
  }
  return Object.freeze({ ...ihdr, rowBytes, decodedBytes: inflated.length });
}

export async function pngMetadata(file, expected, label){
  const status = await lstat(file);
  assert.equal(status.isFile(), true, `${label} must be a regular file`);
  assert.equal(status.isSymbolicLink(), false, `${label} must not be a symlink`);
  const contents = await readFile(file);
  const decoded = decodeAndValidatePng(contents, expected, label);
  return { path: file, bytes: contents.length, sha256: sha256(contents), width: decoded.width, height: decoded.height };
}

async function pathExists(file){
  try { await lstat(file); return true; }
  catch(error){ if(error?.code === 'ENOENT') return false; throw error; }
}

function pathExistsSync(file){
  try { lstatSync(file); return true; }
  catch(error){ if(error?.code === 'ENOENT') return false; throw error; }
}

function ownedPath(root, name){
  return path.join(root, name);
}

export function createPromotionTransaction({ marker, runnerRoot, golfRoot, outputDirectory, validated }){
  assert.match(marker, /^[A-Za-z0-9_-]{8,160}$/, 'promotion marker');
  const projectRoot = path.dirname(runnerRoot);
  assert.equal(path.dirname(golfRoot), projectRoot, 'Runner and Golf must share one transaction filesystem root');
  const backupRoot = ownedPath(projectRoot, `.phase4-backups-${marker}`);
  const committedBackupRoot = ownedPath(projectRoot, `.phase4-committed-backups-${marker}`);
  const shotStage = ownedPath(runnerRoot, `.phase4-shots-stage-${marker}`);
  const boardStage = ownedPath(runnerRoot, `.gridlock-run-v1-frames-stage-${marker}.png`);
  const runnerDistStage = ownedPath(runnerRoot, `.runner-dist-stage-${marker}.html`);
  const runnerStandaloneStage = ownedPath(runnerRoot, `.runner-standalone-stage-${marker}.html`);
  const golfDistStage = ownedPath(golfRoot, `.golf-dist-stage-${marker}.html`);
  const golfStandaloneStage = ownedPath(golfRoot, `.golf-standalone-stage-${marker}.html`);
  const items = [
    {
      id: 'shots', kind: 'directory', stage: shotStage,
      destination: path.join(runnerRoot, 'phase4-shots'),
      backup: path.join(backupRoot, 'runner-phase4-shots'),
    },
    { id: 'board', kind: 'file', stage: boardStage, destination: path.join(runnerRoot, 'gridlock-run-v1-frames.png'), backup: path.join(backupRoot, 'runner-frame-board.png') },
    { id: 'runner-dist', kind: 'file', stage: runnerDistStage, destination: path.join(runnerRoot, 'dist', 'index.html'), backup: path.join(backupRoot, 'runner-dist.html') },
    { id: 'runner-standalone', kind: 'file', stage: runnerStandaloneStage, destination: path.join(runnerRoot, 'gridlock-run-v1.html'), backup: path.join(backupRoot, 'runner-standalone.html') },
    { id: 'golf-dist', kind: 'file', stage: golfDistStage, destination: path.join(golfRoot, 'dist', 'index.html'), backup: path.join(backupRoot, 'golf-dist.html') },
    { id: 'golf-standalone', kind: 'file', stage: golfStandaloneStage, destination: path.join(golfRoot, 'stackyard-golf-v1.html'), backup: path.join(backupRoot, 'golf-standalone.html') },
  ].map(item => ({
    ...item,
    displaced: null,
    backupPending: `${item.backup}.pending`,
    installed: false,
    backedUp: false,
  }));
  return {
    marker, projectRoot, runnerRoot, golfRoot, outputDirectory, validated, items, backupRoot, committedBackupRoot,
    journalPath: path.join(projectRoot, PROMOTION_JOURNAL_NAME),
    journalData: null,
    registeredPaths: Object.freeze([
      ...items.flatMap(item => [item.stage, item.backup, item.backupPending, item.displaced].filter(Boolean)),
      backupRoot,
      committedBackupRoot,
    ]),
    stagedMetadata: null, installedMetadata: null,
    state: 'registered', committed: false,
  };
}

async function fsyncDirectory(directory){
  const handle = await open(directory, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

function fsyncDirectorySync(directory){
  const descriptor = openSync(directory, 'r');
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function atomicWriteJsonSync(file, value){
  const temporary = path.join(path.dirname(file), PROMOTION_JOURNAL_PENDING_NAME);
  const descriptor = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
  fsyncDirectorySync(path.dirname(file));
}

const permissionMode = status => status.mode & 0o7777;
const ownershipMetadata = status => ({ mode: permissionMode(status), uid: status.uid, gid: status.gid });

function runPinnedMetadataTool(tool, args, label){
  const result = spawnSync(tool, args, {
    encoding: null,
    timeout: 2_000,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      LANG: 'C',
      TZ: 'UTC',
    },
  });
  if(result.error){
    throw new Error(`${label} failed: ${result.error.message}`, { cause: result.error });
  }
  if(result.status !== 0){
    throw new Error(`${label} exited ${result.status}: ${Buffer.from(result.stderr || []).toString('utf8')}`);
  }
  return Buffer.from(result.stdout || []);
}

/**
 * Bind the metadata Node's Stats object omits on macOS. Attribute values are
 * decoded from xattr's hex mode back to their original bytes before hashing;
 * ACL text is emitted by the pinned system ls under the C locale and excludes
 * the path-bearing summary row. Flags are the kernel st_flags numeric value.
 */
function extendedMetadataSync(target){
  if(process.platform !== 'darwin') return { platform: process.platform };
  const listed = runPinnedMetadataTool(MACOS_XATTR, [target], `list xattrs for ${target}`)
    .toString('utf8');
  const names = listed.split('\n').filter(Boolean).sort((left, right) => (
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  ));
  const xattrs = names.map(name => {
    const encoded = runPinnedMetadataTool(
      MACOS_XATTR,
      ['-px', name, target],
      `read xattr ${name} for ${target}`,
    ).toString('ascii').replace(/\s+/g, '');
    assert.match(encoded, /^(?:[0-9A-Fa-f]{2})*$/, `xattr ${name} returned malformed hex`);
    const value = Buffer.from(encoded, 'hex');
    const nameBytes = Buffer.from(name, 'utf8');
    return {
      name,
      nameSha256: sha256(nameBytes),
      bytes: value.length,
      valueSha256: sha256(value),
    };
  });
  const aclOutput = runPinnedMetadataTool(MACOS_LS, ['-lde', target], `read ACL for ${target}`);
  const firstNewline = aclOutput.indexOf(0x0a);
  const acl = firstNewline === -1 ? Buffer.alloc(0) : aclOutput.subarray(firstNewline + 1);
  const rawFlags = runPinnedMetadataTool(MACOS_STAT, ['-f', '%f', target], `read flags for ${target}`)
    .toString('ascii').trim();
  assert.match(rawFlags, /^[0-9]+$/, `${target} returned malformed st_flags`);
  return {
    platform: 'darwin',
    flags: rawFlags,
    aclBytes: acl.length,
    aclSha256: sha256(acl),
    xattrs,
  };
}

async function inodeIdentity(target){
  const status = await lstat(target, { bigint: true });
  return {
    dev: status.dev.toString(),
    ino: status.ino.toString(),
    mtimeNs: status.mtimeNs.toString(),
    birthtimeNs: status.birthtimeNs.toString(),
  };
}

async function applyArtifactMetadata(target, sourceStatus){
  try { await chown(target, sourceStatus.uid, sourceStatus.gid); }
  catch(error){
    // Non-privileged callers may be unable to reproduce foreign ownership.
    // The subsequent exact manifest validation fails closed in that case.
    if(error?.code !== 'EPERM') throw error;
  }
  await chmod(target, permissionMode(sourceStatus));
}

async function atomicWriteJson(file, value){
  const temporary = path.join(path.dirname(file), PROMOTION_JOURNAL_PENDING_NAME);
  let handle = null;
  try {
    handle = await open(temporary, 'w', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    await fsyncDirectory(path.dirname(file));
  } finally {
    if(handle) await handle.close().catch(() => {});
  }
}

async function removeJournalFile(file){
  try { await unlink(file); }
  catch(error){ if(error?.code !== 'ENOENT') throw error; }
  await rm(path.join(path.dirname(file), PROMOTION_JOURNAL_PENDING_NAME), { force: true });
  await fsyncDirectory(path.dirname(file));
}

async function artifactManifest(target, kind, { includeIdentity = false } = {}){
  if(kind === 'file'){
    const status = await lstat(target);
    assert.equal(status.isFile(), true, `${target} must be a regular file`);
    assert.equal(status.isSymbolicLink(), false, `${target} must not be a symlink`);
    const bytes = await readFile(target);
    return {
      kind: 'file', bytes: bytes.length, sha256: sha256(bytes), ...ownershipMetadata(status),
      extended: extendedMetadataSync(target),
      ...(includeIdentity ? { identity: await inodeIdentity(target) } : {}),
    };
  }
  assert.equal(kind, 'directory', `${target} manifest kind`);
  const rootStatus = await lstat(target);
  assert.equal(rootStatus.isDirectory(), true, `${target} must be a directory`);
  assert.equal(rootStatus.isSymbolicLink(), false, `${target} must not be a symlink`);
  const directories = [];
  const files = [];
  async function visit(current){
    const entries = await readdir(current, { withFileTypes: true });
    for(const entry of entries.sort((a, b) => a.name.localeCompare(b.name))){
      const absolute = path.join(current, entry.name);
      if(entry.isDirectory()){
        const status = await lstat(absolute);
        assert.equal(status.isSymbolicLink(), false, `${absolute} must not be a symlink`);
        directories.push({
          path: path.relative(target, absolute), ...ownershipMetadata(status),
          extended: extendedMetadataSync(absolute),
          ...(includeIdentity ? { identity: await inodeIdentity(absolute) } : {}),
        });
        await visit(absolute);
      } else {
        assert.equal(entry.isFile(), true, `${absolute} must be a regular file`);
        const status = await lstat(absolute);
        assert.equal(status.isSymbolicLink(), false, `${absolute} must not be a symlink`);
        const bytes = await readFile(absolute);
        files.push({
          path: path.relative(target, absolute),
          bytes: bytes.length,
          sha256: sha256(bytes),
          ...ownershipMetadata(status),
          extended: extendedMetadataSync(absolute),
          ...(includeIdentity ? { identity: await inodeIdentity(absolute) } : {}),
        });
      }
    }
  }
  await visit(target);
  directories.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    kind: 'directory',
    ...ownershipMetadata(rootStatus),
    extended: extendedMetadataSync(target),
    ...(includeIdentity ? { identity: await inodeIdentity(target) } : {}),
    directories,
    files,
    treeSha256: sha256(Buffer.from(JSON.stringify({ directories, files }))),
  };
}

async function assertArtifactManifest(target, expected, label){
  const actual = await artifactManifest(target, expected.kind, {
    includeIdentity: Object.hasOwn(expected, 'identity'),
  });
  assert.deepEqual(actual, expected, `${label} manifest changed`);
  return actual;
}

function inodeIdentitySync(target){
  const status = lstatSync(target, { bigint: true });
  return {
    dev: status.dev.toString(),
    ino: status.ino.toString(),
    mtimeNs: status.mtimeNs.toString(),
    birthtimeNs: status.birthtimeNs.toString(),
  };
}

function artifactManifestSync(target, kind, { includeIdentity = false } = {}){
  if(kind === 'file'){
    const status = lstatSync(target);
    assert.equal(status.isFile(), true, `${target} must be a regular file`);
    assert.equal(status.isSymbolicLink(), false, `${target} must not be a symlink`);
    const bytes = readFileSync(target);
    return {
      kind: 'file', bytes: bytes.length, sha256: sha256(bytes), ...ownershipMetadata(status),
      extended: extendedMetadataSync(target),
      ...(includeIdentity ? { identity: inodeIdentitySync(target) } : {}),
    };
  }
  assert.equal(kind, 'directory', `${target} manifest kind`);
  const rootStatus = lstatSync(target);
  assert.equal(rootStatus.isDirectory(), true, `${target} must be a directory`);
  assert.equal(rootStatus.isSymbolicLink(), false, `${target} must not be a symlink`);
  const directories = [];
  const files = [];
  function visit(current){
    for(const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))){
      const absolute = path.join(current, entry.name);
      if(entry.isDirectory()){
        const status = lstatSync(absolute);
        assert.equal(status.isSymbolicLink(), false, `${absolute} must not be a symlink`);
        directories.push({
          path: path.relative(target, absolute), ...ownershipMetadata(status),
          extended: extendedMetadataSync(absolute),
          ...(includeIdentity ? { identity: inodeIdentitySync(absolute) } : {}),
        });
        visit(absolute);
      } else {
        assert.equal(entry.isFile(), true, `${absolute} must be a regular file`);
        const status = lstatSync(absolute);
        assert.equal(status.isSymbolicLink(), false, `${absolute} must not be a symlink`);
        const bytes = readFileSync(absolute);
        files.push({
          path: path.relative(target, absolute),
          bytes: bytes.length,
          sha256: sha256(bytes),
          ...ownershipMetadata(status),
          extended: extendedMetadataSync(absolute),
          ...(includeIdentity ? { identity: inodeIdentitySync(absolute) } : {}),
        });
      }
    }
  }
  visit(target);
  directories.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    kind: 'directory',
    ...ownershipMetadata(rootStatus),
    extended: extendedMetadataSync(target),
    ...(includeIdentity ? { identity: inodeIdentitySync(target) } : {}),
    directories,
    files,
    treeSha256: sha256(Buffer.from(JSON.stringify({ directories, files }))),
  };
}

function assertArtifactManifestSync(target, expected, label){
  const actual = artifactManifestSync(target, expected.kind, {
    includeIdentity: Object.hasOwn(expected, 'identity'),
  });
  assert.deepEqual(actual, expected, `${label} manifest changed`);
  return actual;
}

const manifestsEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function persistJournalState(transaction, state, progress = null){
  assert.ok(transaction.journalData, 'promotion journal must be initialized');
  const next = {
    ...transaction.journalData,
    state,
    progress,
    updatedAt: Date.now(),
  };
  await atomicWriteJson(transaction.journalPath, next);
  transaction.journalData = next;
}

async function validatedNewManifest(transaction, item){
  if(item.id === 'shots'){
    const projectStatus = await lstat(transaction.projectRoot);
    const directoryMetadata = {
      mode: 0o777 & ~process.umask(),
      uid: typeof process.getuid === 'function' ? process.getuid() : projectStatus.uid,
      gid: typeof process.getgid === 'function' ? process.getgid() : projectStatus.gid,
    };
    const directoryPaths = new Set();
    const files = [];
    for(const source of transaction.validated.shots){
      const relativePath = path.relative('phase4-shots', source.relativePath);
      const bytes = await readFile(source.path);
      const hash = sha256(bytes);
      assert.equal(hash, source.sha256, `journal source ${source.relativePath} hash changed`);
      const sourceStatus = await lstat(source.path);
      files.push({
        path: relativePath, bytes: bytes.length, sha256: hash,
        ...ownershipMetadata(sourceStatus),
      });
      let parent = path.dirname(relativePath);
      while(parent && parent !== '.'){
        directoryPaths.add(parent);
        const next = path.dirname(parent);
        if(next === parent) break;
        parent = next;
      }
    }
    const directories = [...directoryPaths]
      .sort((a, b) => a.localeCompare(b))
      .map(relativePath => ({ path: relativePath, ...directoryMetadata }));
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      kind: 'directory', ...directoryMetadata, directories, files,
      treeSha256: sha256(Buffer.from(JSON.stringify({ directories, files }))),
    };
  }
  const source = item.id === 'board' ? transaction.validated.frameBoard.path
    : item.id.startsWith('runner-') ? transaction.validated.worlds.runner.path
      : transaction.validated.worlds.golf.path;
  return artifactManifest(source, 'file');
}

async function initializePromotionJournal(transaction){
  assert.equal(await pathExists(transaction.journalPath), false,
    `unfinished promotion journal already exists at ${transaction.journalPath}`);
  const items = [];
  for(const item of transaction.items){
    items.push({
      id: item.id,
      kind: item.kind,
      stage: item.stage,
      destination: item.destination,
      backup: item.backup,
      backupPending: item.backupPending,
      displaced: item.displaced,
      old: await artifactManifest(item.destination, item.kind, { includeIdentity: true }),
      new: await validatedNewManifest(transaction, item),
    });
  }
  const now = Date.now();
  const journal = {
    version: 2,
    transactionId: transaction.marker,
    projectRoot: transaction.projectRoot,
    state: 'staging',
    progress: null,
    createdAt: now,
    updatedAt: now,
    backupRoot: transaction.backupRoot,
    committedBackupRoot: transaction.committedBackupRoot,
    items,
  };
  await atomicWriteJson(transaction.journalPath, journal);
  transaction.journalData = journal;
}

function validateJournalPaths(journal, projectRoot){
  exactKeys(journal, [
    'version', 'transactionId', 'projectRoot', 'state', 'progress', 'createdAt', 'updatedAt',
    'backupRoot', 'committedBackupRoot', 'items',
  ], 'promotion journal');
  assert.equal(journal.version, 2, 'promotion journal version');
  assert.match(journal.transactionId, /^[A-Za-z0-9_-]{8,160}$/, 'promotion journal transaction id');
  assert.ok([
    'staging', 'staged', 'installing', 'installed', 'validated',
    'rolling-back', 'rollback-complete', 'awaiting-grant', 'commit-intent', 'committed',
  ].includes(journal.state), `promotion journal state ${journal.state}`);
  assert.equal(path.resolve(journal.projectRoot), path.resolve(projectRoot), 'promotion journal project root');
  assert.ok(Array.isArray(journal.items), 'promotion journal items');
  const expected = createPromotionTransaction({
    marker: journal.transactionId,
    runnerRoot: path.join(projectRoot, 'runner'),
    golfRoot: path.join(projectRoot, 'golf'),
    outputDirectory: path.join(projectRoot, '.recovery-only'),
    validated: null,
  });
  assert.equal(journal.backupRoot, expected.backupRoot, 'promotion journal backup root');
  assert.equal(journal.committedBackupRoot, expected.committedBackupRoot, 'promotion journal committed backup root');
  assert.equal(journal.items.length, expected.items.length, 'promotion journal item count');
  for(let index = 0; index < expected.items.length; index += 1){
    const actual = journal.items[index];
    const expectedItem = expected.items[index];
    exactKeys(actual, [
      'id', 'kind', 'stage', 'destination', 'backup', 'backupPending', 'displaced', 'old', 'new',
    ], `promotion journal item ${index}`);
    for(const key of ['id', 'kind', 'stage', 'destination', 'backup', 'backupPending', 'displaced']){
      assert.equal(actual[key], expectedItem[key], `promotion journal ${actual.id || index} ${key}`);
    }
  }
  return expected;
}

async function classifyCurrentArtifact(item){
  if(!(await pathExists(item.destination))) return 'missing';
  let currentSemantic;
  let currentIdentity;
  try {
    currentSemantic = await artifactManifest(item.destination, item.kind);
    currentIdentity = await artifactManifest(item.destination, item.kind, { includeIdentity: true });
  }
  catch(error){
    throw new Error(`promotion recovery found divergent current ${item.id}; all evidence preserved: ${error.message}`, { cause: error });
  }
  if(manifestsEqual(currentIdentity, item.old)) return 'old';
  if(manifestsEqual(currentSemantic, item.new)) return 'new';
  throw new Error(`promotion recovery found divergent current ${item.id}; all evidence preserved`);
}

async function persistRecoveredJournal(journalPath, journal, state, progress = null){
  const next = { ...journal, state, progress, updatedAt: Date.now() };
  await atomicWriteJson(journalPath, next);
  return next;
}

async function cleanupRecoveredTransaction({ journalPath, journal, expected, afterRecoveryStep }){
  for(const item of expected.items){
    const existedBefore = await pathExists(item.stage);
    await rm(item.stage, { recursive: item.kind === 'directory', force: true });
    if(afterRecoveryStep) await afterRecoveryStep({ step: 'cleanup-stage', item, existedBefore });
  }
  await rm(journal.backupRoot, { recursive: true, force: true });
  if(afterRecoveryStep) await afterRecoveryStep({ step: 'cleanup-backup-root' });
  await rm(journal.committedBackupRoot, { recursive: true, force: true });
  if(afterRecoveryStep) await afterRecoveryStep({ step: 'cleanup-committed-backup-root' });
  await removeJournalFile(journalPath);
}

/** Recover a killed promotion before any new release work is allowed. */
export async function recoverPromotionJournal({ projectRoot, afterRecoveryStep = null }){
  if(afterRecoveryStep !== null) assert.equal(typeof afterRecoveryStep, 'function', 'afterRecoveryStep hook');
  const resolvedRoot = path.resolve(projectRoot);
  const journalPath = path.join(resolvedRoot, PROMOTION_JOURNAL_NAME);
  const pendingPath = path.join(resolvedRoot, PROMOTION_JOURNAL_PENDING_NAME);
  let journal;
  try { journal = JSON.parse(await readFile(journalPath, 'utf8')); }
  catch(error){
    if(error?.code === 'ENOENT'){
      if(await pathExists(pendingPath)){
        // The stable journal is renamed before staging starts. Therefore a
        // pending-only file can only be an interrupted metadata write with no
        // official or staged mutation, and is safe to discard under the lock.
        await rm(pendingPath, { force: true });
        await fsyncDirectory(resolvedRoot);
        return { recovered: true, action: 'discarded-pending-metadata' };
      }
      return { recovered: false, action: 'none' };
    }
    throw new Error(`promotion journal is unreadable; evidence preserved at ${journalPath}: ${error.message}`, { cause: error });
  }
  const expected = validateJournalPaths(journal, resolvedRoot);
  let committedOnDisk = await pathExists(journal.committedBackupRoot);
  const completeCommit = (journal.state === 'commit-intent' && journal.progress?.finalCommitAck === true)
    || journal.state === 'committed' || committedOnDisk;

  if(completeCommit){
    // Once committed is durable, owned cleanup residue may be partial, but the
    // official generation must remain exactly NEW. Before that terminal state,
    // the atomically relocated old generation must still be complete and exact.
    for(const item of journal.items){
      await assertArtifactManifest(item.destination, item.new, `committed ${item.id}`);
    }
    if(journal.state === 'commit-intent' && journal.progress?.finalCommitAck === true && !committedOnDisk){
      assert.equal(await pathExists(journal.backupRoot), true,
        'durable final commit ACK is missing its retained OLD generation');
      for(const item of journal.items){
        await assertArtifactManifest(item.backup, item.old,
          `durable final commit ACK retained old ${item.id}`);
      }
      await rename(journal.backupRoot, journal.committedBackupRoot);
      await fsyncDirectory(resolvedRoot);
      committedOnDisk = true;
      if(afterRecoveryStep) await afterRecoveryStep({ step: 'commit-point-recovered' });
    }
    if(journal.state !== 'committed'){
      assert.equal(committedOnDisk, true, 'commit point is missing its committed backup root');
      for(const item of journal.items){
        const relocatedBackup = path.join(
          journal.committedBackupRoot,
          path.relative(journal.backupRoot, item.backup),
        );
        await assertArtifactManifest(relocatedBackup, item.old, `commit-point retained old ${item.id}`);
        if(item.displaced){
          const relocatedDisplaced = path.join(
            journal.committedBackupRoot,
            path.relative(journal.backupRoot, item.displaced),
          );
          await assertArtifactManifest(relocatedDisplaced, item.old, `commit-point displaced old ${item.id}`);
        }
      }
      journal = await persistRecoveredJournal(journalPath, journal, 'committed', {
        installed: journal.items.map(item => item.id), recovered: true,
      });
      if(afterRecoveryStep) await afterRecoveryStep({ step: 'committed-terminal' });
    }
    await cleanupRecoveredTransaction({ journalPath, journal, expected, afterRecoveryStep });
    return { recovered: true, action: 'finished-commit', transactionId: journal.transactionId };
  }

  if(journal.state === 'rollback-complete'){
    for(const item of journal.items){
      await assertArtifactManifest(item.destination, item.old, `rollback-complete ${item.id}`);
    }
    await cleanupRecoveredTransaction({ journalPath, journal, expected, afterRecoveryStep });
    return { recovered: true, action: 'rolled-back', transactionId: journal.transactionId };
  }

  // Preflight the entire rollback without mutating anything. Each official
  // artifact must be exact OLD, exact NEW, or the one explicit directory gap
  // between atomic displacement and atomic install/restore.
  const currentStates = new Map();
  for(const item of journal.items){
    const hasBackup = await pathExists(item.backup);
    const hasPending = await pathExists(item.backupPending);
    const hasDisplaced = false;
    if(hasBackup){
      await assertArtifactManifest(item.backup, item.old, `retained old ${item.id}`);
    }
    if(hasDisplaced) await assertArtifactManifest(item.displaced, item.old, `displaced old ${item.id}`);
    const state = await classifyCurrentArtifact(item);
    if(hasPending && state !== 'old'){
      throw new Error(`promotion recovery found unpublished backup with ${state} current ${item.id}; all evidence preserved`);
    }
    if(state === 'new'){
      if(hasPending || !hasBackup){
        throw new Error(`promotion recovery found new current ${item.id} without complete retained OLD evidence; all evidence preserved`);
      }
      if(await pathExists(item.stage)){
        throw new Error(`promotion recovery found both current NEW and a stage for ${item.id}; all evidence preserved`);
      }
    } else if(state === 'missing'){
      if(item.kind !== 'directory' || hasPending || !hasBackup){
        throw new Error(`promotion recovery found unrecognized missing transition for ${item.id}; all evidence preserved`);
      }
    }
    currentStates.set(item.id, state);
  }

  journal = await persistRecoveredJournal(journalPath, journal, 'rolling-back', journal.progress);
  if(afterRecoveryStep) await afterRecoveryStep({ step: 'rolling-back-terminal-intent' });
  for(const item of [...journal.items].reverse()){
    let state = currentStates.get(item.id);
    if(state === 'old') continue;
    await mkdir(path.dirname(item.destination), { recursive: true });
    if(item.kind === 'file'){
      assert.equal(state, 'new', `${item.id} file rollback state`);
      await rename(item.backup, item.destination);
      await fsyncDirectory(path.dirname(item.destination));
      if(afterRecoveryStep) await afterRecoveryStep({ step: 'file-old-restored', item });
      continue;
    }
    if(state === 'new'){
      await rename(item.destination, item.stage);
      await fsyncDirectory(path.dirname(item.destination));
      if(path.dirname(item.stage) !== path.dirname(item.destination)) await fsyncDirectory(path.dirname(item.stage));
      if(afterRecoveryStep) await afterRecoveryStep({ step: 'directory-new-displaced', item });
      state = 'missing';
    }
    assert.equal(state, 'missing', `${item.id} directory rollback state`);
    await rename(item.backup, item.destination);
    await fsyncDirectory(path.dirname(item.destination));
    if(path.dirname(item.backup) !== path.dirname(item.destination)){
      await fsyncDirectory(path.dirname(item.backup));
    }
    if(afterRecoveryStep) await afterRecoveryStep({ step: 'directory-old-restored', item });
  }
  for(const item of journal.items){
    await assertArtifactManifest(item.destination, item.old, `restored old ${item.id}`);
  }
  journal = await persistRecoveredJournal(journalPath, journal, 'rollback-complete', {
    restored: journal.items.map(item => item.id),
  });
  if(afterRecoveryStep) await afterRecoveryStep({ step: 'rollback-complete-terminal' });
  await cleanupRecoveredTransaction({ journalPath, journal, expected, afterRecoveryStep });
  return { recovered: true, action: 'rolled-back', transactionId: journal.transactionId };
}

async function removeOwned(item, key){
  await rm(item[key], { recursive: item.kind === 'directory', force: true });
}

async function cleanupRegisteredPaths(transaction, { includeBackups = true } = {}){
  const errors = [];
  for(const item of transaction.items){
    for(const key of includeBackups ? ['stage', 'backup', 'backupPending', 'displaced'] : ['stage']){
      if(!item[key]) continue;
      try { await removeOwned(item, key); }
      catch(error){ errors.push(new Error(`remove ${item.id} ${key}: ${error.message}`, { cause: error })); }
    }
  }
  if(includeBackups){
    for(const [label, ownedRoot] of [
      ['backup root', transaction.backupRoot],
      ['committed backup root', transaction.committedBackupRoot],
    ]){
      try { await rm(ownedRoot, { recursive: true, force: true }); }
      catch(error){ errors.push(new Error(`remove ${label}: ${error.message}`, { cause: error })); }
    }
  }
  if(errors.length) throw new AggregateError(errors, 'promotion owned-path cleanup failed');
}

function expectedShotSize(relativePath){
  const viewport = relativePath.split(path.sep)[1];
  const expected = PHASE4_SHOT_VIEWPORTS[viewport];
  assert.ok(expected, `unknown screenshot viewport ${viewport}`);
  return expected;
}

async function copyWithInjection(source, destination, copyState){
  copyState.count += 1;
  if(copyState.injectFailureAt === copyState.count){
    throw new Error(`injected stage copy failure at ${copyState.count}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const sourceStatus = await lstat(source);
  await applyArtifactMetadata(destination, sourceStatus);
  const handle = await open(destination, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
  await fsyncDirectory(path.dirname(destination));
  if(copyState.afterCopy) await copyState.afterCopy({
    count: copyState.count,
    source,
    destination,
  });
}

export async function stagePromotionTransaction(transaction, { injectCopyFailureAt = null, afterCopy = null } = {}){
  assert.equal(transaction.state, 'registered', 'promotion must be registered before staging');
  if(injectCopyFailureAt !== null){
    assert.ok(Number.isSafeInteger(injectCopyFailureAt) && injectCopyFailureAt > 0, 'injectCopyFailureAt');
  }
  if(afterCopy !== null) assert.equal(typeof afterCopy, 'function', 'afterCopy hook');
  const copyState = { count: 0, injectFailureAt: injectCopyFailureAt, afterCopy };
  try {
    await cleanupRegisteredPaths(transaction);
    await initializePromotionJournal(transaction);
    const shotsItem = transaction.items.find(item => item.id === 'shots');
    for(const shot of transaction.validated.shots){
      const relativePath = path.relative('phase4-shots', shot.relativePath);
      await copyWithInjection(shot.path, path.join(shotsItem.stage, relativePath), copyState);
    }
    const boardItem = transaction.items.find(item => item.id === 'board');
    await copyWithInjection(transaction.validated.frameBoard.path, boardItem.stage, copyState);
    const worldCopies = [
      ['runner-dist', transaction.validated.worlds.runner.path],
      ['runner-standalone', transaction.validated.worlds.runner.path],
      ['golf-dist', transaction.validated.worlds.golf.path],
      ['golf-standalone', transaction.validated.worlds.golf.path],
    ];
    for(const [id, source] of worldCopies){
      await copyWithInjection(source, transaction.items.find(item => item.id === id).stage, copyState);
    }
    transaction.stagedMetadata = await validateTransactionArtifacts(transaction, 'stage');
    // Staging can legitimately acquire filesystem metadata that differs from
    // the source path (for example inherited provenance on a newly created
    // directory). Bind the journal's exact NEW authority to the completed
    // same-filesystem stage, after content validation and before any official
    // destination can be displaced. A crash before this durable replacement
    // still has only exact OLD officials and is safely rolled back.
    const exactNewById = new Map();
    for(const item of transaction.items){
      exactNewById.set(item.id, await artifactManifest(item.stage, item.kind));
    }
    transaction.journalData = {
      ...transaction.journalData,
      items: transaction.journalData.items.map(item => ({
        ...item,
        new: exactNewById.get(item.id),
      })),
    };
    await persistJournalState(transaction, 'staged', { copied: copyState.count });
    transaction.state = 'staged';
    return transaction.stagedMetadata;
  } catch(error){
    const errors = [error];
    let cleanupSucceeded = false;
    try {
      await cleanupRegisteredPaths(transaction);
      cleanupSucceeded = true;
    } catch(cleanupError){ errors.push(cleanupError); }
    if(cleanupSucceeded && transaction.journalData){
      try { await removeJournalFile(transaction.journalPath); }
      catch(journalError){ errors.push(journalError); }
    }
    transaction.state = 'stage-failed';
    throw new AggregateError(errors, `promotion staging failed: ${error.message}`);
  }
}

export async function installPromotionTransaction(transaction, {
  afterInstallItem = null,
  afterBackupChunk = null,
  afterDisplaceItem = null,
  beforeBackupItem = null,
} = {}){
  assert.equal(transaction.state, 'staged', 'promotion must be fully staged before install');
  if(afterInstallItem !== null) assert.equal(typeof afterInstallItem, 'function', 'afterInstallItem hook');
  if(afterBackupChunk !== null) assert.equal(typeof afterBackupChunk, 'function', 'afterBackupChunk hook');
  if(afterDisplaceItem !== null) assert.equal(typeof afterDisplaceItem, 'function', 'afterDisplaceItem hook');
  if(beforeBackupItem !== null) assert.equal(typeof beforeBackupItem, 'function', 'beforeBackupItem hook');
  try {
    // Whole-set preflight: no backup publication or official rename may occur
    // until every OLD destination and every NEW stage is still exact.
    const projectDevice = (await lstat(transaction.projectRoot)).dev;
    for(const item of transaction.journalData.items){
      assert.equal((await lstat(item.destination)).dev, projectDevice,
        `${item.id} destination is not on the transaction filesystem`);
      assert.equal((await lstat(item.stage)).dev, projectDevice,
        `${item.id} stage is not on the transaction filesystem`);
      await assertArtifactManifest(item.destination, item.old, `pre-install OLD ${item.id}`);
      await assertArtifactManifest(item.stage, item.new, `pre-install NEW ${item.id}`);
      assert.equal(await pathExists(item.backup), false, `${item.id} backup already exists`);
      assert.equal(await pathExists(item.backupPending), false, `${item.id} pending backup already exists`);
    }
    await persistJournalState(transaction, 'installing', { installed: [] });
    const installed = [];
    for(const [index, item] of transaction.items.entries()){
      const journalItem = transaction.journalData.items.find(candidate => candidate.id === item.id);
      if(beforeBackupItem) await beforeBackupItem({ item, index, transaction });
      await assertArtifactManifest(item.destination, journalItem.old, `immediate pre-backup OLD ${item.id}`);
      await assertArtifactManifest(item.stage, journalItem.new, `immediate pre-backup NEW ${item.id}`);
      await mkdir(path.dirname(item.destination), { recursive: true });
      await mkdir(path.dirname(item.backup), { recursive: true });
      if(item.kind === 'file'){
        // A same-filesystem hard link retains the exact original inode,
        // including xattrs/ACLs/timestamps that a byte copy cannot reproduce.
        await link(item.destination, item.backupPending);
        await fsyncDirectory(path.dirname(item.backupPending));
        if(afterBackupChunk) await afterBackupChunk({
          bytesCopied: 0, source: item.destination, destination: item.backupPending,
          item, index, transaction,
        });
        await assertArtifactManifest(item.destination, journalItem.old, `post-hook OLD ${item.id}`);
        await assertArtifactManifest(item.stage, journalItem.new, `post-hook NEW ${item.id}`);
        await assertArtifactManifest(item.backupPending, journalItem.old, `pending hard-link backup ${item.id}`);
        await rename(item.backupPending, item.backup);
      } else {
        if(afterBackupChunk) await afterBackupChunk({
          bytesCopied: 0, source: item.destination, destination: item.backup,
          item, index, transaction,
        });
        await assertArtifactManifest(item.destination, journalItem.old, `post-hook OLD ${item.id}`);
        await assertArtifactManifest(item.stage, journalItem.new, `post-hook NEW ${item.id}`);
        // Directory OLD is itself atomically displaced into the retained
        // backup generation; no live directory is ever recursively removed.
        await rename(item.destination, item.backup);
      }
      await assertArtifactManifest(item.backup, journalItem.old, `retained original ${item.id}`);
      if(path.dirname(item.backup) !== path.dirname(item.destination)){
        await fsyncDirectory(path.dirname(item.destination));
      }
      await fsyncDirectory(path.dirname(item.backup));
      item.backedUp = true;
      await persistJournalState(transaction, 'installing', { current: item.id, step: 'backed-up', installed: [...installed] });
      if(item.kind === 'directory'){
        if(afterDisplaceItem) await afterDisplaceItem({ item, index, transaction });
        await assertArtifactManifest(item.backup, journalItem.old, `post-displace retained OLD ${item.id}`);
      }
      await assertArtifactManifest(item.stage, journalItem.new, `immediate pre-install NEW ${item.id}`);
      await rename(item.stage, item.destination);
      await fsyncDirectory(path.dirname(item.destination));
      item.installed = true;
      installed.push(item.id);
      await persistJournalState(transaction, 'installing', { current: item.id, step: 'installed', installed: [...installed] });
      if(afterInstallItem) await afterInstallItem({ item, index, transaction });
    }
    await fsyncDirectory(transaction.projectRoot);
    await persistJournalState(transaction, 'installed', { installed: [...installed] });
    transaction.state = 'installed';
  } catch(error){
    const errors = [error];
    try { await rollbackPromotionTransaction(transaction); }
    catch(rollbackError){ errors.push(rollbackError); }
    throw new AggregateError(errors, `promotion install failed: ${error.message}`);
  }
}

async function validateTransactionArtifacts(transaction, location){
  const useDestination = location === 'destination';
  const itemPath = id => {
    const item = transaction.items.find(candidate => candidate.id === id);
    return useDestination ? item.destination : item.stage;
  };
  const shotRoot = itemPath('shots');
  const shots = [];
  for(const source of transaction.validated.shots){
    const relativePath = path.relative('phase4-shots', source.relativePath);
    const metadata = await pngMetadata(path.join(shotRoot, relativePath), expectedShotSize(source.relativePath), `${location} ${source.relativePath}`);
    assert.equal(metadata.sha256, source.sha256, `${location} ${source.relativePath} hash changed`);
    shots.push({ ...metadata, relativePath: source.relativePath });
  }
  const board = await pngMetadata(itemPath('board'), PHASE4_BOARD_SIZE, `${location} frame board`);
  assert.equal(board.sha256, transaction.validated.frameBoard.sha256, `${location} frame board hash changed`);
  assert.equal(new Set(shots.map(row => row.sha256)).size, shots.length,
    `${location} screenshots must have 12 distinct hashes`);
  assert.equal(shots.some(row => row.sha256 === board.sha256), false,
    `${location} frame board must not duplicate a screenshot`);
  const worlds = {};
  for(const world of ['runner', 'golf']){
    const expectedHash = transaction.validated.worlds[world].sha256;
    const dist = sha256(await readFile(itemPath(`${world}-dist`)));
    const standalone = sha256(await readFile(itemPath(`${world}-standalone`)));
    assert.equal(dist, expectedHash, `${location} ${world} dist hash changed`);
    assert.equal(standalone, expectedHash, `${location} ${world} standalone hash changed`);
    worlds[world] = { dist, standalone };
  }
  if(useDestination && transaction.stagedMetadata){
    assert.deepEqual(shots.map(row => row.sha256), transaction.stagedMetadata.shots.map(row => row.sha256), 'installed screenshot hashes differ from stage');
    assert.equal(board.sha256, transaction.stagedMetadata.board.sha256, 'installed board hash differs from stage');
    assert.deepEqual(worlds, transaction.stagedMetadata.worlds, 'installed world hashes differ from stage');
  }
  return { shots, board, worlds };
}

export async function validateInstalledTransaction(transaction){
  assert.equal(transaction.state, 'installed', 'transaction must be installed before validation');
  transaction.installedMetadata = await validateTransactionArtifacts(transaction, 'destination');
  for(const item of transaction.journalData.items){
    await assertArtifactManifest(item.destination, item.new, `installed ${item.id}`);
  }
  await persistJournalState(transaction, 'validated', { installed: transaction.items.map(item => item.id) });
  transaction.state = 'validated';
  return transaction.installedMetadata;
}

export async function rollbackPromotionTransaction(transaction){
  if(transaction.committed) throw new Error('cannot rollback a committed promotion');
  try {
    if(transaction.journalData && await pathExists(transaction.journalPath)){
      const durable = JSON.parse(await readFile(transaction.journalPath, 'utf8'));
      validateJournalPaths(durable, transaction.projectRoot);
      assert.equal(durable.transactionId, transaction.marker,
        'rollback journal transaction id changed');
      const durableFinalAck = durable.state === 'committed'
        || (durable.state === 'commit-intent' && durable.progress?.finalCommitAck === true)
        || await pathExists(durable.committedBackupRoot);
      if(durableFinalAck){
        transaction.committed = true;
        transaction.state = durable.state;
        const terminalError = new Error('cannot rollback after durable FINAL_COMMIT_ACK; recovery must finish NEW');
        terminalError.durableFinalCommitAck = true;
        throw terminalError;
      }
      transaction.journalData = durable;
    }
    if(transaction.journalData) await persistJournalState(transaction, 'rolling-back', transaction.journalData.progress);
    if(transaction.journalData) await recoverPromotionJournal({ projectRoot: transaction.projectRoot });
    else await cleanupRegisteredPaths(transaction);
    for(const item of transaction.items){
      item.installed = false;
      item.backedUp = false;
    }
    transaction.state = 'rolled-back';
  } catch(error){
    if(error?.durableFinalCommitAck === true) throw error;
    transaction.state = 'rollback-incomplete';
    throw new AggregateError([error], 'promotion rollback incomplete; journal and retained backup evidence are preserved');
  }
}

export async function commitPromotionTransaction(transaction, {
  beforeCommitIntent = null,
  afterCommitIntent = null,
  beforeCommitPoint = null,
  finalCommitGuard = null,
  afterCommitPoint = null,
  afterCommittedJournal = null,
} = {}){
  assert.equal(transaction.state, 'validated', 'transaction may commit only after installed validation');
  if(beforeCommitIntent !== null) assert.equal(typeof beforeCommitIntent, 'function', 'beforeCommitIntent hook');
  if(afterCommitIntent !== null) assert.equal(typeof afterCommitIntent, 'function', 'afterCommitIntent hook');
  if(beforeCommitPoint !== null) assert.equal(typeof beforeCommitPoint, 'function', 'beforeCommitPoint hook');
  if(finalCommitGuard !== null) assert.equal(typeof finalCommitGuard, 'function', 'finalCommitGuard hook');
  if(afterCommitPoint !== null) assert.equal(typeof afterCommitPoint, 'function', 'afterCommitPoint hook');
  if(afterCommittedJournal !== null) assert.equal(typeof afterCommittedJournal, 'function', 'afterCommittedJournal hook');
  assert.equal(await pathExists(transaction.committedBackupRoot), false, 'committed backup root already exists');
  const hasBackups = await pathExists(transaction.backupRoot);
  assert.equal(hasBackups, true, 'validated transaction must retain its complete backup root');
  assert.equal(transaction.items.every(item => item.backedUp), true, 'validated transaction is missing retained backups');
  // Cached validation flags are not authority. Re-manifest the complete NEW
  // official set and retained exact OLD inode set immediately before intent.
  for(const item of transaction.journalData.items){
    await assertArtifactManifest(item.destination, item.new, `pre-commit NEW ${item.id}`);
    await assertArtifactManifest(item.backup, item.old, `pre-commit retained OLD ${item.id}`);
  }
  if(beforeCommitIntent) await beforeCommitIntent({ transaction });
  await persistJournalState(transaction, 'commit-intent', { installed: transaction.items.map(item => item.id) });
  if(afterCommitIntent) await afterCommitIntent({ transaction });
  if(beforeCommitPoint) await beforeCommitPoint({ transaction });
  if(finalCommitGuard){
    const guardResult = finalCommitGuard({ transaction });
    assert.equal(guardResult?.then, undefined, 'finalCommitGuard must be synchronous');
  }
  // This is intentionally a synchronous critical section. No arbitrary hook,
  // event-loop yield, or process probe can reopen the exact-data window after
  // these manifests and before the atomic directory rename.
  for(const item of transaction.journalData.items){
    assertArtifactManifestSync(item.destination, item.new, `commit-point NEW ${item.id}`);
    assertArtifactManifestSync(item.backup, item.old, `commit-point retained OLD ${item.id}`);
  }
  // This single same-filesystem rename is the commit point. The old generation
  // remains complete before it; recovery recognizes the committed root after.
  renameSync(transaction.backupRoot, transaction.committedBackupRoot);
  // The directory rename is the atomic commit point even if a later fsync or
  // journal update reports an error. Recovery will finish this commit.
  transaction.committed = true;
  transaction.state = 'committed';
  for(const item of transaction.items) item.backedUp = false;
  if(afterCommitPoint) await afterCommitPoint({ transaction });
  await fsyncDirectory(transaction.projectRoot);
  await persistJournalState(transaction, 'committed', { installed: transaction.items.map(item => item.id) });
  if(afterCommittedJournal) await afterCommittedJournal({ transaction });
  try {
    await rm(transaction.committedBackupRoot, { recursive: true, force: true });
    await removeJournalFile(transaction.journalPath);
  } catch(error){
    throw new AggregateError([
      new Error(`remove committed backup root: ${error.message}; committed residue preserved at ${transaction.committedBackupRoot}`, { cause: error }),
    ], 'promotion committed atomically but backup-root cleanup failed');
  }
}

/**
 * Phase 4's inner supervisor stops here. NEW remains installed but fully
 * reversible; exact OLD and the journal are retained until the outer release
 * process has completed its own process/temp/resource checks and ACKs.
 */
export async function preparePromotionForCommitGate(transaction){
  assert.equal(transaction.state, 'validated', 'transaction may become READY only after installed validation');
  for(const item of transaction.journalData.items){
    await assertArtifactManifest(item.destination, item.new, `pre-READY NEW ${item.id}`);
    await assertArtifactManifest(item.backup, item.old, `pre-READY retained OLD ${item.id}`);
  }
  await persistJournalState(transaction, 'awaiting-grant', {
    installed: transaction.items.map(item => item.id),
  });
  for(const item of transaction.journalData.items){
    assertArtifactManifestSync(item.destination, item.new, `READY NEW ${item.id}`);
    assertArtifactManifestSync(item.backup, item.old, `READY retained OLD ${item.id}`);
  }
  transaction.state = 'awaiting-grant';
  return { state: 'awaiting-grant', transactionId: transaction.marker };
}

/**
 * Child-held final ACK. `commit-intent` is the durable terminal choice: recovery
 * finishes NEW from that point; `awaiting-grant` always rolls back to exact OLD.
 */
export function finalizeGrantedPromotionJournalSync({
  projectRoot,
  transactionId,
  transaction,
  finalCommitGuard,
  afterDurableFinalCommitAck = null,
  afterCommitPoint = null,
  afterCommittedJournal = null,
}){
  const resolvedRoot = path.resolve(projectRoot);
  const journalPath = path.join(resolvedRoot, PROMOTION_JOURNAL_NAME);
  let journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const expected = validateJournalPaths(journal, resolvedRoot);
  assert.equal(journal.transactionId, transactionId, 'final commit ACK transaction id');
  assert.equal(journal.state, 'awaiting-grant',
    'final commit ACK requires a provisional awaiting-grant journal');
  assert.equal(pathExistsSync(journal.committedBackupRoot), false,
    'final commit ACK committed root already exists');
  assert.equal(pathExistsSync(journal.backupRoot), true,
    'final commit ACK requires retained exact OLD');
  assert.equal(typeof finalCommitGuard, 'function', 'final commit ACK guard is required');
  assert.ok(transaction && typeof transaction === 'object', 'live promotion transaction is required');
  assert.equal(transaction.marker, transactionId, 'live promotion transaction id');
  for(const [hook, label] of [
    [afterDurableFinalCommitAck, 'afterDurableFinalCommitAck'],
    [afterCommitPoint, 'afterCommitPoint'],
    [afterCommittedJournal, 'afterCommittedJournal'],
  ]){
    if(hook !== null) assert.equal(typeof hook, 'function', `${label} hook`);
  }
  const guardResult = finalCommitGuard();
  assert.equal(guardResult?.then, undefined, 'final commit ACK guard must be synchronous');
  // Final exact-data checks precede the durable ACK. If any fail, recovery sees
  // awaiting-grant and must restore OLD. There is no callback or yield after.
  for(const item of journal.items){
    assertArtifactManifestSync(item.destination, item.new, `final-ack NEW ${item.id}`);
    assertArtifactManifestSync(item.backup, item.old, `final-ack retained OLD ${item.id}`);
  }
  journal = {
    ...journal,
    state: 'commit-intent',
    progress: { installed: journal.items.map(item => item.id), finalCommitAck: true },
    updatedAt: Date.now(),
  };
  atomicWriteJsonSync(journalPath, journal);
  // Monotonic terminal boundary. Every caller-visible error after this line is
  // a committed outcome that recovery must finish; cached state can never
  // authorize rollback over the durable journal.
  transaction.committed = true;
  transaction.state = 'commit-intent';
  if(afterDurableFinalCommitAck) afterDurableFinalCommitAck();
  // `commit-intent` is the durable FINAL_COMMIT_ACK. Recovery finishes NEW if
  // the process is killed anywhere after this write and before cleanup.
  renameSync(journal.backupRoot, journal.committedBackupRoot);
  if(afterCommitPoint) afterCommitPoint();
  fsyncDirectorySync(resolvedRoot);
  journal = {
    ...journal,
    state: 'committed',
    progress: { installed: journal.items.map(item => item.id), finalCommitAck: true },
    updatedAt: Date.now(),
  };
  atomicWriteJsonSync(journalPath, journal);
  transaction.state = 'committed';
  if(afterCommittedJournal) afterCommittedJournal();
  // Retain the committed OLD generation and terminal journal as the durable
  // classification receipt. The outer release always runs bounded recovery
  // after this supervisor exits; recovery revalidates exact NEW/OLD, reports
  // `finished-commit`, and only then removes this evidence.
  for(const item of expected.items) rmSync(item.stage, { recursive: item.kind === 'directory', force: true });
  rmSync(path.join(resolvedRoot, PROMOTION_JOURNAL_PENDING_NAME), { force: true });
  fsyncDirectorySync(resolvedRoot);
  return { committed: true, transactionId, state: 'committed', receiptRetained: true };
}

export async function cleanupUninstalledTransaction(transaction){
  if(!transaction) return;
  if(['staged', 'installed', 'validated', 'awaiting-grant', 'rollback-incomplete'].includes(transaction.state)){
    await rollbackPromotionTransaction(transaction);
    return;
  }
  if(transaction.state === 'committed') return;
  await cleanupRegisteredPaths(transaction);
}

export async function transactionResidues(transaction){
  const residues = [];
  for(const item of transaction.items){
    for(const key of ['stage', 'backup', 'backupPending', 'displaced']){
      if(!item[key]) continue;
      if(await pathExists(item[key])) residues.push({ id: item.id, kind: key, path: item[key] });
    }
  }
  for(const [kind, ownedRoot] of [
    ['backup-root', transaction.backupRoot],
    ['committed-backup-root', transaction.committedBackupRoot],
  ]){
    if(await pathExists(ownedRoot)) residues.push({ id: 'transaction', kind, path: ownedRoot });
  }
  if(await pathExists(transaction.journalPath)){
    residues.push({ id: 'transaction', kind: 'journal', path: transaction.journalPath });
  }
  const pendingJournal = path.join(transaction.projectRoot, PROMOTION_JOURNAL_PENDING_NAME);
  if(await pathExists(pendingJournal)){
    residues.push({ id: 'transaction', kind: 'pending-journal', path: pendingJournal });
  }
  return residues;
}
