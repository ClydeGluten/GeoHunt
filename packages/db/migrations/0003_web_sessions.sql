ALTER TABLE auth_sessions DROP CONSTRAINT session_identity_valid;
ALTER TABLE auth_sessions ADD CONSTRAINT session_identity_valid CHECK (
  (kind IN ('TELEGRAM', 'WEB') AND account_id IS NOT NULL AND participant_id IS NULL) OR
  (kind = 'GUEST' AND participant_id IS NOT NULL AND account_id IS NULL)
);
