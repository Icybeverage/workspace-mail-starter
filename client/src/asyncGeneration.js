/** Bump-on-invalidate token for ignoring stale async completions. */
export function createAsyncGeneration() {
  let generation = 0;

  return {
    begin() {
      generation += 1;
      return generation;
    },
    invalidate() {
      generation += 1;
    },
    isActive(token) {
      return token === generation;
    }
  };
}
