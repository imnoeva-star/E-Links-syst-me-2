const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'offline-sync.js'), 'utf8');

function createSync(fetchImpl) {
  const window = {};
  vm.runInNewContext(source, { window, fetch: fetchImpl });
  return window.OfflineSync;
}

function response(status, data = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
  };
}

test('conflicted offline repair changes override only the changed fields on the latest server version', async () => {
  const requests = [];
  const currentDevice = {
    id: '00000000-0000-4000-8000-000000000001',
    statut: 'EN_COURS',
    urgent: false,
    prix_convenu: '120',
    prix_devise: 'USD',
    frais_usd: '10',
    frais_cdf: '500',
    updated_at: '2026-11-27T09:00:00.123Z',
  };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === 'PATCH') {
      return response(200, {
        ...currentDevice,
        urgent: true,
        frais_usd: '25',
        updated_at: '2026-11-27T09:01:00.456Z',
      });
    }
    return response(200, currentDevice);
  };
  const sync = createSync(fetchImpl);
  const result = await sync.reconcileVersionConflict({
    method: 'PATCH',
    url: `/api/appareils/${currentDevice.id}`,
    body: JSON.stringify({ urgent: true, frais_usd: 25, frais_cdf: 500 }),
    headers: { 'X-Record-Version': '2026-11-27T08:00:00.000Z' },
  });

  assert.equal(result.resolved, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers['X-Record-Version'], currentDevice.updated_at);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    urgent: true,
    frais_usd: 25,
    frais_cdf: 500,
  });
});

test('conflicted fee changes retain both currency fields when either value differs', async () => {
  const requests = [];
  const currentDevice = {
    id: '00000000-0000-4000-8000-000000000002',
    statut: 'PRET',
    frais_usd: '25',
    frais_cdf: '750',
    updated_at: '2026-11-27T09:00:00.123Z',
  };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return options.method === 'PATCH'
      ? response(200, { ...currentDevice, frais_cdf: '500' })
      : response(200, currentDevice);
  };
  const sync = createSync(fetchImpl);
  const result = await sync.reconcileVersionConflict({
    method: 'PATCH',
    url: `/api/appareils/${currentDevice.id}`,
    body: JSON.stringify({ frais_usd: 25, frais_cdf: 500 }),
  });

  assert.equal(result.resolved, true);
  assert.deepEqual(JSON.parse(requests[1].options.body), { frais_usd: 25, frais_cdf: 500 });
});

test('conflicted status changes do not skip a repair lifecycle stage', async () => {
  const requests = [];
  const currentDevice = {
    id: '00000000-0000-4000-8000-000000000003',
    statut: 'DEPOT',
    updated_at: '2026-11-27T09:00:00.123Z',
  };
  const sync = createSync(async (url, options = {}) => {
    requests.push({ url, options });
    return response(200, currentDevice);
  });
  const result = await sync.reconcileVersionConflict({
    method: 'PATCH',
    url: `/api/appareils/${currentDevice.id}`,
    body: JSON.stringify({ statut: 'PRET' }),
  });

  assert.equal(result.resolved, false);
  assert.equal(requests.length, 1);
});

test('conflicted offline archive retries with the current server version', async () => {
  const requests = [];
  const currentDevice = {
    id: '00000000-0000-4000-8000-000000000004',
    updated_at: '2026-11-27T09:00:00.123Z',
  };
  const sync = createSync(async (url, options = {}) => {
    requests.push({ url, options });
    return options.method === 'DELETE'
      ? response(204)
      : response(200, currentDevice);
  });
  const result = await sync.reconcileVersionConflict({
    method: 'DELETE',
    url: `/api/appareils/${currentDevice.id}`,
    headers: { 'X-Record-Version': '2026-11-27T08:00:00.000Z' },
  });

  assert.equal(result.resolved, true);
  assert.equal(requests[1].options.headers['X-Record-Version'], currentDevice.updated_at);
});
