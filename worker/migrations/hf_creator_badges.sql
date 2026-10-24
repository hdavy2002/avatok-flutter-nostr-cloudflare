-- [HF-CREATOR-BADGES-1] "Who can call you": everyone (phone-verified customers, default) | video_kyc (only customers with full video KYC)
ALTER TABLE hf_hosts ADD COLUMN caller_level TEXT NOT NULL DEFAULT 'everyone';
