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
    const result = await db.query('SELECT EXISTS (SELECT 1 FROM techniciens) AS has_technicians');
    const setupCode = process.env.INITIAL_SETUP_CODE;
    const inviteCode = process.env.TECHNICIAN_INVITE_CODE;
    const hasTechnicians = result.rows[0].has_technicians;
    const code = hasTechnicians ? inviteCode : setupCode;
    const codeInvalidForEnvironment =
      process.env.NODE_ENV === 'production' && (!code || code.length < 16);
    const registrationAvailable = hasTechnicians
      ? Boolean(inviteCode) && (process.env.NODE_ENV !== 'production' || inviteCode.length >= 16)
      : !codeInvalidForEnvironment;
    res.set('Cache-Control', 'no-store');
    res.json({
      available: registrationAvailable,
      codeRequired: hasTechnicians || process.env.NODE_ENV === 'production',
      isFirstAccount: !hasTechnicians,
      configurationRequired: !registrationAvailable,
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

  let client;
  let transactionStarted = false;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SELECT pg_advisory_xact_lock($1)', [874221905]);
    const existing = await client.query('SELECT EXISTS (SELECT 1 FROM techniciens) AS has_technicians');
    const hasTechnicians = existing.rows[0].has_technicians;
    const role = 'ADMIN';
    const requiredCode = hasTechnicians
      ? process.env.TECHNICIAN_INVITE_CODE
      : process.env.INITIAL_SETUP_CODE;
    if (hasTechnicians && !requiredCode) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(503).json({ erreur: 'L’administrateur doit configurer le code d’invitation.' });
    }
    if (
      process.env.NODE_ENV === 'production' &&
      (!requiredCode || requiredCode.length < 16)
    ) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(503).json({ erreur: 'Le code requis doit contenir au moins 16 caractères.' });
    }
    if (
      (hasTechnicians || process.env.NODE_ENV === 'production') &&
      !setupCodeMatches(code, requiredCode)
    ) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({
        erreur: hasTechnicians ? 'Code d’invitation incorrect.' : 'Code de première configuration incorrect.',
      });
    }

    const accountId = crypto.randomUUID();
    const technician = await client.query(
      `INSERT INTO techniciens (id, account_id, nom, email, password_hash, role)
       VALUES ($1, $1, $2, LOWER($3), $4, $5)
       RETURNING id, account_id, nom, email, role`,
      [accountId, nom.trim(), email.trim(), await hashPassword(password), role],
    );
    const token = crypto.randomBytes(32).toString('hex');
    const lifetimeSeconds = sessionLifetimeSeconds(remember === true);
    const session = await client.query(
      `INSERT INTO sessions_techniciens (technicien_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 second'))
       RETURNING expires_at`,
      [technician.rows[0].id, hashSessionToken(token), lifetimeSeconds],
    );
    await client.query('COMMIT');
    transactionStarted = false;
    setSessionCookie(res, token, lifetimeSeconds);
    res.status(201).json({
      technicien: {
        ...technician.rows[0],
        legacy_cache_owner: !hasTechnicians,
      },
      session_expires_at: session.rows && session.rows[0] && session.rows[0].expires_at,
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
       WHERE email = LOWER($1) AND actif = TRUE`,
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
      'SELECT id, email FROM techniciens WHERE email = LOWER($1) AND actif = TRUE',
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
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND t.actif = TRUE`,
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
