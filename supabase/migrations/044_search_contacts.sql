-- ============================================================
-- 044_search_contacts — one search path, including custom fields
--
-- The Contacts page had two ways to fetch a page of rows: a plain
-- PostgREST select when no tag filter was active, and the
-- `filter_contacts_by_tags` RPC from migration 025 when one was. Only
-- the second could search server-side, and neither could match a
-- custom-field value.
--
-- That last part is the reason for this migration. The consumer number
-- — the identifier this business actually uses for a customer — lives
-- in `contact_custom_values`, not on `contacts`, so it was unsearchable
-- even though the column is now on screen. Matching it client-side is
-- the same trap migration 025 documents: select the matching value rows,
-- collect their contact ids, then feed them back through `.in('id', …)`,
-- which silently caps around 1000 rows and breaks both the total count
-- and pagination.
--
-- So: one function covering both cases. `p_tag_ids` NULL or empty means
-- "no tag filter", which lets the client stop branching entirely. The
-- search arm gains an EXISTS over `contact_custom_values`, so typing a
-- consumer number finds its contact.
--
-- This replaces `filter_contacts_by_tags`, whose name no longer
-- describes what it does and which had exactly one caller. Migration 025
-- remains the record of how it was defined.
--
-- Security: SECURITY INVOKER (the default), like 025 — the function runs
-- as the caller, so RLS on `contacts`, `contact_tags` and
-- `contact_custom_values` (migration 017) scopes results to the caller's
-- account. `contact_custom_values_select` admits any account member, so
-- the new EXISTS is visible to every role that can see the contact.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.search_contacts(
  p_tag_ids UUID[] DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    -- EXISTS rather than a JOIN for the tag arm: a contact carrying
    -- several of the selected tags matched once per tag under the join,
    -- which needed a DISTINCT to undo. No duplicates to remove here.
    SELECT c.id, c.created_at
    FROM contacts c
    WHERE (
      p_tag_ids IS NULL
      OR cardinality(p_tag_ids) = 0
      OR EXISTS (
        SELECT 1 FROM contact_tags ct
        WHERE ct.contact_id = c.id
          AND ct.tag_id = ANY(p_tag_ids)
      )
    )
    AND (
      p_search IS NULL
      OR c.name ILIKE '%' || p_search || '%'
      OR c.phone ILIKE '%' || p_search || '%'
      OR c.email ILIKE '%' || p_search || '%'
      -- Any custom field, not just the consumer number — whatever the
      -- account defines is searchable by the same box.
      OR EXISTS (
        SELECT 1 FROM contact_custom_values v
        WHERE v.contact_id = c.id
          AND v.value ILIKE '%' || p_search || '%'
      )
    )
  ),
  page AS (
    -- count(*) OVER() is evaluated before LIMIT, so it is the full
    -- match total regardless of the page being returned.
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.search_contacts(UUID[], TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_contacts(UUID[], TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_contacts(UUID[], TEXT, INT, INT) TO authenticated;

-- Superseded by the function above; its single caller now uses that one.
DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT);
