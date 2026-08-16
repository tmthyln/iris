-- Migration number: 0009 	 2026-05-28T01:00:00.000Z

ALTER TABLE transcript ADD COLUMN batch_request_id TEXT;
