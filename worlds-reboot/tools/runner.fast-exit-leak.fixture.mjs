import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const marker = process.argv[2];
assert.match(marker || '', /^[A-Za-z0-9:_-]{8,180}$/, 'fast-exit fixture marker');
const helper = spawn(process.execPath, [
  fileURLToPath(new URL('./phase-wait.fixture.mjs', import.meta.url)),
  `${marker}:attached-helper`,
], {
  detached: false,
  stdio: 'ignore',
});
assert.ok(Number.isSafeInteger(helper.pid) && helper.pid > 0, 'fast-exit fixture helper PID');
helper.unref();
process.stderr.write(`runner-fast-exit-leak-ready:${marker}:${helper.pid}\n`);
process.exitCode = 23;
