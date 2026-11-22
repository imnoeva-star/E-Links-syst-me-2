const { promisify } = require('node:util');
const {
  createHash,
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual,
} = require('node:crypto');
const db = require('./db');

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'atelier_session';
const SESSION_HOURS = 12;
const SESSION_REMEMBER_DAYS = 30;

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 12) {
    throw new Error('Le mot de passe doit contenir entre 6 et 12 caractères.');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  const parts = typeof encoded === 'string' ? encoded.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '16384') return false;
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await scrypt(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function readSessionToken(req) {
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const token = cookie ? cookie.slice(SESSION_COOKIE.length + 1) : '';
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function sessionLifetimeSeconds(remember = false) {
  return remember
    ? SESSION_REMEMBER_DAYS * 24 * 60 * 60
    : SESSION_HOURS * 60 * 60;
}

function setSessionCookie(res, token, lifetimeSeconds = sessionLifetimeSeconds()) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${lifetimeSeconds}${secure}`,
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
  );
}

async function requireTechnician(req, res, next) {
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
              )) AS legacy_cache_owner
       FROM sessions_techniciens s
       JOIN techniciens t ON t.id = s.technicien_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND t.actif = TRUE`,
      [hashSessionToken(token)],
    );
    if (!result.rowCount) return res.status(401).json({ erreur: 'Session expirée. Reconnectez-vous.' });
    req.technicien = result.rows[0];
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  SESSION_COOKIE,
  SESSION_HOURS,
  SESSION_REMEMBER_DAYS,
  clearSessionCookie,
  hashPassword,
  hashSessionToken,
  readSessionToken,
  requireTechnician,
  sessionLifetimeSeconds,
  setSessionCookie,
  verifyPassword,
};
