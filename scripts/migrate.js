require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL_UNPOOLED;
  if (!connectionString) {
    throw new Error('DATABASE_URL_UNPOOLED est requis pour exécuter les migrations.');
  }
  let connectionUrl;
  try {
    connectionUrl = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL_UNPOOLED doit être une URL PostgreSQL valide.');
  }
  if (!['postgres:', 'postgresql:'].includes(connectionUrl.protocol)) {
    throw new Error('DATABASE_URL_UNPOOLED doit être une URL PostgreSQL valide.');
  }
  if (connectionUrl.hostname.toLowerCase().includes('-pooler')) {
    throw new Error('Utilisez une URL Neon directe (sans -pooler) pour les migrations.');
  }

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });
  await client.connect();
  try {
    const directory = path.join(__dirname, '..', 'migrations');
    const availableFiles = (await fs.readdir(directory))
      .filter((file) => /^\d{8}_.+\.sql$/.test(file))
      .sort();
    const requestedFiles = process.argv.slice(2);
    const files = requestedFiles.length ? requestedFiles : availableFiles;
    if (
      new Set(files).size !== files.length ||
      files.some((file) => !availableFiles.includes(file))
    ) {
      throw new Error('Indiquez des noms de migrations existants, sans doublons.');
    }

    for (const file of files) {
      console.log(`Application de ${file}…`);
      await client.query(await fs.readFile(path.join(directory, file), 'utf8'));
    }
    console.log('Migrations terminées.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Échec de migration (${error.code || 'erreur'}): ${error.message}`);
  process.exitCode = 1;
});
