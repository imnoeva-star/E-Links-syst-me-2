BEGIN;

ALTER TABLE appareils_reparation
    ADD COLUMN IF NOT EXISTS type_appareil TEXT NOT NULL DEFAULT 'TELEPHONE',
    ADD COLUMN IF NOT EXISTS frais_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS frais_cdf NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS frais_usd_saisis_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS frais_cdf_saisis_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appareils_type_appareil_check'
          AND conrelid = 'appareils_reparation'::regclass
    ) THEN
        ALTER TABLE appareils_reparation
            ADD CONSTRAINT appareils_type_appareil_check
            CHECK (type_appareil IN ('TELEPHONE', 'TABLETTE', 'ORDINATEUR'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appareils_frais_usd_check'
          AND conrelid = 'appareils_reparation'::regclass
    ) THEN
        ALTER TABLE appareils_reparation
            ADD CONSTRAINT appareils_frais_usd_check CHECK (frais_usd >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appareils_frais_cdf_check'
          AND conrelid = 'appareils_reparation'::regclass
    ) THEN
        ALTER TABLE appareils_reparation
            ADD CONSTRAINT appareils_frais_cdf_check CHECK (frais_cdf >= 0);
    END IF;
END;
$$;

COMMIT;
