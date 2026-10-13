-- Save the 18 kept rows' pre-merge metadata so the merge is exactly reversible
CREATE TABLE public.thoughts_dedup_kept_meta_20261011 AS
SELECT id, metadata, updated_at, now() AS backed_up_at
FROM public.thoughts
WHERE id IN (SELECT kept_id FROM public.thoughts_dedup_backup_20261011);
ALTER TABLE public.thoughts_dedup_kept_meta_20261011 ADD PRIMARY KEY (id);
ALTER TABLE public.thoughts_dedup_kept_meta_20261011 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.thoughts_dedup_kept_meta_20261011 FROM anon, authenticated;

DO $merge$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.thoughts_dedup_backup_20261011;
  IF v_n <> 25 THEN RAISE EXCEPTION 'backup has % rows, expected 25', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.thoughts_dedup_kept_meta_20261011;
  IF v_n <> 18 THEN RAISE EXCEPTION 'kept-meta has % rows, expected 18', v_n; END IF;

WITH b AS (SELECT * FROM public.thoughts_dedup_backup_20261011),
members AS (
  SELECT t.id AS kept_id, t.created_at, t.metadata FROM public.thoughts t WHERE t.id IN (SELECT kept_id FROM b)
  UNION ALL
  SELECT b.kept_id, b.created_at, b.metadata FROM b
),
elems AS (
  SELECT m.kept_id, k.key, e.value, min(m.created_at) AS first_seen, min(e.ord) AS ord
  FROM members m
  CROSS JOIN unnest(ARRAY['topics','people','action_items','dates_mentioned']) AS k(key)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(m.metadata->k.key) = 'array' THEN m.metadata->k.key ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS e(value, ord)
  GROUP BY m.kept_id, k.key, e.value
),
arrs AS (
  SELECT kept_id, jsonb_object_agg(key, arr) AS obj FROM (
    SELECT kept_id, key, jsonb_agg(value ORDER BY first_seen, ord) AS arr FROM elems GROUP BY kept_id, key
  ) x GROUP BY kept_id
),
extras AS (
  SELECT kept_id, jsonb_agg(to_jsonb(id::text) ORDER BY created_at, id) AS ids FROM b GROUP BY kept_id
),
types AS (
  SELECT b.kept_id, jsonb_agg(DISTINCT b.metadata->'type') AS mt
  FROM b JOIN public.thoughts k ON k.id = b.kept_id
  WHERE b.metadata ? 'type' AND (b.metadata->'type') IS DISTINCT FROM (k.metadata->'type')
  GROUP BY b.kept_id
),
newmeta AS (
  SELECT x.kept_id,
         coalesce(t.metadata, '{}'::jsonb) || coalesce(a.obj, '{}'::jsonb)
           || jsonb_build_object('merged_duplicate_ids', x.ids, 'merged_at', now())
           || CASE WHEN ty.mt IS NOT NULL THEN jsonb_build_object('merged_types', ty.mt) ELSE '{}'::jsonb END AS md
  FROM extras x
  JOIN public.thoughts t ON t.id = x.kept_id
  LEFT JOIN arrs a ON a.kept_id = x.kept_id
  LEFT JOIN types ty ON ty.kept_id = x.kept_id
)

  UPDATE public.thoughts t
     SET metadata = nm.md, updated_at = now()
    FROM newmeta nm
   WHERE t.id = nm.kept_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 18 THEN RAISE EXCEPTION 'merged % kept rows, expected 18', v_n; END IF;

  DELETE FROM public.thoughts
   WHERE id IN (SELECT id FROM public.thoughts_dedup_backup_20261011);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 25 THEN RAISE EXCEPTION 'deleted % rows, expected 25', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.thoughts;
  IF v_n <> 160 THEN RAISE EXCEPTION 'thoughts has % rows, expected 160', v_n; END IF;

  SELECT count(*) INTO v_n FROM (
    SELECT 1 FROM public.thoughts
    GROUP BY encode(sha256(convert_to(lower(trim(regexp_replace(content,'\s+',' ','g'))),'UTF8')),'hex')
    HAVING count(*) > 1) d;
  IF v_n <> 0 THEN RAISE EXCEPTION '% fingerprint collisions remain', v_n; END IF;
END
$merge$;
