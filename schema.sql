-- Schéma initial. À exécuter une fois sur la base PostgreSQL.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nom TEXT NOT NULL DEFAULT '',
    telephone TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE techniciens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nom TEXT NOT NULL CHECK (char_length(nom) BETWEEN 1 AND 80),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'TECHNICIEN'
        CHECK (role IN ('ADMIN', 'TECHNICIEN')),
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE appareils_reparation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id),
    marque TEXT NOT NULL,
    modele TEXT NOT NULL DEFAULT '',
    panne TEXT NOT NULL,
    statut TEXT NOT NULL DEFAULT 'DEPOT'
        CHECK (statut IN ('DEPOT', 'EN_COURS', 'PRET', 'LIVRE')),
    prix_convenu NUMERIC(12, 2) CHECK (prix_convenu IS NULL OR prix_convenu >= 0),
    prix_devise TEXT NOT NULL DEFAULT 'USD'
        CONSTRAINT appareils_prix_devise_check CHECK (prix_devise IN ('USD', 'CDF')),
    urgent BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    request_key UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX appareils_statut_created_idx
    ON appareils_reparation (statut, created_at DESC)
    WHERE archived_at IS NULL;
CREATE INDEX appareils_urgent_idx
    ON appareils_reparation (urgent, created_at DESC)
    WHERE archived_at IS NULL;

CREATE TABLE actes_approbation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appareil_id UUID NOT NULL UNIQUE REFERENCES appareils_reparation(id),
    clause TEXT NOT NULL,
    type_validation TEXT NOT NULL CHECK (type_validation IN ('SIGNATURE')),
    signature_data TEXT NOT NULL,
    valide_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE paiements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appareil_id UUID NOT NULL REFERENCES appareils_reparation(id),
    montant NUMERIC(12, 2) NOT NULL CHECK (montant > 0),
    devise TEXT NOT NULL CHECK (devise IN ('USD', 'CDF')),
    request_key UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX paiements_appareil_created_idx
    ON paiements (appareil_id, created_at DESC);
CREATE INDEX paiements_created_idx
    ON paiements (created_at DESC);

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
