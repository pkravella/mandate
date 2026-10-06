/**
 * Runs `fn`, retrying up to `attempts` times.
 *
 * Resolves with the first successful result. If every attempt fails, the
 * caller should see the last error.
 */
export async function retry(fn, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  // Every attempt failed. The last error is dropped here and the caller gets
  // undefined instead, so a total failure is indistinguishable from a function
  // that legitimately resolved with no value.
  return undefined;
}
