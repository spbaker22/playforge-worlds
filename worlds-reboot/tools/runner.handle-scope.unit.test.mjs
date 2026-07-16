import test from 'node:test';
import assert from 'node:assert/strict';

import { createIdentityHandleScope } from './active-handle-scope.mjs';

class FakeSocket {}
class FakeRequest {}

test('caller baseline uses stable identity and cannot mask a new same-type Runner leak', () => {
  const ignoredStdio = new FakeSocket();
  const callerSocket = new FakeSocket();
  const callerRequest = new FakeRequest();
  let handles = [ignoredStdio, callerSocket];
  let requests = [callerRequest];
  const scope = createIdentityHandleScope({
    getHandles: () => handles,
    getRequests: () => requests,
    ignoredHandles: [ignoredStdio],
  });

  assert.equal(scope.baselineHandleCount, 1);
  assert.equal(scope.baselineRequestCount, 1);
  assert.deepEqual(scope.classify(), {
    baselineHandles: [callerSocket],
    baselineRequests: [callerRequest],
    handles: [],
    requests: [],
  });

  const runnerSocket = new FakeSocket();
  const runnerRequest = new FakeRequest();
  assert.equal(runnerSocket.constructor, callerSocket.constructor,
    'fixture must use the same handle type for caller and Runner resources');
  assert.equal(runnerRequest.constructor, callerRequest.constructor,
    'fixture must use the same request type for caller and Runner resources');
  handles = [ignoredStdio, callerSocket, runnerSocket];
  requests = [callerRequest, runnerRequest];
  assert.deepEqual(scope.classify(), {
    baselineHandles: [callerSocket],
    baselineRequests: [callerRequest],
    handles: [runnerSocket],
    requests: [runnerRequest],
  });

  // Counts/types matching the baseline still cannot hide replacement objects.
  handles = [ignoredStdio, runnerSocket];
  requests = [runnerRequest];
  assert.deepEqual(scope.classify(), {
    baselineHandles: [],
    baselineRequests: [],
    handles: [runnerSocket],
    requests: [runnerRequest],
  });
});
