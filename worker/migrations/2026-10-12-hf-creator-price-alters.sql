-- [HF-CREATOR-PRICE-1] Schema only. Apply deliberately before deploying the corresponding Worker.
-- Existing hosts remain Standard. Never seed fake listings through a production migration.
ALTER TABLE hf_hosts ADD COLUMN category TEXT NOT NULL DEFAULT 'standard' CHECK(category IN ('standard','influencer','celebrity'));
ALTER TABLE hf_hosts ADD COLUMN private_phone_enc TEXT;
ALTER TABLE hf_hosts ADD COLUMN listing_revision INTEGER NOT NULL DEFAULT 1;
