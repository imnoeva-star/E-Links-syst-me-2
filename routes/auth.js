const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const {
  clearSessionCookie,
  hashPassword,
  hashSessionToken,
  readSessionToken,
  sessionLifetimeSeconds,
  setSessionCookie,
  verifyPassword,
} = require('../auth');
const { passwordResetEmailConfigured, sendPasswordResetEmail } = require('../email');

const router = express.Router();
const dummyPasswordHash = hashPassword(crypto.randomBytes(6).toString('hex'));

function ipHash(req) {
  return crypto.createHash('sha256').update(req.ip || 'unknown').digest('hex');
}

function cleanExpiredRequests() {
  return db.query(`
    UPDATE workshop_account_requests
    SET status = 'EXPIRED'
    WHERE status = 'APPROVED'
      AND code_expires_at IS NOT NULL
      AND code_expires_at <= NOW()
  `);
}

function validEmail(value) {
  return typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function validName(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 80;
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 6 && value.length <= 12;
}

function setupCodeMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const providedHash = crypto.createHash('sha256').update(provided).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

router.get('/setup', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({
      available: true,
      codeRequired: false,
      isFirstAccount: false,
      configurationRequired: false,
      passwordRecoveryAvailable: passwordResetEmailConfigured(),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/register', async (req, res, next) => {
  const { nom, email, password, confirmation, code, remember } = req.body || {};
  if (!validName(nom) || !validEmail(email) || !validPassword(password) || password !== confirmation) {
    return res.status(400).json({
      erreur: 'Vérifiez le nom, l’e-mail et le mot de passe (6 à 12 caractères).',
    });
  }
  const emailAddress = email.trim().toLowerCase();
  let client;
  let transactionStarted = false;
  try {
    await cleanExpiredRequests();
    const recent = await db.query(
      `SELECT COUNT(*) AS total
       FROM workshop_account_requests
       WHERE ip_hash = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [ipHash(req)],
    );
    if (Number(recent.rows[0]?.total || 0) >= 5) {
      return res.status(429).json({
        erreur: 'Trop de demandes. Réessayez dans une heure.',
      });
    }
    client = await db.pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    const existingTechnician = await client.query(
      'SELECT id FROM techniciens WHERE email = LOWER($1)',
      [emailAddress],
    );
    if (existingTechnician.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ erreur: 'Cette adresse e-mail est déjà utilisée.' });
    }
    const activeRequest = await client.query(
      `SELECT id FROM workshop_account_requests
       WHERE LOWER(email) = $1 AND status IN ('PENDING', 'APPROVED')`,
      [emailAddress],
    );
    if (activeRequest.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({
        erreur: 'Une demande est déjà en attente pour cette adresse.',
      });
    }
    const requestId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    await client.query(
      `INSERT INTO workshop_account_requests
       (id, nom, email, password_hash, ip_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [requestId, nom.trim(), emailAddress, passwordHash, ipHash(req)],
    );
    await client.query('COMMIT');
    transactionStarted = false;
    res.status(201).json({
      request_id: requestId,
      message: 'Demande envoyée à l’administrateur. Attendez sa confirmation.',
    });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(`Échec d’annulation de la création du compte (${rollbackError.code || 'connexion'}).`);
      }
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

router.post('/workshop-request/confirm', async (req, res, next) => {
  const { request_id: requestId, email, code } = req.body || {};
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !UUID_PATTERN.test(requestId || '') ||
    typeof email !== 'string' ||
    !/^\d{6}$/.test(code || '')
  ) {
    return res.status(400).json({ erreur: 'Demande ou code invalide.' });
  }
  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    const requestResult = await client.query(
      `SELECT id, nom, email, password_hash, code_hash, code_expires_at, code_attempts
       FROM workshop_account_requests
       WHERE id = $1 AND LOWER(email) = LOWER($2)
         AND status = 'APPROVED'
       FOR UPDATE`,
      [requestId, email.trim()],
    );
    if (!requestResult.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ erreur: 'Cette demande a expiré ou n’est plus approuvée.' });
    }
    const request = requestResult.rows[0];
    if (
      !request.code_expires_at ||
      new Date(request.code_expires_at).getTime() <= Date.now()
    ) {
      await client.query(
        `UPDATE workshop_account_requests SET status = 'EXPIRED' WHERE id = $1`,
        [requestId],
      );
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(410).json({ erreur: 'Le code a expiré. Demandez une nouvelle approbation.' });
    }
    if (Number(request.code_attempts || 0) >= 5) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(429).json({ erreur: 'Trop de tentatives. Demandez une nouvelle approbation.' });
    }
    const codeHash = crypto.createHash('sha256').update(String(code)).digest('hex');
    const supplied = Buffer.from(codeHash);
    const expected = Buffer.from(request.code_hash || '');
    const validCode = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (!validCode) {
      await client.query(
        `UPDATE workshop_account_requests
         SET code_attempts = code_attempts + 1
         WHERE id = $1`,
        [requestId],
      );
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(401).json({ erreur: 'Code incorrect.' });
    }
    const existing = await client.query(
      'SELECT id FROM techniciens WHERE email = LOWER($1)',
      [email.trim().toLowerCase()],
    );
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ erreur: 'Cette adresse e-mail est déjà utilisée.' });
    }
    const accountId = crypto.randomUUID();
    const technician = await client.query(
      `INSERT INTO techniciens (id, account_id, nom, email, password_hash, role)
       VALUES ($1, $1, $2, LOWER($3), $4, 'ADMIN')
       RETURNING id, account_id, nom, email, role`,
      [accountId, request.nom, request.email, request.password_hash],
    );
    await client.query(
      `UPDATE workshop_account_requests
       SET status = 'CONFIRMED', confirmed_at = NOW()
       WHERE id = $1`,
      [requestId],
    );
    const token = crypto.randomBytes(32).toString('hex');
    const lifetimeSeconds = sessionLifetimeSeconds(true);
    await client.query(
      `INSERT INTO sessions_techniciens (technicien_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 second'))`,
      [technician.rows[0].id, hashSessionToken(token), lifetimeSeconds],
    );
    await client.query('COMMIT');
    transactionStarted = false;
    setSessionCookie(res, token, lifetimeSeconds);
    res.status(201).json({
      technicien: {
        ...technician.rows[0],
        legacy_cache_owner: false,
      },
      session_expires_at: new Date(Date.now() + lifetimeSeconds * 1000).toISOString(),
    });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(`Échec d’annulation de la confirmation (${rollbackError.code || 'connexion'}).`);
      }
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

router.post('/login', async (req, res, next) => {
  const { email, password, remember } = req.body || {};
  if (
    typeof email !== 'string' ||
    email.length > 254 ||
    typeof password !== 'string' ||
    password.length < 6 ||
    password.length > 12
  ) {
    return res.status(400).json({ erreur: 'Adresse e-mail ou mot de passe invalide (6 à 12 caractères).' });
  }

  try {
    const emailAddress = email.trim().toLowerCase();
    const rateLimitKey = crypto
      .createHash('sha256')
      .update(`${req.ip || 'unknown'}:${emailAddress}`)
      .digest('hex');
    await db.query(
      'DELETE FROM auth_login_attempts WHERE window_started_at < NOW() - INTERVAL \'1 day\'',
    );
    const rateLimit = await db.query(
      `SELECT attempts
       FROM auth_login_attempts
       WHERE key_hash = $1 AND window_started_at > NOW() - INTERVAL '15 minutes'`,
      [rateLimitKey],
    );
    if (Number(rateLimit.rows[0] && rateLimit.rows[0].attempts) >= 8) {
      return res.status(429).json({ erreur: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    }

    const result = await db.query(
      `SELECT t.id, t.nom, t.email, t.password_hash, t.role, t.account_id,
              (t.account_id = (
                SELECT root.account_id
                FROM techniciens AS root
                WHERE root.role = 'ADMIN' AND root.account_id = root.id
                ORDER BY root.created_at, root.id
                LIMIT 1
              )) AS legacy_cache_owner
       FROM techniciens AS t
       WHERE email = LOWER($1) AND actif = TRUE
         AND t.role = 'ADMIN' AND t.id = t.account_id`,
      [emailAddress],
    );
    const technician = result.rows[0];
    const validPassword = await verifyPassword(
      password,
      technician ? technician.password_hash : await dummyPasswordHash,
    );
    if (!technician || !validPassword) {
      await db.query(
        `INSERT INTO auth_login_attempts (key_hash, attempts, window_started_at)
         VALUES ($1, 1, NOW())
         ON CONFLICT (key_hash) DO UPDATE SET
           attempts = CASE
             WHEN auth_login_attempts.window_started_at <= NOW() - INTERVAL '15 minutes' THEN 1
             ELSE auth_login_attempts.attempts + 1
           END,
           window_started_at = CASE
             WHEN auth_login_attempts.window_started_at <= NOW() - INTERVAL '15 minutes' THEN NOW()
             ELSE auth_login_attempts.window_started_at
           END`,
        [rateLimitKey],
      );
      return res.status(401).json({ erreur: 'Adresse e-mail ou mot de passe incorrect.' });
    }
    await db.query('DELETE FROM auth_login_attempts WHERE key_hash = $1', [rateLimitKey]);
    await db.query('DELETE FROM auth_login_attempts WHERE window_started_at < NOW() - INTERVAL \'1 day\'');

    const token = crypto.randomBytes(32).toString('hex');
    const lifetimeSeconds = sessionLifetimeSeconds(remember === true);
    const session = await db.query(
      `INSERT INTO sessions_techniciens (technicien_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 second'))
       RETURNING expires_at`,
      [technician.id, hashSessionToken(token), lifetimeSeconds],
    );
    await db.query('DELETE FROM sessions_techniciens WHERE expires_at <= NOW()');
    setSessionCookie(res, token, lifetimeSeconds);
    res.json({
      technicien: {
        id: technician.id,
        nom: technician.nom,
        email: technician.email,
        role: technician.role,
        account_id: technician.account_id,
        legacy_cache_owner: technician.legacy_cache_owner,
      },
      session_expires_at: session.rows && session.rows[0] && session.rows[0].expires_at,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/password-reset/request', async (req, res, next) => {
  const { email } = req.body || {};
  if (!validEmail(email)) {
    return res.status(400).json({ erreur: 'Saisissez une adresse e-mail valide.' });
  }
  if (!passwordResetEmailConfigured()) {
    return res.status(503).json({
      erreur: 'La récupération par e-mail n’est pas encore configurée. Contactez l’administrateur.',
    });
  }

  const emailAddress = email.trim().toLowerCase();
  const rateLimitKey = crypto
    .createHash('sha256')
    .update(`password-reset:${req.ip || 'unknown'}:${emailAddress}`)
    .digest('hex');
  try {
    await db.query(
      'DELETE FROM auth_login_attempts WHERE window_started_at < NOW() - INTERVAL \'1 day\'',
    );
    const rateLimit = await db.query(
      `SELECT attempts
       FROM auth_login_attempts
       WHERE key_hash = $1 AND window_started_at > NOW() - INTERVAL '15 minutes'`,
      [rateLimitKey],
    );
    if (Number(rateLimit.rows[0] && rateLimit.rows[0].attempts) >= 3) {
      return res.status(429).json({ erreur: 'Trop de demandes. Réessayez dans 15 minutes.' });
    }
    await db.query(
      `INSERT INTO auth_login_attempts (key_hash, attempts, window_started_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (key_hash) DO UPDATE SET
         attempts = CASE
           WHEN auth_login_attempts.window_started_at <= NOW() - INTERVAL '15 minutes' THEN 1
           ELSE auth_login_attempts.attempts + 1
         END,
         window_started_at = CASE
           WHEN auth_login_attempts.window_started_at <= NOW() - INTERVAL '15 minutes' THEN NOW()
           ELSE auth_login_attempts.window_started_at
         END`,
      [rateLimitKey],
    );

    const result = await db.query(
      `SELECT id, email FROM techniciens
       WHERE email = LOWER($1) AND actif = TRUE
         AND role = 'ADMIN' AND id = account_id`,
      [emailAddress],
    );
    const technician = result.rows[0];
    if (technician) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashSessionToken(token);
      await db.query('DELETE FROM password_reset_tokens WHERE technicien_id = $1 OR expires_at <= NOW()', [
        technician.id,
      ]);
      await db.query(
        `INSERT INTO password_reset_tokens (technicien_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [technician.id, tokenHash],
      );
      try {
        await sendPasswordResetEmail(technician.email, token);
      } catch (emailError) {
        await db.query('DELETE FROM password_reset_tokens WHERE token_hash = $1', [tokenHash]);
        console.error(`Échec d’envoi du courriel de récupération (${emailError.code || 'SMTP'}).`);
        return res.status(503).json({
          erreur: 'Le courriel de récupération n’a pas pu être envoyé. Réessayez plus tard.',
        });
      }
    }
    res.json({
      message: 'Si cette adresse est associée à un compte actif, un lien de réinitialisation vient d’être envoyé.',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/password-reset/confirm', async (req, res, next) => {
  const { token, password, confirmation } = req.body || {};
  if (
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(token) ||
    !validPassword(password) ||
    password !== confirmation
  ) {
    return res.status(400).json({
      erreur: 'Lien invalide ou expiré, ou mot de passe non conforme (6 à 12 caractères).',
    });
  }

  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    const result = await client.query(
      `SELECT r.technicien_id
       FROM password_reset_tokens r
       JOIN techniciens t ON t.id = r.technicien_id
       WHERE r.token_hash = $1 AND r.expires_at > NOW() AND t.actif = TRUE
         AND t.role = 'ADMIN' AND t.id = t.account_id
       FOR UPDATE OF r`,
      [hashSessionToken(token)],
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ erreur: 'Ce lien de réinitialisation est invalide ou expiré.' });
    }

    const technicianId = result.rows[0].technicien_id;
    await client.query(
      'UPDATE techniciens SET password_hash = $1 WHERE id = $2',
      [await hashPassword(password), technicianId],
    );
    await client.query('DELETE FROM password_reset_tokens WHERE technicien_id = $1', [technicianId]);
    await client.query('DELETE FROM sessions_techniciens WHERE technicien_id = $1', [technicianId]);
    await client.query('COMMIT');
    transactionStarted = false;
    clearSessionCookie(res);
    res.json({ message: 'Mot de passe modifié. Connectez-vous avec votre nouveau mot de passe.' });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(`Échec d’annulation de la réinitialisation (${rollbackError.code || 'connexion'}).`);
      }
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

router.get('/session', async (req, res, next) => {
  const token = readSessionToken(req);
  if (!token) return res.status(401).json({ erreur: 'Connexion requise.' });
  try {
    const result = await db.query(
      `SELECT t.id, t.nom, t.email, t.role, t.account_id,
              (t.account_id = (
                SELECT root.account_id
                FROM techniciens AS root
                WHERE root.role = 'ADMIN' AND root.account_id = root.id
                ORDER BY root.created_at, root.id
                LIMIT 1
              )) AS legacy_cache_owner,
              s.expires_at
       FROM sessions_techniciens s
       JOIN techniciens t ON t.id = s.technicien_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND t.actif = TRUE
         AND t.role = 'ADMIN' AND t.id = t.account_id`,
      [hashSessionToken(token)],
    );
    if (!result.rowCount) {
      clearSessionCookie(res);
      return res.status(401).json({ erreur: 'Session expirée. Reconnectez-vous.' });
    }
    const { expires_at, ...technician } = result.rows[0];
    res.json({ technicien: technician, session_expires_at: expires_at });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', async (req, res, next) => {
  const token = readSessionToken(req);
  try {
    if (token) {
      await db.query('DELETE FROM sessions_techniciens WHERE token_hash = $1', [hashSessionToken(token)]);
    }
    clearSessionCookie(res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
