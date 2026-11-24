BEGIN;

CREATE TABLE IF NOT EXISTS workshop_account_requests (
  id UUID PRIMARY KEY,
  nom VARCHAR(80) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONFIRMED')),
  code_hash VARCHAR(64),
  code_expires_at TIMESTAMPTZ,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  ip_hash VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS workshop_account_requests_status_created_idx
  ON workshop_account_requests(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS workshop_account_requests_active_email_uidx
  ON workshop_account_requests(email)
  WHERE status IN ('PENDING', 'APPROVED');

COMMIT;
