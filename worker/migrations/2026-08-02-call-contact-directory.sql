-- Server-readable, privacy-minimised contact membership used only for call
-- admission. Names and raw phone numbers never enter D1: AvaTOK contacts are
-- stored by uid and device contacts by sha256(E.164).
CREATE TABLE IF NOT EXISTS call_contact_directory (
  owner_uid   TEXT NOT NULL,
  contact_key TEXT NOT NULL,
  contact_uid TEXT,
  phone_hash  TEXT,
  source      TEXT NOT NULL CHECK (source IN ('avatok', 'device')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (owner_uid, contact_key)
);
CREATE INDEX IF NOT EXISTS idx_call_contact_uid
  ON call_contact_directory(owner_uid, contact_uid);
CREATE INDEX IF NOT EXISTS idx_call_contact_phone
  ON call_contact_directory(owner_uid, phone_hash);

CREATE TABLE IF NOT EXISTS call_contact_directory_sync (
  owner_uid  TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('avatok', 'device')),
  count      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_uid, source)
);
