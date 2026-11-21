const express = require('express');
const db = require('../db');
const auth = require('./auth');
const { hashPassword, requireTechnician } = require('../auth');

const router = express.Router();
const STATUTS = new Set(['DEPOT', 'EN_COURS', 'PRET', 'LIVRE']);
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

function patchMatchesDevice(device, body) {
  if (body.statut !== undefined && body.statut !== device.statut) return false;
  if (body.urgent !== undefined && body.urgent !== device.urgent) return false;
  if (Object.prototype.hasOwnProperty.call(body, 'prix_convenu')) {
    const currentPrice = device.prix_convenu === null ? null : Number(device.prix_convenu);
    if (currentPrice !== body.prix_convenu || device.prix_devise !== body.prix_devise) return false;
  }
  return true;
}

function normalizeTelephone(value) {
  return value.trim().replace(/[\s().-]/g, '');
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
    return res.status(403).json({ erreur: 'Réservé à l’administrateur de l’atelier.' });
  }
  next();
}

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.use('/auth', auth);
router.use(requireTechnician);

router.param('id', (req, res, next, id) => {
  if (!UUID_PATTERN.test(id)) return res.status(400).json({ erreur: 'Identifiant d’appareil invalide.' });
  next();
});

router.get('/techniciens', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, nom, email, role, actif, created_at
       FROM techniciens
       ORDER BY CASE role WHEN 'ADMIN' THEN 0 ELSE 1 END, nom`,
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post('/techniciens', requireAdmin, async (req, res, next) => {
  const { nom, email, password, confirmation } = req.body || {};
  if (
    typeof nom !== 'string' ||
    nom.trim().length < 1 ||
    nom.trim().length > 80 ||
    typeof email !== 'string' ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
    typeof password !== 'string' ||
    password.length < 6 ||
    password.length > 12 ||
    password !== confirmation
  ) {
    return res.status(400).json({
      erreur: 'Vérifiez le nom, l’e-mail et le mot de passe (6 à 12 caractères).',
    });
  }
  try {
    const passwordHash = await hashPassword(password);
    const result = await db.query(
      `INSERT INTO techniciens (nom, email, password_hash, role)
       VALUES ($1, LOWER($2), $3, 'TECHNICIEN')
       RETURNING id, nom, email, role, actif, created_at`,
      [nom.trim(), email.trim(), passwordHash],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.patch('/techniciens/:id', requireAdmin, async (req, res, next) => {
  const { actif } = req.body || {};
  if (typeof actif !== 'boolean') {
    return res.status(400).json({ erreur: 'Le statut du compte doit être un booléen.' });
  }
  if (req.params.id === req.technicien.id && !actif) {
    return res.status(409).json({ erreur: 'Un administrateur ne peut pas désactiver son propre compte.' });
  }
  try {
    const result = await db.query(
      `UPDATE techniciens
       SET actif = $2
       WHERE id = $1
         AND (
           $2 = TRUE OR role <> 'ADMIN' OR
           (SELECT COUNT(*) FROM techniciens WHERE role = 'ADMIN' AND actif = TRUE) > 1
         )
       RETURNING id, nom, email, role, actif, created_at`,
      [req.params.id, actif],
    );
    if (result.rowCount) return res.json(result.rows[0]);
    const existing = await db.query('SELECT id FROM techniciens WHERE id = $1', [req.params.id]);
    if (!existing.rowCount) return res.status(404).json({ erreur: 'Technicien introuvable.' });
    return res.status(409).json({ erreur: 'Le dernier administrateur actif ne peut pas être désactivé.' });
  } catch (error) {
    next(error);
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
       WHERE regexp_replace(telephone, '[^0-9+]', '', 'g') ILIKE $1
       ORDER BY created_at DESC
       LIMIT 8`,
      [`%${telephone}%`],
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
        JOIN appareils_reparation a ON a.id = p.appareil_id
        JOIN actes_approbation acte ON acte.appareil_id = a.id
        CROSS JOIN period_bounds
        WHERE a.statut = 'LIVRE'
          AND a.archived_at IS NULL
          AND p.created_at >= (period_bounds.start_local AT TIME ZONE 'Africa/Kinshasa')
          AND p.created_at < (period_bounds.end_local AT TIME ZONE 'Africa/Kinshasa')
        GROUP BY 1
      )
      SELECT
        to_char(buckets.bucket, '${period.format}') AS bucket,
        COALESCE(revenue.usd, 0) AS usd,
        COALESCE(revenue.cdf, 0) AS cdf
      FROM buckets
      LEFT JOIN revenue USING (bucket)
      ORDER BY buckets.bucket
    `);
    res.json({ period: periodName, points: result.rows });
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
      )
      SELECT
        COALESCE((
          SELECT SUM(p.montant) FILTER (WHERE p.devise = 'USD')
          FROM paiements p
          JOIN appareils_reparation a ON a.id = p.appareil_id
          JOIN actes_approbation acte ON acte.appareil_id = a.id
          CROSS JOIN semaine
          WHERE a.statut = 'LIVRE'
            AND a.archived_at IS NULL
            AND p.created_at >= semaine.debut
            AND p.created_at < semaine.fin
        ), 0) AS chiffre_semaine_usd,
        COALESCE((
          SELECT SUM(p.montant) FILTER (WHERE p.devise = 'CDF')
          FROM paiements p
          JOIN appareils_reparation a ON a.id = p.appareil_id
          JOIN actes_approbation acte ON acte.appareil_id = a.id
          CROSS JOIN semaine
          WHERE a.statut = 'LIVRE'
            AND a.archived_at IS NULL
            AND p.created_at >= semaine.debut
            AND p.created_at < semaine.fin
        ), 0) AS chiffre_semaine_cdf,
        COUNT(*) FILTER (WHERE statut <> 'LIVRE') AS appareils_attente,
        COUNT(*) FILTER (WHERE urgent = TRUE AND statut <> 'LIVRE') AS urgents
      FROM appareils_reparation
      WHERE archived_at IS NULL
    `);
    const urgents = await db.query(
      `SELECT a.id, a.marque, a.modele, a.panne, a.statut, c.nom, c.telephone
       FROM appareils_reparation a
       JOIN clients c ON c.id = a.client_id
       WHERE a.urgent = TRUE AND a.statut <> 'LIVRE' AND a.archived_at IS NULL
       ORDER BY a.created_at ASC
       LIMIT 10`,
    );
    const journalier = await db.query(`
      WITH semaine AS (
        SELECT
          date_trunc('week', NOW() AT TIME ZONE 'Africa/Kinshasa')
            AT TIME ZONE 'Africa/Kinshasa' AS debut,
          (date_trunc('week', NOW() AT TIME ZONE 'Africa/Kinshasa') + INTERVAL '1 week')
            AT TIME ZONE 'Africa/Kinshasa' AS fin
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
        JOIN appareils_reparation a ON a.id = p.appareil_id
        JOIN actes_approbation acte ON acte.appareil_id = a.id
        CROSS JOIN semaine
        WHERE a.statut = 'LIVRE'
          AND a.archived_at IS NULL
          AND p.created_at >= semaine.debut
          AND p.created_at < semaine.fin
        GROUP BY 1
      )
      SELECT
        to_char(jours.jour, 'YYYY-MM-DD') AS jour,
        COALESCE(paiements_journaliers.usd, 0) AS usd,
        COALESCE(paiements_journaliers.cdf, 0) AS cdf
      FROM jours
      LEFT JOIN paiements_journaliers USING (jour)
      ORDER BY jours.jour
    `);
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
    const [clients, appareils, paiements] = await Promise.all([
      client.query(
        'SELECT id, nom, telephone FROM clients ORDER BY created_at DESC',
      ),
      client.query(
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
         JOIN clients c ON c.id = a.client_id
         LEFT JOIN actes_approbation acte ON acte.appareil_id = a.id
         LEFT JOIN LATERAL (
           SELECT
             COALESCE(SUM(montant) FILTER (WHERE devise = 'USD'), 0) AS total_usd,
             COALESCE(SUM(montant) FILTER (WHERE devise = 'CDF'), 0) AS total_cdf
           FROM paiements
           WHERE appareil_id = a.id
         ) totaux ON TRUE
         WHERE a.archived_at IS NULL
         ORDER BY a.created_at DESC, a.id`,
      ),
      client.query(
        `SELECT p.id, p.appareil_id, p.montant, p.devise, p.request_key,
                p.created_at::text AS created_at
         FROM paiements p
         JOIN appareils_reparation a ON a.id = p.appareil_id
         WHERE a.archived_at IS NULL
         ORDER BY p.created_at`,
      ),
    ]);
    await client.query('COMMIT');
    transactionStarted = false;
    res.json({
      clients: clients.rows,
      appareils: appareils.rows,
      paiements: paiements.rows,
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
  if (!['waiting', 'archive'].includes(section)) {
    return res.status(400).json({ erreur: 'Section d’appareils invalide.' });
  }
  if (
    typeof rawPage !== 'string' ||
    !/^[1-9]\d*$/.test(rawPage) ||
    Number(rawPage) > 100000 ||
    typeof status !== 'string' ||
    !Object.prototype.hasOwnProperty.call(statusFilters, status) ||
    (section === 'archive' && status !== 'ALL') ||
    search.length > 120 ||
    (req.query.q !== undefined && typeof req.query.q !== 'string')
  ) {
    return res.status(400).json({ erreur: 'Recherche ou numéro de page invalide.' });
  }
  const where =
    section === 'archive'
      ? "a.archived_at IS NULL AND a.statut = 'LIVRE'"
      : `a.archived_at IS NULL AND a.statut <> 'LIVRE'${statusFilters[status]}`;
  const searchFilter =
    "($1 = '' OR position(lower($1) in lower(concat_ws(' ', c.nom, c.telephone, a.marque, a.modele, a.panne))) > 0 OR ($2 <> '' AND position($2 in regexp_replace(c.telephone, '[^0-9]', '', 'g')) > 0))";
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
       JOIN clients c ON c.id = a.client_id
       LEFT JOIN actes_approbation acte ON acte.appareil_id = a.id
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(montant) FILTER (WHERE devise = 'USD'), 0) AS total_usd,
           COALESCE(SUM(montant) FILTER (WHERE devise = 'CDF'), 0) AS total_cdf
         FROM paiements
         WHERE appareil_id = a.id
       ) totaux ON TRUE
       WHERE ${where} AND ${searchFilter}
       ORDER BY ${section === 'waiting' ? 'a.urgent DESC, ' : ''}a.created_at DESC, a.id
       LIMIT 50 OFFSET $3`;
    const requestedPage = Number(rawPage);
    const [count, initialResult] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS total
         FROM appareils_reparation a
         JOIN clients c ON c.id = a.client_id
         WHERE ${where} AND ${searchFilter}`,
        [search, searchDigits],
      ),
      db.query(listSql, [search, searchDigits, (requestedPage - 1) * 50]),
    ]);
    const total = Number(count.rows[0].total);
    const pages = Math.max(1, Math.ceil(total / 50));
    const page = Math.min(requestedPage, pages);
    let result = initialResult;
    if (page !== requestedPage) {
      result = await db.query(listSql, [search, searchDigits, (page - 1) * 50]);
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
       JOIN clients c ON c.id = a.client_id
       LEFT JOIN actes_approbation acte ON acte.appareil_id = a.id
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(montant) FILTER (WHERE devise = 'USD'), 0) AS total_usd,
           COALESCE(SUM(montant) FILTER (WHERE devise = 'CDF'), 0) AS total_cdf
         FROM paiements
         WHERE appareil_id = a.id
       ) totaux ON TRUE
       WHERE a.id = $1 AND a.archived_at IS NULL`,
      [req.params.id],
    );
    if (!result.rowCount) return res.status(404).json({ erreur: 'Appareil introuvable.' });
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.post('/appareils', async (req, res, next) => {
  const body = req.body || {};
  const { id, nom = '', telephone, marque, modele = '', panne, prix_convenu = null, urgent = false } = body;
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
    (typeof modele !== 'string')
  ) {
    return res.status(400).json({ erreur: 'Téléphone, marque et panne sont obligatoires.' });
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
       JOIN clients c ON c.id = a.client_id
       WHERE a.request_key = $1`,
      [requestKey],
    );
    if (prior.rowCount) {
      const device = prior.rows[0];
      const sameRequest =
        (id === undefined || device.id === id) &&
        device.telephone === normalizedTelephone &&
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
         INSERT INTO clients (nom, telephone)
         VALUES ($2, $3)
         ON CONFLICT (telephone) DO UPDATE SET nom = CASE
           WHEN EXCLUDED.nom <> '' THEN EXCLUDED.nom
           ELSE clients.nom
         END
         RETURNING id
       )
       INSERT INTO appareils_reparation
         (id, client_id, marque, modele, panne, prix_convenu, urgent, request_key)
       SELECT COALESCE($1::uuid, gen_random_uuid()), client.id, $4, $5, $6, $7, $8, $9
       FROM client
       ON CONFLICT (request_key) DO NOTHING
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
      ],
    );
    if (result.rowCount) return res.status(201).json(result.rows[0]);
    const existing = await db.query(
      `SELECT a.*, a.updated_at::text AS updated_at, c.telephone FROM appareils_reparation a
       JOIN clients c ON c.id = a.client_id
       WHERE a.request_key = $1`,
      [requestKey],
    );
    if (existing.rowCount) {
      const device = existing.rows[0];
      const sameRequest =
        (id === undefined || device.id === id) &&
        device.telephone === normalizedTelephone &&
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
  if (hasPrice !== hasPriceCurrency) {
    return res.status(400).json({ erreur: 'Le prix et sa devise doivent être fournis ensemble.' });
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
      `UPDATE appareils_reparation
       SET statut = COALESCE($2, statut),
           prix_convenu = CASE WHEN $3::boolean THEN $4::numeric ELSE prix_convenu END,
           urgent = COALESCE($5, urgent),
           prix_devise = CASE WHEN $3::boolean THEN $6::text ELSE prix_devise END,
           updated_at = NOW()
       WHERE id = $1 AND archived_at IS NULL AND statut <> 'LIVRE'
         AND ($7::timestamptz IS NULL OR updated_at = $7::timestamptz)
         AND (
           $2::text IS NULL OR statut = $2 OR
           ($2 = 'EN_COURS' AND statut = 'DEPOT') OR
           ($2 = 'PRET' AND statut = 'EN_COURS')
         )
       RETURNING *, updated_at::text AS updated_at`,
      [
        req.params.id,
        statut || null,
        hasPrice,
        prix_convenu === undefined ? null : prix_convenu,
        urgent === undefined ? null : urgent,
        body.prix_devise === undefined ? null : body.prix_devise,
        expectedVersion || null,
      ],
    );
    if (!result.rowCount) {
      const current = await db.query(
        'SELECT *, updated_at::text AS updated_at FROM appareils_reparation WHERE id = $1 AND archived_at IS NULL',
        [req.params.id],
      );
      if (!current.rowCount) return res.status(404).json({ erreur: 'Appareil introuvable.' });
      if (expectedVersion && current.rows[0].updated_at !== expectedVersion) {
        if (patchMatchesDevice(current.rows[0], body)) return res.json(current.rows[0]);
        return res.status(409).json({
          erreur: 'Ce dossier a changé sur un autre appareil. Rechargez-le avant de réessayer.',
        });
      }
      if (current.rows[0].statut === 'LIVRE') {
        return res.status(409).json({ erreur: 'Un appareil livré ne peut plus être modifié.' });
      }
      return res.status(409).json({ erreur: 'Respectez l’ordre des étapes : dépôt, en cours, puis prêt.' });
    }
    res.json(result.rows[0]);
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
      'SELECT id, appareil_id, montant, devise, request_key, created_at FROM paiements WHERE request_key = $1',
      [requestKey],
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
       WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
      [req.params.id],
    );
    if (!appareil.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ erreur: 'Appareil introuvable.' });
    }
    prior = await client.query(
      'SELECT id, appareil_id, montant, devise, request_key, created_at FROM paiements WHERE request_key = $1',
      [requestKey],
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
      `INSERT INTO paiements (appareil_id, montant, devise, request_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (request_key) DO NOTHING
       RETURNING id, appareil_id, montant, devise, request_key, created_at`,
      [req.params.id, montant, devise, requestKey],
    );
    if (result.rowCount) {
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(201).json(result.rows[0]);
    }
    prior = await client.query(
      'SELECT id, appareil_id, montant, devise, request_key, created_at FROM paiements WHERE request_key = $1',
      [requestKey],
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
       WHERE id = $1 AND archived_at IS NULL
         AND ($2::timestamptz IS NULL OR updated_at = $2::timestamptz)
       RETURNING id`,
      [req.params.id, expectedVersion || null],
    );
    if (!result.rowCount) {
      const current = await db.query(
        'SELECT archived_at FROM appareils_reparation WHERE id = $1',
        [req.params.id],
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
       WHERE id = $1 AND archived_at IS NULL
       FOR UPDATE`,
      [req.params.id],
    );
    if (!appareil.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ erreur: 'Appareil introuvable.' });
    }
    const acteExistant = await client.query(
      `SELECT id, appareil_id, clause, type_validation, valide_at, signature_data
       FROM actes_approbation WHERE appareil_id = $1`,
      [req.params.id],
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
      `INSERT INTO actes_approbation (appareil_id, clause, type_validation, signature_data)
       VALUES ($1, $2, 'SIGNATURE', $3)
       ON CONFLICT (appareil_id) DO NOTHING
       RETURNING id, appareil_id, clause, type_validation, valide_at`,
      [req.params.id, CLAUSE_SORTIE, signatureData],
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ erreur: 'Un acte existe déjà pour cet appareil.' });
    }
    const updated = await client.query(
      `UPDATE appareils_reparation SET statut = 'LIVRE', updated_at = NOW()
       WHERE id = $1 AND ($2::timestamptz IS NULL OR updated_at = $2::timestamptz)
       RETURNING id, statut, updated_at::text AS updated_at`,
      [req.params.id, expectedVersion || null],
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
