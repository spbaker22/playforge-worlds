/**
 * Capture caller-owned handles/requests by object identity. A later resource
 * with the same constructor, file descriptor, or endpoint is still introduced
 * work unless it is the exact object present at scope creation.
 */
export function createIdentityHandleScope({
  getHandles = () => typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [],
  getRequests = () => typeof process._getActiveRequests === 'function' ? process._getActiveRequests() : [],
  ignoredHandles = [],
} = {}){
  if(typeof getHandles !== 'function' || typeof getRequests !== 'function'){
    throw new TypeError('handle scope readers must be functions');
  }
  const ignored = new Set(ignoredHandles);
  const baselineHandleIdentities = new Set(
    [...getHandles()].filter(handle => !ignored.has(handle)),
  );
  const baselineRequestIdentities = new Set(getRequests());

  return Object.freeze({
    baselineHandleCount: baselineHandleIdentities.size,
    baselineRequestCount: baselineRequestIdentities.size,
    classify(){
      const currentHandles = [...getHandles()].filter(handle => !ignored.has(handle));
      const currentRequests = [...getRequests()];
      return {
        baselineHandles: currentHandles.filter(handle => baselineHandleIdentities.has(handle)),
        baselineRequests: currentRequests.filter(request => baselineRequestIdentities.has(request)),
        handles: currentHandles.filter(handle => !baselineHandleIdentities.has(handle)),
        requests: currentRequests.filter(request => !baselineRequestIdentities.has(request)),
      };
    },
  });
}
