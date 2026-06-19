-- Adds users.bio — free-text self-description that AvaBrain learns from.
--
-- The canonical schema (cfnative.sql) already declares `bio TEXT` in the users
-- CREATE TABLE, so databases created from scratch already have this column. This
-- migration is ONLY for D1 instances provisioned before bio was added.
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so this errors with
-- "duplicate column name: bio" if the column already exists — that error is
-- SAFE TO IGNORE (it means the column is already there). Apply once per legacy DB.
ALTER TABLE users ADD COLUMN bio TEXT;
