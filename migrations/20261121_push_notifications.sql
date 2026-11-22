BEGIN;

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appareil_id UUID NOT NULL REFERENCES appareils_reparation(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (appareil_id, endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_appareil_idx
    ON push_subscriptions (appareil_id);

COMMIT;
