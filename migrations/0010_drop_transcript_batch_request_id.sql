-- Migration number: 0010 	 2026-10-03T00:00:00.000Z

-- Transcription moved from queue-message polling to a Workflow (#220), which
-- keeps the Whisper batch request ids in its own durable state. Apply this
-- after deploying the Workflow version of the Worker: the old queue consumer
-- still writes batch_request_id.

-- Requests the old pipeline left mid-poll have nothing driving them any more;
-- fail them so they can be requested again. Only the old pipeline ever set
-- batch_request_id, so requests running in the Workflow are left alone. Its
-- pending requests (whose queue message the new consumer drops) cannot be told
-- apart from new ones here; the API fails those when it finds no Workflow
-- instance for them (failIfOrphaned in src/services/transcription.ts).
UPDATE transcript
SET status = 'error',
    error_message = 'Interrupted by a transcription pipeline upgrade; request it again',
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'processing' AND batch_request_id IS NOT NULL;

ALTER TABLE transcript DROP COLUMN batch_request_id;
