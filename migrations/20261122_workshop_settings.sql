BEGIN;

CREATE TABLE IF NOT EXISTS parametres_atelier (
    account_id UUID PRIMARY KEY REFERENCES techniciens(id) ON DELETE CASCADE,
    statistiques_depuis DATE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
