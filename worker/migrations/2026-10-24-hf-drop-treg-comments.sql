-- [HF-CHANNEL-LOGIN-P1] (HF-REEL-59) One-off cleanup, DML only, DB_META: drop the Instagram comments imported through treg, except ones our users
-- replied to (a visible reply in hf_reel_comments with parent_id = the imported comment id), so those conversations stay.
DELETE FROM hf_reel_ext_comments
 WHERE platform = 'instagram'
   AND NOT EXISTS (SELECT 1 FROM hf_reel_comments oc WHERE oc.parent_id = hf_reel_ext_comments.id AND oc.status = 'visible');
