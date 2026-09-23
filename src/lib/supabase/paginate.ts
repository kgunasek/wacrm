const PAGE_SIZE = 1000

/**
 * Fetch every row matching a query, paginating past PostgREST's default
 * row cap (1000 per request — Supabase's `db-max-rows` default).
 *
 * Any `.select(...).eq(...)...` chain without an explicit `.range()`
 * silently truncates at that cap with no error — a broadcast audience
 * of 2,510 tagged contacts (or "Send to All" against 8,861 contacts)
 * quietly resolved to only the first 1,000, under-delivering the rest
 * with no indication anything was wrong.
 *
 * Usage — build the query fresh each page, add `.range()` last:
 *   const rows = await fetchAllRows((from, to) =>
 *     supabase.from('contact_tags').select('contact_id').in('tag_id', ids).range(from, to)
 *   )
 */
export async function fetchAllRows<T>(
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  let start = 0
  for (;;) {
    const { data, error } = await build(start, start + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
    start += PAGE_SIZE
  }
  return rows
}

const ID_CHUNK_SIZE = 200

/**
 * Fetch rows matching a large set of ids, chunked to keep each request's
 * `.in()` filter small.
 *
 * A single `.in('id', ids)` with a few thousand UUIDs builds a query
 * string tens of KB long (2,510 UUIDs ≈ 93KB) — large enough that the
 * request fails at the transport level (`TypeError: Failed to fetch` in
 * the browser, `TypeError: fetch failed` in Node), not with a graceful
 * HTTP error. This is exactly what an audience this large hits once
 * `fetchAllRows` above correctly stops under-counting it.
 */
export async function fetchRowsByIds<T>(
  ids: string[],
  build: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + ID_CHUNK_SIZE)
    const { data, error } = await build(chunk)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
  }
  return rows
}
