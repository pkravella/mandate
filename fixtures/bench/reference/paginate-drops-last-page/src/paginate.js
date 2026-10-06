/**
 * Walks a paginated fetcher until it reports no more pages.
 *
 * `fetchPage(n)` resolves with `{ items, hasMore }`.
 */
export async function collectAll(fetchPage) {
  const all = [];
  let page = 0;
  for (;;) {
    const result = await fetchPage(page);
    all.push(...result.items);
    if (!result.hasMore) break;
    page += 1;
  }
  return all;
}
