require('dotenv').config();

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, test } = require('node:test');
const db = require('../db');
const { app } = require('../server');
const {
  SESSION_COOKIE,
  hashPassword,
  hashSessionToken,
  readSessionToken,
  sessionLifetimeSeconds,
  verifyPassword,
} = require('../auth');

let server;
let baseUrl;

async function startServer() {
  if (server) return;
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.pool.end();
});

test('password hashes are salted, verifiable, and reject weak input', async () => {
  const firstHash = await hashPassword('Aa1234');
  const secondHash = await hashPassword('Aa1234');
  assert.notEqual(firstHash, secondHash);
  assert.equal(await verifyPassword('Aa1234', firstHash), true);
  assert.equal(await verifyPassword('un-autre-mot-de-passe', firstHash), false);
  assert.equal(await verifyPassword('test', 'invalid'), false);
  assert.equal(typeof await hashPassword('MotdeP@ss12'), 'string');
  await assert.rejects(() => hashPassword('abcde'), /6 et 12/);
  await assert.rejects(() => hashPassword('MotdePasse123'), /6 et 12/);
});

test('session tokens are read only from the expected cookie and stored as hashes', () => {
  const token = 'a'.repeat(64);
  assert.equal(readSessionToken({ headers: { cookie: `other=value; atelier_session=${token}` } }), token);
  assert.equal(readSessionToken({ headers: { cookie: 'atelier_session=invalid' } }), null);
  assert.equal(readSessionToken({ headers: {} }), null);
  assert.equal(hashSessionToken(token).length, 64);
  assert.notEqual(hashSessionToken(token), token);
});

test('remembered sessions last 30 days and standard sessions last 12 hours', () => {
  assert.equal(sessionLifetimeSeconds(true), 30 * 24 * 60 * 60);
  assert.equal(sessionLifetimeSeconds(false), 12 * 60 * 60);
});

test('health endpoint responds without database details', async () => {
  await startServer();
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('static app includes local production CSS and the technician login', async () => {
  await startServer();
  const page = await fetch(`${baseUrl}/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /name="theme-color" content="#f1f5f9"/);
  assert.match(html, /<e-links-intro id="e-links-intro"><\/e-links-intro>/);
  assert.match(html, /src="\/e-links-intro\.js"/);
  assert.match(html, /href="\/e-links-intro\.css"/);
  assert.match(html, /src="\/offline-store\.js"/);
  assert.match(html, /id="offline-status"/);
  assert.match(html, /id="dashboard-sync-note"/);
  assert.match(html, /data-page="report"/);
  assert.match(html, /id="page-report"/);
  assert.match(html, /data-report-period="year"/);
  assert.match(html, /id="report-donut"/);
  assert.doesNotMatch(html, /Ravi de vous revoir/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /id="registration-form"/);
  assert.match(html, /id="remember-session"/);
  assert.match(html, /id="show-password-recovery"/);
  assert.match(html, /id="password-recovery-form"/);
  assert.match(html, /id="password-reset-form"/);
  assert.match(html, /id="technician-form"/);
  assert.match(html, /maxlength="12" required/);
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /id="waiting-next"/);
  assert.match(html, /id="archive-next"/);
  assert.match(html, /id="app-main"/);
  assert.match(html, /id="device-dialog" aria-labelledby="device-title" class="hidden min-h-screen/);
  assert.match(html, /id="device-close"/);
  assert.match(html, /id="device-fault"/);
  assert.match(html, /id="device-approval-clause"/);
  assert.match(html, /id="device-signature"/);
  assert.ok(html.indexOf('id="device-approval"') > html.indexOf('id="payment-form"'));
  assert.match(html, /id="prix"[^>]*required/);
  assert.match(html, /Prix total convenu en USD \(obligatoire\)/);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
  const css = await fetch(`${baseUrl}/styles.css`);
  assert.equal(css.status, 200);
  const cssText = await css.text();
  assert.match(cssText, /\.hidden\s*\{/);
  assert.match(cssText, /#signature-canvas\s*\{[^}]*touch-action:\s*none/);
  assert.match(cssText, /#signature-canvas\s*\{[^}]*height:\s*clamp\(180px,\s*30vh,\s*240px\)/);
  const script = await fetch(`${baseUrl}/app.js`);
  assert.equal(script.status, 200);
  const scriptText = await script.text();
  assert.match(scriptText, /playWelcome\(technician\.nom\)/);
  assert.match(scriptText, /getCoalescedEvents/);
  assert.match(scriptText, /quadraticCurveTo/);
  assert.match(scriptText, /setPointerCapture\(event\.pointerId\)/);
  assert.match(scriptText, /ResizeObserver\(resizeSignatureCanvas\)/);
  const introScript = await fetch(`${baseUrl}/e-links-intro.js`);
  assert.equal(introScript.status, 200);
  const introText = await introScript.text();
  assert.match(introText, /customElements\.define\('e-links-intro'/);
  assert.match(introText, /Bonjour, \$\{displayName/);
  assert.match(introText, /async playWelcome\(name\)/);
  assert.doesNotMatch(introText, /<style>/);
  assert.doesNotMatch(introText, /e-links-intro-caption|Chargement E-Links…/);
  const brandScene = introText.slice(
    introText.indexOf('<div class="e-links-intro-brand-scene"'),
    introText.indexOf('</div>\n          </div>'),
  );
  assert.equal((brandScene.match(/class="e-links-intro-bubble e-links-intro-brand-bubble/g) || []).length, 3);
  assert.match(
    introText,
    /<div class="e-links-intro-greeting-stage" hidden>\s*<p class="e-links-intro-greeting" aria-hidden="true"><\/p>\s*<\/div>/,
  );
  const introCss = await fetch(`${baseUrl}/e-links-intro.css`);
  assert.equal(introCss.status, 200);
  const introCssText = await introCss.text();
  assert.match(introCssText, /@keyframes e-links-intro-orbit/);
  assert.match(introCssText, /translateX\(124px\)/);
  assert.match(
    introCssText,
    /e-links-intro\[data-dismissed="true"\]\s*\{\s*opacity:\s*0;\s*visibility:\s*hidden;\s*pointer-events:\s*none;/,
  );
  const offlineStore = await fetch(`${baseUrl}/offline-store.js`);
  assert.equal(offlineStore.status, 200);
  assert.match(await offlineStore.text(), /indexedDB\.open/);
  const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  const manifestData = await manifest.json();
  assert.equal(manifestData.theme_color, '#f1f5f9');
  assert.deepEqual(manifestData.icons.map((icon) => [icon.src, icon.sizes]), [
    ['/icon-192.png', '192x192'],
    ['/icon-512.png', '512x512'],
  ]);
  for (const icon of manifestData.icons) {
    const response = await fetch(`${baseUrl}${icon.src}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/png/);
  }
  const pageHtml = await (await fetch(`${baseUrl}/`)).text();
  assert.match(pageHtml, /rel="apple-touch-icon" href="\/icon-192\.png"/);
  const serviceWorker = await fetch(`${baseUrl}/service-worker.js`);
  const serviceWorkerText = await serviceWorker.text();
  assert.match(serviceWorkerText, /atelier-express-v18/);
  assert.match(serviceWorkerText, /offline-store\.js/);
  assert.match(serviceWorkerText, /icon-512\.png/);
  assert.match(serviceWorkerText, /addEventListener\('push'/);
  const trackingPage = await fetch(`${baseUrl}/suivi`);
  assert.equal(trackingPage.status, 200);
  assert.match(await trackingPage.text(), /Suivi de réparation/);
  const trackingScript = await fetch(`${baseUrl}/suivi.js`);
  assert.equal(trackingScript.status, 200);
  assert.match(await trackingScript.text(), /PushManager/);
});

test('Render blueprint deploys commits automatically', () => {
  const renderYaml = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'render.yaml'),
    'utf8',
  );
  assert.match(renderYaml, /^\s+autoDeployTrigger:\s*commit\s*$/m);
});

test('business API requires an authenticated technician and disables caching', async () => {
  await startServer();
  const response = await fetch(`${baseUrl}/api/appareils`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const snapshot = await fetch(`${baseUrl}/api/offline/snapshot`);
  assert.equal(snapshot.status, 401);
  assert.equal(snapshot.headers.get('cache-control'), 'no-store');
});

test('public repair tracking exposes no client or payment details and accepts consented Push subscriptions', async () => {
  await startServer();
  const originalQuery = db.query;
  const previousVapid = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  };
  const vapid = require('web-push').generateVAPIDKeys();
  const token = '00000000-0000-4000-8000-000000000022';
  const queries = [];
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:test@example.invalid';
  db.query = async (sql) => {
    queries.push(sql);
    if (sql.includes('SELECT marque, modele, statut')) {
      return {
        rows: [{ marque: 'Tecno', modele: 'Spark', statut: 'EN_COURS', updated_at: '2026-11-21T12:00:00.000Z' }],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT statut FROM appareils_reparation')) {
      return { rows: [{ statut: 'EN_COURS' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO push_subscriptions')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    const tracking = await fetch(`${baseUrl}/api/public/appareils/${token}`);
    assert.equal(tracking.status, 200);
    const trackingData = await tracking.json();
    assert.deepEqual(Object.keys(trackingData.appareil).sort(), ['marque', 'modele', 'statut', 'updated_at'].sort());
    assert.equal(trackingData.appareil.statut, 'EN_COURS');
    assert.equal(trackingData.push_public_key, vapid.publicKey);

    for (const endpoint of [
      'http://push.example.invalid/subscription',
      'https://127.0.0.1/subscription',
    ]) {
      const invalid = await fetch(`${baseUrl}/api/public/appareils/${token}/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: {
            endpoint,
            keys: { p256dh: 'a'.repeat(43), auth: 'b'.repeat(22) },
          },
        }),
      });
      assert.equal(invalid.status, 400);
    }

    const subscribed = await fetch(`${baseUrl}/api/public/appareils/${token}/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/test-subscription',
          keys: { p256dh: 'a'.repeat(43), auth: 'b'.repeat(22) },
        },
      }),
    });
    assert.equal(subscribed.status, 201);
    assert.deepEqual(await subscribed.json(), { active: true });
    assert.ok(queries.some((sql) => sql.includes('INSERT INTO push_subscriptions')));
  } finally {
    db.query = originalQuery;
    for (const [key, value] of Object.entries({
      VAPID_PUBLIC_KEY: previousVapid.publicKey,
      VAPID_PRIVATE_KEY: previousVapid.privateKey,
      VAPID_SUBJECT: previousVapid.subject,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('technician QR route creates an app-origin tracking QR', async () => {
  await startServer();
  const originalQuery = db.query;
  const originalBaseUrl = process.env.APP_BASE_URL;
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const appareilId = '00000000-0000-4000-8000-000000000023';
  process.env.APP_BASE_URL = 'https://atelier.example.invalid';
  db.query = async (sql) => {
    if (sql.includes('sessions_techniciens')) {
      return {
        rows: [{ id: '00000000-0000-4000-8000-000000000001', nom: 'Test', email: 'test@example.invalid', role: 'ADMIN' }],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT id FROM appareils_reparation')) {
      return { rows: [{ id: appareilId }], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    const response = await fetch(`${baseUrl}/api/appareils/${appareilId}/qr`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
    });
    assert.equal(response.status, 200);
    const qr = await response.json();
    assert.equal(qr.url, `https://atelier.example.invalid/suivi?appareil=${appareilId}`);
    assert.match(qr.qr_code, /^data:image\/png;base64,/);
  } finally {
    db.query = originalQuery;
    if (originalBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = originalBaseUrl;
  }
});

test('ready transition queues a Push delivery only when entering PRET', async () => {
  await startServer();
  const originalQuery = db.query;
  const originalVapid = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  };
  const vapid = require('web-push').generateVAPIDKeys();
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const appareilId = '00000000-0000-4000-8000-000000000024';
  let previousStatus = 'EN_COURS';
  let pushLookups = 0;
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:test@example.invalid';
  db.query = async (sql) => {
    if (sql.includes('sessions_techniciens')) {
      return {
        rows: [{ id: '00000000-0000-4000-8000-000000000001', nom: 'Test', email: 'test@example.invalid', role: 'ADMIN' }],
        rowCount: 1,
      };
    }
    if (sql.includes('WITH current_device AS')) {
      return {
        rows: [{
          id: appareilId,
          statut: 'PRET',
          previous_statut: previousStatus,
          updated_at: '2026-11-21T12:00:00.000Z',
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM push_subscriptions')) {
      pushLookups += 1;
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    for (const previous of ['EN_COURS', 'PRET']) {
      previousStatus = previous;
      const response = await fetch(`${baseUrl}/api/appareils/${appareilId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${sessionToken}`,
        },
        body: JSON.stringify({ statut: 'PRET' }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).statut, 'PRET');
    }
    assert.equal(pushLookups, 1);
  } finally {
    db.query = originalQuery;
    for (const [key, value] of Object.entries({
      VAPID_PUBLIC_KEY: originalVapid.publicKey,
      VAPID_PRIVATE_KEY: originalVapid.privateKey,
      VAPID_SUBJECT: originalVapid.subject,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('revenue reports validate periods and include only delivered approved repairs', async () => {
  await startServer();
  const originalQuery = db.query;
  const token = crypto.randomBytes(32).toString('hex');
  const reportQueries = [];
  db.query = async (sql) => {
    if (sql.includes('sessions_techniciens')) {
      return {
        rows: [{ id: '00000000-0000-4000-8000-000000000001', nom: 'Test', email: 'test@example.invalid', role: 'ADMIN' }],
        rowCount: 1,
      };
    }
    if (sql.includes('WITH local_now AS')) {
      reportQueries.push(sql);
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    for (const period of ['quarter', 'constructor', 'toString']) {
      const invalid = await fetch(`${baseUrl}/api/reports/revenue?period=${period}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      });
      assert.equal(invalid.status, 400);
    }

    const periods = [
      ['day', "INTERVAL '1 hour'"],
      ['week', "INTERVAL '1 day'"],
      ['month', "INTERVAL '1 day'"],
      ['year', "INTERVAL '1 month'"],
    ];
    for (const [period, interval] of periods) {
      const response = await fetch(`${baseUrl}/api/reports/revenue?period=${period}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { period, points: [] });
      assert.ok(reportQueries[reportQueries.length - 1].includes(interval));
    }
    assert.equal(reportQueries.length, periods.length);
    for (const sql of reportQueries) {
      assert.match(sql, /JOIN actes_approbation/);
      assert.match(sql, /a\.statut = 'LIVRE'/);
      assert.match(sql, /a\.archived_at IS NULL/);
      assert.match(sql, /Africa\/Kinshasa/);
      assert.match(sql, /generate_series/);
    }
  } finally {
    db.query = originalQuery;
  }
});

test('stale offline changes are rejected when another device changed the repair', async () => {
  await startServer();
  const originalQuery = db.query;
  const token = crypto.randomBytes(32).toString('hex');
  db.query = async (sql) => {
    if (sql.includes('sessions_techniciens')) {
      return {
        rows: [{ id: '00000000-0000-4000-8000-000000000001', nom: 'Test', email: 'test@example.invalid', role: 'ADMIN' }],
        rowCount: 1,
      };
    }
    if (sql.includes('WITH current_device AS')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT *, updated_at::text AS updated_at FROM appareils_reparation')) {
      return {
        rows: [{
          id: '00000000-0000-4000-8000-000000000002',
          statut: 'PRET',
          urgent: false,
          prix_convenu: '100',
          prix_devise: 'USD',
          updated_at: '2026-11-18 07:00:00+00',
        }],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    const response = await fetch(`${baseUrl}/api/appareils/00000000-0000-4000-8000-000000000002`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE}=${token}`,
        'X-Record-Version': '2026-11-18 06:00:00+00',
      },
      body: JSON.stringify({ statut: 'EN_COURS' }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).erreur, /changé sur un autre appareil/i);
  } finally {
    db.query = originalQuery;
  }
});

test('repair intake accepts a stable client-generated ID for offline synchronization', async () => {
  await startServer();
  const originalQuery = db.query;
  const token = crypto.randomBytes(32).toString('hex');
  const deviceId = '00000000-0000-4000-8000-000000000003';
  const requestKey = '00000000-0000-4000-8000-000000000004';
  const body = {
    id: deviceId,
    nom: 'Test',
    telephone: '+243812345678',
    marque: 'Tecno',
    modele: 'Spark',
    panne: 'Écran cassé',
    prix_convenu: 100,
    urgent: false,
  };
  let insertedValues;
  db.query = async (sql, values = []) => {
    if (sql.includes('sessions_techniciens')) {
      return {
        rows: [{ id: '00000000-0000-4000-8000-000000000001', nom: 'Test', email: 'test@example.invalid', role: 'ADMIN' }],
        rowCount: 1,
      };
    }
    if (sql.includes('WHERE a.request_key = $1')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('WITH client AS')) {
      insertedValues = values;
      return {
        rows: [{ id: deviceId, client_id: '00000000-0000-4000-8000-000000000005' }],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    const response = await fetch(`${baseUrl}/api/appareils`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE}=${token}`,
        'Idempotency-Key': requestKey,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).id, deviceId);
    assert.equal(insertedValues[0], deviceId);
    assert.equal(insertedValues[1], 'Test');
    assert.equal(insertedValues[2], '+243812345678');
    assert.equal(insertedValues[8], requestKey);
  } finally {
    db.query = originalQuery;
  }
});

test('new repair intake rejects a missing agreed price before database writes', async () => {
  await startServer();
  const originalQuery = db.query;
  let sessionLookups = 0;
  db.query = async (sql) => {
    sessionLookups += 1;
    assert.match(sql, /sessions_techniciens/);
    return {
      rows: [{ id: '00000000-0000-4000-8000-000000000001', nom: 'Test', email: 'test@example.invalid', role: 'ADMIN' }],
      rowCount: 1,
    };
  };
  const token = crypto.randomBytes(32).toString('hex');
  const baseBody = {
    telephone: '+243812345678',
    marque: 'Tecno',
    modele: 'Spark',
    panne: 'Écran cassé',
    urgent: false,
  };
  try {
    for (const [index, price] of [undefined, null].entries()) {
      const body = { ...baseBody };
      if (price !== undefined) body.prix_convenu = price;
      const response = await fetch(`${baseUrl}/api/appareils`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${token}`,
          'Idempotency-Key': `${index + 1}1111111-1111-4111-8111-111111111111`,
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).erreur, /prix total convenu est obligatoire/i);
    }
    assert.equal(sessionLookups, 2);
  } finally {
    db.query = originalQuery;
  }
});

test('initial registration validates password and confirmation before database access', async () => {
  await startServer();
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nom: 'Nova',
      email: 'nova@example.com',
      password: 'abcde',
      confirmation: 'abcde',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).erreur, /6 à 12/);
});

test('technician registration requires the configured invitation code', async () => {
  await startServer();
  const originalConnect = db.pool.connect;
  const originalInviteCode = process.env.TECHNICIAN_INVITE_CODE;
  const originalNodeEnv = process.env.NODE_ENV;
  let insertedAccount = false;
  process.env.NODE_ENV = 'development';
  process.env.TECHNICIAN_INVITE_CODE = 'atelier-invite-test';
  db.pool.connect = async () => ({
    query: async (sql) => {
      if (sql === 'SELECT EXISTS (SELECT 1 FROM techniciens) AS has_technicians') {
        return { rows: [{ has_technicians: true }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO techniciens')) insertedAccount = true;
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  });
  try {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nom: 'Nova',
        email: 'nova@example.com',
        password: 'Aa1234',
        confirmation: 'Aa1234',
        code: 'code-invalide',
      }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).erreur, /Code d’invitation/);
    assert.equal(insertedAccount, false);
  } finally {
    db.pool.connect = originalConnect;
    if (originalInviteCode === undefined) delete process.env.TECHNICIAN_INVITE_CODE;
    else process.env.TECHNICIAN_INVITE_CODE = originalInviteCode;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test('login stores the 30-day expiration when remember is selected', async () => {
  await startServer();
  const originalQuery = db.query;
  const passwordHash = await hashPassword('Aa1234');
  let sessionExpirationSeconds;
  db.query = async (sql, values = []) => {
    if (sql.includes('SELECT attempts')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT id, nom, email, password_hash, role')) {
      return {
        rows: [{
          id: '00000000-0000-4000-8000-000000000001',
          nom: 'Nova',
          email: 'nova@example.com',
          password_hash: passwordHash,
          role: 'ADMIN',
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO sessions_techniciens')) {
      sessionExpirationSeconds = values[2];
    }
    return { rows: [], rowCount: 1 };
  };
  try {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nova@example.com', password: 'Aa1234', remember: true }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /Max-Age=2592000/);
    assert.equal(sessionExpirationSeconds, 30 * 24 * 60 * 60);
  } finally {
    db.query = originalQuery;
  }
});

test('password reset rejects malformed tokens before database access', async () => {
  await startServer();
  const response = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: 'invalid',
      password: 'Aa1234',
      confirmation: 'Aa1234',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).erreur, /Lien invalide ou expiré/);
});

test('password reset consumes its token and revokes existing sessions', async () => {
  await startServer();
  const originalConnect = db.pool.connect;
  const token = crypto.randomBytes(32).toString('hex');
  let tokenAvailable = true;
  let updatedPasswordHash;
  let revokedSessions = false;
  db.pool.connect = async () => ({
    query: async (sql, values = []) => {
      if (sql.includes('SELECT r.technicien_id')) {
        return tokenAvailable
          ? { rows: [{ technicien_id: '00000000-0000-4000-8000-000000000001' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('UPDATE techniciens SET password_hash')) {
        updatedPasswordHash = values[0];
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('DELETE FROM password_reset_tokens')) tokenAvailable = false;
      if (sql.startsWith('DELETE FROM sessions_techniciens')) revokedSessions = true;
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  });
  try {
    const response = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'NeW123', confirmation: 'NeW123' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    assert.match((await response.json()).message, /Mot de passe modifié/);
    assert.equal(await verifyPassword('NeW123', updatedPasswordHash), true);
    assert.equal(revokedSessions, true);

    const replay = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'NeW123', confirmation: 'NeW123' }),
    });
    assert.equal(replay.status, 400);
  } finally {
    db.pool.connect = originalConnect;
  }
});
