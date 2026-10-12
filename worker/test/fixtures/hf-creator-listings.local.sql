-- LOCAL TEST FIXTURE ONLY. Never use a deployment/migration runner for this file.
-- The test harness must first create TEMP TABLE hf_fixture_guard(value TEXT) and insert 'local_test'.
-- This intentionally fails on a database without that explicitly supplied guard.
CREATE TEMP TABLE hf_fixture_assert (ok INTEGER CHECK(ok=1));
INSERT INTO hf_fixture_assert SELECT CASE WHEN COUNT(*)=1 AND MIN(value)='local_test' THEN 1 ELSE 0 END FROM temp.hf_fixture_guard;

-- All fake examples stay offline drafts, with no fabricated identity, KYC, voice, followers or reviews.
INSERT OR IGNORE INTO hf_hosts(uid,slug,status,category,display_name,about,tagline,price_per_min,languages_json,topics_json,created_at,updated_at)
VALUES
('fixture_creator_anya','demo-anya-aaaa','draft','influencer','Anya','A fictional host for local layout review.','Films and everyday stories',20,'["Hindi","English"]','["kisi-topic-pe-baat"]',1,1),
('fixture_creator_kabir','demo-kabir-bbbb','draft','influencer','Kabir','A fictional host for local layout review.','Cricket and friendly conversation',40,'["Hindi"]','["bas-baat-karni-hai"]',1,1),
('fixture_creator_meera','demo-meera-cccc','draft','celebrity','Meera','A fictional host for local layout review.','A conversation about creative work',100,'["English","Tamil"]','["english-mein-casual-chat"]',1,1);
DROP TABLE temp.hf_fixture_assert;
