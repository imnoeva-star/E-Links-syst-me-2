require('dotenv').config();

const express = require('express');
const path = require('node:path');
const api = require('./routes/api');
const db = require('./db');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'",
  );
  next();
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/suivi', (req, res) => res.sendFile(path.join(__dirname, 'public', 'suivi.html')));

app.get('/readyz', async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT
        to_regclass('public.clients') IS NOT NULL AND
        to_regclass('public.appareils_reparation') IS NOT NULL AND
        to_regclass('public.actes_approbation') IS NOT NULL AND
        to_regclass('public.paiements') IS NOT NULL AND
        to_regclass('public.techniciens') IS NOT NULL AND
        to_regclass('public.sessions_techniciens') IS NOT NULL AND
         to_regclass('public.password_reset_tokens') IS NOT NULL AND
        to_regclass('public.auth_login_attempts') IS NOT NULL AND
        to_regclass('public.push_subscriptions') IS NOT NULL AND
        to_regclass('public.parametres_atelier') IS NOT NULL AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.techniciens')
            AND attname = 'role' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.appareils_reparation')
            AND attname = 'request_key' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.paiements')
            AND attname = 'request_key' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.techniciens')
            AND attname = 'account_id' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.clients')
            AND attname = 'account_id' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.appareils_reparation')
            AND attname = 'account_id' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.appareils_reparation')
            AND attname = 'type_appareil' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.appareils_reparation')
            AND attname = 'frais_usd' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.appareils_reparation')
            AND attname = 'frais_cdf' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.appareils_reparation')
            AND attname = 'frais_usd_saisis_at' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.appareils_reparation')
            AND attname = 'frais_cdf_saisis_at' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.paiements')
            AND attname = 'account_id' AND NOT attisdropped
        ) AND
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.actes_approbation')
            AND attname = 'account_id' AND NOT attisdropped
        ) AS ready
    `);
    if (!result.rows[0].ready) {
      return res.status(503).json({ status: 'not_ready', erreur: 'Schéma ou migration manquant.' });
    }
    res.json({ status: 'ready' });
  } catch (error) {
    next(error);
  }
});

app.use(express.json({ limit: '1mb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ erreur: 'Route API introuvable.' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ erreur: 'Corps JSON invalide.' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ erreur: 'Requête trop volumineuse.' });
  }

  const code = error.code || '';
  if (code === '42P01') {
    console.error('Schéma PostgreSQL absent ou incomplet.');
    return res.status(503).json({
      erreur: 'Schéma PostgreSQL absent ou incomplet. Appliquez les migrations configurées.',
    });
  }
  if (code === '22P02') return res.status(400).json({ erreur: 'Format de donnée invalide.' });
  if (code === '23505') return res.status(409).json({ erreur: 'Cette donnée existe déjà.' });
  if (
    code.startsWith('08') ||
    ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', '57P01', '57P03', '53300', '53000'].includes(code)
  ) {
    console.error(`Base de données indisponible (${code || 'connexion'}).`);
    return res.status(503).json({ erreur: 'Base de données momentanément indisponible. Réessayez.' });
  }
  console.error(`Erreur serveur (${code || error.name || 'inconnue'}): ${error.message}`);
  res.status(500).json({ erreur: 'Erreur serveur. Réessayez.' });
});

function startServer() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL est requis pour démarrer Atelier Express.');
  }
  const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
  const server = app.listen(port, host, () => {
    console.log(`Atelier Express écoute sur le port ${port}.`);
  });
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Arrêt demandé (${signal}).`);
    const timeout = setTimeout(() => {
      server.closeAllConnections();
      db.pool.end().finally(() => process.exit(1));
    }, 10000);
    timeout.unref();
    server.close(() => {
      clearTimeout(timeout);
      db.pool.end()
        .then(() => process.exit(0))
        .catch((error) => {
          console.error(`Échec de fermeture PostgreSQL: ${error.message}`);
          process.exit(1);
        });
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) startServer();

module.exports = { app, startServer };
