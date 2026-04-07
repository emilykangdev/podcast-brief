-- All existing briefs are pre-launch test data — reclassify from PRODUCTION to STAGING.
UPDATE public.briefs SET environment = 'STAGING' WHERE environment = 'PRODUCTION';

-- Old briefs stored transcriptId (UUID) in input_url instead of the Apple Podcasts URL.
-- The new API route writes the actual URL, but old rows need backfilling so regeneration works.
-- Joins on briefs.input_url = transcripts.id (the old UUID pattern) to pull the real apple_url.
UPDATE public.briefs b
SET input_url = t.apple_url
FROM public.transcripts t
WHERE b.input_url = t.id::text
  AND b.input_url NOT LIKE 'https://%';
