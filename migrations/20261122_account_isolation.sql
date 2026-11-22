BEGIN;

ALTER TABLE techniciens
    ADD COLUMN IF NOT EXISTS account_id UUID;

UPDATE techniciens
SET account_id = id,
    role = CASE WHEN role = 'TECHNICIEN' THEN 'ADMIN' ELSE role END
WHERE account_id IS NULL;

ALTER TABLE techniciens
    ALTER COLUMN account_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS techniciens_account_idx
    ON techniciens (account_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'techniciens_account_id_fkey'
          AND conrelid = 'techniciens'::regclass
    ) THEN
        ALTER TABLE techniciens
            ADD CONSTRAINT techniciens_account_id_fkey
            FOREIGN KEY (account_id) REFERENCES techniciens(id);
    END IF;
END;
$$;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS account_id UUID;

UPDATE clients AS c
SET account_id = owner.id
FROM (
    SELECT id
    FROM techniciens
    WHERE role = 'ADMIN' AND account_id = id
    ORDER BY created_at, id
    LIMIT 1
) AS owner
WHERE c.account_id IS NULL;

ALTER TABLE clients
    ALTER COLUMN account_id SET NOT NULL,
    DROP CONSTRAINT IF EXISTS clients_telephone_key;

CREATE UNIQUE INDEX IF NOT EXISTS clients_account_telephone_uidx
    ON clients (account_id, telephone);
CREATE UNIQUE INDEX IF NOT EXISTS clients_id_account_uidx
    ON clients (id, account_id);
CREATE INDEX IF NOT EXISTS clients_account_created_idx
    ON clients (account_id, created_at DESC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'clients_account_id_fkey'
          AND conrelid = 'clients'::regclass
    ) THEN
        ALTER TABLE clients
            ADD CONSTRAINT clients_account_id_fkey
            FOREIGN KEY (account_id) REFERENCES techniciens(id);
    END IF;
END;
$$;

ALTER TABLE appareils_reparation
    ADD COLUMN IF NOT EXISTS account_id UUID;

UPDATE appareils_reparation AS a
SET account_id = owner.id
FROM (
    SELECT id
    FROM techniciens
    WHERE role = 'ADMIN' AND account_id = id
    ORDER BY created_at, id
    LIMIT 1
) AS owner
WHERE a.account_id IS NULL;

ALTER TABLE appareils_reparation
    ALTER COLUMN account_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS appareils_id_account_uidx
    ON appareils_reparation (id, account_id);
ALTER TABLE appareils_reparation
    DROP CONSTRAINT IF EXISTS appareils_reparation_request_key_key;
DROP INDEX IF EXISTS appareils_request_key_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS appareils_account_request_key_uidx
    ON appareils_reparation (account_id, request_key);
CREATE INDEX IF NOT EXISTS appareils_account_status_created_idx
    ON appareils_reparation (account_id, statut, created_at DESC)
    WHERE archived_at IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appareils_account_id_fkey'
          AND conrelid = 'appareils_reparation'::regclass
    ) THEN
        ALTER TABLE appareils_reparation
            ADD CONSTRAINT appareils_account_id_fkey
            FOREIGN KEY (account_id) REFERENCES techniciens(id);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appareils_client_account_fkey'
          AND conrelid = 'appareils_reparation'::regclass
    ) THEN
        ALTER TABLE appareils_reparation
            ADD CONSTRAINT appareils_client_account_fkey
            FOREIGN KEY (client_id, account_id)
            REFERENCES clients(id, account_id);
    END IF;
END;
$$;

ALTER TABLE actes_approbation
    DISABLE TRIGGER actes_approbation_immuables;
ALTER TABLE actes_approbation
    ADD COLUMN IF NOT EXISTS account_id UUID;
UPDATE actes_approbation AS acte
SET account_id = a.account_id
FROM appareils_reparation AS a
WHERE acte.appareil_id = a.id AND acte.account_id IS NULL;
ALTER TABLE actes_approbation
    ENABLE TRIGGER actes_approbation_immuables;

ALTER TABLE actes_approbation
    ALTER COLUMN account_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'actes_account_id_fkey'
          AND conrelid = 'actes_approbation'::regclass
    ) THEN
        ALTER TABLE actes_approbation
            ADD CONSTRAINT actes_account_id_fkey
            FOREIGN KEY (appareil_id, account_id)
            REFERENCES appareils_reparation(id, account_id);
    END IF;
END;
$$;

ALTER TABLE paiements
    DISABLE TRIGGER paiements_immuables;
ALTER TABLE paiements
    ADD COLUMN IF NOT EXISTS account_id UUID;
UPDATE paiements AS p
SET account_id = a.account_id
FROM appareils_reparation AS a
WHERE p.appareil_id = a.id AND p.account_id IS NULL;
ALTER TABLE paiements
    ENABLE TRIGGER paiements_immuables;

ALTER TABLE paiements
    ALTER COLUMN account_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS paiements_account_created_idx
    ON paiements (account_id, created_at DESC);
ALTER TABLE paiements
    DROP CONSTRAINT IF EXISTS paiements_request_key_key;
DROP INDEX IF EXISTS paiements_request_key_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS paiements_account_request_key_uidx
    ON paiements (account_id, request_key);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'paiements_account_id_fkey'
          AND conrelid = 'paiements'::regclass
    ) THEN
        ALTER TABLE paiements
            ADD CONSTRAINT paiements_account_id_fkey
            FOREIGN KEY (appareil_id, account_id)
            REFERENCES appareils_reparation(id, account_id);
    END IF;
END;
$$;

COMMIT;
