import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

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
    for(const value of part) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data){
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32([typeBytes, data]), 8 + data.length);
  return chunk;
}

function makeRgbPng(width, height, seed){
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for(let row = 0; row < height; row += 1) raw[row * (rowBytes + 1)] = 0;
  raw[1] = seed & 0xff;
  raw[2] = (seed >>> 8) & 0xff;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function createPhase4TransactionFixtureSandbox(marker, point){
  const root = await mkdtemp(path.join(tmpdir(), `phase4-transaction-${marker}-`));
  const runnerRoot = path.join(root, 'runner');
  const golfRoot = path.join(root, 'golf');
  const outputDirectory = path.join(root, 'output');
  await Promise.all([
    mkdir(path.join(runnerRoot, 'dist'), { recursive: true }),
    mkdir(path.join(golfRoot, 'dist'), { recursive: true }),
    mkdir(path.join(runnerRoot, 'phase4-shots', 'old'), { recursive: true }),
    mkdir(path.join(outputDirectory, 'sources'), { recursive: true }),
  ]);
  const old = {
    board: Buffer.from(`old-board-${marker}`),
    runner: Buffer.from(`old-runner-${marker}`),
    golf: Buffer.from(`old-golf-${marker}`),
    shots: Buffer.from(`old-shots-${marker}`),
  };
  await Promise.all([
    writeFile(path.join(runnerRoot, 'gridlock-run-v1-frames.png'), old.board),
    writeFile(path.join(runnerRoot, 'dist', 'index.html'), old.runner),
    writeFile(path.join(runnerRoot, 'gridlock-run-v1.html'), old.runner),
    writeFile(path.join(golfRoot, 'dist', 'index.html'), old.golf),
    writeFile(path.join(golfRoot, 'stackyard-golf-v1.html'), old.golf),
    writeFile(path.join(runnerRoot, 'phase4-shots', 'old', 'sentinel.txt'), old.shots),
  ]);

  const sources = path.join(outputDirectory, 'sources');
  const board = makeRgbPng(1440, 900, 100);
  const runner = Buffer.from(`fresh-runner-${marker}`);
  const golf = Buffer.from(`fresh-golf-${marker}`);
  const boardPath = path.join(sources, 'board.png');
  const runnerPath = path.join(sources, 'runner.html');
  const golfPath = path.join(sources, 'golf.html');
  await Promise.all([
    writeFile(boardPath, board), writeFile(runnerPath, runner), writeFile(golfPath, golf),
  ]);
  const shots = [];
  let seed = 1;
  for(const [viewport, size] of Object.entries({
    '1366x1024': { width: 1366, height: 1024 },
    '1024x768': { width: 1024, height: 768 },
  })){
    for(const name of ['opening', 'hero-s14', 'gameplay-s60', 'slide-s90-92', 'genuine-recovery', 'finish']){
      const bytes = makeRgbPng(size.width, size.height, seed++);
      const source = path.join(sources, `${viewport}-${name}.png`);
      await writeFile(source, bytes);
      shots.push({
        path: source,
        relativePath: path.join('phase4-shots', viewport, `${name}.png`),
        sha256: sha256(bytes),
      });
    }
  }
  const validated = {
    shots,
    frameBoard: { path: boardPath, relativePath: 'gridlock-run-v1-frames.png', sha256: sha256(board) },
    worlds: {
      runner: { path: runnerPath, sha256: sha256(runner) },
      golf: { path: golfPath, sha256: sha256(golf) },
    },
  };
  const configPath = path.join(root, `outer-${point}.json`);
  await writeFile(configPath, `${JSON.stringify({
    marker, runnerRoot, golfRoot, outputDirectory, validated, point,
  })}\n`);
  return { root, runnerRoot, golfRoot, configPath, old, validated };
}
