BEGIN;

CREATE TABLE IF NOT EXISTS techniciens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nom TEXT NOT NULL CHECK (char_length(nom) BETWEEN 1 AND 80),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions_techniciens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    technicien_id UUID NOT NULL REFERENCES techniciens(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_technicien_expiry_idx
    ON sessions_techniciens (technicien_id, expires_at);

CREATE TABLE IF NOT EXISTS auth_login_attempts (
    key_hash TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_login_attempt_window_idx
    ON auth_login_attempts (window_started_at);

ALTER TABLE appareils_reparation
    ADD COLUMN IF NOT EXISTS request_key UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS appareils_request_key_uidx
    ON appareils_reparation (request_key);

ALTER TABLE paiements
    ADD COLUMN IF NOT EXISTS request_key UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS paiements_request_key_uidx
    ON paiements (request_key);

COMMIT;
