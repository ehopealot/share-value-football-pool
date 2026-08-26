-- Monotonic claim token used to prevent an older overlapping provider poll from replacing newer state.
ALTER TABLE odds_ingestion ADD COLUMN poll_generation INTEGER NOT NULL DEFAULT 0;
