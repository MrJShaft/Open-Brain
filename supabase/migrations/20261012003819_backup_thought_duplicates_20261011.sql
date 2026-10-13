CREATE TABLE public.thoughts_dedup_backup_20261011 AS
WITH f AS (
  SELECT t.*, encode(sha256(convert_to(lower(trim(regexp_replace(t.content,'\s+',' ','g'))),'UTF8')),'hex') AS fp
  FROM public.thoughts t
), r AS (
  SELECT f.*,
         row_number() OVER (PARTITION BY fp ORDER BY created_at, id) AS rn,
         first_value(id) OVER (PARTITION BY fp ORDER BY created_at, id) AS kept_id,
         count(*) OVER (PARTITION BY fp) AS n
  FROM f
)
SELECT id, content, embedding, metadata, created_at, updated_at, content_fingerprint,
       kept_id, now() AS backed_up_at
FROM r WHERE n > 1 AND rn > 1;

ALTER TABLE public.thoughts_dedup_backup_20261011 ADD PRIMARY KEY (id);
ALTER TABLE public.thoughts_dedup_backup_20261011 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.thoughts_dedup_backup_20261011 FROM anon, authenticated;
