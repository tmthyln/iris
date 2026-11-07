-- Migration number: 0012 	 2026-11-04T00:00:00.000Z

-- The R2 key of the audio an episode's transcripts were made from. Publishers
-- stitch different ads into each request, so a transcript's timestamps only
-- hold for that exact file, and the player has to play it.
ALTER TABLE feed_item ADD COLUMN pinned_audio_key TEXT;
