/**
 * Instance Request Throttle Utility
 * Staggers outbound broker requests per instance ID so multiple concurrent calls to the
 * same instance (e.g. a health ping and an analyzer-status check) don't fire back-to-back.
 * Extracted from instance.service.js - shared by the health-check and analyzer-mode
 * services, so it lives in utils rather than being owned by (or duplicated across) either.
 */

const INSTANCE_REQUEST_DELAY_MS = 300;
const instanceRequestTimestamps = new Map();

export async function staggeredInstanceRequest(instanceId, fn) {
  const last = instanceRequestTimestamps.get(instanceId) || 0;
  const now = Date.now();
  const wait = INSTANCE_REQUEST_DELAY_MS - (now - last);
  if (wait > 0) {
    await new Promise(resolve => setTimeout(resolve, wait));
  }

  try {
    return await fn();
  } finally {
    instanceRequestTimestamps.set(instanceId, Date.now());
  }
}
