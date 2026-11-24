const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('offline storage opens a separate database for each non-legacy account', async () => {
  const openedDatabases = [];
  const values = new Map();
  const localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const indexedDB = {
    open(name) {
      openedDatabases.push(name);
      const request = {};
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          close() {},
        };
        request.onsuccess();
      });
      return request;
    },
  };
  const window = { indexedDB, localStorage };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'offline-store.js'), 'utf8'),
    { window, indexedDB, console },
  );
  const store = window.OfflineStore;
  const primaryAccountId = '00000000-0000-4000-8000-000000000001';
  const otherAccountId = '00000000-0000-4000-8000-000000000002';

  await store.open();
  assert.equal(store.setAccount(otherAccountId, false), false);
  await store.open();
  assert.equal(await store.replaceSnapshot({ clients: [] }, primaryAccountId), false);
  assert.equal(store.setAccount(primaryAccountId, true), true);
  await store.open();

  assert.deepEqual(openedDatabases, [
    'atelier-express-offline',
    `atelier-express-offline-${otherAccountId}`,
    'atelier-express-offline',
  ]);
});
