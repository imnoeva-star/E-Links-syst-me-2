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
const AUTHENTICATED_TECHNICIAN = {
  id: '00000000-0000-4000-8000-000000000010',
  account_id: '00000000-0000-4000-8000-000000000010',
  nom: 'Test',
  email: 'test@example.invalid',
  role: 'ADMIN',
  legacy_cache_owner: true,
};

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
  assert.doesNotMatch(html, /id="show-registration"|Créer un compte/);
  assert.match(html, /id="workshop-request-form"/);
  assert.match(html, /id="workshop-confirm-form"/);
  assert.match(html, /id="workshop-request-list"/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /id="remember-session"/);
  assert.match(html, /id="show-password-recovery"/);
  assert.match(html, /id="password-recovery-form"/);
  assert.match(html, /id="password-reset-form"/);
  assert.doesNotMatch(html, /Équipe et comptes|id="page-team"|id="technician-form"/);
  assert.match(html, /maxlength="12" required/);
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /id="waiting-next"/);
  assert.match(html, /id="archive-next"/);
  assert.match(html, /id="settings-menu-link"/);
  assert.match(html, /id="statistics-start-date"/);
  assert.match(html, /id="export-data"/);
  assert.match(html, /id="removed-list"/);
  assert.match(html, /id="app-main"/);
  assert.match(html, /id="device-dialog" aria-labelledby="device-title" class="hidden min-h-screen/);
  assert.match(html, /id="device-close"/);
  assert.match(html, /id="device-fault"/);
  assert.match(html, /id="device-edit-form"/);
  assert.match(html, /id="device-archive-button"/);
  assert.match(html, /id="type-appareil"/);
  assert.match(html, /id="brand-suggestions"/);
  assert.match(html, /id="personal-net-usd"/);
  assert.match(html, /id="device-expense-usd"/);
  assert.match(html, /id="device-expense-cdf"/);
  assert.match(html, /id="device-approval-clause"/);
  assert.match(html, /id="device-signature"/);
  assert.match(html, /id="device-price-row"/);
  assert.match(html, /id="device-payments-section"/);
  assert.match(html, /id="device-repair-history"/);
  assert.match(html, /id="device-history-expense-usd"/);
  assert.match(html, /id="device-history-expense-cdf"/);
  assert.match(html, /id="device-qr-section"/);
  assert.doesNotMatch(html, /id="device-summary"|Reste sur le prix convenu/);
  assert.ok(html.indexOf('id="device-approval"') > html.indexOf('id="payment-form"'));
  assert.match(html, /id="prix"[^>]*required/);
  assert.match(html, /Prix total convenu en USD \(obligatoire\)/);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
  const css = await fetch(`${baseUrl}/styles.css`);
  assert.equal(css.status, 200);
  const cssText = await css.text();
  assert.match(cssText, /\.hidden\s*\{/);
  assert.match(cssText, /\.tracking-status-card\[data-status=["']?EN_COURS["']?\]/);
  assert.match(cssText, /\.tracking-notification/);
  assert.match(cssText, /#signature-canvas\s*\{[^}]*touch-action:\s*none/);
  assert.match(cssText, /#signature-canvas\s*\{[^}]*height:\s*clamp\(180px,\s*30vh,\s*240px\)/);
  const script = await fetch(`${baseUrl}/app.js`);
  assert.equal(script.status, 200);
  const scriptText = await script.text();
  assert.match(scriptText, /playWelcome\(technician\.nom\)/);
  assert.match(scriptText, /window\.addEventListener\('popstate'/);
  assert.match(scriptText, /const isAuthRequest = url === '\/api\/auth\/setup' \|\| url\.startsWith\('\/api\/auth\/'\)/);
  assert.match(scriptText, /Connexion Internet requise pour créer ou ouvrir un compte/);
  assert.match(scriptText, /function resetIntakeForm\(\)/);
  assert.match(scriptText, /const isDelivered = device\.statut === 'LIVRE' \|\| Boolean\(device\.acte_valide\)/);
  assert.match(scriptText, /device-archive-button'\)\.classList\.toggle\('hidden', state\.technician\?\.role !== 'ADMIN' \|\| isDelivered\)/);
  assert.match(scriptText, /device-payments-section'\)\.classList\.remove\('hidden'\)/);
  assert.match(scriptText, /device-repair-history'\)\.classList\.toggle\('hidden', !isDelivered\)/);
  assert.match(scriptText, /device-qr-section'\)\.classList\.toggle\('hidden', isDelivered\)/);
  assert.match(scriptText, /expense-form'\)\.classList\.toggle\('hidden', isDelivered\)/);
  assert.match(scriptText, /\/api\/reports\/personal/);
  assert.match(scriptText, /Émettre un nouveau code/);
  assert.match(scriptText, /if \(currentOperation\.blocked\) \{\s*const reconciliation = await reconcileVersionConflict\(currentOperation\)/);
  assert.doesNotMatch(scriptText, /ce dossier a changé sur un autre appareil\/i\.test\(currentOperation\.error/);
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
  assert.match(serviceWorkerText, /atelier-express-v32/);
  assert.match(serviceWorkerText, /offline-store\.js/);
  assert.match(serviceWorkerText, /icon-512\.png/);
  assert.match(serviceWorkerText, /addEventListener\('push'/);
  assert.match(serviceWorkerText, /vibrate:\s*\[300,\s*120,\s*300,\s*120,\s*650\]/);
  assert.match(serviceWorkerText, /requireInteraction:\s*true/);
  assert.match(serviceWorkerText, /renotify:\s*true/);
  const pushSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'push-notifications.js'),
    'utf8',
  );
  assert.match(pushSource, /urgency:\s*'high'/);
  const trackingPage = await fetch(`${baseUrl}/suivi`);
  assert.equal(trackingPage.status, 200);
  const trackingHtml = await trackingPage.text();
  assert.match(trackingHtml, /Suivi de réparation/);
  assert.match(trackingHtml, /id="tracking-progress"/);
  assert.match(trackingHtml, /data-step="EN_COURS"/);
  assert.match(trackingHtml, /id="notification-panel"/);
  const trackingScript = await fetch(`${baseUrl}/suivi.js`);
  assert.equal(trackingScript.status, 200);
  const trackingScriptText = await trackingScript.text();
  assert.match(trackingScriptText, /title:\s*'En cours'/);
  assert.match(trackingScriptText, /currentStatus === 'PRET' \|\| currentStatus === 'LIVRE'/);
  assert.match(trackingScriptText, /PushManager/);
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

test('authenticated business reads and mutations are constrained to the technician account', async () => {
  await startServer();
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const token = crypto.randomBytes(32).toString('hex');
  const deviceId = '00000000-0000-4000-8000-000000000022';
  const queries = [];
  const transactionQueries = [];

  db.query = async (sql, values = []) => {
    if (sql.includes('sessions_techniciens')) {
      assert.match(sql, /t\.role = 'ADMIN' AND t\.id = t\.account_id/);
      return { rows: [{ ...AUTHENTICATED_TECHNICIAN }], rowCount: 1 };
    }
    queries.push({ sql, values });
    if (sql.includes('SELECT COUNT(*) AS total')) return { rows: [{ total: '0' }], rowCount: 1 };
    if (sql.includes('WITH semaine AS')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('WITH local_now AS')) return { rows: [], rowCount: 0 };
    if (sql.includes('WITH personal_local_now AS')) {
      return {
        rows: [{
          encaissements_usd: '120.50',
          encaissements_cdf: '50000',
          depenses_usd: '20.25',
          depenses_cdf: '5000',
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('WITH current_device AS')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('UPDATE appareils_reparation')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  db.pool.connect = async () => ({
    query: async (sql, values = []) => {
      transactionQueries.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  });

  const request = (path, options = {}) => fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Cookie: `${SESSION_COOKIE}=${token}`,
      ...(options.headers || {}),
    },
  });

  try {
    assert.equal((await request('/api/clients?telephone=123')).status, 200);
    assert.equal((await request('/api/appareils')).status, 200);
    assert.equal((await request('/api/appareils?section=removed')).status, 200);
    assert.equal((await request(`/api/appareils/${deviceId}`)).status, 404);
    assert.equal((await request('/api/reports/revenue?period=week')).status, 200);
    assert.equal((await request('/api/reports/personal?period=quarter')).status, 400);
    const personalReport = await request('/api/reports/personal?period=week');
    assert.equal(personalReport.status, 200);
    assert.deepEqual(await personalReport.json(), {
      period: 'week',
      encaissements_usd: '120.50',
      encaissements_cdf: '50000',
      depenses_usd: '20.25',
      depenses_cdf: '5000',
      net_usd: 100.25,
      net_cdf: 45000,
    });
    assert.equal((await request('/api/dashboard')).status, 200);
    assert.equal((await request('/api/offline/snapshot')).status, 200);
    assert.equal((await request('/api/techniciens')).status, 404);

    const patch = await request(`/api/appareils/${deviceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statut: 'EN_COURS' }),
    });
    assert.equal(patch.status, 404);
    assert.equal((await request(`/api/appareils/${deviceId}`, { method: 'DELETE' })).status, 404);

    const payment = await request(`/api/appareils/${deviceId}/paiements`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': '00000000-0000-4000-8000-000000000023',
      },
      body: JSON.stringify({ montant: 10, devise: 'USD' }),
    });
    assert.equal(payment.status, 404);

    const approval = await request(`/api/appareils/${deviceId}/approbation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature_data: 'data:image/png;base64,AAAA' }),
    });
    assert.equal(approval.status, 404);

    const tenantId = AUTHENTICATED_TECHNICIAN.account_id;
    const scopedQuery = (text) => queries.find((entry) => entry.sql.includes(text));
    assert.deepEqual(scopedQuery('FROM clients').values, ['%123%', tenantId]);
    assert.match(scopedQuery('WITH local_now AS').sql, /a\.account_id = \$1/);
    assert.deepEqual(scopedQuery('WITH local_now AS').values, [tenantId]);
    const personalQuery = scopedQuery('WITH personal_local_now AS');
    assert.match(personalQuery.sql, /p\.account_id = \$1/);
    assert.match(personalQuery.sql, /a\.account_id = \$1/);
    assert.match(personalQuery.sql, /statistics_settings\.start_date/);
    assert.deepEqual(personalQuery.values, [tenantId]);
    assert.match(scopedQuery('WITH local_now AS').sql, /statistics_settings\.start_date/);
    assert.ok(queries.some((entry) => entry.sql.includes('FROM appareils_reparation a') &&
      entry.sql.includes('a.account_id = $1') && entry.values[0] === tenantId));
    const removedQuery = queries.find((entry) => entry.sql.includes('a.archived_at IS NOT NULL'));
    assert.ok(removedQuery);
    assert.equal(removedQuery.values[0], tenantId);
    assert.ok(queries.some((entry) => entry.sql.includes('WITH current_device AS') &&
      entry.sql.includes('account_id = $8') && entry.values[7] === tenantId));
    assert.ok(queries.some((entry) => entry.sql.startsWith('UPDATE appareils_reparation') &&
      entry.sql.includes('account_id = $3') && entry.values[2] === tenantId));
    assert.ok(transactionQueries.some((entry) => entry.sql.includes('FROM paiements WHERE request_key = $1 AND account_id = $2') &&
      entry.values[1] === tenantId));
    assert.ok(transactionQueries.some((entry) => entry.sql.includes('appareils_reparation') &&
      entry.sql.includes('account_id = $2') && entry.values[1] === tenantId));
    for (const entry of transactionQueries.filter((item) => item.sql.startsWith('SELECT'))) {
      assert.match(entry.sql, /account_id/);
      assert.ok(entry.values.includes(tenantId));
    }
  } finally {
    db.query = originalQuery;
    db.pool.connect = originalConnect;
  }
});

test('workshop settings, exports, and archived-device restoration stay scoped to the administrator account', async () => {
  await startServer();
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const token = crypto.randomBytes(32).toString('hex');
  const accountId = AUTHENTICATED_TECHNICIAN.account_id;
  const queries = [];
  const transactionQueries = [];
  let authenticatedTechnician = { ...AUTHENTICATED_TECHNICIAN };
  db.query = async (sql, values = []) => {
    if (sql.includes('sessions_techniciens')) {
      return { rows: [{ ...authenticatedTechnician }], rowCount: 1 };
    }
    queries.push({ sql, values });
    if (sql.includes('SELECT statistiques_depuis::text AS statistiques_depuis')) {
      return { rows: [{ statistiques_depuis: '2026-11-20' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO parametres_atelier')) {
      return { rows: [{ statistiques_depuis: values[1] }], rowCount: 1 };
    }
    if (sql.includes('UPDATE appareils_reparation') && sql.includes('archived_at = NULL')) {
      return { rows: [{ id: '00000000-0000-4000-8000-000000000033', updated_at: '2026-11-22T12:00:00.000Z' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  db.pool.connect = async () => ({
    query: async (sql, values = []) => {
      transactionQueries.push({ sql, values });
      if (sql.includes('SELECT statistiques_depuis::text')) {
        return { rows: [{ statistiques_depuis: '2026-11-20' }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT * FROM clients')) return { rows: [{ id: 'client-1' }], rowCount: 1 };
      if (sql.startsWith('SELECT * FROM appareils_reparation')) return { rows: [{ id: 'device-1' }], rowCount: 1 };
      if (sql.startsWith('SELECT * FROM paiements')) return { rows: [{ id: 'payment-1' }], rowCount: 1 };
      if (sql.startsWith('SELECT * FROM actes_approbation')) return { rows: [{ id: 'acte-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  });
  const request = (path, options = {}) => fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Cookie: `${SESSION_COOKIE}=${token}`,
      ...(options.headers || {}),
    },
  });
  try {
    const settings = await request('/api/settings');
    assert.equal(settings.status, 200);
    assert.deepEqual(await settings.json(), { statistiques_depuis: '2026-11-20' });
    assert.deepEqual(queries.find((entry) => entry.sql.includes('SELECT statistiques_depuis::text')).values, [accountId]);

    const invalidDate = await request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statistiques_depuis: '2026-02-30' }),
    });
    assert.equal(invalidDate.status, 400);

    const updatedSettings = await request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statistiques_depuis: '2026-11-21' }),
    });
    assert.equal(updatedSettings.status, 200);
    assert.deepEqual(queries.find((entry) => entry.sql.includes('INSERT INTO parametres_atelier')).values, [
      accountId,
      '2026-11-21',
    ]);

    const backup = await request('/api/export');
    assert.equal(backup.status, 200);
    const backupData = await backup.json();
    assert.equal(backupData.format, 'atelier-express-backup');
    assert.deepEqual(backupData.clients, [{ id: 'client-1' }]);
    assert.deepEqual(backupData.appareils_reparation, [{ id: 'device-1' }]);
    assert.ok(transactionQueries.filter((entry) => entry.sql.startsWith('SELECT')).every((entry) => (
      entry.values[0] === accountId && entry.sql.includes('account_id = $1')
    )));

    const restored = await request('/api/appareils/00000000-0000-4000-8000-000000000033/restore', {
      method: 'POST',
      headers: { 'X-Record-Version': '2026-11-22T11:00:00.000Z' },
    });
    assert.equal(restored.status, 200);
    const restoreQuery = queries.find((entry) => entry.sql.includes('archived_at = NULL'));
    assert.deepEqual(restoreQuery.values.slice(1), [
      '2026-11-22T11:00:00.000Z',
      accountId,
    ]);

    authenticatedTechnician = { ...AUTHENTICATED_TECHNICIAN, role: 'TECHNICIEN' };
    const technicianOnly = await request('/api/settings');
    assert.equal(technicianOnly.status, 403);
  } finally {
    db.query = originalQuery;
    db.pool.connect = originalConnect;
  }
});

test('active repair corrections preserve account boundaries and refuse signed records', async () => {
  await startServer();
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const token = crypto.randomBytes(32).toString('hex');
  const accountId = AUTHENTICATED_TECHNICIAN.account_id;
  const deviceId = '00000000-0000-4000-8000-000000000034';
  const queries = [];
  let signed = false;
  db.query = async (sql) => {
    if (sql.includes('sessions_techniciens')) {
      return { rows: [{ ...AUTHENTICATED_TECHNICIAN }], rowCount: 1 };
    }
    throw new Error(`Unexpected direct query: ${sql}`);
  };
  db.pool.connect = async () => ({
    query: async (sql, values = []) => {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT a.id, a.client_id')) {
        return {
          rows: [{
            id: deviceId,
            client_id: '00000000-0000-4000-8000-000000000035',
            statut: 'EN_COURS',
            updated_at: '2026-11-22T12:00:00.000Z',
            acte_id: signed ? 'acte-1' : null,
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE appareils_reparation')) {
        return {
          rows: [{
            id: deviceId,
            type_appareil: 'TABLETTE',
            marque: 'Samsung',
            modele: 'Tab',
            panne: 'Écran',
            prix_convenu: '150',
            prix_devise: 'USD',
            urgent: true,
            updated_at: '2026-11-22T12:10:00.000Z',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  });
  try {
    const response = await fetch(`${baseUrl}/api/appareils/${deviceId}/details`, {
      method: 'PATCH',
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        'Content-Type': 'application/json',
        'X-Record-Version': '2026-11-22T12:00:00.000Z',
      },
      body: JSON.stringify({
        nom: 'Client corrigé',
        telephone: '+243812345678',
        type_appareil: 'TABLETTE',
        marque: 'Samsung',
        modele: 'Tab',
        panne: 'Écran',
        prix_convenu: 150,
        prix_devise: 'USD',
        urgent: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(queries.some((entry) => entry.sql.startsWith('UPDATE clients') &&
      entry.values[3] === accountId));
    assert.ok(queries.some((entry) => entry.sql.startsWith('UPDATE appareils_reparation') &&
      entry.values[8] === accountId));

    queries.length = 0;
    signed = true;
    const rejected = await fetch(`${baseUrl}/api/appareils/${deviceId}/details`, {
      method: 'PATCH',
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        'Content-Type': 'application/json',
        'X-Record-Version': '2026-11-22T12:00:00.000Z',
      },
      body: JSON.stringify({
        nom: 'Client corrigé',
        telephone: '+243812345678',
        type_appareil: 'TABLETTE',
        marque: 'Samsung',
        modele: 'Tab',
        panne: 'Écran',
        prix_convenu: 150,
        prix_devise: 'USD',
        urgent: true,
      }),
    });
    assert.equal(rejected.status, 409);
    assert.equal(queries.some((entry) => entry.sql.startsWith('UPDATE clients')), false);
    assert.equal(queries.some((entry) => entry.sql.startsWith('UPDATE appareils_reparation')), false);
  } finally {
    db.query = originalQuery;
    db.pool.connect = originalConnect;
  }
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
    if (sql.includes('SELECT type_appareil, marque, modele, statut')) {
      return {
        rows: [{ type_appareil: 'TELEPHONE', marque: 'Tecno', modele: 'Spark', statut: 'EN_COURS', updated_at: '2026-11-21T12:00:00.000Z' }],
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
    assert.deepEqual(Object.keys(trackingData.appareil).sort(), ['type_appareil', 'marque', 'modele', 'statut', 'updated_at'].sort());
    assert.equal(trackingData.appareil.type_appareil, 'TELEPHONE');
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
        rows: [{ ...AUTHENTICATED_TECHNICIAN }],
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
        rows: [{ ...AUTHENTICATED_TECHNICIAN }],
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
        rows: [{ ...AUTHENTICATED_TECHNICIAN }],
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

test('repair costs update both currencies and stay scoped to the logged-in account', async () => {
  await startServer();
  const originalQuery = db.query;
  const token = crypto.randomBytes(32).toString('hex');
  const deviceId = '00000000-0000-4000-8000-000000000033';
  const accountId = AUTHENTICATED_TECHNICIAN.account_id;
  let update;
  db.query = async (sql, values = []) => {
    if (sql.includes('sessions_techniciens')) {
      return { rows: [{ ...AUTHENTICATED_TECHNICIAN }], rowCount: 1 };
    }
    if (sql.includes('WITH current_device AS')) {
      update = { sql, values };
      return {
        rows: [{
          id: deviceId,
          statut: 'LIVRE',
          frais_usd: '15.25',
          frais_cdf: '5000',
          updated_at: '2026-11-22 11:00:00+00',
          previous_statut: 'LIVRE',
        }],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    const response = await fetch(`${baseUrl}/api/appareils/${deviceId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE}=${token}`,
      },
      body: JSON.stringify({ frais_usd: 15.25, frais_cdf: 5000 }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.frais_usd, '15.25');
    assert.equal(result.frais_cdf, '5000');
    assert.match(update.sql, /account_id = \$8/);
    assert.match(update.sql, /frais_usd_saisis_at/);
    assert.match(update.sql, /frais_cdf_saisis_at/);
    assert.deepEqual(update.values.slice(7), [accountId, true, 15.25, 5000]);
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
        rows: [{ ...AUTHENTICATED_TECHNICIAN }],
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
    type_appareil: 'TABLETTE',
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
        rows: [{ ...AUTHENTICATED_TECHNICIAN }],
        rowCount: 1,
      };
    }
    if (sql.includes('WHERE a.request_key = $1')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('WITH client AS')) {
      insertedValues = values;
      assert.match(sql, /type_appareil/);
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
    assert.equal(insertedValues[9], AUTHENTICATED_TECHNICIAN.account_id);
    assert.equal(insertedValues[10], 'TABLETTE');
  } finally {
    db.query = originalQuery;
  }
});

test('repair intake rejects device types outside the supported categories', async () => {
  await startServer();
  const originalQuery = db.query;
  const token = crypto.randomBytes(32).toString('hex');
  let businessQueries = 0;
  db.query = async (sql) => {
    if (sql.includes('sessions_techniciens')) {
      return { rows: [{ ...AUTHENTICATED_TECHNICIAN }], rowCount: 1 };
    }
    businessQueries += 1;
    throw new Error('Invalid device type must be rejected before database writes.');
  };
  try {
    const response = await fetch(`${baseUrl}/api/appareils`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE}=${token}`,
        'Idempotency-Key': '00000000-0000-4000-8000-000000000034',
      },
      body: JSON.stringify({
        telephone: '+243812345678',
        type_appareil: 'MONTRE',
        marque: 'Test',
        modele: '',
        panne: 'Écran cassé',
        prix_convenu: 10,
        urgent: false,
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(businessQueries, 0);
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
      rows: [{ ...AUTHENTICATED_TECHNICIAN }],
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

test('public workshop request creates no account before approval', async () => {
  await startServer();
  const originalConnect = db.pool.connect;
  const originalQuery = db.query;
  let requested = false;
  db.query = async (sql) => {
    if (sql.includes('UPDATE workshop_account_requests')) return { rows: [], rowCount: 0 };
    if (sql.includes('COUNT(*) AS total')) return { rows: [{ total: '0' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  db.pool.connect = async () => ({
    query: async (sql, values = []) => {
      if (sql.includes('SELECT id FROM techniciens WHERE email')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id FROM workshop_account_requests')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO workshop_account_requests')) requested = true;
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  });
  try {
    const publicResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nom: 'Nova',
        email: 'nova@example.com',
        password: 'Aa1234',
        confirmation: 'Aa1234',
      }),
    });
    assert.equal(publicResponse.status, 201);
    assert.match((await publicResponse.json()).message, /envoyée à l’administrateur/);
    assert.equal(requested, true);

    const unauthenticated = await fetch(`${baseUrl}/api/workshop-requests`);
    assert.equal(unauthenticated.status, 401);
  } finally {
    db.pool.connect = originalConnect;
    db.query = originalQuery;
  }
});

test('principal admin can reissue a lost code for an expired workshop request', async () => {
  await startServer();
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const requestId = '00000000-0000-4000-8000-000000000031';
  const adminId = AUTHENTICATED_TECHNICIAN.id;
  let updatedCodeHash;
  let released = false;
  db.query = async (sql) => {
    if (sql.includes('FROM sessions_techniciens s')) {
      return { rows: [{ ...AUTHENTICATED_TECHNICIAN }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  db.pool.connect = async () => ({
    query: async (sql, values = []) => {
      if (sql.includes('SELECT id FROM techniciens')) {
        return { rows: [{ id: adminId }], rowCount: 1 };
      }
      if (sql.includes('SELECT id, email FROM workshop_account_requests')) {
        assert.match(sql, /status IN \('APPROVED', 'EXPIRED'\)/);
        return { rows: [{ id: requestId, email: 'atelier@example.com' }], rowCount: 1 };
      }
      if (sql.includes('UPDATE workshop_account_requests')) {
        assert.match(sql, /code_attempts = 0/);
        assert.match(sql, /INTERVAL '3 minutes'/);
        updatedCodeHash = values[1];
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => { released = true; },
  });
  try {
    const response = await fetch(`${baseUrl}/api/workshop-requests/${requestId}/reissue`, {
      method: 'POST',
      headers: { Cookie: `atelier_session=${'a'.repeat(64)}` },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.match(result.code, /^\d{6}$/);
    assert.equal(result.email, 'atelier@example.com');
    assert.equal(result.expires_in_seconds, 180);
    assert.equal(
      updatedCodeHash,
      crypto.createHash('sha256').update(result.code).digest('hex'),
    );
    assert.equal(released, true);
  } finally {
    db.pool.connect = originalConnect;
    db.query = originalQuery;
  }
});

test('approved workshop code cannot confirm after expiry', async () => {
  await startServer();
  const originalConnect = db.pool.connect;
  let createdAccount = false;
  db.pool.connect = async () => ({
    query: async (sql) => {
      if (sql.includes('SELECT id, nom, email, password_hash, code_hash')) {
        return {
          rows: [{
            id: '00000000-0000-4000-8000-000000000030',
            nom: 'Nouvel atelier',
            email: 'atelier@example.com',
            password_hash: 'stored-hash',
            code_hash: '0'.repeat(64),
            code_expires_at: new Date(Date.now() - 60000).toISOString(),
            code_attempts: 0,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO techniciens')) createdAccount = true;
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  });
  try {
    const response = await fetch(`${baseUrl}/api/auth/workshop-request/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: '00000000-0000-4000-8000-000000000030',
        email: 'atelier@example.com',
        code: '123456',
      }),
    });
    assert.equal(response.status, 410);
    assert.match((await response.json()).erreur, /code a expiré/i);
    assert.equal(createdAccount, false);
  } finally {
    db.pool.connect = originalConnect;
  }
});

test('employee accounts cannot log in as independent workshop owners', async () => {
  await startServer();
  const originalQuery = db.query;
  let loginQuery;
  db.query = async (sql) => {
    if (sql.includes('SELECT attempts')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT t.id, t.nom, t.email, t.password_hash')) {
      loginQuery = sql;
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  };
  try {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'employee@example.com', password: 'Aa1234' }),
    });
    assert.equal(response.status, 401);
    assert.match(loginQuery, /t\.role = 'ADMIN' AND t\.id = t\.account_id/);
  } finally {
    db.query = originalQuery;
  }
});

test('login stores the 30-day expiration when remember is selected', async () => {
  await startServer();
  const originalQuery = db.query;
  const passwordHash = await hashPassword('Aa1234');
  let sessionExpirationSeconds;
  db.query = async (sql, values = []) => {
    if (sql.includes('SELECT attempts')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT t.id, t.nom, t.email, t.password_hash')) {
      return {
        rows: [{
          id: AUTHENTICATED_TECHNICIAN.account_id,
          nom: 'Nova',
          email: 'nova@example.com',
          password_hash: passwordHash,
          role: 'ADMIN',
          account_id: AUTHENTICATED_TECHNICIAN.account_id,
          legacy_cache_owner: true,
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
