-- @scope: platform
-- 050: Widen judge rating from 0..5 to 0..100.
-- Scale any existing ratings by ×20 so relative ordering is preserved
-- (1→20, 2→40, 3→60, 4→80, 5→100). Zero stays zero.
-- Drop constraint BEFORE the UPDATE — scaling 1..5 to 20..100 would violate
-- the existing 0..5 check if the constraint is still in place.

ALTER TABLE hackathon_submission_ratings
  DROP CONSTRAINT IF EXISTS hackathon_submission_ratings_rating_check;

UPDATE hackathon_submission_ratings
   SET rating = rating * 20
 WHERE rating BETWEEN 1 AND 5;

ALTER TABLE hackathon_submission_ratings
  ADD CONSTRAINT hackathon_submission_ratings_rating_check
    CHECK (rating BETWEEN 0 AND 100);
