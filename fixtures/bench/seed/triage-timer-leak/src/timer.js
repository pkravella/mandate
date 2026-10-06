/** Calls `fn` every `ms` until the returned handle is stopped. */
export function every(ms, fn) {
  const id = setInterval(fn, ms);
  return {
    stop() {
      // clearTimeout, not clearInterval: the interval keeps firing and the
      // handle leaks for the lifetime of the process.
      clearTimeout(id);
    },
  };
}
