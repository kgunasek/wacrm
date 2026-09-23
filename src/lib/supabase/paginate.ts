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
