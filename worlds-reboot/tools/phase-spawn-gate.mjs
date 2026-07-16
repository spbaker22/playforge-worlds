import assert from 'node:assert/strict';
import { closeSync, readSync } from 'node:fs';

// This preload is intentionally synchronous and dependency-minimal. Node loads
// it before --test or the requested entry module. Until the parent sends the
// exact one-shot GO record, no phase-owned JavaScript can execute or spawn.
const rawFd = process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_FD;
const nonce = process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE;
if(rawFd !== undefined || nonce !== undefined){
  assert.notEqual(rawFd, undefined, 'spawn gate nonce existed without fd');
  assert.notEqual(nonce, undefined, 'spawn gate fd existed without nonce');
  assert.match(rawFd, /^3$/, 'spawn gate fd');
  assert.match(nonce, /^[0-9a-f]{48}$/, 'spawn gate nonce');
  const fd = Number(rawFd);

  const expected = Buffer.from(`GO ${nonce}\n`);
  const received = Buffer.alloc(expected.length + 1);
  let offset = 0;
  try {
    while(offset < received.length){
      const bytes = readSync(fd, received, offset, received.length - offset, null);
      if(bytes === 0) break; // Parent death/close means fail without phase work.
      offset += bytes;
      if(received.subarray(0, offset).includes(0x0a)) break;
    }
  } finally {
    closeSync(fd);
  }
  assert.equal(offset, expected.length, 'spawn gate closed before exact GO');
  assert.deepEqual(received.subarray(0, offset), expected, 'spawn gate GO mismatch');

  // Delete the one-shot capability before target code starts. Nested Node and
  // node:test children receive only the trusted nonblocking marker preload.
  assert.equal(process.env.NODE_OPTIONS, undefined,
    'gated child inherited unexpected NODE_OPTIONS executable authority');
  const descendantMarker = process.env.PLAYFORGE_INTERNAL_DESCENDANT_MARKER;
  assert.match(descendantMarker || '', /^[A-Za-z0-9:_-]{8,220}$/,
    'spawn gate descendant marker');
  const descendantOption = `--import=${new URL('./phase-descendant-marker.mjs', import.meta.url).href}`;
  process.env.NODE_OPTIONS = descendantOption;
  delete process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_FD;
  delete process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE;
  await import('./phase-child-process-guard.mjs');
}
