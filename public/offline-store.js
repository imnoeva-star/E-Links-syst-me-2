(() => {
  const DATABASE_NAME = 'atelier-express-offline';
  const ACCOUNT_STORAGE_KEY = 'atelier-express-offline-account';
  const LEGACY_OWNER_STORAGE_KEY = 'atelier-express-offline-legacy-owner';
  const DATABASE_VERSION = 1;
  const STORES = ['meta', 'clients', 'appareils', 'paiements', 'operations'];
  const accountIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let databaseName = DATABASE_NAME;
  let activeAccountId = null;
  let databasePromise;
  let activeDatabase;
  let operationSequence = 0;

  try {
    const storedAccountId = window.localStorage.getItem(ACCOUNT_STORAGE_KEY);
    if (accountIdPattern.test(storedAccountId || '')) {
      activeAccountId = storedAccountId;
      databaseName = window.localStorage.getItem(LEGACY_OWNER_STORAGE_KEY) === storedAccountId
        ? DATABASE_NAME
        : `${DATABASE_NAME}-${storedAccountId}`;
    }
  } catch (error) {
    console.error('Échec de lecture du compte hors ligne actif.', error);
  }

  function setAccount(accountId, legacyCacheOwner) {
    if (!accountIdPattern.test(accountId || '') || typeof legacyCacheOwner !== 'boolean') {
      throw new Error('Le compte connecté ne peut pas être utilisé pour le stockage hors ligne.');
    }
    const switchedAccount = activeAccountId !== null && activeAccountId !== accountId;
    const nextDatabaseName = legacyCacheOwner
      ? DATABASE_NAME
      : `${DATABASE_NAME}-${accountId}`;
    if (nextDatabaseName !== databaseName) {
      if (activeDatabase) activeDatabase.close();
      activeDatabase = null;
      databasePromise = null;
    }
    databaseName = nextDatabaseName;
    activeAccountId = accountId;
    window.localStorage.setItem(ACCOUNT_STORAGE_KEY, accountId);
    if (legacyCacheOwner) {
      window.localStorage.setItem(LEGACY_OWNER_STORAGE_KEY, accountId);
    } else {
      window.localStorage.removeItem(LEGACY_OWNER_STORAGE_KEY);
    }
    return switchedAccount;
  }

  function newId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function openDatabase() {
    if (!('indexedDB' in window)) {
      return Promise.reject(new Error('Le stockage hors ligne n’est pas disponible sur cet appareil.'));
    }
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          STORES.forEach((name) => {
            if (!database.objectStoreNames.contains(name)) {
              database.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' });
            }
          });
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => request.result.close();
          activeDatabase = request.result;
          resolve(request.result);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Fermez les autres fenêtres de l’application puis réessayez.'));
      });
    }
    return databasePromise;
  }

  async function read(storeName, key) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function all(storeName) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function write(storeName, value) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(value);
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Échec d’écriture du stockage hors ligne.'));
    });
  }

  async function remove(storeName, key) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Échec de suppression du stockage hors ligne.'));
    });
  }

  async function replaceSnapshot(snapshot, expectedAccountId) {
    if (expectedAccountId && expectedAccountId !== activeAccountId) return false;
    const [existingClients, existingDevices, existingPayments] = await Promise.all([
      all('clients'),
      all('appareils'),
      all('paiements'),
    ]);
    if (expectedAccountId && expectedAccountId !== activeAccountId) return false;
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['meta', 'clients', 'appareils', 'paiements'], 'readwrite');
      const stores = {
        meta: transaction.objectStore('meta'),
        clients: transaction.objectStore('clients'),
        appareils: transaction.objectStore('appareils'),
        paiements: transaction.objectStore('paiements'),
      };
      const localPending = {
        clients: existingClients.filter((record) => record.pending_sync),
        appareils: existingDevices.filter((record) => record.pending_sync),
        paiements: existingPayments.filter((record) => record.pending_sync),
      };
      ['clients', 'appareils', 'paiements'].forEach((name) => {
        stores[name].clear();
        const records = new Map((snapshot[name] || []).map((record) => [record.id, record]));
        localPending[name].forEach((record) => records.set(record.id, record));
        records.forEach((record) => stores[name].put(record));
      });
      stores.meta.put({ key: 'captured_at', value: snapshot.captured_at });
      stores.meta.put({
        key: 'settings',
        statistiques_depuis: snapshot.settings && snapshot.settings.statistiques_depuis || null,
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Échec d’enregistrement des données hors ligne.'));
    });
    return true;
  }

  async function saveSession(technician, expiresAt) {
    return write('meta', {
      key: 'offline_session',
      technician,
      saved_at: new Date().toISOString(),
      expires_at: expiresAt || new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    });
  }

  async function getSession() {
    const record = await read('meta', 'offline_session');
    if (record && (!Number.isFinite(Date.parse(record.expires_at)) || Date.parse(record.expires_at) <= Date.now())) {
      await clearSession();
      return null;
    }
    return record ? record.technician : null;
  }

  async function clearSession() {
    return remove('meta', 'offline_session');
  }

  async function commitMutation(operation, records = {}) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const storeNames = ['meta', 'operations', ...Object.keys(records)];
      const transaction = database.transaction(storeNames, 'readwrite');
      const meta = transaction.objectStore('meta');
      const operations = transaction.objectStore('operations');
      const sequenceRequest = meta.get('operation_sequence');
      let record;
      sequenceRequest.onsuccess = () => {
        operationSequence = Math.max(operationSequence, Number(sequenceRequest.result && sequenceRequest.result.value) || 0) + 1;
        meta.put({ key: 'operation_sequence', value: operationSequence });
        record = {
          ...operation,
          id: operation.id || newId(),
          sequence: operationSequence,
          created_at: new Date().toISOString(),
          blocked: false,
        };
        operations.put(record);
        Object.entries(records).forEach(([storeName, value]) => {
          const store = transaction.objectStore(storeName);
          (Array.isArray(value) ? value : [value]).forEach((item) => store.put(item));
        });
      };
      transaction.oncomplete = () => resolve(record);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Échec de mise en file hors ligne.'));
    });
  }

  async function enqueue(operation) {
    return commitMutation(operation);
  }

  async function getQueue() {
    return (await all('operations')).sort((left, right) =>
      left.sequence - right.sequence);
  }

  async function replaceOperation(operation) {
    return write('operations', operation);
  }

  async function replaceDeviceVersion(deviceId, localVersion, serverVersion) {
    const operations = await getQueue();
    await Promise.all(operations
      .filter((operation) => operation.deviceId === deviceId && operation.baseVersion === localVersion)
      .map((operation) => replaceOperation({ ...operation, baseVersion: serverVersion })));
  }

  window.OfflineStore = {
    all,
    clearSession,
    commitMutation,
    enqueue,
    get: read,
    setAccount,
    getQueue,
    getSession,
    isCurrentAccount: (accountId) => accountId === activeAccountId,
    open: openDatabase,
    remove,
    replaceDeviceVersion,
    replaceOperation,
    replaceSnapshot,
    saveSession,
    write,
  };
})();
