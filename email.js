const nodemailer = require('nodemailer');

function getEmailConfig() {
  const { APP_BASE_URL, SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = process.env;
  const port = Number(SMTP_PORT);
  if (
    !APP_BASE_URL ||
    !SMTP_HOST ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !SMTP_FROM ||
    Boolean(SMTP_USER) !== Boolean(SMTP_PASSWORD)
  ) {
    return null;
  }

  let baseUrl;
  try {
    baseUrl = new URL(APP_BASE_URL);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (process.env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:')
  ) {
    return null;
  }

  return {
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    host: SMTP_HOST,
    port,
    secure: SMTP_SECURE === 'true',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
    from: SMTP_FROM,
  };
}

function passwordResetEmailConfigured() {
  return getEmailConfig() !== null;
}

async function sendPasswordResetEmail(email, token) {
  const config = getEmailConfig();
  if (!config) throw new Error('La configuration SMTP ou APP_BASE_URL est incomplète.');

  const resetUrl = new URL('/', config.baseUrl);
  resetUrl.searchParams.set('reset_token', token);
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
  await transporter.sendMail({
    from: config.from,
    to: email,
    subject: 'Réinitialisation de votre mot de passe - Atelier Express',
    text: [
      'Une demande de réinitialisation du mot de passe de votre compte Atelier Express a été reçue.',
      '',
      `Ouvrez ce lien dans l’heure pour choisir un nouveau mot de passe : ${resetUrl.toString()}`,
      '',
      'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.',
    ].join('\n'),
  });
}

module.exports = {
  passwordResetEmailConfigured,
  sendPasswordResetEmail,
};
