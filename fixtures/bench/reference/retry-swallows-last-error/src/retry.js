/**
 * Runs `fn`, retrying up to `attempts` times.
 *
 * Resolves with the first successful result. If every attempt fails, the last
 * error is rethrown.
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
  throw lastError;
}
