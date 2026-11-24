const express = require('express');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const db = require('../db');
const pushNotifications = require('../push-notifications');
const auth = require('./auth');
const { hashPassword, requireTechnician } = require('../auth');

const router = express.Router();
const STATUTS = new Set(['DEPOT', 'EN_COURS', 'PRET', 'LIVRE']);
const DEVICE_TYPES = new Set(['TELEPHONE', 'TABLETTE', 'ORDINATEUR']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAUSE_SORTIE =
  'Appareil testé et accepté par le client. Aucune réclamation ne sera acceptée après 48 heures.';
const REPORT_PERIODS = {
  day: { range: 'day', bucket: 'hour', step: 'hour', format: 'HH24' },
  week: { range: 'week', bucket: 'day', step: 'day', format: 'YYYY-MM-DD' },
  month: { range: 'month', bucket: 'day', step: 'day', format: 'YYYY-MM-DD' },
  year: { range: 'year', bucket: 'month', step: 'month', format: 'YYYY-MM' },
};

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validRequestKey(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validVersion(value) {
  return value === undefined || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
}

function validPushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (
        hostname === 'fcm.googleapis.com' ||
        hostname === 'push.services.mozilla.com' ||
        hostname.endsWith('.push.services.mozilla.com') ||
        hostname.endsWith('.push.apple.com') ||
        hostname.endsWith('.notify.windows.com')
      );
  } catch {
    return false;
  }
}

function patchMatchesDevice(device, body) {
  if (body.statut !== undefined && body.statut !== device.statut) return false;
  if (body.urgent !== undefined && body.urgent !== device.urgent) return false;
  if (Object.prototype.hasOwnProperty.call(body, 'prix_convenu')) {
    const currentPrice = device.prix_convenu === null ? null : Number(device.prix_convenu);
    if (currentPrice !== body.prix_convenu || device.prix_devise !== body.prix_devise) return false;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'frais_usd')) {
    if (
      Number(device.frais_usd || 0) !== body.frais_usd ||
      Number(device.frais_cdf || 0) !== body.frais_cdf
    ) return false;
  }
  return true;
}

function normalizeTelephone(value) {
  return value.trim().replace(/[\s().-]/g, '');
}

function validDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function kinshasaDateOnly() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kinshasa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function paymentMatches(payment, appareilId, montant, devise) {
  return (
    payment.appareil_id === appareilId &&
    Number(payment.montant) === montant &&
    payment.devise === devise
  );
}

function requireAdmin(req, res, next) {
  if (req.technicien.role !== 'ADMIN') {
    return res.status(403).json({ erreur: 'Réservé au propriétaire de l’atelier.' });
  }
  next();
}

function validWorkshopName(value) {
  return typeof value === 'string' &&
    value.trim().length >= 1 &&
    value.trim().length <= 80;
}

function validWorkshopEmail(value) {
  return typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.use('/auth', auth);
router.param('id', (req, res, next, id) => {
  if (!UUID_PATTERN.test(id)) return res.status(400).json({ erreur: 'Identifiant d’appareil invalide.' });
  next();
});

router.get('/public/appareils/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT type_appareil, marque, modele, statut, updated_at::text AS updated_at
       FROM appareils_reparation
       WHERE id = $1 AND archived_at IS NULL`,
      [req.params.id],
    );
    if (!result.rowCount) return res.status(404).json({ erreur: 'Dossier introuvable.' });
    res.json({
      appareil: result.rows[0],
      push_public_key: pushNotifications.getPublicKey(),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/public/appareils/:id/notifications', async (req, res, next) => {
  const subscription = req.body && req.body.subscription;
  const endpoint = subscription && subscription.endpoint;
  const keys = subscription && subscription.keys;
  if (!pushNotifications.getPublicKey()) {
    return res.status(503).json({ erreur: 'Les notifications Push ne sont pas configurées.' });
  }
  if (
    !validPushEndpoint(endpoint) ||
    !keys ||
    typeof keys.p256dh !== 'string' ||
    !/^[A-Za-z0-9_-]{20,200}$/.test(keys.p256dh) ||
    typeof keys.auth !== 'string' ||
    !/^[A-Za-z0-9_-]{16,100}$/.test(keys.auth)
  ) {
    return res.status(400).json({ erreur: 'Abonnement Push invalide.' });
  }
  try {
    const appareil = await db.query(
      `SELECT statut FROM appareils_reparation
       WHERE id = $1 AND archived_at IS NULL`,
      [req.params.id],
    );
    if (!appareil.rowCount) return res.status(404).json({ erreur: 'Dossier introuvable.' });
    if (appareil.rows[0].statut === 'LIVRE') {
      return res.status(409).json({ erreur: 'Cet appareil a déjà été restitué.' });
    }
    await db.query(
      `INSERT INTO push_subscriptions (appareil_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (appareil_id, endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.params.id, endpoint, keys.p256dh, keys.auth],
    );
    if (appareil.rows[0].statut === 'PRET') {
      await pushNotifications.notifySubscription(subscription, req.params.id);
    }
    res.status(201).json({ active: true });
  } catch (error) {
    next(error);
  }
});

router.delete('/public/appareils/:id/notifications', async (req, res, next) => {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 2048) {
    return res.status(400).json({ erreur: 'Abonnement Push invalide.' });
  }
  try {
    await db.query(
      'DELETE FROM push_subscriptions WHERE appareil_id = $1 AND endpoint = $2',
      [req.params.id, endpoint],
    );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.use(requireTechnician);

router.get('/workshop-requests', requireAdmin, async (req, res, next) => {
  try {
    const primary = await db.query(
      `SELECT id FROM techniciens
       WHERE role = 'ADMIN' AND account_id = id
       ORDER BY created_at, id
       LIMIT 1`,
    );
    if (!primary.rowCount || primary.rows[0].id !== req.technicien.account_id) {
      return res.status(403).json({ erreur: 'Seul l’administrateur principal peut traiter les demandes.' });
    }
    await db.query(`
      UPDATE workshop_account_requests
      SET status = 'EXPIRED'
      WHERE status = 'APPROVED'
        AND code_expires_at IS NOT NULL
        AND code_expires_at <= NOW()
    `);
    const result = await db.query(
      `SELECT id, nom, email, status, code_expires_at::text AS code_expires_at,
              code_attempts, created_at::text AS created_at, reviewed_at::text AS reviewed_at
       FROM workshop_account_requests
       WHERE status IN ('PENDING', 'APPROVED')
       ORDER BY created_at DESC`,
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post('/workshop-requests/:id/approve', requireAdmin, async (req, res, next) => {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ erreur: 'Demande invalide.' });
  }
  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    const primary = await client.query(
      `SELECT id FROM techniciens
       WHERE role = 'ADMIN' AND account_id = id
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE`,
    );
    if (!primary.rowCount || primary.rows[0].id !== req.technicien.account_id) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ erreur: 'Seul l’administrateur principal peut approuver.' });
    }
    const requestResult = await client.query(
      `SELECT id, email FROM workshop_account_requests
       WHERE id = $1 AND status = 'PENDING'
       FOR UPDATE`,
      [req.params.id],
    );
    if (!requestResult.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ erreur: 'Cette demande n’est plus en attente.' });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    await client.query(
      `UPDATE workshop_account_requests
       SET status = 'APPROVED', code_hash = $2,
           code_expires_at = NOW() + INTERVAL '3 minutes',
           code_attempts = 0, reviewed_at = NOW()
       WHERE id = $1`,
      [req.params.id, codeHash],
    );
    await client.query('COMMIT');
    transactionStarted = false;
    res.json({
      code,
      expires_in_seconds: 180,
      email: requestResult.rows[0].email,
    });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(`Échec d’annulation de l’approbation (${rollbackError.code || 'connexion'}).`);
      }
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

router.post('/workshop-requests/:id/reject', requireAdmin, async (req, res, next) => {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ erreur: 'Demande invalide.' });
  }
  try {
    const primary = await db.query(
      `SELECT id FROM techniciens
       WHERE role = 'ADMIN' AND account_id = id
       ORDER BY created_at, id
       LIMIT 1`,
    );
    if (!primary.rowCount || primary.rows[0].id !== req.technicien.account_id) {
      return res.status(403).json({ erreur: 'Seul l’administrateur principal peut refuser.' });
    }
    const result = await db.query(
      `UPDATE workshop_account_requests
       SET status = 'REJECTED', reviewed_at = NOW()
       WHERE id = $1 AND status = 'PENDING'
       RETURNING id`,
      [req.params.id],
    );
    if (!result.rowCount) return res.status(409).json({ erreur: 'Cette demande n’est plus en attente.' });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/workshops', requireAdmin, async (req, res, next) => {
  return res.status(403).json({
    erreur: 'Créez les ateliers via une demande approuvée par code temporaire.',
  });
  const { nom, email, password, confirmation } = req.body || {};
  if (
    !validWorkshopName(nom) ||
    !validWorkshopEmail(email) ||
    typeof password !== 'string' ||
    password.length < 6 ||
    password.length > 12 ||
    password !== confirmation
  ) {
    return res.status(400).json({
      erreur: 'Vérifiez le nom, l’e-mail et le mot de passe (6 à 12 caractères).',
    });
  }

  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    const primary = await client.query(
      `SELECT id
       FROM techniciens
       WHERE role = 'ADMIN' AND account_id = id
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE`,
    );
    if (!primary.rowCount || primary.rows[0].id !== req.technicien.account_id) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({
        erreur: 'Seul l’administrateur principal peut créer un nouvel atelier.',
      });
    }

    const accountId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const account = await client.query(
      `INSERT INTO techniciens (id, account_id, nom, email, password_hash, role)
       VALUES ($1, $1, $2, LOWER($3), $4, 'ADMIN')
       ON CONFLICT (email) DO NOTHING
       RETURNING id, account_id, nom, email, role`,
      [accountId, nom.trim(), email.trim(), passwordHash],
    );
    if (!account.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ erreur: 'Cette adresse e-mail est déjà utilisée.' });
    }
    await client.query('COMMIT');
    transactionStarted = false;
    res.status(201).json(account.rows[0]);
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(`Échec d’annulation de la création d’ateliers (${rollbackError.code || 'connexion'}).`);
      }
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

router.get('/settings', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT statistiques_depuis::text AS statistiques_depuis FROM parametres_atelier WHERE account_id = $1',
      [req.technicien.account_id],
    );
    res.json({ statistiques_depuis: result.rows[0]?.statistiques_depuis || null });
  } catch (error) {
    next(error);
  }
});

router.patch('/settings', requireAdmin, async (req, res, next) => {
  const { statistiques_depuis: startDate } = req.body || {};
  if (
    (startDate !== null && !validDateOnly(startDate)) ||
    (typeof startDate === 'string' && startDate > kinshasaDateOnly())
  ) {
    return res.status(400).json({ erreur: 'Choisissez une date valide, qui n’est pas dans le futur.' });
  }
  try {
    const result = await db.query(
      `INSERT INTO parametres_atelier (account_id, statistiques_depuis)
       VALUES ($1, $2::date)
       ON CONFLICT (account_id) DO UPDATE
         SET statistiques_depuis = EXCLUDED.statistiques_depuis, updated_at = NOW()
       RETURNING statistiques_depuis::text AS statistiques_depuis`,
      [req.technicien.account_id, startDate],
    );
    res.json({ statistiques_depuis: result.rows[0].statistiques_depuis });
  } catch (error) {
    next(error);
  }
});

router.get('/export', requireAdmin, async (req, res, next) => {
  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionStarted = true;
    const [settings, clients, appareils, paiements, actes] = await Promise.all([
      client.query(
        'SELECT statistiques_depuis::text AS statistiques_depuis FROM parametres_atelier WHERE account_id = $1',
        [req.technicien.account_id],
      ),
      client.query(
        'SELECT * FROM clients WHERE account_id = $1 ORDER BY created_at, id',
        [req.technicien.account_id],
      ),
      client.query(
        'SELECT * FROM appareils_reparation WHERE account_id = $1 ORDER BY created_at, id',
        [req.technicien.account_id],
      ),
      client.query(
        'SELECT * FROM paiements WHERE account_id = $1 ORDER BY created_at, id',
        [req.technicien.account_id],
      ),
      client.query(
        'SELECT * FROM actes_approbation WHERE account_id = $1 ORDER BY valide_at, id',
        [req.technicien.account_id],
      ),
    ]);
    await client.query('COMMIT');
    transactionStarted = false;
    const generatedAt = new Date();
    res.setHeader('Content-Disposition', `attachment; filename="atelier-express-sauvegarde-${generatedAt.toISOString().slice(0, 10)}.json"`);
    res.json({
      format: 'atelier-express-backup',
      version: 1,
      generated_at: generatedAt.toISOString(),
      account_id: req.technicien.account_id,
      parametres: settings.rows[0] || { statistiques_depuis: null },
      clients: clients.rows,
      appareils_reparation: appareils.rows,
      paiements: paiements.rows,
      actes_approbation: actes.rows,
    });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(`Échec d’annulation de l’export (${rollbackError.code || 'connexion'}).`);
      }
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

// Recherche rapide et création/réutilisation du client par numéro de téléphone.
router.get('/clients', async (req, res, next) => {
  const rawTelephone = typeof req.query.telephone === 'string' ? req.query.telephone : '';
  const telephone = normalizeTelephone(rawTelephone);
  if (telephone.length < 3) return res.json([]);
  if (telephone.length > 20 || !/^\+?[0-9]+$/.test(telephone)) {
    return res.status(400).json({ erreur: 'Numéro de téléphone invalide.' });
  }
  try {
    const result = await db.query(
      `SELECT id, nom, telephone
       FROM clients
       WHERE account_id = $2
         AND regexp_replace(telephone, '[^0-9+]', '', 'g') ILIKE $1
       ORDER BY created_at DESC
       LIMIT 8`,
      [`%${telephone}%`, req.technicien.account_id],
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.get('/reports/revenue', async (req, res, next) => {
  const periodName = req.query.period;
  if (
    typeof periodName !== 'string' ||
    !Object.prototype.hasOwnProperty.call(REPORT_PERIODS, periodName)
  ) {
    return res.status(400).json({ erreur: 'Période de bilan invalide.' });
  }
  const period = REPORT_PERIODS[periodName];

  try {
    const result = await db.query(`
      WITH local_now AS (
        SELECT NOW() AT TIME ZONE 'Africa/Kinshasa' AS instant_local
      ),
      period_bounds AS (
        SELECT
          date_trunc('${period.range}', instant_local) AS start_local,
          date_trunc('${period.range}', instant_local) + INTERVAL '1 ${period.range}' AS end_local
        FROM local_now
      ),
      statistics_settings AS (
        SELECT (
          SELECT statistiques_depuis
          FROM parametres_atelier
          WHERE account_id = $1
        ) AS start_date
      ),
      buckets AS (
        SELECT generate_series(
          period_bounds.start_local,
          period_bounds.end_local - INTERVAL '1 ${period.step}',
          INTERVAL '1 ${period.step}'
        ) AS bucket
        FROM period_bounds
      ),
      revenue AS (
        SELECT
          date_trunc('${period.bucket}', p.created_at AT TIME ZONE 'Africa/Kinshasa') AS bucket,
          SUM(p.montant) FILTER (WHERE p.devise = 'USD') AS usd,
          SUM(p.montant) FILTER (WHERE p.devise = 'CDF') AS cdf
        FROM paiements p
        JOIN appareils_reparation a ON a.id = p.appareil_id AND a.account_id = p.account_id
        JOIN actes_approbation acte ON acte.appareil_id = a.id AND acte.account_id = a.account_id
        CROSS JOIN period_bounds
        CROSS JOIN statistics_settings
        WHERE a.statut = 'LIVRE'
          AND a.account_id = $1
          AND p.account_id = $1
          AND a.archived_at IS NULL
          AND p.created_at >= (period_bounds.start_local AT TIME ZONE 'Africa/Kinshasa')
          AND p.created_at < (period_bounds.end_local AT TIME ZONE 'Africa/Kinshasa')
          AND (
            statistics_settings.start_date IS NULL OR
            p.created_at >= (statistics_settings.start_date::timestamp AT TIME ZONE 'Africa/Kinshasa')
          )
        GROUP BY 1
      )
      SELECT
        to_char(buckets.bucket, '${period.format}') AS bucket,
        COALESCE(revenue.usd, 0) AS usd,
        COALESCE(revenue.cdf, 0) AS cdf
      FROM buckets
      LEFT JOIN revenue USING (bucket)
      ORDER BY buckets.bucket
    `, [req.technicien.account_id]);
    res.json({ period: periodName, points: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get('/reports/personal', async (req, res, next) => {
  const periodName = req.query.period;
  if (
    typeof periodName !== 'string' ||
    !Object.prototype.hasOwnProperty.call(REPORT_PERIODS, periodName)
  ) {
    return res.status(400).json({ erreur: 'Période de bilan invalide.' });
  }
  const period = REPORT_PERIODS[periodName];

  try {
    const result = await db.query(`
      WITH personal_local_now AS (
        SELECT NOW() AT TIME ZONE 'Africa/Kinshasa' AS instant_local
      ),
      period_bounds AS (
        SELECT
          date_trunc('${period.range}', instant_local) AS start_local,
          date_trunc('${period.range}', instant_local) + INTERVAL '1 ${period.range}' AS end_local
        FROM personal_local_now
      ),
      statistics_settings AS (
        SELECT (
          SELECT statistiques_depuis
          FROM parametres_atelier
          WHERE account_id = $1
        ) AS start_date
      )
      SELECT
        COALESCE((
          SELECT SUM(p.montant) FILTER (WHERE p.devise = 'USD')
          FROM paiements p
          CROSS JOIN period_bounds
          CROSS JOIN statistics_settings
          WHERE p.account_id = $1
            AND p.created_at >= (period_bounds.start_local AT TIME ZONE 'Africa/Kinshasa')
            AND p.created_at < (period_bounds.end_local AT TIME ZONE 'Africa/Kinshasa')
            AND (
              statistics_settings.start_date IS NULL OR
              p.created_at >= (statistics_settings.start_date::timestamp AT TIME ZONE 'Africa/Kinshasa')
            )
        ), 0) AS encaissements_usd,
        COALESCE((
          SELECT SUM(p.montant) FILTER (WHERE p.devise = 'CDF')
          FROM paiements p
          CROSS JOIN period_bounds
          CROSS JOIN statistics_settings
          WHERE p.account_id = $1
            AND p.created_at >= (period_bounds.start_local AT TIME ZONE 'Africa/Kinshasa')
            AND p.created_at < (period_bounds.end_local AT TIME ZONE 'Africa/Kinshasa')
            AND (
              statistics_settings.start_date IS NULL OR
              p.created_at >= (statistics_settings.start_date::timestamp AT TIME ZONE 'Africa/Kinshasa')
            )
        ), 0) AS encaissements_cdf,
        COALESCE((
          SELECT SUM(a.frais_usd)
          FROM appareils_reparation a
          CROSS JOIN period_bounds
          CROSS JOIN statistics_settings
          WHERE a.account_id = $1
            AND a.frais_usd_saisis_at >= (period_bounds.start_local AT TIME ZONE 'Africa/Kinshasa')
            AND a.frais_usd_saisis_at < (period_bounds.end_local AT TIME ZONE 'Africa/Kinshasa')
            AND (
              statistics_settings.start_date IS NULL OR
              a.frais_usd_saisis_at >= (statistics_settings.start_date::timestamp AT TIME ZONE 'Africa/Kinshasa')
            )
        ), 0) AS depenses_usd,
        COALESCE((
          SELECT SUM(a.frais_cdf)
          FROM appareils_reparation a
          CROSS JOIN period_bounds
          CROSS JOIN statistics_settings
          WHERE a.account_id = $1
            AND a.frais_cdf_saisis_at >= (period_bounds.start_local AT TIME ZONE 'Africa/Kinshasa')
            AND a.frais_cdf_saisis_at < (period_bounds.end_local AT TIME ZONE 'Africa/Kinshasa')
            AND (
              statistics_settings.start_date IS NULL OR
              a.frais_cdf_saisis_at >= (statistics_settings.start_date::timestamp AT TIME ZONE 'Africa/Kinshasa')
            )
        ), 0) AS depenses_cdf
    `, [req.technicien.account_id]);
    const totals = result.rows[0];
    res.json({
      period: periodName,
      ...totals,
      net_usd: (
        Math.round(Number(totals.encaissements_usd) * 100) -
        Math.round(Number(totals.depenses_usd) * 100)
      ) / 100,
      net_cdf: (
        Math.round(Number(totals.encaissements_cdf) * 100) -
        Math.round(Number(totals.depenses_cdf) * 100)
      ) / 100,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/dashboard', async (req, res, next) => {
  try {
    const result = await db.query(`
      WITH semaine AS (
        SELECT
          date_trunc('week', NOW() AT TIME ZONE 'Africa/Kinshasa')
            AT TIME ZONE 'Africa/Kinshasa' AS debut,
          (date_trunc('week', NOW() AT TIME ZONE 'Africa/Kinshasa') + INTERVAL '1 week')
            AT TIME ZONE 'Africa/Kinshasa' AS fin
      ),
      statistics_settings AS (
        SELECT (
          SELECT statistiques_depuis
          FROM parametres_atelier
          WHERE account_id = $1
        ) AS start_date
      )
      SELECT
        COALESCE((
          SELECT SUM(p.montant) FILTER (WHERE p.devise = 'USD')
          FROM paiements p
          JOIN appareils_reparation a ON a.id = p.appareil_id AND a.account_id = p.account_id
          JOIN actes_approbation acte ON acte.appareil_id = a.id AND acte.account_id = a.account_id
          CROSS JOIN semaine
          CROSS JOIN statistics_settings
          WHERE a.statut = 'LIVRE'
            AND a.account_id = $1
            AND p.account_id = $1
            AND a.archived_at IS NULL
            AND p.created_at >= semaine.debut
            AND p.created_at < semaine.fin
            AND (
              statistics_settings.start_date IS NULL OR
              p.created_at >= (statistics_settings.start_date::timestamp AT TIME ZONE 'Africa/Kinshasa')
            )
        ), 0) AS chiffre_semaine_usd,
        COALESCE((
          SELECT SUM(p.montant) FILTER (WHERE p.devise = 'CDF')
          FROM paiements p
          JOIN appareils_reparation a ON a.id = p.appareil_id AND a.account_id = p.account_id
          JOIN actes_approbation acte ON acte.appareil_id = a.id AND acte.account_id = a.account_id
          CROSS JOIN semaine
          CROSS JOIN statistics_settings
          WHERE a.statut = 'LIVRE'
            AND a.account_id = $1
            AND p.account_id = $1
            AND a.archived_at IS NULL
            AND p.created_at >= semaine.debut
            AND p.created_at < semaine.fin
            AND (
              statistics_settings.start_date IS NULL OR
              p.created_at >= (statistics_settings.start_date::timestamp AT TIME ZONE 'Africa/Kinshasa')
            )
        ), 0) AS chiffre_semaine_cdf,
        COUNT(*) FILTER (WHERE statut <> 'LIVRE') AS appareils_attente,
        COUNT(*) FILTER (WHERE urgent = TRUE AND statut <> 'LIVRE') AS urgents
      FROM appareils_reparation
      WHERE archived_at IS NULL AND account_id = $1
    `, [req.technicien.account_id]);
    const urgents = await db.query(
      `SELECT a.id, a.marque, a.modele, a.panne, a.statut, c.nom, c.telephone
       FROM appareils_reparation a
       JOIN clients c ON c.id = a.client_id AND c.account_id = a.account_id
       WHERE a.account_id = $1 AND a.urgent = TRUE AND a.statut <> 'LIVRE' AND a.archived_at IS NULL
       ORDER BY a.created_at ASC
       LIMIT 10`,
      [req.technicien.account_id],
    );
    const journalier = await db.query(`
      WITH semaine AS (
        SELECT
          date_trunc('week', NOW() AT TIME ZONE 'Africa/Kinshasa')
            AT TIME ZONE 'Africa/Kinshasa' AS debut,
          (date_trunc('week', NOW() AT TIME ZONE 'Africa/Kinshasa') + INTERVAL '1 week')
            AT TIME ZONE 'Africa/Kinshasa' AS fin
      ),
      statistics_settings AS (
        SELECT (
          SELECT statistiques_depuis
          FROM parametres_atelier
          WHERE account_id = $1
        ) AS start_date
      ),
      jours AS (
        SELECT
          ((semaine.debut AT TIME ZONE 'Africa/Kinshasa')::date + numero.jour)::date AS jour
        FROM semaine
        CROSS JOIN generate_series(0, 6) AS numero(jour)
      ),
      paiements_journaliers AS (
        SELECT
          (p.created_at AT TIME ZONE 'Africa/Kinshasa')::date AS jour,
          COALESCE(SUM(p.montant) FILTER (WHERE p.devise = 'USD'), 0) AS usd,
          COALESCE(SUM(p.montant) FILTER (WHERE p.devise = 'CDF'), 0) AS cdf
        FROM paiements p
        JOIN appareils_reparation a ON a.id = p.appareil_id AND a.account_id = p.account_id
        JOIN actes_approbation acte ON acte.appareil_id = a.id AND acte.account_id = a.account_id
        CROSS JOIN semaine
        CROSS JOIN statistics_settings
        WHERE a.statut = 'LIVRE'
          AND a.account_id = $1
          AND p.account_id = $1
          AND a.archived_at IS NULL
          AND p.created_at >= semaine.debut
          AND p.created_at < semaine.fin
          AND (
            statistics_settings.start_date IS NULL OR
            p.created_at >= (statistics_settings.start_date::timestamp AT TIME ZONE 'Africa/Kinshasa')
          )
        GROUP BY 1
      )
      SELECT
        to_char(jours.jour, 'YYYY-MM-DD') AS jour,
        COALESCE(paiements_journaliers.usd, 0) AS usd,
        COALESCE(paiements_journaliers.cdf, 0) AS cdf
      FROM jours
      LEFT JOIN paiements_journaliers USING (jour)
      ORDER BY jours.jour
    `, [req.technicien.account_id]);
    res.json({
      ...result.rows[0],
      encaissements_journaliers: journalier.rows,
      prioritaire: urgents.rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/offline/snapshot', async (req, res, next) => {
  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionStarted = true;
    const clients = await client.query(
      'SELECT id, nom, telephone FROM clients WHERE account_id = $1 ORDER BY created_at DESC',
      [req.technicien.account_id],
    );
    const settings = await client.query(
      'SELECT statistiques_depuis::text AS statistiques_depuis FROM parametres_atelier WHERE account_id = $1',
      [req.technicien.account_id],
    );
    const appareils = await client.query(
      `SELECT a.*, a.updated_at::text AS updated_at,
              c.nom AS client_nom, c.telephone,
              (acte.id IS NOT NULL) AS acte_valide,
              acte.clause, acte.valide_at, acte.signature_data,
              totaux.total_usd AS paiements_usd,
              totaux.total_cdf AS paiements_cdf,
              CASE WHEN a.prix_devise = 'USD' AND a.prix_convenu IS NOT NULL
                   THEN GREATEST(a.prix_convenu - totaux.total_usd, 0)
                   WHEN a.prix_devise = 'CDF' AND a.prix_convenu IS NOT NULL
                   THEN GREATEST(a.prix_convenu - totaux.total_cdf, 0)
                   ELSE NULL
              END AS solde
       FROM appareils_reparation a
       JOIN clients c ON c.id = a.client_id AND c.account_id = a.account_id
       LEFT JOIN actes_approbation acte ON acte.appareil_id = a.id AND acte.account_id = a.account_id
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(montant) FILTER (WHERE devise = 'USD'), 0) AS total_usd,
           COALESCE(SUM(montant) FILTER (WHERE devise = 'CDF'), 0) AS total_cdf
         FROM paiements
         WHERE appareil_id = a.id AND account_id = a.account_id
       ) totaux ON TRUE
       WHERE a.account_id = $1 AND a.archived_at IS NULL
       ORDER BY a.created_at DESC, a.id`,
      [req.technicien.account_id],
    );
    const paiements = await client.query(
      `SELECT p.id, p.appareil_id, p.montant, p.devise, p.request_key,
              p.created_at::text AS created_at
       FROM paiements p
       JOIN appareils_reparation a ON a.id = p.appareil_id AND a.account_id = p.account_id
       WHERE a.account_id = $1 AND p.account_id = $1 AND a.archived_at IS NULL
       ORDER BY p.created_at`,
      [req.technicien.account_id],
    );
    await client.query('COMMIT');
    transactionStarted = false;
    res.json({
      clients: clients.rows,
      appareils: appareils.rows,
      paiements: paiements.rows,
      settings: settings.rows[0] || { statistiques_depuis: null },
      captured_at: new Date().toISOString(),
    });
  } catch (error) {
    if (client && transactionStarted) await client.query('ROLLBACK');
    next(error);
  } finally {
    if (client) client.release();
  }
});

router.get('/appareils', async (req, res, next) => {
  const section = req.query.section === undefined ? 'waiting' : req.query.section;
  const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const searchDigits = search.replace(/\D/g, '');
  const rawPage = req.query.page === undefined ? '1' : req.query.page;
  const status = req.query.status === undefined ? 'ALL' : req.query.status;
  const statusFilters = {
    ALL: '',
    DEPOT: " AND a.statut = 'DEPOT'",
    EN_COURS: " AND a.statut = 'EN_COURS'",
    PRET: " AND a.statut = 'PRET'",
    URGENT: ' AND a.urgent = TRUE',
  };
  if (!['waiting', 'archive', 'removed'].includes(section)) {
    return res.status(400).json({ erreur: 'Section d’appareils invalide.' });
  }
  if (
    typeof rawPage !== 'string' ||
    !/^[1-9]\d*$/.test(rawPage) ||
    Number(rawPage) > 100000 ||
    typeof status !== 'string' ||
    !Object.prototype.hasOwnProperty.call(statusFilters, status) ||
    (section !== 'waiting' && status !== 'ALL') ||
    search.length > 120 ||
    (req.query.q !== undefined && typeof req.query.q !== 'string')
  ) {
    return res.status(400).json({ erreur: 'Recherche ou numéro de page invalide.' });
  }
  const where =
    section === 'archive'
      ? "a.archived_at IS NULL AND a.statut = 'LIVRE'"
      : section === 'removed'
        ? 'a.archived_at IS NOT NULL'
        : `a.archived_at IS NULL AND a.statut <> 'LIVRE'${statusFilters[status]}`;
  const searchFilter =
    "($2 = '' OR position(lower($2) in lower(concat_ws(' ', c.nom, c.telephone, a.marque, a.modele, a.panne))) > 0 OR ($3 <> '' AND position($3 in regexp_replace(c.telephone, '[^0-9]', '', 'g')) > 0))";
  try {
    const listSql =
      `SELECT a.*, a.updated_at::text AS updated_at, c.nom AS client_nom, c.telephone,
              (acte.id IS NOT NULL) AS acte_valide,
              totaux.total_usd AS paiements_usd,
              totaux.total_cdf AS paiements_cdf,
              CASE WHEN a.prix_devise = 'USD' AND a.prix_convenu IS NOT NULL
                   THEN GREATEST(a.prix_convenu - totaux.total_usd, 0)
                   WHEN a.prix_devise = 'CDF' AND a.prix_convenu IS NOT NULL
                   THEN GREATEST(a.prix_convenu - totaux.total_cdf, 0)
                   ELSE NULL
              END AS solde
       FROM appareils_reparation a
       JOIN clients c ON c.id = a.client_id AND c.account_id = a.account_id
       LEFT JOIN actes_approbation acte ON acte.appareil_id = a.id AND acte.account_id = a.account_id
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(montant) FILTER (WHERE devise = 'USD'), 0) AS total_usd,
           COALESCE(SUM(montant) FILTER (WHERE devise = 'CDF'), 0) AS total_cdf
         FROM paiements
         WHERE appareil_id = a.id AND account_id = a.account_id
       ) totaux ON TRUE
       WHERE a.account_id = $1 AND ${where} AND ${searchFilter}
       ORDER BY ${
         section === 'waiting'
           ? 'a.urgent DESC, a.created_at DESC'
           : section === 'removed'
             ? 'a.archived_at DESC'
             : 'a.created_at DESC'
       }, a.id
       LIMIT 50 OFFSET $4`;
    const requestedPage = Number(rawPage);
    const [count, initialResult] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS total
         FROM appareils_reparation a
         JOIN clients c ON c.id = a.client_id
         WHERE a.account_id = $1 AND ${where} AND ${searchFilter}`,
        [req.technicien.account_id, search, searchDigits],
      ),
      db.query(listSql, [
        req.technicien.account_id,
        search,
        searchDigits,
        (requestedPage - 1) * 50,
      ]),
    ]);
    const total = Number(count.rows[0].total);
    const pages = Math.max(1, Math.ceil(total / 50));
    const page = Math.min(requestedPage, pages);
    let result = initialResult;
    if (page !== requestedPage) {
      result = await db.query(listSql, [
        req.technicien.account_id,
        search,
        searchDigits,
        (page - 1) * 50,
      ]);
    }
    res.json({ appareils: result.rows, total, page, pages });
  } catch (error) {
    next(error);
  }
});

router.get('/appareils/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT a.*, a.updated_at::text AS updated_at, c.nom AS client_nom, c.telephone,
              (acte.id IS NOT NULL) AS acte_valide,
              acte.clause,
              acte.valide_at,
              acte.signature_data,
              totaux.total_usd AS paiements_usd,
              totaux.total_cdf AS paiements_cdf,
              CASE WHEN a.prix_devise = 'USD' AND a.prix_convenu IS NOT NULL
                   THEN GREATEST(a.prix_convenu - totaux.total_usd, 0)
                   WHEN a.prix_devise = 'CDF' AND a.prix_convenu IS NOT NULL
                   THEN GREATEST(a.prix_convenu - totaux.total_cdf, 0)
                   ELSE NULL
              END AS solde
       FROM appareils_reparation a
       JOIN clients c ON c.id = a.client_id AND c.account_id = a.account_id
       LEFT JOIN actes_approbation acte ON acte.appareil_id = a.id AND acte.account_id = a.account_id
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(montant) FILTER (WHERE devise = 'USD'), 0) AS total_usd,
           COALESCE(SUM(montant) FILTER (WHERE devise = 'CDF'), 0) AS total_cdf
         FROM paiements
         WHERE appareil_id = a.id AND account_id = a.account_id
       ) totaux ON TRUE
       WHERE a.id = $1 AND a.account_id = $2 AND a.archived_at IS NULL`,
      [req.params.id, req.technicien.account_id],
    );
    if (!result.rowCount) return res.status(404).json({ erreur: 'Appareil introuvable.' });
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.patch('/appareils/:id/details', requireAdmin, async (req, res, next) => {
  const body = req.body || {};
  const telephone = typeof body.telephone === 'string' ? normalizeTelephone(body.telephone) : '';
  const expectedVersion = req.get('X-Record-Version');
  if (
    !validVersion(expectedVersion) ||
    typeof body.nom !== 'string' ||
    body.nom.trim().length > 80 ||
    !/^\+?[0-9]{7,20}$/.test(telephone) ||
    !DEVICE_TYPES.has(body.type_appareil) ||
    !isNonEmptyString(body.marque) ||
    body.marque.trim().length > 60 ||
    typeof body.modele !== 'string' ||
    body.modele.trim().length > 100 ||
    !isNonEmptyString(body.panne) ||
    body.panne.trim().length > 300 ||
    (body.prix_convenu !== null && (
      typeof body.prix_convenu !== 'number' ||
      !Number.isFinite(body.prix_convenu) ||
      body.prix_convenu < 0 ||
      body.prix_convenu > 9999999999.99 ||
      Math.round(body.prix_convenu * 100) !== body.prix_convenu * 100
    )) ||
    !['USD', 'CDF'].includes(body.prix_devise) ||
    typeof body.urgent !== 'boolean'
  ) {
    return res.status(400).json({ erreur: 'Vérifiez les informations du dossier et du client.' });
  }

  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    const current = await client.query(
      `SELECT a.id, a.client_id, a.statut, a.updated_at::text AS updated_at,
              acte.id AS acte_id
       FROM appareils_reparation a
       JOIN clients c ON c.id = a.client_id AND c.account_id = a.account_id
       LEFT JOIN actes_approbation acte ON acte.appareil_id = a.id AND acte.account_id = a.account_id
       WHERE a.id = $1 AND a.account_id = $2 AND a.archived_at IS NULL
       FOR UPDATE OF a, c`,
      [req.params.id, req.technicien.account_id],
    );
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ erreur: 'Dossier introuvable.' });
    }
    if (
      current.rows[0].statut === 'LIVRE' ||
      current.rows[0].acte_id ||
      (
        expectedVersion &&
        Date.parse(current.rows[0].updated_at) !== Date.parse(expectedVersion)
      )
    ) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({
        erreur: current.rows[0].statut === 'LIVRE' || current.rows[0].acte_id
          ? 'Un dossier livré ou signé ne peut plus être modifié. Archivez-le si nécessaire.'
          : 'Ce dossier a changé sur un autre appareil. Rechargez-le avant de réessayer.',
      });
    }
    await client.query(
      'UPDATE clients SET nom = $1, telephone = $2 WHERE id = $3 AND account_id = $4',
      [body.nom.trim(), telephone, current.rows[0].client_id, req.technicien.account_id],
    );
    const updated = await client.query(
      `UPDATE appareils_reparation
       SET type_appareil = $1, marque = $2, modele = $3, panne = $4,
           prix_convenu = $5, prix_devise = $6, urgent = $7, updated_at = NOW()
       WHERE id = $8 AND account_id = $9 AND archived_at IS NULL AND statut <> 'LIVRE'
       RETURNING id, type_appareil, marque, modele, panne, prix_convenu, prix_devise,
                 urgent, updated_at::text AS updated_at`,
      [
        body.type_appareil,
        body.marque.trim(),
        body.modele.trim(),
        body.panne.trim(),
        body.prix_convenu,
        body.prix_devise,
        body.urgent,
        req.params.id,
        req.technicien.account_id,
      ],
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ erreur: 'Ce dossier ne peut plus être modifié.' });
    }
    await client.query('COMMIT');
    transactionStarted = false;
    res.json({
      ...updated.rows[0],
      client_nom: body.nom.trim(),
      telephone,
    });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(`Échec d’annulation de la modification (${rollbackError.code || 'connexion'}).`);
      }
    }
    if (error.code === '23505' && error.constraint === 'clients_account_telephone_uidx') {
      return res.status(409).json({ erreur: 'Ce numéro est déjà associé à un autre client de cet atelier.' });
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

router.post('/appareils/:id/qr', async (req, res, next) => {
  const configuredBaseUrl = process.env.APP_BASE_URL;
  let baseUrl;
  try {
    if (!configuredBaseUrl) throw new Error('APP_BASE_URL absent.');
    baseUrl = new URL(configuredBaseUrl);
    if (
      !['http:', 'https:'].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password ||
      (process.env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:')
    ) {
      throw new Error('APP_BASE_URL invalide.');
    }
  } catch (error) {
    console.error(`Configuration APP_BASE_URL invalide (${error.message}).`);
    return res.status(503).json({ erreur: 'L’adresse publique de l’application n’est pas configurée.' });
  }
  try {
    const appareil = await db.query(
      'SELECT id FROM appareils_reparation WHERE id = $1 AND account_id = $2 AND archived_at IS NULL',
      [req.params.id, req.technicien.account_id],
    );
    if (!appareil.rowCount) return res.status(404).json({ erreur: 'Appareil introuvable.' });
    const trackingUrl = new URL('/suivi', baseUrl);
    trackingUrl.searchParams.set('appareil', req.params.id);
    const qrCode = await QRCode.toDataURL(trackingUrl.toString(), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 280,
    });
    res.json({ url: trackingUrl.toString(), qr_code: qrCode });
  } catch (error) {
    next(error);
  }
});

router.post('/appareils', async (req, res, next) => {
  const body = req.body || {};
  const { id, nom = '', telephone, marque, modele = '', panne, prix_convenu = null, urgent = false } = body;
  const typeAppareil = body.type_appareil === undefined ? 'TELEPHONE' : body.type_appareil;
  const requestKey = req.get('Idempotency-Key');
  if (!validRequestKey(requestKey)) {
    return res.status(400).json({ erreur: 'Clé de requête invalide. Réessayez le dépôt.' });
  }
  if (id !== undefined && !validRequestKey(id)) {
    return res.status(400).json({ erreur: 'Identifiant d’appareil invalide.' });
  }
  if (
    !isNonEmptyString(telephone) ||
    !isNonEmptyString(marque) ||
    !isNonEmptyString(panne) ||
    (typeof nom !== 'string') ||
    (typeof modele !== 'string') ||
    !DEVICE_TYPES.has(typeAppareil)
  ) {
    return res.status(400).json({ erreur: 'Type, téléphone, marque et panne sont obligatoires ou invalides.' });
  }
  const normalizedTelephone = normalizeTelephone(telephone);
  if (!/^\+?[0-9]{7,20}$/.test(normalizedTelephone)) {
    return res.status(400).json({ erreur: 'Numéro de téléphone invalide.' });
  }
  if (nom.trim().length > 80 || modele.trim().length > 100 || marque.trim().length > 60 || panne.trim().length > 500) {
    return res.status(400).json({ erreur: 'Un des champs dépasse la longueur autorisée.' });
  }
  if (typeof urgent !== 'boolean') {
    return res.status(400).json({ erreur: 'La priorité doit être un booléen.' });
  }
  if (
    typeof prix_convenu !== 'number' ||
    !Number.isFinite(prix_convenu) ||
    prix_convenu < 0 ||
    prix_convenu > 9999999999.99 ||
    Math.round(prix_convenu * 100) !== prix_convenu * 100
  ) {
    return res.status(400).json({
      erreur: 'Le prix total convenu est obligatoire et doit être positif ou nul, avec au plus deux décimales.',
    });
  }

  try {
    const prior = await db.query(
      `SELECT a.*, a.updated_at::text AS updated_at, c.telephone FROM appareils_reparation a
       JOIN clients c ON c.id = a.client_id AND c.account_id = a.account_id
       WHERE a.request_key = $1 AND a.account_id = $2`,
      [requestKey, req.technicien.account_id],
    );
    if (prior.rowCount) {
      const device = prior.rows[0];
      const sameRequest =
        (id === undefined || device.id === id) &&
        device.telephone === normalizedTelephone &&
        device.type_appareil === typeAppareil &&
        device.marque === marque.trim() &&
        device.modele === modele.trim() &&
        device.panne === panne.trim() &&
        ((prix_convenu === null && device.prix_convenu === null) ||
          Number(device.prix_convenu) === prix_convenu) &&
        device.urgent === urgent;
      if (!sameRequest) return res.status(409).json({ erreur: 'Cette clé a déjà servi pour un autre dépôt.' });
      const { telephone: _telephone, ...existingDevice } = device;
      return res.status(200).json(existingDevice);
    }
    const result = await db.query(
      `WITH client AS (
         INSERT INTO clients (account_id, nom, telephone)
         VALUES ($10, $2, $3)
         ON CONFLICT (account_id, telephone) DO UPDATE SET nom = CASE
           WHEN EXCLUDED.nom <> '' THEN EXCLUDED.nom
           ELSE clients.nom
         END
         RETURNING id
       )
       INSERT INTO appareils_reparation
         (id, account_id, client_id, type_appareil, marque, modele, panne, prix_convenu, urgent, request_key)
       SELECT COALESCE($1::uuid, gen_random_uuid()), $10, client.id, $11, $4, $5, $6, $7, $8, $9
       FROM client
       ON CONFLICT (account_id, request_key) DO NOTHING
       RETURNING *, updated_at::text AS updated_at`,
      [
        id || null,
        String(nom).trim(),
        normalizedTelephone,
        String(marque).trim(),
        String(modele).trim(),
        String(panne).trim(),
        prix_convenu,
        urgent,
        requestKey,
        req.technicien.account_id,
        typeAppareil,
      ],
    );
    if (result.rowCount) return res.status(201).json(result.rows[0]);
    const existing = await db.query(
      `SELECT a.*, a.updated_at::text AS updated_at, c.telephone FROM appareils_reparation a
       JOIN clients c ON c.id = a.client_id AND c.account_id = a.account_id
       WHERE a.request_key = $1 AND a.account_id = $2`,
      [requestKey, req.technicien.account_id],
    );
    if (existing.rowCount) {
      const device = existing.rows[0];
      const sameRequest =
        (id === undefined || device.id === id) &&
        device.telephone === normalizedTelephone &&
        device.type_appareil === typeAppareil &&
        device.marque === marque.trim() &&
        device.modele === modele.trim() &&
        device.panne === panne.trim() &&
        ((prix_convenu === null && device.prix_convenu === null) ||
          Number(device.prix_convenu) === prix_convenu) &&
        device.urgent === urgent;
      if (!sameRequest) return res.status(409).json({ erreur: 'Cette clé a déjà servi pour un autre dépôt.' });
      const { telephone: _telephone, ...existingDevice } = device;
      return res.status(200).json(existingDevice);
    }
    return res.status(409).json({ erreur: 'Le dépôt n’a pas pu être confirmé. Réessayez.' });
  } catch (error) {
    next(error);
  }
});

router.patch('/appareils/:id', async (req, res, next) => {
  const body = req.body || {};
  const { statut, prix_convenu, urgent } = body;
  const expectedVersion = req.get('X-Record-Version');
  if (!validVersion(expectedVersion)) {
    return res.status(400).json({ erreur: 'Version du dossier invalide.' });
  }
  const hasPrice = Object.prototype.hasOwnProperty.call(body, 'prix_convenu');
  const hasPriceCurrency = Object.prototype.hasOwnProperty.call(body, 'prix_devise');
  const hasExpensesUsd = Object.prototype.hasOwnProperty.call(body, 'frais_usd');
  const hasExpensesCdf = Object.prototype.hasOwnProperty.call(body, 'frais_cdf');
  const hasExpenses = hasExpensesUsd || hasExpensesCdf;
  if (hasPrice !== hasPriceCurrency) {
    return res.status(400).json({ erreur: 'Le prix et sa devise doivent être fournis ensemble.' });
  }
  if (hasExpensesUsd !== hasExpensesCdf) {
    return res.status(400).json({ erreur: 'Les totaux des frais en USD et en FC doivent être fournis ensemble.' });
  }
  if (hasPriceCurrency && !['USD', 'CDF'].includes(body.prix_devise)) {
    return res.status(400).json({ erreur: 'La devise du prix doit être USD ou CDF.' });
  }
  if (statut !== undefined && (!STATUTS.has(statut) || statut === 'LIVRE')) {
    return res.status(400).json({
      erreur: statut === 'LIVRE'
        ? 'La restitution exige l’enregistrement d’un acte signé.'
        : 'Statut non valide.',
    });
  }
  if (urgent !== undefined && typeof urgent !== 'boolean') {
    return res.status(400).json({ erreur: 'La priorité doit être un booléen.' });
  }
  if (hasExpenses && ['frais_usd', 'frais_cdf'].some((field) => (
    typeof body[field] !== 'number' ||
    !Number.isFinite(body[field]) ||
    body[field] < 0 ||
    body[field] > 9999999999.99 ||
    Math.round(body[field] * 100) !== body[field] * 100
  ))) {
    return res.status(400).json({ erreur: 'Les frais doivent être des montants positifs ou nuls avec au plus deux décimales.' });
  }
  if (prix_convenu !== undefined && prix_convenu !== null) {
    if (
      typeof prix_convenu !== 'number' ||
      !Number.isFinite(prix_convenu) ||
      prix_convenu < 0 ||
      prix_convenu > 9999999999.99
    ) {
      return res.status(400).json({ erreur: 'Le prix convenu doit être un nombre positif.' });
    }
    if (Math.round(prix_convenu * 100) !== prix_convenu * 100) {
      return res.status(400).json({ erreur: 'Le prix convenu doit avoir au plus deux décimales.' });
    }
  }
  try {
    const result = await db.query(
      `WITH current_device AS (
         SELECT id, statut
         FROM appareils_reparation
         WHERE id = $1 AND account_id = $8 AND archived_at IS NULL
         FOR UPDATE
       ),
       updated_device AS (
         UPDATE appareils_reparation AS a
         SET statut = COALESCE($2, a.statut),
             prix_convenu = CASE WHEN $3::boolean THEN $4::numeric ELSE a.prix_convenu END,
             urgent = COALESCE($5, a.urgent),
             prix_devise = CASE WHEN $3::boolean THEN $6::text ELSE a.prix_devise END,
             frais_usd = CASE WHEN $9::boolean THEN $10::numeric ELSE a.frais_usd END,
             frais_cdf = CASE WHEN $9::boolean THEN $11::numeric ELSE a.frais_cdf END,
             frais_usd_saisis_at = CASE
               WHEN $9::boolean AND a.frais_usd IS DISTINCT FROM $10::numeric THEN NOW()
               ELSE a.frais_usd_saisis_at
             END,
             frais_cdf_saisis_at = CASE
               WHEN $9::boolean AND a.frais_cdf IS DISTINCT FROM $11::numeric THEN NOW()
               ELSE a.frais_cdf_saisis_at
             END,
             updated_at = NOW()
         FROM current_device AS previous
         WHERE a.id = previous.id AND a.account_id = $8
           AND a.archived_at IS NULL
           AND ($7::timestamptz IS NULL OR a.updated_at = $7::timestamptz)
           AND (
             previous.statut <> 'LIVRE' OR
             ($9::boolean AND $2::text IS NULL AND NOT $3::boolean AND $5::boolean IS NULL)
           )
           AND (
             $2::text IS NULL OR previous.statut = $2 OR
             ($2 = 'EN_COURS' AND previous.statut = 'DEPOT') OR
             ($2 = 'PRET' AND previous.statut = 'EN_COURS')
           )
         RETURNING a.*, a.updated_at::text AS updated_at, previous.statut AS previous_statut
       )
       SELECT * FROM updated_device`,
      [
        req.params.id,
        statut || null,
        hasPrice,
        prix_convenu === undefined ? null : prix_convenu,
        urgent === undefined ? null : urgent,
        body.prix_devise === undefined ? null : body.prix_devise,
        expectedVersion || null,
        req.technicien.account_id,
        hasExpenses,
        hasExpenses ? body.frais_usd : null,
        hasExpenses ? body.frais_cdf : null,
      ],
    );
    if (!result.rowCount) {
      const current = await db.query(
        'SELECT *, updated_at::text AS updated_at FROM appareils_reparation WHERE id = $1 AND account_id = $2 AND archived_at IS NULL',
        [req.params.id, req.technicien.account_id],
      );
      if (!current.rowCount) return res.status(404).json({ erreur: 'Appareil introuvable.' });
      if (expectedVersion && current.rows[0].updated_at !== expectedVersion) {
        if (patchMatchesDevice(current.rows[0], body)) return res.json(current.rows[0]);
        return res.status(409).json({
          erreur: 'Ce dossier a changé sur un autre appareil. Rechargez-le avant de réessayer.',
        });
      }
      if (current.rows[0].statut === 'LIVRE') {
        if (hasExpenses && statut === undefined && !hasPrice && urgent === undefined) {
          return res.status(409).json({ erreur: 'Ces frais ont déjà changé. Rechargez le dossier avant de réessayer.' });
        }
        return res.status(409).json({ erreur: 'Un appareil livré ne peut plus être modifié.' });
      }
      return res.status(409).json({ erreur: 'Respectez l’ordre des étapes : dépôt, en cours, puis prêt.' });
    }
    const { previous_statut: previousStatus, ...device } = result.rows[0];
    if (previousStatus === 'EN_COURS' && device.statut === 'PRET') {
      pushNotifications.notifyReady(device.id).catch((error) => {
        console.error(`Échec d’envoi de l’alerte « appareil prêt » (${error.code || error.message}).`);
      });
    }
    res.json(device);
  } catch (error) {
    next(error);
  }
});

router.post('/appareils/:id/paiements', async (req, res, next) => {
  const body = req.body || {};
  const { montant, devise } = body;
  const requestKey = req.get('Idempotency-Key');
  if (!validRequestKey(requestKey)) {
    return res.status(400).json({ erreur: 'Clé de requête invalide. Réessayez le paiement.' });
  }
  if (typeof montant !== 'number' || !Number.isFinite(montant) || montant <= 0 || montant > 9999999999.99) {
    return res.status(400).json({ erreur: 'Le montant du paiement doit être supérieur à zéro.' });
  }
  if (Math.round(montant * 100) !== montant * 100) {
    return res.status(400).json({ erreur: 'Le paiement doit avoir au maximum deux décimales.' });
  }
  if (!['USD', 'CDF'].includes(devise)) {
    return res.status(400).json({ erreur: 'La devise du paiement doit être USD ou CDF.' });
  }

  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    let prior = await client.query(
      'SELECT id, appareil_id, montant, devise, request_key, created_at FROM paiements WHERE request_key = $1 AND account_id = $2',
      [requestKey, req.technicien.account_id],
    );
    if (prior.rowCount) {
      const payment = prior.rows[0];
      if (!paymentMatches(payment, req.params.id, montant, devise)) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(409).json({ erreur: 'Cette clé a déjà servi pour un autre paiement.' });
      }
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(200).json(payment);
    }
    const appareil = await client.query(
      `SELECT id, statut FROM appareils_reparation
       WHERE id = $1 AND account_id = $2 AND archived_at IS NULL FOR UPDATE`,
      [req.params.id, req.technicien.account_id],
    );
    if (!appareil.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ erreur: 'Appareil introuvable.' });
    }
    prior = await client.query(
      'SELECT id, appareil_id, montant, devise, request_key, created_at FROM paiements WHERE request_key = $1 AND account_id = $2',
      [requestKey, req.technicien.account_id],
    );
    if (prior.rowCount) {
      const payment = prior.rows[0];
      if (!paymentMatches(payment, req.params.id, montant, devise)) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(409).json({ erreur: 'Cette clé a déjà servi pour un autre paiement.' });
      }
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(200).json(payment);
    }
    if (appareil.rows[0].statut === 'LIVRE') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ erreur: 'Un appareil livré ne peut plus recevoir de paiement.' });
    }
    const result = await client.query(
      `INSERT INTO paiements (appareil_id, account_id, montant, devise, request_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, request_key) DO NOTHING
       RETURNING id, appareil_id, montant, devise, request_key, created_at`,
      [req.params.id, req.technicien.account_id, montant, devise, requestKey],
    );
    if (result.rowCount) {
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(201).json(result.rows[0]);
    }
    prior = await client.query(
      'SELECT id, appareil_id, montant, devise, request_key, created_at FROM paiements WHERE request_key = $1 AND account_id = $2',
      [requestKey, req.technicien.account_id],
    );
    if (prior.rowCount && paymentMatches(prior.rows[0], req.params.id, montant, devise)) {
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(200).json(prior.rows[0]);
    }
    await client.query('ROLLBACK');
    transactionStarted = false;
    return res.status(409).json({ erreur: 'Cette clé a déjà servi pour un autre paiement.' });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(`Échec d’annulation du paiement (${rollbackError.code || 'connexion'}).`);
      }
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

// Suppression logique pour préserver l'historique et les actes liés.
router.delete('/appareils/:id', async (req, res, next) => {
  const expectedVersion = req.get('X-Record-Version');
  if (!validVersion(expectedVersion)) {
    return res.status(400).json({ erreur: 'Version du dossier invalide.' });
  }
  try {
    const result = await db.query(
      `UPDATE appareils_reparation
       SET archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND account_id = $3 AND archived_at IS NULL
         AND ($2::timestamptz IS NULL OR updated_at = $2::timestamptz)
       RETURNING id`,
      [req.params.id, expectedVersion || null, req.technicien.account_id],
    );
    if (!result.rowCount) {
      const current = await db.query(
        'SELECT archived_at FROM appareils_reparation WHERE id = $1 AND account_id = $2',
        [req.params.id, req.technicien.account_id],
      );
      if (!current.rowCount) return res.status(404).json({ erreur: 'Appareil introuvable.' });
      if (current.rows[0].archived_at) return res.status(204).end();
      return res.status(409).json({
        erreur: 'Ce dossier a changé sur un autre appareil. Rechargez-le avant de réessayer.',
      });
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/appareils/:id/restore', requireAdmin, async (req, res, next) => {
  const expectedVersion = req.get('X-Record-Version');
  if (!validVersion(expectedVersion)) {
    return res.status(400).json({ erreur: 'Version du dossier invalide.' });
  }
  try {
    const restored = await db.query(
      `UPDATE appareils_reparation
       SET archived_at = NULL, updated_at = NOW()
       WHERE id = $1 AND account_id = $3 AND archived_at IS NOT NULL
         AND ($2::timestamptz IS NULL OR updated_at = $2::timestamptz)
       RETURNING id, updated_at::text AS updated_at`,
      [req.params.id, expectedVersion || null, req.technicien.account_id],
    );
    if (!restored.rowCount) {
      const current = await db.query(
        'SELECT archived_at FROM appareils_reparation WHERE id = $1 AND account_id = $2',
        [req.params.id, req.technicien.account_id],
      );
      if (!current.rowCount) return res.status(404).json({ erreur: 'Dossier introuvable.' });
      if (!current.rows[0].archived_at) return res.status(409).json({ erreur: 'Ce dossier est déjà actif.' });
      return res.status(409).json({
        erreur: 'Ce dossier a changé sur un autre appareil. Rechargez la liste avant de réessayer.',
      });
    }
    res.json(restored.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.post('/appareils/:id/approbation', async (req, res, next) => {
  const { signature_data: signatureData } = req.body || {};
  const expectedVersion = req.get('X-Record-Version');
  if (!validVersion(expectedVersion)) {
    return res.status(400).json({ erreur: 'Version du dossier invalide.' });
  }
  if (
    !isNonEmptyString(signatureData) ||
    signatureData.length > 1_000_000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signatureData)
  ) {
    return res.status(400).json({ erreur: 'Signature absente ou trop volumineuse.' });
  }
  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    const appareil = await client.query(
      `SELECT id, statut FROM appareils_reparation
       WHERE id = $1 AND account_id = $2 AND archived_at IS NULL
       FOR UPDATE`,
      [req.params.id, req.technicien.account_id],
    );
    if (!appareil.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ erreur: 'Appareil introuvable.' });
    }
    const acteExistant = await client.query(
      `SELECT id, appareil_id, clause, type_validation, valide_at, signature_data
       FROM actes_approbation WHERE appareil_id = $1 AND account_id = $2`,
      [req.params.id, req.technicien.account_id],
    );
    if (acteExistant.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      if (acteExistant.rows[0].signature_data !== signatureData) {
        return res.status(409).json({ erreur: 'Un acte de restitution différent existe déjà pour ce dossier.' });
      }
      return res.status(200).json({ ...acteExistant.rows[0], statut: 'LIVRE' });
    }
    if (appareil.rows[0].statut !== 'PRET') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ erreur: 'L’appareil doit être prêt avant sa restitution.' });
    }

    const result = await client.query(
      `INSERT INTO actes_approbation (appareil_id, account_id, clause, type_validation, signature_data)
       VALUES ($1, $2, $3, 'SIGNATURE', $4)
       ON CONFLICT (appareil_id) DO NOTHING
       RETURNING id, appareil_id, clause, type_validation, valide_at`,
      [req.params.id, req.technicien.account_id, CLAUSE_SORTIE, signatureData],
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ erreur: 'Un acte existe déjà pour cet appareil.' });
    }
    const updated = await client.query(
      `UPDATE appareils_reparation SET statut = 'LIVRE', updated_at = NOW()
       WHERE id = $1 AND account_id = $3 AND
         ($2::timestamptz IS NULL OR updated_at = $2::timestamptz)
       RETURNING id, statut, updated_at::text AS updated_at`,
      [req.params.id, expectedVersion || null, req.technicien.account_id],
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({
        erreur: 'Ce dossier a changé sur un autre appareil. Rechargez-le avant de réessayer.',
      });
    }
    await client.query('COMMIT');
    transactionStarted = false;
    res.status(201).json({
      ...result.rows[0],
      statut: updated.rows[0].statut,
      updated_at: updated.rows[0].updated_at,
    });
  } catch (error) {
    if (client && transactionStarted) await client.query('ROLLBACK');
    next(error);
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
