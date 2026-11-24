-- Schéma initial. À exécuter une fois sur la base PostgreSQL.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE techniciens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    nom TEXT NOT NULL CHECK (char_length(nom) BETWEEN 1 AND 80),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'TECHNICIEN'
        CHECK (role IN ('ADMIN', 'TECHNICIEN')),
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT techniciens_account_id_fkey
        FOREIGN KEY (account_id) REFERENCES techniciens(id)
);

CREATE INDEX techniciens_account_idx ON techniciens (account_id);

CREATE TABLE parametres_atelier (
    account_id UUID PRIMARY KEY REFERENCES techniciens(id) ON DELETE CASCADE,
    statistiques_depuis DATE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    nom TEXT NOT NULL DEFAULT '',
    telephone TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT clients_account_telephone_uidx UNIQUE (account_id, telephone),
    CONSTRAINT clients_id_account_uidx UNIQUE (id, account_id),
    CONSTRAINT clients_account_id_fkey FOREIGN KEY (account_id) REFERENCES techniciens(id)
);

CREATE INDEX clients_account_created_idx
    ON clients (account_id, created_at DESC);

CREATE TABLE sessions_techniciens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    technicien_id UUID NOT NULL REFERENCES techniciens(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sessions_technicien_expiry_idx
    ON sessions_techniciens (technicien_id, expires_at);

CREATE TABLE password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    technicien_id UUID NOT NULL REFERENCES techniciens(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX password_reset_technicien_idx
    ON password_reset_tokens (technicien_id, expires_at);

CREATE TABLE auth_login_attempts (
    key_hash TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX auth_login_attempt_window_idx
    ON auth_login_attempts (window_started_at);

CREATE TABLE workshop_account_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nom TEXT NOT NULL CHECK (char_length(nom) BETWEEN 1 AND 80),
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONFIRMED')),
    code_hash TEXT,
    code_expires_at TIMESTAMPTZ,
    code_attempts INTEGER NOT NULL DEFAULT 0,
    ip_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ
);

CREATE TABLE appareils_reparation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    client_id UUID NOT NULL,
    type_appareil TEXT NOT NULL DEFAULT 'TELEPHONE'
        CONSTRAINT appareils_type_appareil_check CHECK (type_appareil IN ('TELEPHONE', 'TABLETTE', 'ORDINATEUR')),
    marque TEXT NOT NULL,
    modele TEXT NOT NULL DEFAULT '',
    panne TEXT NOT NULL,
    statut TEXT NOT NULL DEFAULT 'DEPOT'
        CHECK (statut IN ('DEPOT', 'EN_COURS', 'PRET', 'LIVRE')),
    prix_convenu NUMERIC(12, 2) CHECK (prix_convenu IS NULL OR prix_convenu >= 0),
    prix_devise TEXT NOT NULL DEFAULT 'USD'
        CONSTRAINT appareils_prix_devise_check CHECK (prix_devise IN ('USD', 'CDF')),
    frais_usd NUMERIC(12, 2) NOT NULL DEFAULT 0
        CONSTRAINT appareils_frais_usd_check CHECK (frais_usd >= 0),
    frais_cdf NUMERIC(12, 2) NOT NULL DEFAULT 0
        CONSTRAINT appareils_frais_cdf_check CHECK (frais_cdf >= 0),
    frais_usd_saisis_at TIMESTAMPTZ,
    frais_cdf_saisis_at TIMESTAMPTZ,
    urgent BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    request_key UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT appareils_account_request_key_uidx UNIQUE (account_id, request_key),
    CONSTRAINT appareils_id_account_uidx UNIQUE (id, account_id),
    CONSTRAINT appareils_account_id_fkey FOREIGN KEY (account_id) REFERENCES techniciens(id),
    CONSTRAINT appareils_client_account_fkey FOREIGN KEY (client_id, account_id)
        REFERENCES clients(id, account_id)
);

CREATE INDEX appareils_account_status_created_idx
    ON appareils_reparation (account_id, statut, created_at DESC)
    WHERE archived_at IS NULL;
CREATE INDEX appareils_statut_created_idx
    ON appareils_reparation (statut, created_at DESC)
    WHERE archived_at IS NULL;
CREATE INDEX appareils_urgent_idx
    ON appareils_reparation (urgent, created_at DESC)
    WHERE archived_at IS NULL;

CREATE TABLE actes_approbation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appareil_id UUID NOT NULL UNIQUE,
    account_id UUID NOT NULL,
    clause TEXT NOT NULL,
    type_validation TEXT NOT NULL CHECK (type_validation IN ('SIGNATURE')),
    signature_data TEXT NOT NULL,
    valide_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT actes_account_id_fkey FOREIGN KEY (appareil_id, account_id)
        REFERENCES appareils_reparation(id, account_id)
);

CREATE TABLE paiements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appareil_id UUID NOT NULL,
    account_id UUID NOT NULL,
    montant NUMERIC(12, 2) NOT NULL CHECK (montant > 0),
    devise TEXT NOT NULL CHECK (devise IN ('USD', 'CDF')),
    request_key UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT paiements_account_request_key_uidx UNIQUE (account_id, request_key),
    CONSTRAINT paiements_account_id_fkey FOREIGN KEY (appareil_id, account_id)
        REFERENCES appareils_reparation(id, account_id)
);

CREATE INDEX paiements_account_created_idx
    ON paiements (account_id, created_at DESC);
CREATE INDEX paiements_appareil_created_idx
    ON paiements (appareil_id, created_at DESC);
CREATE INDEX paiements_created_idx
    ON paiements (created_at DESC);

CREATE TABLE push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appareil_id UUID NOT NULL REFERENCES appareils_reparation(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (appareil_id, endpoint)
);

CREATE INDEX push_subscriptions_appareil_idx
    ON push_subscriptions (appareil_id);

-- Un acte signé est un enregistrement d'archive : aucune modification/suppression.
CREATE FUNCTION refuser_modification_acte() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Un acte d’approbation archivé ne peut pas être modifié ni supprimé';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER actes_approbation_immuables
    BEFORE UPDATE OR DELETE ON actes_approbation
    FOR EACH ROW EXECUTE FUNCTION refuser_modification_acte();

CREATE FUNCTION refuser_modification_paiement() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Un paiement enregistré ne peut pas être modifié ni supprimé';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paiements_immuables
    BEFORE UPDATE OR DELETE ON paiements
    FOR EACH ROW EXECUTE FUNCTION refuser_modification_paiement();
