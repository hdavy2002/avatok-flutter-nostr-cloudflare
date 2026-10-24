-- [HF-CREATOR-SPACES-1] total YouTube views per channel + creator type (channel | women | lgbtq)
ALTER TABLE hf_channels ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hf_hosts ADD COLUMN creator_kind TEXT NOT NULL DEFAULT 'channel';
