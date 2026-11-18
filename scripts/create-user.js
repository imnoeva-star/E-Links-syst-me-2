const readline = require('node:readline');
const db = require('../db');
const { hashPassword } = require('../auth');

function ask(prompt) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => terminal.question(prompt, (answer) => {
    terminal.close();
    resolve(answer.trim());
  }));
}

function askHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Exécutez cette commande depuis un terminal interactif pour saisir le mot de passe en privé.');
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    let value = '';
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.setRawMode(wasRaw);
      input.pause();
      input.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('Saisie annulée.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    input.on('data', onData);
  });
}

async function main() {
  const options = Object.fromEntries(
    process.argv.slice(2).reduce((args, value, index, input) => {
      if (value === '--name') args.push(['nom', input[index + 1]]);
      if (value === '--email') args.push(['email', input[index + 1]]);
      return args;
    }, []),
  );
  const nom = options.nom || await ask('Nom du technicien : ');
  const email = (options.email || await ask('Adresse e-mail : ')).toLowerCase();
  if (!nom || nom.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('Nom ou adresse e-mail invalide.');
  }
  const password = await askHidden('Mot de passe (6 à 12 caractères, saisie masquée) : ');
  const confirmation = await askHidden('Confirmer le mot de passe : ');
  if (password !== confirmation) throw new Error('Les mots de passe ne correspondent pas.');
  const passwordHash = await hashPassword(password);
  await db.query(
    'INSERT INTO techniciens (nom, email, password_hash) VALUES ($1, $2, $3)',
    [nom, email, passwordHash],
  );
  console.log(`Compte créé pour ${email}.`);
}

main()
  .catch((error) => {
    console.error(error.message || 'Impossible de créer le compte technicien.');
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
