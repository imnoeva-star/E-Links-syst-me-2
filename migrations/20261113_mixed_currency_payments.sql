BEGIN;

-- Les anciens prix étaient affichés en FC dans l’application.
ALTER TABLE appareils_reparation
    ADD COLUMN IF NOT EXISTS prix_devise TEXT;
UPDATE appareils_reparation
    SET prix_devise = 'CDF'
    WHERE prix_devise IS NULL;
ALTER TABLE appareils_reparation
    ALTER COLUMN prix_devise SET DEFAULT 'USD',
    ALTER COLUMN prix_devise SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appareils_prix_devise_check'
          AND conrelid = 'appareils_reparation'::regclass
    ) THEN
        ALTER TABLE appareils_reparation
            ADD CONSTRAINT appareils_prix_devise_check
            CHECK (prix_devise IN ('USD', 'CDF'));
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS paiements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appareil_id UUID NOT NULL REFERENCES appareils_reparation(id),
    montant NUMERIC(12, 2) NOT NULL CHECK (montant > 0),
    devise TEXT NOT NULL CHECK (devise IN ('USD', 'CDF')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paiements_appareil_created_idx
    ON paiements (appareil_id, created_at DESC);
CREATE INDEX IF NOT EXISTS paiements_created_idx
    ON paiements (created_at DESC);

CREATE OR REPLACE FUNCTION refuser_modification_paiement() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Un paiement enregistré ne peut pas être modifié ni supprimé';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'paiements_immuables'
          AND tgrelid = 'paiements'::regclass
          AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER paiements_immuables
            BEFORE UPDATE OR DELETE ON paiements
            FOR EACH ROW EXECUTE FUNCTION refuser_modification_paiement();
    END IF;
END;
$$;

COMMIT;
