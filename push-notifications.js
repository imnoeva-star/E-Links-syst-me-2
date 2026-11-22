const webPush = require('web-push');
const db = require('./db');

let lastConfiguration = '';
let configuredPublicKey = null;

function configure() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || '';
  const configuration = `${publicKey}\0${privateKey}\0${subject}`;
  if (configuration === lastConfiguration) return configuredPublicKey;
  lastConfiguration = configuration;
  configuredPublicKey = null;
  if (!publicKey || !privateKey || !subject) return null;
  try {
    webPush.setVapidDetails(subject, publicKey, privateKey);
    configuredPublicKey = publicKey;
  } catch (error) {
    console.error(`Configuration VAPID invalide (${error.message}).`);
  }
  return configuredPublicKey;
}

async function deliver(subscription, appareilId) {
  try {
    await webPush.sendNotification(
      subscription,
      JSON.stringify({
        title: 'E-Links · Atelier Express',
        body: 'Votre téléphone est prêt. Vous pouvez passer à l’atelier.',
        url: `/suivi?appareil=${encodeURIComponent(appareilId)}`,
      }),
      {
        TTL: 86400,
        urgency: 'high',
      },
    );
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      await db.query(
        'DELETE FROM push_subscriptions WHERE appareil_id = $1 AND endpoint = $2',
        [appareilId, subscription.endpoint],
      );
      return;
    }
    console.error(`Échec d’envoi Push (${error.statusCode || error.code || 'erreur'}).`);
  }
}

async function notifyReady(appareilId) {
  if (!configure()) return false;
  const result = await db.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE appareil_id = $1',
    [appareilId],
  );
  await Promise.all(result.rows.map((row) =>
    deliver(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      appareilId,
    ),
  ));
  return true;
}

async function notifySubscription(subscription, appareilId) {
  if (!configure()) return false;
  await deliver(subscription, appareilId);
  return true;
}

module.exports = {
  getPublicKey: configure,
  notifyReady,
  notifySubscription,
};
