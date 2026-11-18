require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
});

pool.on('error', (error) => {
  console.error(`Erreur sur une connexion PostgreSQL inactive (${error.code || error.message}).`);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
