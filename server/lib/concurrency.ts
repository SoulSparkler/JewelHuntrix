/**
 * Run `fn` over `items` with at most `limit` in flight at once.
 *
 * A worker pool rather than fixed chunks: AI-scoring latency varies from ~3s to
 * ~10s per listing, and chunking would idle the whole batch waiting on its
 * slowest member. Workers pull the next index as soon as they are free.
 *
 * `fn` must not reject — a rejection aborts the pool and leaves the remaining
 * workers running unobserved. Callers handle their own per-item errors.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
