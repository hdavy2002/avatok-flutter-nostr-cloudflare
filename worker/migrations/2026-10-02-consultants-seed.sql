-- [AUMFE-CONSULT-FOUNDATION-1 2026-10-02] Launch personas (draft, unattached: admin attaches each real consultant's
-- account and replaces the photo). Seed reviews are seed=1 and NEVER shown publicly (previewers see them labelled).
INSERT OR IGNORE INTO consultants (id, slug, name, disciplines_json, photo_url, photo_hero_url, tagline, bio, lineage, city, languages_json, years, rate_rupees, rate_floor, rate_ceil, slot_minutes, status, is_seed, sort_order, created_at, updated_at) VALUES
('cn_seed_gurdev', 'gurdev-singh-bedi', 'Gurdev Singh Bedi', '["astrology"]', '/images/consultants/gurdev-singh-bedi.jpg', '/images/consultants/gurdev-singh-bedi-hero.jpg',
 'Plain answers on career, marriage timing and your dasha.', 'Reads janam kundlis in Amritsar. Plain answers on career, marriage timing and your dasha — and only the remedies the shastras prescribe.', NULL, 'Amritsar', '["Punjabi","Hindi","English"]', 46, 1000, 300, 5000, 30, 'draft', 1, 10, 1790900000000, 1790900000000),
('cn_seed_meenakshi', 'meenakshi-raghavan', 'Meenakshi Raghavan', '["numerology"]', '/images/consultants/meenakshi-raghavan.jpg', '/images/consultants/meenakshi-raghavan-hero.jpg',
 'Your name, birth date and everyday numbers, read together.', 'Your name, your birth date and the numbers you live with every day — mobile, house, business. She reads them together and tells you which ones work for you.', NULL, 'Chennai', '["Tamil","Hindi","English"]', 19, 600, 300, 5000, 30, 'draft', 1, 20, 1790900000000, 1790900000000),
('cn_seed_kamla', 'kamla-bisht', 'Kamla Bisht', '["palmistry","face_reading"]', '/images/consultants/kamla-bisht.jpg', '/images/consultants/kamla-bisht-hero.jpg',
 'Samudrika Shastra — palm and face, read before you call.', 'Samudrika Shastra from Dehradun. She studies the photo of your palm or face before you call, then talks you through what it shows.', NULL, 'Dehradun', '["Garhwali","Hindi"]', 28, 700, 300, 5000, 30, 'draft', 1, 30, 1790900000000, 1790900000000),
('cn_seed_anjali', 'anjali-desai', 'Anjali Desai', '["tarot"]', '/images/consultants/anjali-desai.jpg', '/images/consultants/anjali-desai-hero.jpg',
 'You draw the cards; she helps you think the choice through.', 'You draw your own three cards while booking — love, work and money. Anjali reads the spread before your call and helps you think through the choice in front of you.', NULL, 'Mumbai', '["Hindi","Marathi","English"]', 9, 500, 300, 5000, 30, 'draft', 1, 40, 1790900000000, 1790900000000);

INSERT OR IGNORE INTO consultant_availability (consultant_id, weekday, start_hm, end_hm) VALUES
('cn_seed_gurdev',1,'10:00','13:00'),('cn_seed_gurdev',2,'10:00','13:00'),('cn_seed_gurdev',3,'10:00','13:00'),('cn_seed_gurdev',4,'10:00','13:00'),('cn_seed_gurdev',5,'10:00','13:00'),('cn_seed_gurdev',6,'10:00','13:00'),
('cn_seed_gurdev',1,'17:00','19:00'),('cn_seed_gurdev',3,'17:00','19:00'),('cn_seed_gurdev',5,'17:00','19:00'),
('cn_seed_meenakshi',1,'16:00','19:00'),('cn_seed_meenakshi',2,'16:00','19:00'),('cn_seed_meenakshi',3,'16:00','19:00'),('cn_seed_meenakshi',4,'16:00','19:00'),('cn_seed_meenakshi',5,'16:00','19:00'),
('cn_seed_kamla',1,'09:00','11:00'),('cn_seed_kamla',2,'09:00','11:00'),('cn_seed_kamla',3,'09:00','11:00'),('cn_seed_kamla',4,'09:00','11:00'),('cn_seed_kamla',5,'09:00','11:00'),('cn_seed_kamla',6,'09:00','11:00'),
('cn_seed_kamla',1,'16:00','18:00'),('cn_seed_kamla',3,'16:00','18:00'),('cn_seed_kamla',5,'16:00','18:00'),
('cn_seed_anjali',1,'18:00','21:00'),('cn_seed_anjali',2,'18:00','21:00'),('cn_seed_anjali',3,'18:00','21:00'),('cn_seed_anjali',4,'18:00','21:00'),('cn_seed_anjali',5,'18:00','21:00'),('cn_seed_anjali',6,'18:00','21:00');

INSERT OR IGNORE INTO consult_reviews (id, consultant_id, stars, text, display_name, discipline, status, seed, created_at) VALUES
('cr_seed_g1','cn_seed_gurdev',5,'He told me straight that my job change should wait until after March. Calm, no drama, no costly remedies.','Harpreet K.','astrology','approved',1,1790800000000),
('cr_seed_g2','cn_seed_gurdev',5,'Explained our kundli milan gun by gun. My parents were on the call too and understood everything.','Neha S.','astrology','approved',1,1790700000000),
('cr_seed_g3','cn_seed_gurdev',4,'Very knowledgeable. Thirty minutes ran short for all my questions — I will book again.','Vikram R.','astrology','approved',1,1790600000000),
('cr_seed_m1','cn_seed_meenakshi',5,'Checked five names for my shop in one call and explained why two of them clash with my date.','Sandeep G.','numerology','approved',1,1790800000000),
('cr_seed_m2','cn_seed_meenakshi',5,'She did not push me to change my name — just showed me the numbers and let me decide.','Lakshmi V.','numerology','approved',1,1790700000000),
('cr_seed_k1','cn_seed_kamla',5,'She had already studied my palm photo — the call was all about me, not about setting up.','Pooja N.','palmistry','approved',1,1790800000000),
('cr_seed_k2','cn_seed_kamla',5,'Spoke to me in Garhwali. Felt like talking to my nani.','Arun M.','face_reading','approved',1,1790700000000),
('cr_seed_a1','cn_seed_anjali',5,'Seeing the cards pop up on my phone while she explained them made it feel real.','Divya I.','tarot','approved',1,1790800000000),
('cr_seed_a2','cn_seed_anjali',4,'Kind and practical. She helped me think, she did not just predict.','Sneha P.','tarot','approved',1,1790700000000);
