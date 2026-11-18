BEGIN;

ALTER TABLE techniciens
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'TECHNICIEN';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'techniciens_role_check'
          AND conrelid = 'techniciens'::regclass
    ) THEN
        ALTER TABLE techniciens
            ADD CONSTRAINT techniciens_role_check
            CHECK (role IN ('ADMIN', 'TECHNICIEN'));
    END IF;
END;
$$;

COMMIT;
