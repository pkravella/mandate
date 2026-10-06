/**
 * Walks a paginated fetcher until it reports no more pages.
 *
 * `fetchPage(n)` resolves with `{ items, hasMore }`.
 */
export async function collectAll(fetchPage) {
  const all = [];
  let page = 0;
  let result = await fetchPage(page);
  // The loop appends BEFORE checking hasMore on the next page, but it exits on
  // the current page's flag -- so the final page's items are fetched and then
  // discarded.
  while (result.hasMore) {
    all.push(...result.items);
    page += 1;
    result = await fetchPage(page);
  }
  return all;
}
