const $ = (selector) => document.querySelector(selector);
const formatMoney = (value, currency = 'CDF') =>
  `${new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: currency === 'USD' ? 2 : 0,
  }).format(Number(value || 0))} ${currency === 'USD' ? '$' : 'FC'}`;
const formatDate = (value) => value
  ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—';
const statusNames = { DEPOT: 'Dépôt', EN_COURS: 'En cours', PRET: 'Prêt', LIVRE: 'Livré' };
const statusOrder = ['DEPOT', 'EN_COURS', 'PRET', 'LIVRE'];
const deviceTypeNames = {
  TELEPHONE: 'Téléphone',
  TABLETTE: 'Tablette',
  ORDINATEUR: 'Ordinateur',
};
const brandSuggestions = {
  TELEPHONE: {
    popular: ['Tecno', 'Infinix', 'Samsung', 'iPhone', 'Itel', 'Xiaomi'],
    all: [
      'Alcatel', 'Apple', 'Asus', 'BlackBerry', 'Google', 'Honor', 'Huawei', 'Infinix',
      'Itel', 'Lenovo', 'Meizu', 'Motorola', 'Nokia', 'Nothing', 'OnePlus', 'Oppo',
      'Poco', 'Realme', 'Redmi', 'Samsung', 'Sony', 'Tecno', 'TCL', 'Vivo', 'Wiko', 'ZTE',
    ],
  },
  TABLETTE: {
    popular: ['Samsung', 'iPad', 'Lenovo', 'Huawei', 'Tecno', 'Infinix'],
    all: [
      'Amazon Fire', 'Apple', 'Asus', 'Acer', 'Google', 'Huawei', 'Infinix', 'Itel',
      'Lenovo', 'Microsoft Surface', 'Nokia', 'Samsung', 'TCL', 'Tecno', 'Xiaomi', 'ZTE',
    ],
  },
  ORDINATEUR: {
    popular: ['HP', 'Dell', 'Lenovo', 'Apple', 'Asus', 'Acer'],
    all: [
      'Acer', 'Apple', 'Asus', 'Dell', 'Fujitsu', 'Google Chromebook', 'HP', 'Huawei',
      'Lenovo', 'Microsoft Surface', 'MSI', 'Samsung', 'Toshiba', 'Xiaomi',
    ],
  },
};
const state = {
  approvalId: null,
  hasSignature: false,
  pendingIntake: null,
  pendingPayment: null,
  approvalVersion: null,
  passwordResetToken: null,
  isOffline: false,
  isSyncing: false,
  offlineStorageError: null,
  lastSnapshotAt: 0,
  technician: null,
  reportPeriod: 'week',
  reportCurrency: 'USD',
  reportData: null,
  personalReportData: null,
  workshopSettings: { statistiques_depuis: null },
};
const pageTitles = {
  dashboard: 'Tableau de bord',
  report: 'Bilan',
  new: 'Nouveau dépôt',
  waiting: 'Salle d’attente',
  archive: 'Archives',
  settings: 'Paramètres',
};

function showPage(name, updateUrl = true, loadData = true) {
  const requestedPage = Object.prototype.hasOwnProperty.call(pageTitles, name) ? name : 'dashboard';
  const page = requestedPage === 'settings' && state.technician?.role !== 'ADMIN'
    ? 'dashboard'
    : requestedPage;
  document.querySelectorAll('.page-view').forEach((view) => {
    view.classList.toggle('hidden', view.id !== `page-${page}`);
  });
  $('#page-title').textContent = pageTitles[page];
  document.querySelectorAll('#main-menu [data-page]').forEach((button) => {
    const active = button.dataset.page === page;
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
    button.classList.toggle('bg-teal-50', active);
    button.classList.toggle('text-teal-800', active);
  });
  closeMenu(false);
  if (updateUrl && window.location.hash !== `#${page}`) {
    window.history.pushState(null, '', `#${page}`);
  } else if (!updateUrl && window.location.hash && window.location.hash !== `#${page}`) {
    window.history.replaceState(null, '', `#${page}`);
  }
  if (loadData) loadPageData(page).catch(showConnectionError);
}

function loadPageData(page) {
  if (page === 'dashboard') return loadDashboard();
  if (page === 'report') return loadRevenueReport();
  if (page === 'waiting' || page === 'archive') return loadDevices(page);
  if (page === 'settings') return loadSettings();
  return Promise.resolve();
}

function openMenu() {
  const menu = $('#main-menu');
  const backdrop = $('#menu-backdrop');
  backdrop.classList.remove('hidden');
  window.requestAnimationFrame(() => backdrop.classList.remove('opacity-0'));
  menu.classList.remove('invisible');
  menu.classList.remove('-translate-x-full');
  menu.setAttribute('aria-hidden', 'false');
  menu.inert = false;
  $('#menu-toggle').setAttribute('aria-expanded', 'true');
  $('#menu-toggle').setAttribute('aria-label', 'Fermer le menu');
  document.body.classList.add('overflow-hidden');
  $('#menu-close').focus();
}

function closeMenu(returnFocus = false) {
  const menu = $('#main-menu');
  const backdrop = $('#menu-backdrop');
  menu.classList.add('-translate-x-full');
  menu.setAttribute('aria-hidden', 'true');
  menu.inert = true;
  backdrop.classList.add('opacity-0');
  window.setTimeout(() => {
    if (menu.getAttribute('aria-hidden') === 'true') {
      menu.classList.add('invisible');
      backdrop.classList.add('hidden');
    }
  }, 300);
  $('#menu-toggle').setAttribute('aria-expanded', 'false');
  $('#menu-toggle').setAttribute('aria-label', 'Ouvrir le menu');
  document.body.classList.remove('overflow-hidden');
  if (returnFocus) $('#menu-toggle').focus();
}

$('#menu-toggle').addEventListener('click', openMenu);
$('#menu-close').addEventListener('click', () => closeMenu(true));
$('#menu-backdrop').addEventListener('click', () => closeMenu(true));
document.addEventListener('keydown', (event) => {
  const isMenuOpen = $('#menu-toggle').getAttribute('aria-expanded') === 'true';
  if (event.key === 'Escape' && isMenuOpen) {
    closeMenu(true);
    return;
  }
  if (event.key === 'Tab' && isMenuOpen) {
    const focusable = [...$('#main-menu').querySelectorAll('button:not([disabled])')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

document.querySelectorAll('[data-page]')
  .forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
document.querySelectorAll('[data-report-period]').forEach((button) => {
  button.addEventListener('click', () => {
    state.reportPeriod = button.dataset.reportPeriod;
    updateReportControls();
    loadRevenueReport().catch(showConnectionError);
  });
});
document.querySelectorAll('[data-report-currency]').forEach((button) => {
  button.addEventListener('click', () => {
    state.reportCurrency = button.dataset.reportCurrency;
    updateReportControls();
    if (state.reportData) renderRevenueReport(state.reportData);
  });
});
window.addEventListener('hashchange', () => showPage(window.location.hash.slice(1), false));
window.addEventListener('popstate', () => {
  if ($('#approval-dialog').open) {
    $('#approval-dialog').close();
    if (deviceHistoryEntry && !$('#device-dialog').classList.contains('hidden')) {
      window.history.pushState({ appDeviceDialog: true }, '', window.location.href);
    }
    return;
  }
  if (!$('#device-dialog').classList.contains('hidden')) {
    closeDevice({ fromHistory: true });
  }
});

function deviceSearchText(device) {
  return [
    device.client_nom,
    device.nom,
    device.telephone,
    device.marque,
    device.modele,
    deviceTypeNames[device.type_appareil],
    device.panne,
  ].filter(Boolean).join(' ').toLocaleLowerCase('fr');
}

function normalizedPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function kinshasaDateParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kinshasa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function kinshasaDateKey(value) {
  const parts = kinshasaDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function reportBuckets(period, now = new Date()) {
  const current = kinshasaDateParts(now);
  const year = Number(current.year);
  const month = Number(current.month);
  const day = Number(current.day);

  if (period === 'day') {
    return Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
  }
  if (period === 'year') {
    return Array.from({ length: 12 }, (_, index) =>
      `${current.year}-${String(index + 1).padStart(2, '0')}`);
  }

  const start = new Date(Date.UTC(year, month - 1, day));
  if (period === 'week') start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  else start.setUTCDate(1);

  const count = period === 'week' ? 7 : new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

async function offlineRevenueReport(period) {
  if (!['day', 'week', 'month', 'year'].includes(period)) {
    throw new Error('Période de bilan invalide.');
  }
  const [devices, payments, settings] = await Promise.all([
    OfflineStore.all('appareils'),
    OfflineStore.all('paiements'),
    OfflineStore.get('meta', 'settings'),
  ]);
  const deliveredIds = new Set(devices
    .filter((device) => !device.archived_at && device.statut === 'LIVRE' && device.acte_valide)
    .map((device) => device.id));
  const buckets = reportBuckets(period);
  const totals = new Map(buckets.map((bucket) => [bucket, { usd: 0, cdf: 0 }]));
  const todayKey = kinshasaDateKey(new Date());

  payments.forEach((payment) => {
    if (!deliveredIds.has(payment.appareil_id)) return;
    if (settings?.statistiques_depuis && kinshasaDateKey(payment.created_at) < settings.statistiques_depuis) return;
    const parts = kinshasaDateParts(payment.created_at);
    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    if (period === 'day' && dateKey !== todayKey) return;
    const bucket = period === 'day'
      ? parts.hour
      : period === 'year'
        ? `${parts.year}-${parts.month}`
        : dateKey;
    const entry = totals.get(bucket);
    const amount = Math.round(Number(payment.montant) * 100);
    if (!entry || !Number.isFinite(amount) || amount <= 0) return;
    if (payment.devise === 'USD') entry.usd += amount;
    else if (payment.devise === 'CDF') entry.cdf += amount;
  });

  return {
    period,
    points: buckets.map((bucket) => {
      const total = totals.get(bucket);
      return { bucket, usd: total.usd / 100, cdf: total.cdf / 100 };
    }),
  };
}

async function offlinePersonalReport(period) {
  if (!['day', 'week', 'month', 'year'].includes(period)) {
    throw new Error('Période de bilan invalide.');
  }
  const [devices, payments, settings] = await Promise.all([
    OfflineStore.all('appareils'),
    OfflineStore.all('paiements'),
    OfflineStore.get('meta', 'settings'),
  ]);
  const buckets = reportBuckets(period);
  const todayKey = kinshasaDateKey(new Date());
  const startKey = period === 'week' ? buckets[0] : todayKey;
  const totals = {
    encaissements_usd: 0,
    encaissements_cdf: 0,
    depenses_usd: 0,
    depenses_cdf: 0,
  };
  const isInPeriod = (value) => {
    if (!value) return false;
    const key = kinshasaDateKey(value);
    if (period === 'day') return key === todayKey;
    if (period === 'week') return key >= startKey && key <= todayKey;
    if (period === 'month') return key.slice(0, 7) === todayKey.slice(0, 7);
    return key.slice(0, 4) === todayKey.slice(0, 4);
  };

  payments.forEach((payment) => {
    if (!isInPeriod(payment.created_at)) return;
    if (settings?.statistiques_depuis && kinshasaDateKey(payment.created_at) < settings.statistiques_depuis) return;
    const amount = Math.round(Number(payment.montant) * 100);
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (payment.devise === 'USD') totals.encaissements_usd += amount;
    else if (payment.devise === 'CDF') totals.encaissements_cdf += amount;
  });
  devices.forEach((device) => {
    if (
      isInPeriod(device.frais_usd_saisis_at) &&
      (!settings?.statistiques_depuis || kinshasaDateKey(device.frais_usd_saisis_at) >= settings.statistiques_depuis)
    ) {
      const usd = Math.round(Number(device.frais_usd || 0) * 100);
      if (Number.isFinite(usd) && usd >= 0) totals.depenses_usd += usd;
    }
    if (
      isInPeriod(device.frais_cdf_saisis_at) &&
      (!settings?.statistiques_depuis || kinshasaDateKey(device.frais_cdf_saisis_at) >= settings.statistiques_depuis)
    ) {
      const cdf = Math.round(Number(device.frais_cdf || 0) * 100);
      if (Number.isFinite(cdf) && cdf >= 0) totals.depenses_cdf += cdf;
    }
  });

  const amounts = Object.fromEntries(
    Object.entries(totals).map(([key, amount]) => [key, amount / 100]),
  );
  return {
    period,
    ...amounts,
    net_usd: (totals.encaissements_usd - totals.depenses_usd) / 100,
    net_cdf: (totals.encaissements_cdf - totals.depenses_cdf) / 100,
  };
}

async function offlineDashboard() {
  const [devices, payments, settings] = await Promise.all([
    OfflineStore.all('appareils'),
    OfflineStore.all('paiements'),
    OfflineStore.get('meta', 'settings'),
  ]);
  const visibleDevices = devices.filter((device) => !device.archived_at);
  const deliveredIds = new Set(visibleDevices
    .filter((device) => device.statut === 'LIVRE' && device.acte_valide)
    .map((device) => device.id));
  const todayKey = kinshasaDateKey(new Date());
  const today = new Date(`${todayKey}T00:00:00Z`);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400000);
  const dates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday.getTime() + index * 86400000);
    return date.toISOString().slice(0, 10);
  });
  const revenue = Object.fromEntries(dates.map((date) => [date, { usd: 0, cdf: 0 }]));
  let usd = 0;
  let cdf = 0;
  payments.forEach((payment) => {
    if (!deliveredIds.has(payment.appareil_id)) return;
    const date = kinshasaDateKey(payment.created_at);
    if (settings?.statistiques_depuis && date < settings.statistiques_depuis) return;
    if (!Object.prototype.hasOwnProperty.call(revenue, date)) return;
    const amount = Number(payment.montant || 0);
    if (payment.devise === 'USD') {
      usd += amount;
      revenue[date].usd += amount;
    } else if (payment.devise === 'CDF') {
      cdf += amount;
      revenue[date].cdf += amount;
    }
  });
  const urgent = visibleDevices
    .filter((device) => device.urgent && device.statut !== 'LIVRE')
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
    .slice(0, 10)
    .map((device) => ({
      id: device.id,
      marque: device.marque,
      modele: device.modele,
      panne: device.panne,
      statut: device.statut,
      nom: device.client_nom,
      telephone: device.telephone,
    }));
  return {
    chiffre_semaine_usd: usd,
    chiffre_semaine_cdf: cdf,
    encaissements_journaliers: dates.map((jour) => ({ jour, ...revenue[jour] })),
    appareils_attente: visibleDevices.filter((device) => device.statut !== 'LIVRE').length,
    urgents: visibleDevices.filter((device) => device.urgent && device.statut !== 'LIVRE').length,
    prioritaire: urgent,
  };
}

async function offlineRequest(url, options = {}) {
  const parsedUrl = new URL(url, window.location.origin);
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  const body = options.body ? JSON.parse(options.body) : {};
  const pathname = parsedUrl.pathname;

  if (!state.technician) {
    throw new Error('Une première connexion en ligne est nécessaire sur cet appareil.');
  }
  if (method === 'GET') {
    if (
      ['/api/dashboard', '/api/reports/revenue', '/api/reports/personal', '/api/clients', '/api/appareils'].includes(pathname) &&
      !(await OfflineStore.get('meta', 'captured_at'))
    ) {
      throw new Error('Ouvrez l’application une fois en ligne pour préparer les données hors connexion.');
    }
    if (pathname === '/api/dashboard') return offlineDashboard();
    if (pathname === '/api/reports/revenue') {
      return offlineRevenueReport(parsedUrl.searchParams.get('period'));
    }
    if (pathname === '/api/reports/personal') {
      return offlinePersonalReport(parsedUrl.searchParams.get('period'));
    }
    if (pathname === '/api/clients') {
      const telephone = (parsedUrl.searchParams.get('telephone') || '').replace(/\D/g, '');
      if (telephone.length < 3) return [];
      return (await OfflineStore.all('clients'))
        .filter((client) => client.telephone.replace(/\D/g, '').includes(telephone))
        .slice(0, 8);
    }
    if (pathname === '/api/appareils') {
      const section = parsedUrl.searchParams.get('section') || 'waiting';
      if (section === 'removed') {
        throw new Error('La restauration des dossiers nécessite une connexion Internet.');
      }
      const search = (parsedUrl.searchParams.get('q') || '').trim().toLocaleLowerCase('fr');
      const status = parsedUrl.searchParams.get('status') || 'ALL';
      const requestedPage = Math.max(1, Number(parsedUrl.searchParams.get('page')) || 1);
      const matching = (await OfflineStore.all('appareils'))
        .filter((device) => {
          if (device.archived_at) return false;
          if (section === 'archive' && device.statut !== 'LIVRE') return false;
          if (section === 'waiting' && device.statut === 'LIVRE') return false;
          if (status === 'URGENT' && !device.urgent) return false;
          if (['DEPOT', 'EN_COURS', 'PRET'].includes(status) && device.statut !== status) return false;
          return !search || deviceSearchText(device).includes(search) ||
            normalizedPhone(device.telephone).includes(normalizedPhone(search));
        })
        .sort((left, right) => {
          if (section === 'waiting' && left.urgent !== right.urgent) return left.urgent ? -1 : 1;
          return String(right.created_at).localeCompare(String(left.created_at));
        });
      const pages = Math.max(1, Math.ceil(matching.length / 50));
      const page = Math.min(requestedPage, pages);
      return {
        appareils: matching.slice((page - 1) * 50, page * 50),
        total: matching.length,
        page,
        pages,
      };
    }
    if (pathname === '/api/settings' || pathname === '/api/export') {
      throw new Error('Les paramètres et les sauvegardes nécessitent une connexion Internet.');
    }
    const deviceMatch = pathname.match(/^\/api\/appareils\/([0-9a-f-]+)$/i);
    if (deviceMatch) {
      const device = await OfflineStore.get('appareils', deviceMatch[1]);
      if (!device || device.archived_at) throw new Error('Dossier introuvable dans les données hors ligne.');
      return device;
    }
    throw new Error('Cette fonction nécessite une connexion Internet.');
  }

  if (!['POST', 'PATCH', 'DELETE'].includes(method)) {
    throw new Error('Cette fonction nécessite une connexion Internet.');
  }
  const createMatch = pathname === '/api/appareils' && method === 'POST';
  const paymentMatch = pathname.match(/^\/api\/appareils\/([0-9a-f-]+)\/paiements$/i);
  const approvalMatch = pathname.match(/^\/api\/appareils\/([0-9a-f-]+)\/approbation$/i);
  const deviceMatch = pathname.match(/^\/api\/appareils\/([0-9a-f-]+)$/i);
  const now = new Date().toISOString();
  const records = {};
  let operation;

  if (createMatch) {
    const id = body.id || newRequestKey();
    const typeAppareil = body.type_appareil || 'TELEPHONE';
    const requestKey = headers.get('Idempotency-Key');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey || '') ||
        !['TELEPHONE', 'TABLETTE', 'ORDINATEUR'].includes(typeAppareil) ||
        typeof body.telephone !== 'string' ||
        typeof body.marque !== 'string' || typeof body.panne !== 'string' ||
        typeof body.nom !== 'string' || typeof body.modele !== 'string' ||
        typeof body.urgent !== 'boolean' || !body.marque.trim() || !body.panne.trim() ||
        typeof body.prix_convenu !== 'number' || !Number.isFinite(body.prix_convenu) ||
        body.prix_convenu < 0 || body.prix_convenu > 9999999999.99 ||
        Math.round(body.prix_convenu * 100) !== body.prix_convenu * 100 ||
        body.nom.trim().length > 80 || body.modele.trim().length > 100 ||
        body.marque.trim().length > 60 || body.panne.trim().length > 500) {
      throw new Error('Vérifiez les informations obligatoires du dépôt avant de l’enregistrer.');
    }
    body.id = id;
    const telephone = body.telephone.trim().replace(/[\s().-]/g, '');
    if (!/^\+?[0-9]{7,20}$/.test(telephone)) throw new Error('Numéro de téléphone invalide.');
    const clients = await OfflineStore.all('clients');
    let client = clients.find((item) => item.telephone === telephone);
    if (!client) client = { id: newRequestKey(), nom: body.nom || '', telephone, pending_sync: true };
    else if (body.nom) client = { ...client, nom: body.nom, pending_sync: true };
    records.clients = client;
    const device = {
      id,
      client_id: client.id,
      client_nom: body.nom || client.nom || '',
      telephone,
      type_appareil: typeAppareil,
      marque: body.marque,
      modele: body.modele || '',
      panne: body.panne,
      statut: 'DEPOT',
      prix_convenu: body.prix_convenu,
      prix_devise: 'USD',
      frais_usd: 0,
      frais_cdf: 0,
      frais_usd_saisis_at: null,
      frais_cdf_saisis_at: null,
      urgent: Boolean(body.urgent),
      archived_at: null,
      request_key: requestKey,
      created_at: now,
      updated_at: now,
      acte_valide: false,
      clause: null,
      signature_data: null,
      valide_at: null,
      paiements_usd: 0,
      paiements_cdf: 0,
      solde: body.prix_convenu,
      pending_sync: true,
    };
    records.appareils = device;
    operation = {
      method,
      url: pathname,
      body: JSON.stringify(body),
      headers: { 'Idempotency-Key': requestKey },
      deviceId: id,
      localVersion: now,
    };
    await OfflineStore.commitMutation(operation, records);
    updateOfflineStatus();
    return device;
  }

  const deviceId = paymentMatch ? paymentMatch[1] : approvalMatch ? approvalMatch[1] : deviceMatch && deviceMatch[1];
  if (!deviceId) throw new Error('Cette opération ne peut pas être mise en attente hors ligne.');
  const device = await OfflineStore.get('appareils', deviceId);
  if (!device || device.archived_at) throw new Error('Ce dossier n’est pas disponible hors ligne.');

  if (paymentMatch && method === 'POST') {
    const requestKey = headers.get('Idempotency-Key');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey || '') ||
        !Number.isFinite(body.montant) || body.montant <= 0 ||
        body.montant > 9999999999.99 || Math.round(body.montant * 100) !== body.montant * 100 ||
        !['USD', 'CDF'].includes(body.devise) || device.statut === 'LIVRE') {
      throw new Error('Vérifiez le montant et la devise du paiement.');
    }
    const payment = {
      id: requestKey,
      appareil_id: deviceId,
      montant: body.montant,
      devise: body.devise,
      request_key: requestKey,
      created_at: now,
      pending_sync: true,
    };
    const updatedDevice = { ...device, pending_sync: true };
    if (body.devise === 'USD') updatedDevice.paiements_usd = Number(device.paiements_usd || 0) + body.montant;
    else updatedDevice.paiements_cdf = Number(device.paiements_cdf || 0) + body.montant;
    if (device.prix_devise === body.devise && device.prix_convenu !== null) {
      updatedDevice.solde = Math.max(0, Number(device.prix_convenu) -
        Number(body.devise === 'USD' ? updatedDevice.paiements_usd : updatedDevice.paiements_cdf));
    }
    records.appareils = updatedDevice;
    records.paiements = payment;
    operation = {
      method,
      url: pathname,
      body: JSON.stringify(body),
      headers: { 'Idempotency-Key': requestKey },
      deviceId,
    };
    await OfflineStore.commitMutation(operation, records);
    updateOfflineStatus();
    return payment;
  }

  const baseVersion = headers.get('X-Record-Version') || device.updated_at;
  const updatedDevice = { ...device, updated_at: now, pending_sync: true };
  if (approvalMatch && method === 'POST') {
    if (
      device.statut !== 'PRET' ||
      typeof body.signature_data !== 'string' ||
      body.signature_data.length > 1000000 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.signature_data)
    ) {
      throw new Error('Le dossier doit être prêt et la signature du client présente.');
    }
    updatedDevice.statut = 'LIVRE';
    updatedDevice.acte_valide = true;
    updatedDevice.clause = 'Appareil testé et accepté par le client. Aucune réclamation ne sera acceptée après 48 heures.';
    updatedDevice.signature_data = body.signature_data;
    updatedDevice.valide_at = now;
  } else if (deviceMatch && method === 'PATCH') {
    if (body.statut && !['DEPOT', 'EN_COURS', 'PRET'].includes(body.statut)) {
      throw new Error('Statut non valide.');
    }
    if (
      body.statut &&
      body.statut !== device.statut &&
      !(
        (body.statut === 'EN_COURS' && device.statut === 'DEPOT') ||
        (body.statut === 'PRET' && device.statut === 'EN_COURS')
      )
    ) {
      throw new Error('Respectez l’ordre des étapes : dépôt, en cours, puis prêt.');
    }
    if (body.statut) updatedDevice.statut = body.statut;
    if (typeof body.urgent === 'boolean') updatedDevice.urgent = body.urgent;
    if (Object.prototype.hasOwnProperty.call(body, 'prix_convenu')) {
      updatedDevice.prix_convenu = body.prix_convenu;
      updatedDevice.prix_devise = body.prix_devise;
    }
    const hasExpensesUsd = Object.prototype.hasOwnProperty.call(body, 'frais_usd');
    const hasExpensesCdf = Object.prototype.hasOwnProperty.call(body, 'frais_cdf');
    if (hasExpensesUsd !== hasExpensesCdf) {
      throw new Error('Saisissez les frais en USD et en FC.');
    }
    if (hasExpensesUsd) {
      const validAmount = (amount) =>
        typeof amount === 'number' &&
        Number.isFinite(amount) &&
        amount >= 0 &&
        amount <= 9999999999.99 &&
        Math.round(amount * 100) === amount * 100;
      if (!validAmount(body.frais_usd) || !validAmount(body.frais_cdf)) {
        throw new Error('Vérifiez les totaux des frais en USD et en FC.');
      }
      if (Number(device.frais_usd || 0) !== body.frais_usd) updatedDevice.frais_usd_saisis_at = now;
      if (Number(device.frais_cdf || 0) !== body.frais_cdf) updatedDevice.frais_cdf_saisis_at = now;
      updatedDevice.frais_usd = body.frais_usd;
      updatedDevice.frais_cdf = body.frais_cdf;
    }
  } else if (deviceMatch && method === 'DELETE') {
    updatedDevice.archived_at = now;
  } else {
    throw new Error('Cette opération ne peut pas être mise en attente hors ligne.');
  }
  records.appareils = updatedDevice;
  operation = {
    method,
    url: pathname,
    body: options.body || '',
    headers: baseVersion ? { 'X-Record-Version': baseVersion } : {},
    deviceId,
    baseVersion,
    localVersion: now,
  };
  await OfflineStore.commitMutation(operation, records);
  updateOfflineStatus();
  return updatedDevice;
}

async function cacheOnlineResponse(url, method, data, options = {}, accountId) {
  const isCurrentAccount = () =>
    accountId &&
    state.technician?.account_id === accountId &&
    OfflineStore.isCurrentAccount(accountId);
  if (!isCurrentAccount()) return;
  const parsedUrl = new URL(url, window.location.origin);
  if (method === 'GET' && parsedUrl.pathname === '/api/offline/snapshot') {
    await OfflineStore.replaceSnapshot(data, accountId);
    return;
  }
  if (method === 'GET' && parsedUrl.pathname === '/api/appareils') {
    for (const device of data.appareils || []) {
      if (!isCurrentAccount()) return;
      const cached = await OfflineStore.get('appareils', device.id);
      if (!isCurrentAccount()) return;
      if (!cached || !cached.pending_sync) await OfflineStore.write('appareils', device);
    }
    return;
  }
  if (method === 'GET' && /^\/api\/appareils\/[0-9a-f-]+$/i.test(parsedUrl.pathname)) {
    const cached = await OfflineStore.get('appareils', data.id);
    if (!isCurrentAccount()) return;
    if (!cached || !cached.pending_sync) await OfflineStore.write('appareils', data);
    return;
  }
  const body = method === 'DELETE' ? {} : JSON.parse(options.body || '{}');
  if (method === 'POST' && parsedUrl.pathname === '/api/appareils') {
    const telephone = String(body.telephone || '').trim().replace(/[\s().-]/g, '');
    const clients = await OfflineStore.all('clients');
    if (!isCurrentAccount()) return;
    let client = clients.find((item) => item.telephone === telephone);
    if (!client) {
      client = { id: data.client_id, nom: body.nom || '', telephone };
    } else if (body.nom) {
      client = { ...client, nom: body.nom };
    }
    await OfflineStore.write('clients', client);
    if (!isCurrentAccount()) return;
    const existing = await OfflineStore.get('appareils', data.id);
    if (!isCurrentAccount()) return;
    await OfflineStore.write('appareils', {
      ...existing,
      ...data,
      client_id: data.client_id || client.id,
      client_nom: body.nom || client.nom || '',
      telephone,
      pending_sync: false,
    });
    return;
  }
  const paymentMatch = parsedUrl.pathname.match(/^\/api\/appareils\/([0-9a-f-]+)\/paiements$/i);
  if (paymentMatch && method === 'POST' && data) {
    const device = await OfflineStore.get('appareils', paymentMatch[1]);
    if (!isCurrentAccount()) return;
    if (device) {
      const payments = await OfflineStore.all('paiements');
      if (!isCurrentAccount()) return;
      const alreadyStored = payments.some((payment) => payment.request_key === data.request_key);
      if (!alreadyStored) {
        await OfflineStore.write('paiements', { ...data, pending_sync: false });
        if (!isCurrentAccount()) return;
        const updatedDevice = { ...device, pending_sync: false };
        if (data.devise === 'USD') updatedDevice.paiements_usd = Number(device.paiements_usd || 0) + Number(data.montant);
        else updatedDevice.paiements_cdf = Number(device.paiements_cdf || 0) + Number(data.montant);
        await OfflineStore.write('appareils', updatedDevice);
      }
    }
    return;
  }
  const approvalMatch = parsedUrl.pathname.match(/^\/api\/appareils\/([0-9a-f-]+)\/approbation$/i);
  if (approvalMatch && method === 'POST' && data) {
    const device = await OfflineStore.get('appareils', approvalMatch[1]);
    if (!isCurrentAccount()) return;
    if (device) {
      await OfflineStore.write('appareils', {
        ...device,
        statut: 'LIVRE',
        acte_valide: true,
        clause: data.clause || 'Appareil testé et accepté par le client. Aucune réclamation ne sera acceptée après 48 heures.',
        signature_data: body.signature_data,
        valide_at: data.valide_at,
        updated_at: data.updated_at,
        pending_sync: false,
      });
    }
    return;
  }
  const deviceMatch = parsedUrl.pathname.match(/^\/api\/appareils\/([0-9a-f-]+)$/i);
  if (deviceMatch && method === 'PATCH' && data) {
    const device = await OfflineStore.get('appareils', deviceMatch[1]);
    if (!isCurrentAccount()) return;
    if (device) await OfflineStore.write('appareils', { ...device, ...data, pending_sync: false });
    return;
  }
  if (deviceMatch && method === 'DELETE') {
    const device = await OfflineStore.get('appareils', deviceMatch[1]);
    if (!isCurrentAccount()) return;
    if (device) {
      await OfflineStore.write('appareils', {
        ...device,
        archived_at: new Date().toISOString(),
        pending_sync: false,
      });
    }
  }
}

function setOfflineMode(value) {
  state.isOffline = value;
  updateOfflineStatus();
}

async function updateOfflineStatus(message = '') {
  const status = $('#offline-status');
  if (!status) return;
  if (state.offlineStorageError) {
    status.textContent = `Mode hors ligne indisponible : ${state.offlineStorageError}`;
    status.className = 'mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800';
    status.classList.remove('hidden');
    return;
  }
  const queue = await OfflineStore.getQueue().catch(() => []);
  const blocked = queue.find((operation) => operation.blocked);
  if (state.isOffline) {
    status.textContent = `Hors ligne · ${queue.length} action${queue.length === 1 ? '' : 's'} en attente`;
    status.className = 'mb-3 rounded-lg bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-900';
  } else if (blocked) {
    status.textContent = message || `Synchronisation bloquée : ${blocked.error || 'un dossier a changé sur un autre appareil. Vos modifications restent conservées ici.'}`;
    status.className = 'mb-3 rounded-lg bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-900';
  } else if (state.isSyncing) {
    status.textContent = 'Synchronisation des changements…';
    status.className = 'mb-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900';
  } else if (queue.length) {
    status.textContent = `${queue.length} action${queue.length === 1 ? '' : 's'} en attente de synchronisation`;
    status.className = 'mb-3 rounded-lg bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-900';
  } else {
    status.textContent = '';
    status.className = 'mb-3 hidden rounded-lg px-3 py-2 text-sm';
    return;
  }
  status.classList.remove('hidden');
}

async function request(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const isSessionCheck = url === '/api/auth/session';
  const accountId = state.technician?.account_id || null;
  const isCurrentRequest = () => !accountId || state.technician?.account_id === accountId;
  const staleRequestError = () => {
    const error = new Error('La session a changé pendant le chargement.');
    error.stale = true;
    return error;
  };
  const readOffline = async () => {
    const data = await offlineRequest(url, options);
    if (!isCurrentRequest()) throw staleRequestError();
    return data;
  };
  if (state.isOffline || !navigator.onLine) {
    if (isSessionCheck) {
      const error = new Error('Serveur inaccessible. Vérifiez la connexion puis réessayez.');
      error.offline = true;
      throw error;
    }
    return readOffline();
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } catch (error) {
    if (!isCurrentRequest()) throw staleRequestError();
    if (error.name === 'AbortError') {
      setOfflineMode(true);
      if (isSessionCheck) {
        const timeoutError = new Error('La vérification de session a expiré.');
        timeoutError.offline = true;
        throw timeoutError;
      }
      return readOffline();
    }
    setOfflineMode(true);
    if (isSessionCheck) {
      const networkError = new Error('Serveur inaccessible. Vérifiez la connexion puis réessayez.');
      networkError.offline = true;
      throw networkError;
    }
    return readOffline();
  } finally {
    window.clearTimeout(timeout);
  }
  if (!isCurrentRequest()) throw staleRequestError();
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (!isCurrentRequest()) throw staleRequestError();
    if (response.status === 503 && url.startsWith('/api/')) {
      setOfflineMode(true);
      if (isSessionCheck) {
        const unavailableError = new Error(body.erreur || 'Serveur inaccessible.');
        unavailableError.offline = true;
        throw unavailableError;
      }
      return readOffline();
    }
    if (
      response.status === 401 &&
      url !== '/api/auth/login' &&
      url !== '/api/auth/session'
    ) {
      await OfflineStore.clearSession().catch((storageError) =>
        console.error('Échec de suppression de la session hors ligne.', storageError),
      );
      if (!isCurrentRequest()) throw staleRequestError();
      showLogin('Votre session a expiré. Reconnectez-vous.');
    }
    const error = new Error(body.erreur || 'Une erreur est survenue.');
    error.status = response.status;
    throw error;
  }
  setOfflineMode(false);
  const data = response.status === 204 ? null : await response.json();
  if (!isCurrentRequest()) throw staleRequestError();
  if (accountId && isCurrentRequest()) {
    try {
      await cacheOnlineResponse(url, method, data, options, accountId);
    } catch (error) {
      console.error('Échec de mise à jour du cache hors ligne.', error);
    }
  }
  return data;
}

async function refreshOfflineSnapshot() {
  const accountId = state.technician?.account_id;
  if (!accountId) return;
  try {
    const response = await fetch('/api/offline/snapshot', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.erreur || 'Impossible d’actualiser les données hors ligne.');
      error.status = response.status;
      throw error;
    }
    const snapshot = await response.json();
    if (
      state.technician?.account_id !== accountId ||
      !OfflineStore.isCurrentAccount(accountId)
    ) return;
    await OfflineStore.replaceSnapshot(snapshot, accountId);
    if (state.technician?.account_id !== accountId) return;
    state.lastSnapshotAt = Date.now();
    state.offlineStorageError = null;
    await updateOfflineStatus();
  } catch (error) {
    if (error instanceof TypeError || error.status >= 500) {
      state.offlineStorageError = null;
      setOfflineMode(true);
    } else {
      state.offlineStorageError = error.message || 'Impossible d’actualiser les données hors ligne.';
      await updateOfflineStatus();
    }
    throw error;
  }
}

async function finishSyncedOperation(operation, data) {
  if (operation.method === 'POST' && operation.url === '/api/appareils') {
    const device = await OfflineStore.get('appareils', operation.deviceId);
    if (device && data) {
      const requestBody = JSON.parse(operation.body || '{}');
      const clients = await OfflineStore.all('clients');
      const normalizedTelephone = normalizedPhone(requestBody.telephone);
      const localClient = clients.find((client) => normalizedPhone(client.telephone) === normalizedTelephone);
      if (localClient) {
        if (localClient.id !== data.client_id) await OfflineStore.remove('clients', localClient.id);
        await OfflineStore.write('clients', {
          ...localClient,
          id: data.client_id,
          nom: requestBody.nom || localClient.nom,
          pending_sync: false,
        });
      }
      await OfflineStore.write('appareils', {
        ...device,
        client_id: data.client_id,
        created_at: data.created_at,
        updated_at: data.updated_at,
      });
    }
  } else if (operation.url.endsWith('/paiements')) {
    const requestKey = new Headers(operation.headers).get('Idempotency-Key');
    const payments = await OfflineStore.all('paiements');
    const pending = payments.find((payment) => payment.request_key === requestKey);
    if (pending && data) {
      await OfflineStore.remove('paiements', pending.id);
      await OfflineStore.write('paiements', { ...data, pending_sync: false });
    }
  } else if (operation.method === 'DELETE') {
    const device = await OfflineStore.get('appareils', operation.deviceId);
    if (device) await OfflineStore.write('appareils', { ...device, pending_sync: false });
  }
  if (operation.localVersion && data && data.updated_at) {
    await OfflineStore.replaceDeviceVersion(operation.deviceId, operation.localVersion, data.updated_at);
    const device = await OfflineStore.get('appareils', operation.deviceId);
    if (device) await OfflineStore.write('appareils', { ...device, updated_at: data.updated_at });
  }
  const remaining = (await OfflineStore.getQueue())
    .some((queued) => queued.deviceId === operation.deviceId && queued.id !== operation.id);
  const device = operation.deviceId && await OfflineStore.get('appareils', operation.deviceId);
  if (device) await OfflineStore.write('appareils', { ...device, pending_sync: remaining });
}

async function reconcileVersionConflict(operation) {
  const approvalMatch = operation.url.match(/^\/api\/appareils\/([0-9a-f-]+)\/approbation$/i);
  const statusMatch = operation.url.match(/^\/api\/appareils\/([0-9a-f-]+)$/i);
  const deviceId = approvalMatch ? approvalMatch[1] : statusMatch && statusMatch[1];
  if (!deviceId || !['PATCH', 'POST'].includes(operation.method)) return { resolved: false };
  const body = JSON.parse(operation.body || '{}');
  if (approvalMatch) {
    if (
      operation.method !== 'POST' ||
      typeof body.signature_data !== 'string' ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.signature_data)
    ) {
      return { resolved: false };
    }
  } else {
    if (
      operation.method !== 'PATCH' ||
      Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, 'statut')
    ) {
      return { resolved: false };
    }
    const targetIndex = statusOrder.indexOf(body.statut);
    if (targetIndex < 1 || targetIndex > statusOrder.indexOf('PRET')) {
      return { resolved: false };
    }
  }

  const deviceUrl = `/api/appareils/${deviceId}`;
  const currentResponse = await fetch(deviceUrl, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!currentResponse.ok) return { resolved: false };
  const currentDevice = await currentResponse.json();
  if (approvalMatch) {
    if (
      currentDevice.statut === 'LIVRE' &&
      currentDevice.acte_valide &&
      currentDevice.signature_data === body.signature_data
    ) {
      return { resolved: true, data: currentDevice };
    }
    if (currentDevice.statut !== 'PRET' || currentDevice.acte_valide) {
      return { resolved: false };
    }
  } else {
    const targetIndex = statusOrder.indexOf(body.statut);
    const currentIndex = statusOrder.indexOf(currentDevice.statut);
    if (currentIndex >= targetIndex) return { resolved: true, data: currentDevice };
    if (currentIndex + 1 !== targetIndex) return { resolved: false };
  }
  if (!currentDevice.updated_at) return { resolved: false };
  const retryResponse = await fetch(operation.url, {
    method: operation.method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(operation.headers || {}),
      'X-Record-Version': currentDevice.updated_at,
    },
    body: operation.body,
  });
  if (!retryResponse.ok) return { resolved: false, response: retryResponse };
  return {
    resolved: true,
    data: retryResponse.status === 204 ? null : await retryResponse.json(),
  };
}

async function syncPendingOperations() {
  if (state.isSyncing || state.isOffline || !navigator.onLine || !state.technician) return;
  state.isSyncing = true;
  await updateOfflineStatus();
  let interrupted = false;
  try {
    const queue = await OfflineStore.getQueue();
    const blockedDeviceIds = new Set();
    for (const operation of queue) {
      const currentOperation = await OfflineStore.get('operations', operation.id);
      if (!currentOperation || blockedDeviceIds.has(currentOperation.deviceId)) continue;
      let response;
      if (currentOperation.blocked) {
        const isVersionConflict = /ce dossier a changé sur un autre appareil/i.test(currentOperation.error || '');
        if (isVersionConflict) {
          const reconciliation = await reconcileVersionConflict(currentOperation);
          if (reconciliation.resolved) {
            await finishSyncedOperation(currentOperation, reconciliation.data);
            await OfflineStore.remove('operations', currentOperation.id);
            continue;
          }
          response = reconciliation.response;
        }
        if (!response) {
          if (currentOperation.deviceId) blockedDeviceIds.add(currentOperation.deviceId);
          continue;
        }
      } else {
        try {
          response = await fetch(currentOperation.url, {
            method: currentOperation.method,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...(currentOperation.headers || {}) },
            body: currentOperation.method === 'DELETE' ? undefined : currentOperation.body,
          });
        } catch (error) {
          setOfflineMode(true);
          interrupted = true;
          break;
        }
      }
      if (!response.ok) {
        if (response.status === 409 && !currentOperation.blocked) {
          const reconciliation = await reconcileVersionConflict(currentOperation);
          if (reconciliation.resolved) {
            await finishSyncedOperation(currentOperation, reconciliation.data);
            await OfflineStore.remove('operations', currentOperation.id);
            continue;
          }
          if (reconciliation.response) response = reconciliation.response;
        }
        const body = await response.json().catch(() => ({}));
        if (response.status === 401) {
          await OfflineStore.clearSession();
          showLogin('Session expirée. Reconnectez-vous pour synchroniser les actions en attente.');
          interrupted = true;
          break;
        }
        if (response.status >= 500) {
          setOfflineMode(true);
          interrupted = true;
          break;
        }
        await OfflineStore.replaceOperation({
          ...currentOperation,
          blocked: true,
          error: body.erreur || `La synchronisation a échoué (${response.status}).`,
        });
        if (currentOperation.deviceId) blockedDeviceIds.add(currentOperation.deviceId);
        continue;
      }
      const data = response.status === 204 ? null : await response.json();
      await finishSyncedOperation(currentOperation, data);
      await OfflineStore.remove('operations', currentOperation.id);
    }
    if (!interrupted) {
      await refreshOfflineSnapshot();
      await refresh();
    }
  } catch (error) {
    console.error('Échec de synchronisation hors ligne.', error);
    if (error instanceof TypeError) setOfflineMode(true);
  } finally {
    state.isSyncing = false;
    await updateOfflineStatus();
  }
}

function showLogin(message = '') {
  state.technician = null;
  $('#app-shell').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  showAuthForm('login-form');
  $('#login-password').value = '';
  $('#login-message').textContent = message;
  $('#login-message').className = `mt-3 min-h-5 text-sm${message ? ' text-red-700' : ''}`;
}

function showAuthForm(formId) {
  ['login-form', 'registration-form', 'password-recovery-form', 'password-reset-form'].forEach((id) => {
    $(`#${id}`).classList.toggle('hidden', id !== formId);
  });
}

async function showApp(technician, { offline = false, expiresAt } = {}) {
  if (
    !technician ||
    !technician.account_id ||
    typeof technician.legacy_cache_owner !== 'boolean'
  ) {
    throw new Error('Reconnectez-vous une fois en ligne pour activer le stockage privé de ce compte.');
  }
  const switchedAccount = OfflineStore.setAccount(technician.account_id, technician.legacy_cache_owner);
  state.technician = technician;
  if (!offline) {
    try {
      await OfflineStore.saveSession(technician, expiresAt);
      state.offlineStorageError = null;
    } catch (error) {
      console.error('Échec d’activation de l’accès hors ligne.', error);
      state.offlineStorageError = error.message;
    }
  }
  if (switchedAccount) {
    window.location.reload();
    return;
  }
  setOfflineMode(offline);
  $('#login-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  $('#menu-technician-name').textContent = technician.nom;
  $('#settings-menu-link').classList.toggle('hidden', technician.role !== 'ADMIN');
  showPage(window.location.hash.slice(1) || 'dashboard', false, false);
  refresh();
  if (!offline) syncPendingOperations();
  await $('#e-links-intro').playWelcome(technician.nom);
}

function newRequestKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const message = $('#login-message');
  button.disabled = true;
  button.textContent = 'Connexion…';
  message.textContent = '';
  try {
    const result = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('#login-email').value.trim(),
        password: $('#login-password').value,
        remember: $('#remember-session').checked,
      }),
    });
    $('#login-password').value = '';
    await showApp(result.technicien, { expiresAt: result.session_expires_at });
  } catch (error) {
    message.textContent = error.message;
    message.className = 'mt-3 min-h-5 text-sm text-red-700';
  } finally {
    button.disabled = false;
    button.textContent = 'Se connecter';
  }
});

$('#show-registration').addEventListener('click', () => {
  showAuthForm('registration-form');
  $('#registration-message').textContent = '';
  $('#register-name').focus();
});

$('#show-login').addEventListener('click', () => {
  showAuthForm('login-form');
  $('#login-message').textContent = '';
  $('#login-email').focus();
});

$('#registration-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const message = $('#registration-message');
  button.disabled = true;
  button.textContent = 'Création…';
  message.textContent = '';
  try {
    const result = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        nom: $('#register-name').value.trim(),
        email: $('#register-email').value.trim(),
        password: $('#register-password').value,
        confirmation: $('#register-confirmation').value,
        code: $('#setup-code').value,
        remember: $('#remember-session').checked,
      }),
    });
    $('#register-password').value = '';
    $('#register-confirmation').value = '';
    $('#setup-code').value = '';
    await showApp(result.technicien, { expiresAt: result.session_expires_at });
  } catch (error) {
    message.textContent = error.message;
    message.className = 'mt-3 min-h-5 text-sm text-red-700';
    if (error.status === 409) {
      showAuthForm('login-form');
      $('#login-message').textContent = error.message;
      $('#login-message').className = 'mt-3 min-h-5 text-sm text-amber-700';
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Créer mon compte';
  }
});

$('#show-password-recovery').addEventListener('click', () => {
  $('#recovery-email').value = $('#login-email').value.trim();
  $('#recovery-message').textContent = '';
  showAuthForm('password-recovery-form');
  $('#recovery-email').focus();
});

$('#recovery-back').addEventListener('click', () => showLogin());

$('#password-recovery-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const message = $('#recovery-message');
  button.disabled = true;
  button.textContent = 'Envoi…';
  message.textContent = '';
  try {
    const result = await request('/api/auth/password-reset/request', {
      method: 'POST',
      body: JSON.stringify({ email: $('#recovery-email').value.trim() }),
    });
    message.textContent = result.message;
    message.className = 'mt-3 min-h-5 text-sm text-teal-800';
  } catch (error) {
    message.textContent = error.message;
    message.className = 'mt-3 min-h-5 text-sm text-red-700';
  } finally {
    button.disabled = false;
    button.textContent = 'Envoyer le lien';
  }
});

$('#password-reset-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const message = $('#reset-message');
  button.disabled = true;
  button.textContent = 'Modification…';
  message.textContent = '';
  try {
    const result = await request('/api/auth/password-reset/confirm', {
      method: 'POST',
      body: JSON.stringify({
        token: state.passwordResetToken,
        password: $('#reset-password').value,
        confirmation: $('#reset-confirmation').value,
      }),
    });
    state.passwordResetToken = null;
    await OfflineStore.clearSession();
    $('#reset-password').value = '';
    $('#reset-confirmation').value = '';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    showLogin(result.message);
    $('#login-message').className = 'mt-3 min-h-5 text-sm text-teal-800';
  } catch (error) {
    message.textContent = error.message;
    message.className = 'mt-3 min-h-5 text-sm text-red-700';
  } finally {
    button.disabled = false;
    button.textContent = 'Modifier le mot de passe';
  }
});

$('#reset-back').addEventListener('click', () => {
  state.passwordResetToken = null;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  showLogin();
});

async function loadRegistrationSetup() {
  try {
    const setup = await request('/api/auth/setup');
    $('#show-registration').classList.toggle('hidden', !setup.available);
    $('#password-recovery-config-note').classList.toggle('hidden', setup.passwordRecoveryAvailable);
    $('#setup-code-container').classList.toggle('hidden', !setup.codeRequired);
    $('#setup-code').required = setup.codeRequired;
    $('#registration-title').textContent = setup.isFirstAccount
      ? 'Créer le premier compte'
      : 'Créer un atelier indépendant';
    $('#registration-description').textContent = setup.isFirstAccount
      ? 'Votre compte personnel sera le seul accès à cet atelier.'
      : 'Chaque inscription crée un atelier privé avec ses propres dossiers et bilans.';
    $('#setup-code-label').textContent = setup.isFirstAccount
      ? 'Code de première configuration'
      : 'Code d’invitation';
    if (setup.configurationRequired) {
      $('#login-message').textContent =
        setup.isFirstAccount
          ? 'La première inscription doit être activée dans la configuration du serveur.'
          : 'La création de comptes nécessite un code d’invitation configuré par l’administrateur.';
      $('#login-message').className = 'mt-3 min-h-5 text-sm text-amber-700';
    }
  } catch (error) {
    console.error(error);
    $('#login-message').textContent = 'Impossible de vérifier l’accès. Réessayez.';
    $('#login-message').className = 'mt-3 min-h-5 text-sm text-red-700';
  }
}

$('#logout').addEventListener('click', async () => {
  try {
    if (state.isOffline || !navigator.onLine) {
      alert('Reconnectez-vous à Internet pour fermer la session en toute sécurité.');
      return;
    }
    if ((await OfflineStore.getQueue()).length) {
      await syncPendingOperations();
      if ((await OfflineStore.getQueue()).length) {
        alert('Synchronisez les actions en attente avant de vous déconnecter.');
        return;
      }
    }
    await request('/api/auth/logout', { method: 'POST' });
    await OfflineStore.clearSession();
    showLogin();
    $('#login-password').value = '';
  } catch (error) {
    alert(error.message);
  }
});

async function loadDashboard() {
  const queue = await OfflineStore.getQueue();
  const hasPendingOperations = queue.length > 0;
  const [data, personal] = await Promise.all([
    hasPendingOperations ? offlineDashboard() : request('/api/dashboard'),
    hasPendingOperations
      ? offlinePersonalReport('week')
      : request('/api/reports/personal?period=week'),
  ]);
  const syncNote = $('#dashboard-sync-note');
  syncNote.classList.toggle('hidden', !hasPendingOperations);
  $('#revenue-usd').textContent = formatMoney(data.chiffre_semaine_usd, 'USD');
  $('#revenue-cdf').textContent = formatMoney(data.chiffre_semaine_cdf, 'CDF');
  $('#dashboard-net-usd').textContent = formatMoney(personal.net_usd, 'USD');
  $('#dashboard-net-cdf').textContent = formatMoney(personal.net_cdf, 'CDF');
  renderRevenueCharts(data.encaissements_journaliers);
  $('#pending-count').textContent = data.appareils_attente;
  $('#urgent-count').textContent = `${data.urgents} urgent${Number(data.urgents) > 1 ? 's' : ''}`;
  const priorityList = $('#priority-list');
  priorityList.replaceChildren();
  if (!data.prioritaire.length) {
    priorityList.innerHTML = '<li class="text-slate-400">Aucune urgence pour le moment.</li>';
  } else {
    data.prioritaire.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'flex justify-between gap-2';
      li.textContent = `${deviceTypeNames[item.type_appareil] || deviceTypeNames.TELEPHONE} · ${item.marque} ${item.modele} · ${item.panne}`;
      const status = document.createElement('span');
      status.className = 'shrink-0 font-semibold text-amber-700';
      status.textContent = statusNames[item.statut];
      li.append(status);
      priorityList.append(li);
    });
  }
}

function updateReportControls() {
  document.querySelectorAll('[data-report-period]').forEach((button) => {
    const active = button.dataset.reportPeriod === state.reportPeriod;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('bg-teal-700', active);
    button.classList.toggle('text-white', active);
    button.classList.toggle('text-slate-600', !active);
  });
  document.querySelectorAll('[data-report-currency]').forEach((button) => {
    const active = button.dataset.reportCurrency === state.reportCurrency;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('bg-white', active);
    button.classList.toggle('shadow-sm', active);
    button.classList.toggle('text-teal-800', active);
    button.classList.toggle('text-slate-600', !active);
  });
}

function reportBucketLabel(bucket, period) {
  if (period === 'day') return `${bucket} h`;
  if (period === 'year') {
    return new Date(`${bucket}-01T12:00:00Z`).toLocaleDateString('fr-FR', {
      month: 'long',
      timeZone: 'Africa/Kinshasa',
    });
  }
  const date = new Date(`${bucket}T12:00:00Z`);
  const options = period === 'week'
    ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Kinshasa' }
    : { day: 'numeric', month: 'short', timeZone: 'Africa/Kinshasa' };
  return new Intl.DateTimeFormat('fr-FR', options).format(date);
}

function renderRevenueReport(data) {
  state.reportData = data;
  const currency = state.reportCurrency;
  const field = currency.toLowerCase();
  const points = Array.isArray(data.points) ? data.points : [];
  const total = points.reduce((sum, point) => sum + Number(point[field] || 0), 0);
  const labels = {
    day: 'Aujourd’hui',
    week: 'Cette semaine',
    month: 'Ce mois-ci',
    year: 'Cette année',
  };
  const groupLabels = {
    day: 'Détail par heure',
    week: 'Détail par jour',
    month: 'Détail par jour',
    year: 'Détail par mois',
  };
  const chart = $('#report-donut');
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const colors = [
    '#14b8a6', '#f59e0b', '#8b5cf6', '#f97316', '#3b82f6', '#ec4899',
    '#84cc16', '#06b6d4', '#ef4444', '#a855f7', '#22c55e', '#eab308',
  ];
  const radius = 78;
  const circumference = 2 * Math.PI * radius;
  const track = document.createElementNS(svgNamespace, 'circle');
  track.setAttribute('cx', '110');
  track.setAttribute('cy', '110');
  track.setAttribute('r', String(radius));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', '#e2e8f0');
  track.setAttribute('stroke-width', '24');
  chart.replaceChildren(track);

  const positivePoints = points
    .map((point) => ({ ...point, amount: Number(point[field] || 0) }))
    .filter((point) => point.amount > 0);
  let offset = 0;
  positivePoints.forEach((point, index) => {
    const segmentLength = (point.amount / total) * circumference;
    const visibleLength = Math.max(0, segmentLength - 2);
    const segment = document.createElementNS(svgNamespace, 'circle');
    segment.setAttribute('cx', '110');
    segment.setAttribute('cy', '110');
    segment.setAttribute('r', String(radius));
    segment.setAttribute('fill', 'none');
    segment.setAttribute('stroke', colors[index % colors.length]);
    segment.setAttribute('stroke-width', '24');
    segment.setAttribute('stroke-linecap', 'round');
    segment.setAttribute('stroke-dasharray', `${visibleLength} ${circumference - visibleLength}`);
    segment.setAttribute('stroke-dashoffset', String(-offset));
    segment.setAttribute('transform', 'rotate(-90 110 110)');
    segment.setAttribute('data-revenue-segment', '');
    chart.append(segment);
    offset += segmentLength;
  });

  $('#report-total').textContent = formatMoney(total, currency);
  $('#report-currency-label').textContent = currency;
  $('#report-range').textContent = labels[state.reportPeriod];
  $('#report-breakdown-title').textContent = groupLabels[state.reportPeriod];
  $('#report-empty').classList.toggle('hidden', total > 0);
  chart.setAttribute(
    'aria-label',
    `${labels[state.reportPeriod]} : ${formatMoney(total, currency)} répartis par période`,
  );

  const legend = $('#report-legend');
  legend.replaceChildren();
  positivePoints.forEach((point, index) => {
    const item = document.createElement('li');
    item.className = 'flex items-center justify-between gap-2 rounded-lg bg-slate-50 p-2';
    const labelGroup = document.createElement('span');
    labelGroup.className = 'flex min-w-0 items-center gap-2';
    const marker = document.createElementNS(svgNamespace, 'svg');
    marker.setAttribute('viewBox', '0 0 12 12');
    marker.setAttribute('class', 'h-3 w-3 shrink-0');
    marker.setAttribute('aria-hidden', 'true');
    const dot = document.createElementNS(svgNamespace, 'circle');
    dot.setAttribute('cx', '6');
    dot.setAttribute('cy', '6');
    dot.setAttribute('r', '5');
    dot.setAttribute('fill', colors[index % colors.length]);
    marker.append(dot);
    const label = document.createElement('span');
    label.className = 'truncate text-slate-600';
    label.textContent = reportBucketLabel(point.bucket, state.reportPeriod);
    labelGroup.append(marker, label);
    const amount = document.createElement('strong');
    amount.className = 'shrink-0 text-right text-slate-900';
    amount.textContent = formatMoney(point.amount, currency);
    item.append(labelGroup, amount);
    legend.append(item);
  });
}

function renderPersonalReport(data) {
  state.personalReportData = data;
  const labels = {
    day: 'Aujourd’hui',
    week: 'Cette semaine',
    month: 'Ce mois-ci',
    year: 'Cette année',
  };
  $('#personal-report-range').textContent = labels[data.period] || labels.week;
  ['usd', 'cdf'].forEach((currency) => {
    const suffix = currency.toUpperCase();
    $('#personal-income-' + currency).textContent =
      formatMoney(data[`encaissements_${currency}`], suffix);
    $('#personal-costs-' + currency).textContent =
      formatMoney(data[`depenses_${currency}`], suffix);
    $('#personal-net-' + currency).textContent =
      formatMoney(data[`net_${currency}`], suffix);
  });
}

async function loadRevenueReport() {
  const period = state.reportPeriod;
  const queue = await OfflineStore.getQueue();
  const [data, personal] = await Promise.all([
    queue.length
      ? offlineRevenueReport(period)
      : request(`/api/reports/revenue?period=${encodeURIComponent(period)}`),
    queue.length
      ? offlinePersonalReport(period)
      : request(`/api/reports/personal?period=${encodeURIComponent(period)}`),
  ]);
  if (period !== state.reportPeriod) return;
  $('#report-sync-note').classList.toggle('hidden', queue.length === 0);
  renderRevenueReport(data);
  renderPersonalReport(personal);
}

function renderRevenueCharts(dailyRevenue) {
  const entries = Array.isArray(dailyRevenue) ? dailyRevenue : [];
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const charts = [
    { id: 'chart-usd', field: 'usd', currency: 'USD', color: '#0f766e' },
    { id: 'chart-cdf', field: 'cdf', currency: 'CDF', color: '#f59e0b' },
  ];

  charts.forEach(({ id, field, currency, color }) => {
    const chart = $(`#${id}`);
    const values = entries.map((entry) => Number(entry[field] || 0));
    const maximum = Math.max(0, ...values);
    chart.replaceChildren();

    const baseline = document.createElementNS(svgNamespace, 'line');
    baseline.setAttribute('x1', '5');
    baseline.setAttribute('x2', '205');
    baseline.setAttribute('y1', '60');
    baseline.setAttribute('y2', '60');
    baseline.setAttribute('stroke', '#e2e8f0');
    chart.append(baseline);

    entries.forEach((entry, index) => {
      const value = values[index];
      const x = 10 + index * 28;
      const barHeight = maximum > 0 && value > 0 ? Math.max(3, (value / maximum) * 38) : 0;
      if (barHeight > 0) {
        const bar = document.createElementNS(svgNamespace, 'rect');
        bar.setAttribute('x', String(x));
        bar.setAttribute('y', String(60 - barHeight));
        bar.setAttribute('width', '16');
        bar.setAttribute('height', String(barHeight));
        bar.setAttribute('rx', '3');
        bar.setAttribute('fill', color);
        const title = document.createElementNS(svgNamespace, 'title');
        const [year, month, day] = entry.jour.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        const weekday = new Intl.DateTimeFormat('fr-FR', { weekday: 'long' }).format(date);
        title.textContent = `${weekday} · ${formatMoney(value, currency)}`;
        bar.append(title);
        chart.append(bar);
      }

      const [year, month, day] = entry.jour.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      const label = document.createElementNS(svgNamespace, 'text');
      label.setAttribute('x', String(x + 8));
      label.setAttribute('y', '78');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', '#64748b');
      label.setAttribute('font-size', '9');
      label.textContent = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' })
        .format(date)
        .replace('.', '');
      chart.append(label);
    });
  });
}

function makeStatusSelect(device) {
  const select = document.createElement('select');
  select.className = 'rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold';
  select.setAttribute('aria-label', `Statut de ${device.marque} ${device.modele}`);
  select.disabled = device.statut === 'LIVRE';
  const currentIndex = statusOrder.indexOf(device.statut);
  statusOrder.forEach((status, index) => {
    const option = document.createElement('option');
    option.value = status;
    option.textContent = statusNames[status];
    option.selected = status === device.statut;
    option.disabled = index < currentIndex || index > currentIndex + 1 || status === 'LIVRE';
    select.append(option);
  });
  select.addEventListener('change', async () => {
    const nextStatus = select.value;
    try {
      await request(`/api/appareils/${device.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ statut: nextStatus }),
        headers: device.updated_at ? { 'X-Record-Version': device.updated_at } : {},
      });
      if (nextStatus === 'LIVRE') showPage('archive', true, false);
      await refresh();
    } catch (error) {
      alert(error.message);
      select.value = device.statut;
    }
  });
  return select;
}

function renderDeviceList(listId, devices, archived, search, removed = false) {
  const list = $(`#${listId}`);
  list.replaceChildren();
  if (!devices.length) {
    list.innerHTML = search
      ? '<li class="text-sm text-slate-400">Aucun résultat pour cette recherche.</li>'
      : archived || removed
        ? removed
          ? '<li class="text-sm text-slate-400">Aucun dossier archivé.</li>'
          : '<li class="text-sm text-slate-400">Aucun appareil livré dans les archives.</li>'
        : '<li class="text-sm text-slate-400">Aucun appareil dans la salle d’attente.</li>';
    return;
  }
  devices.forEach((device) => {
    const item = document.createElement('li');
      item.className = `${removed ? '' : 'cursor-pointer '}rounded-xl border border-slate-100 p-3 transition hover:border-teal-200`;
    const top = document.createElement('div');
    top.className = 'flex items-start justify-between gap-2';
    const details = document.createElement('div');
    details.className = 'min-w-0 flex-1';
    const title = document.createElement('p');
    title.className = 'font-bold';
    title.textContent = `${deviceTypeNames[device.type_appareil] || deviceTypeNames.TELEPHONE} · ${device.marque} ${device.modele}`.trim();
    const description = document.createElement('p');
    description.className = 'text-sm text-slate-500';
    description.textContent = `${device.panne} · ${device.client_nom || device.telephone}`;
    const openRecord = document.createElement(removed ? 'div' : 'button');
    if (!removed) openRecord.type = 'button';
    openRecord.className = 'block w-full text-left';
    if (!removed) openRecord.setAttribute('aria-label', `Ouvrir le dossier ${title.textContent}`);
    openRecord.append(title, description);
    if (!removed) openRecord.addEventListener('click', () => openDevice(device.id, openRecord));
    details.append(openRecord);
    if (device.prix_convenu !== null) {
      const price = document.createElement('p');
      price.className = 'mt-1 text-xs text-slate-500';
      price.textContent =
        `Prix : ${formatMoney(device.prix_convenu, device.prix_devise)} · ` +
        `Reçu : ${formatMoney(device.paiements_usd, 'USD')} + ${formatMoney(device.paiements_cdf, 'CDF')}`;
      details.append(price);
    }
    if (device.urgent) {
      const badge = document.createElement('span');
      badge.className = 'rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-800';
      badge.textContent = 'Urgent';
      top.append(details, badge);
    } else {
      top.append(details);
    }
    if (device.pending_sync) {
      const pending = document.createElement('span');
      pending.className = 'mt-1 inline-block rounded-full bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-800';
      pending.textContent = 'Synchronisation en attente';
      details.append(pending);
    }
    const actions = document.createElement('div');
    actions.className = 'mt-3 flex flex-wrap items-center justify-between gap-2';
    if (archived || removed) {
      const badge = document.createElement('span');
      badge.className = 'rounded-full bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600';
      badge.textContent = removed
        ? `Archivé le ${formatDate(device.archived_at)}`
        : statusNames[device.statut];
      actions.append(badge);
    } else {
      actions.append(makeStatusSelect(device));
    }
    if (!removed) {
      const dossier = document.createElement('button');
      dossier.type = 'button';
      dossier.className = 'rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold';
      dossier.textContent = 'Ouvrir le dossier';
      dossier.addEventListener('click', () => openDevice(device.id, dossier));
      actions.append(dossier);
    }
    if (!archived && !removed && device.statut === 'PRET' && !device.acte_valide) {
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'rounded-lg bg-teal-700 px-3 py-2 text-xs font-bold text-white';
      approve.textContent = 'Restituer / signer';
      approve.addEventListener('click', () => openApproval(device));
      actions.append(approve);
    }
    if (removed && state.technician?.role === 'ADMIN') {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'rounded-lg bg-teal-700 px-3 py-2 text-xs font-bold text-white';
      restore.textContent = 'Restaurer';
      restore.addEventListener('click', async (event) => {
        event.stopPropagation();
        restore.disabled = true;
        try {
          await request(`/api/appareils/${device.id}/restore`, {
            method: 'POST',
            headers: device.updated_at ? { 'X-Record-Version': device.updated_at } : {},
          });
          await loadRemovedDevices();
          await refresh();
        } catch (error) {
          alert(error.message);
          restore.disabled = false;
        }
      });
      actions.append(restore);
    }
    item.append(top, actions);
    if (!removed) {
      item.addEventListener('click', (event) => {
        if (!event.target.closest('button, select')) openDevice(device.id, item);
      });
    }
    list.append(item);
  });
}

let waitingPage = 1;
let archivePage = 1;
let removedPage = 1;
const deviceLoadSequence = { waiting: 0, archive: 0, removed: 0 };
let waitingSearchTimer;
let archiveSearchTimer;

function updatePagination(section, result) {
  const page = result.page;
  $(`#${section}-pagination-label`).textContent =
    `${result.total} appareil${result.total === 1 ? '' : 's'} · page ${page}/${result.pages}`;
  $(`#${section}-previous`).disabled = page <= 1;
  $(`#${section}-next`).disabled = page >= result.pages;
  if (section === 'archive') archivePage = page;
  else if (section === 'removed') removedPage = page;
  else waitingPage = page;
}

async function loadDevices(section) {
  const sequence = ++deviceLoadSequence[section];
  const params = new URLSearchParams({
    section,
    page: String(section === 'archive' ? archivePage : section === 'removed' ? removedPage : waitingPage),
    q: section === 'removed' ? '' : $(`#${section}-search`).value.trim(),
  });
  if (section === 'waiting') params.set('status', $('#waiting-status').value);
  const result = await request(`/api/appareils?${params}`);
  if (sequence !== deviceLoadSequence[section]) return;
  renderDeviceList(
    section === 'removed' ? 'removed-list' : `${section}-list`,
    result.appareils,
    section === 'archive',
    params.get('q'),
    section === 'removed',
  );
  updatePagination(section, result);
}

function loadRemovedDevices() {
  return loadDevices('removed');
}

$('#waiting-search').addEventListener('input', () => {
  waitingPage = 1;
  window.clearTimeout(waitingSearchTimer);
  waitingSearchTimer = window.setTimeout(() => loadDevices('waiting').catch(showConnectionError), 250);
});
$('#archive-search').addEventListener('input', () => {
  archivePage = 1;
  window.clearTimeout(archiveSearchTimer);
  archiveSearchTimer = window.setTimeout(() => loadDevices('archive').catch(showConnectionError), 250);
});
$('#waiting-status').addEventListener('change', () => {
  waitingPage = 1;
  loadDevices('waiting').catch(showConnectionError);
});
$('#waiting-previous').addEventListener('click', () => {
  waitingPage = Math.max(1, waitingPage - 1);
  loadDevices('waiting').catch(showConnectionError);
});
$('#waiting-next').addEventListener('click', () => {
  waitingPage += 1;
  loadDevices('waiting').catch(showConnectionError);
});
$('#archive-previous').addEventListener('click', () => {
  archivePage = Math.max(1, archivePage - 1);
  loadDevices('archive').catch(showConnectionError);
});
$('#archive-next').addEventListener('click', () => {
  archivePage += 1;
  loadDevices('archive').catch(showConnectionError);
});
$('#removed-previous').addEventListener('click', () => {
  removedPage = Math.max(1, removedPage - 1);
  loadRemovedDevices().catch(showConnectionError);
});
$('#removed-next').addEventListener('click', () => {
  removedPage += 1;
  loadRemovedDevices().catch(showConnectionError);
});

async function loadSettings() {
  if (state.technician?.role !== 'ADMIN') return;
  const [settings] = await Promise.all([
    request('/api/settings'),
    loadRemovedDevices(),
  ]);
  state.workshopSettings = settings;
  $('#statistics-start-date').value = settings.statistiques_depuis || '';
  $('#statistics-start-date').max = kinshasaDateKey(new Date());
  $('#statistics-start-current').textContent = settings.statistiques_depuis
    ? `Les statistiques commencent le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Africa/Kinshasa' }).format(new Date(`${settings.statistiques_depuis}T12:00:00`))}.`
    : 'Aucune date de départ définie. Les statistiques utilisent tout l’historique.';
}

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const message = $('#settings-message');
  const nextDate = $('#statistics-start-date').value || null;
  button.disabled = true;
  try {
    if ((await OfflineStore.getQueue()).length) {
      throw new Error('Synchronisez les actions en attente avant de modifier les statistiques.');
    }
    if (!confirm(nextDate
      ? `Les bilans ignoreront les encaissements et frais antérieurs au ${nextDate}. Aucune donnée ne sera supprimée. Continuer ?`
      : 'Supprimer la date de départ ? Les bilans réutiliseront tout l’historique. Continuer ?')) return;
    message.textContent = 'Enregistrement…';
    message.className = 'text-sm text-slate-600';
    state.workshopSettings = await request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ statistiques_depuis: nextDate }),
    });
    await OfflineStore.write('meta', {
      key: 'settings',
      statistiques_depuis: state.workshopSettings.statistiques_depuis,
    });
    message.textContent = 'Date de départ enregistrée. Les données restent conservées.';
    message.className = 'text-sm text-teal-800';
    await refresh();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'text-sm text-red-700';
  } finally {
    button.disabled = false;
  }
});

$('#export-data').addEventListener('click', async () => {
  const button = $('#export-data');
  const message = $('#export-message');
  button.disabled = true;
  message.textContent = '';
  try {
    if ((await OfflineStore.getQueue()).length) {
      throw new Error('Synchronisez les actions en attente avant de télécharger la sauvegarde.');
    }
    if (!navigator.onLine || state.isOffline) {
      throw new Error('La sauvegarde nécessite une connexion Internet.');
    }
    const backup = await request('/api/export');
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `atelier-express-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.textContent = 'Sauvegarde téléchargée. Conservez ce fichier dans un endroit sûr.';
    message.className = 'mt-2 text-sm text-teal-800';
  } catch (error) {
    message.textContent = error.message;
    message.className = 'mt-2 text-sm text-red-700';
  } finally {
    button.disabled = false;
  }
});

let activeDeviceId = null;
let activeDeviceVersion = null;
let deviceReturnScrollY = 0;
let deviceReturnFocus = null;
let deviceHistoryEntry = false;

async function openDevice(id, trigger = null) {
  try {
    const device = await request(`/api/appareils/${id}`);
    activeDeviceId = device.id;
    activeDeviceVersion = device.updated_at;
    $('#device-title').textContent = `${device.marque} ${device.modele}`.trim();
    $('#device-client').textContent =
      `${device.client_nom || 'Client'} · ${device.telephone}`;
    $('#device-type').textContent = deviceTypeNames[device.type_appareil] || deviceTypeNames.TELEPHONE;
    $('#device-fault').textContent = device.panne;
    $('#device-status').textContent = statusNames[device.statut];
    $('#device-priority').textContent = device.urgent ? 'Urgent' : 'Normale';
    const canManage = state.technician?.role === 'ADMIN' &&
      device.statut !== 'LIVRE' &&
      !device.acte_valide;
    const isDelivered = device.statut === 'LIVRE' || Boolean(device.acte_valide);
    $('#device-edit-toggle').classList.toggle('hidden', !canManage);
    $('#device-archive-button').classList.toggle('hidden', state.technician?.role !== 'ADMIN' || isDelivered);
    $('#device-price-row').classList.remove('hidden');
    $('#device-payments-section').classList.remove('hidden');
    $('#device-edit-section').classList.add('hidden');
    $('#device-edit-message').textContent = '';
    $('#edit-client-name').value = device.client_nom || '';
    $('#edit-client-phone').value = device.telephone || '';
    $('#edit-device-type').value = device.type_appareil || 'TELEPHONE';
    $('#edit-device-brand').value = device.marque || '';
    $('#edit-device-model').value = device.modele || '';
    $('#edit-device-fault').value = device.panne || '';
    $('#edit-device-price').value = device.prix_convenu ?? '';
    $('#edit-device-currency').value = device.prix_devise || 'USD';
    $('#edit-device-urgent').checked = Boolean(device.urgent);
    $('#device-created').textContent = formatDate(device.created_at);
    $('#device-updated').textContent = formatDate(device.updated_at);
    $('#device-price').textContent = device.prix_convenu === null
      ? 'Non défini'
      : formatMoney(device.prix_convenu, device.prix_devise);
    $('#device-paid-usd').textContent = formatMoney(device.paiements_usd, 'USD');
    $('#device-paid-cdf').textContent = formatMoney(device.paiements_cdf, 'CDF');
    $('#device-balance').textContent = device.solde === null
      ? 'Non défini'
      : formatMoney(device.solde, device.prix_devise);
    $('#device-expense-usd').value = Number(device.frais_usd || 0) > 0
      ? String(device.frais_usd)
      : '';
    $('#device-expense-cdf').value = Number(device.frais_cdf || 0) > 0
      ? String(device.frais_cdf)
      : '';
    $('#expense-message').textContent = '';
    $('#device-repair-history').classList.toggle('hidden', !isDelivered);
    $('#device-history-expense-usd').textContent = formatMoney(device.frais_usd, 'USD');
    $('#device-history-expense-cdf').textContent = formatMoney(device.frais_cdf, 'CDF');
    $('#device-qr-section').classList.toggle('hidden', isDelivered);
    $('#device-qr-result').classList.add('hidden');
    $('#device-qr-message').textContent = '';
    $('#device-qr-button').disabled = false;
    const approvalSection = $('#device-approval');
    const signature = $('#device-signature');
    const hasSignature = typeof device.signature_data === 'string' &&
      /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(device.signature_data);
    approvalSection.classList.toggle('hidden', !device.clause && !hasSignature);
    $('#device-approval-clause').textContent = device.clause || 'Aucun acte de restitution enregistré.';
    $('#device-approval-date').textContent = device.valide_at
      ? `Signé le ${formatDate(device.valide_at)}`
      : '';
    signature.classList.toggle('hidden', !hasSignature);
    $('#device-signature-missing').classList.toggle('hidden', hasSignature);
    if (hasSignature) signature.src = device.signature_data;
    else signature.removeAttribute('src');
    $('#payment-form').classList.toggle('hidden', device.statut === 'LIVRE');
    $('#expense-form').classList.toggle('hidden', isDelivered);
    $('#payment-message').textContent = '';
    $('#payment-amount').value = '';
    $('#payment-currency').value = 'USD';
    updatePaymentPlaceholder();
    const deviceView = $('#device-dialog');
    if (deviceView.classList.contains('hidden')) {
      deviceReturnScrollY = window.scrollY;
      deviceReturnFocus = trigger && trigger.matches('button') ? trigger : null;
      window.history.pushState({ appDeviceDialog: true }, '', window.location.href);
      deviceHistoryEntry = true;
      $('#app-main').classList.add('hidden');
      deviceView.classList.remove('hidden');
      window.scrollTo(0, 0);
    }
    $('#device-close').focus();
  } catch (error) {
    alert(error.message);
  }
}

$('#device-edit-toggle').addEventListener('click', () => {
  const section = $('#device-edit-section');
  section.classList.toggle('hidden');
  if (!section.classList.contains('hidden')) $('#edit-client-name').focus();
});

$('#device-edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeDeviceId || !activeDeviceVersion) return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const message = $('#device-edit-message');
  const body = {
    nom: $('#edit-client-name').value.trim(),
    telephone: $('#edit-client-phone').value.trim(),
    type_appareil: $('#edit-device-type').value,
    marque: $('#edit-device-brand').value.trim(),
    modele: $('#edit-device-model').value.trim(),
    panne: $('#edit-device-fault').value.trim(),
    prix_convenu: $('#edit-device-price').value === '' ? null : Number($('#edit-device-price').value),
    prix_devise: $('#edit-device-currency').value,
    urgent: $('#edit-device-urgent').checked,
  };
  button.disabled = true;
  try {
    if ((await OfflineStore.getQueue()).length) {
      throw new Error('Synchronisez les actions en attente avant de corriger un dossier.');
    }
    message.textContent = 'Enregistrement…';
    message.className = 'text-sm text-slate-600';
    await request(`/api/appareils/${activeDeviceId}/details`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'X-Record-Version': activeDeviceVersion },
    });
    await openDevice(activeDeviceId);
    $('#device-edit-section').classList.add('hidden');
    await refresh();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'text-sm text-red-700';
  } finally {
    button.disabled = false;
  }
});

$('#device-archive-button').addEventListener('click', async () => {
  if (!activeDeviceId || !activeDeviceVersion) return;
  if (!confirm('Archiver ce dossier ? Il sera masqué des listes, mais vous pourrez le restaurer dans Paramètres.')) return;
  const deviceId = activeDeviceId;
  try {
    await request(`/api/appareils/${deviceId}`, {
      method: 'DELETE',
      headers: { 'X-Record-Version': activeDeviceVersion },
    });
    closeDevice();
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

async function loadDeviceQr(id) {
  const button = $('#device-qr-button');
  const message = $('#device-qr-message');
  button.disabled = true;
  button.textContent = 'Création du QR…';
  message.textContent = '';
  message.className = 'mt-2 text-sm text-slate-600';
  try {
    const qr = await request(`/api/appareils/${id}/qr`, { method: 'POST' });
    if (activeDeviceId !== id) return;
    $('#device-qr-image').src = qr.qr_code;
    $('#device-qr-link').href = qr.url;
    $('#device-qr-link').textContent = qr.url;
    $('#device-qr-result').classList.remove('hidden');
    message.textContent = 'Le client peut scanner ce QR pour suivre la réparation et activer les alertes.';
  } catch (error) {
    message.textContent = state.isOffline || !navigator.onLine
      ? 'Dépôt conservé hors connexion. Le QR sera disponible après synchronisation.'
      : error.message;
    message.className = 'mt-2 text-sm text-amber-700';
  } finally {
    button.disabled = false;
    button.textContent = 'Afficher le QR client';
  }
}

$('#device-qr-button').addEventListener('click', () => {
  if (activeDeviceId) loadDeviceQr(activeDeviceId);
});

function closeDevice({ fromHistory = false } = {}) {
  $('#device-dialog').classList.add('hidden');
  $('#app-main').classList.remove('hidden');
  window.scrollTo(0, deviceReturnScrollY);
  if (deviceReturnFocus && deviceReturnFocus.isConnected) deviceReturnFocus.focus();
  else $('#menu-toggle').focus();
  deviceReturnFocus = null;
  activeDeviceId = null;
  activeDeviceVersion = null;
  if (!fromHistory && deviceHistoryEntry) {
    window.history.replaceState(null, '', window.location.href);
  }
  deviceHistoryEntry = false;
}

$('#device-close').addEventListener('click', closeDevice);

document.addEventListener('keydown', (event) => {
  if (
    event.key === 'Escape' &&
    !$('#approval-dialog').open &&
    !$('#device-dialog').classList.contains('hidden')
  ) {
    closeDevice();
  }
});

async function refresh() {
  try {
    await loadPageData(window.location.hash.slice(1) || 'dashboard');
    $('#connection-message').classList.add('hidden');
    $('#connection-message').textContent = '';
  } catch (error) {
    showConnectionError(error);
  }
}

function showConnectionError(error) {
  if (error.stale) return;
  console.error(error);
  $('#connection-message').textContent = error.message || 'Impossible de charger les données. Réessayez.';
  $('#connection-message').classList.remove('hidden');
}

const chipClassName = 'rounded-full border border-slate-200 px-3 py-2 text-sm font-semibold active:bg-teal-50';
const selectedChipClasses = ['border-teal-700', 'bg-teal-50', 'text-teal-800'];
const updateChipSelection = (group, value) => {
  group.querySelectorAll('button').forEach((button) => {
    button.classList.remove(...selectedChipClasses);
    if (button.dataset.value === value) button.classList.add(...selectedChipClasses);
  });
};

function renderBrandOptions() {
  const type = $('#type-appareil').value;
  const suggestions = brandSuggestions[type] || brandSuggestions.TELEPHONE;
  const brandList = $('#brand-suggestions');
  brandList.replaceChildren(...suggestions.all.map((value) => {
    const option = document.createElement('option');
    option.value = value;
    return option;
  }));
  const popularBrands = $('#brands');
  popularBrands.replaceChildren(...suggestions.popular.map((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = chipClassName;
    button.dataset.value = value;
    button.textContent = value;
    return button;
  }));
  updateChipSelection(popularBrands, $('#marque').value);
}

document.querySelectorAll('#faults .chip').forEach((button) => {
  button.className = chipClassName;
  button.addEventListener('click', () => {
    updateChipSelection($('#faults'), button.dataset.value);
    $('#panne').value = button.dataset.value;
    $('#autre-panne').classList.toggle('hidden', button.dataset.value !== 'Autre');
    if (button.dataset.value !== 'Autre') $('#autre-panne').value = '';
  });
});

$('#brands').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button) return;
  $('#marque').value = button.dataset.value;
  updateChipSelection($('#brands'), button.dataset.value);
});
$('#marque').addEventListener('input', () => updateChipSelection($('#brands'), $('#marque').value));
$('#type-appareil').addEventListener('change', renderBrandOptions);
renderBrandOptions();

let searchTimer;
let clientLookupSequence = 0;
let autoFilledClientName = false;
$('#telephone').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const lookupSequence = ++clientLookupSequence;
  searchTimer = setTimeout(async () => {
    const match = $('#client-match');
    const telephone = $('#telephone').value.trim();
    if (telephone.length < 3) {
      match.classList.add('hidden');
      return;
    }
    try {
      const clients = await request(`/api/clients?telephone=${encodeURIComponent(telephone)}`);
      if (
        lookupSequence !== clientLookupSequence ||
        normalizedPhone($('#telephone').value) !== normalizedPhone(telephone)
      ) return;
      if (!clients.length) {
        match.classList.add('hidden');
        return;
      }
      match.textContent = `Client connu : ${clients[0].nom || clients[0].telephone}`;
      match.classList.remove('hidden');
      if (clients[0].nom) {
        $('#nom').value = clients[0].nom;
        autoFilledClientName = true;
      }
    } catch (error) {
      console.error(error);
    }
  }, 250);
  if (autoFilledClientName) {
    $('#nom').value = '';
    autoFilledClientName = false;
  }
});
$('#nom').addEventListener('input', () => { autoFilledClientName = false; });

let submittingIntake = false;
let intakeNoticeTimer;
const intakeForm = $('#intake-form');
const intakeButton = intakeForm.querySelector('button[type="submit"]');

function resetIntakeForm() {
  clientLookupSequence += 1;
  clearTimeout(searchTimer);
  intakeForm.reset();
  $('#client-match').textContent = '';
  $('#client-match').classList.add('hidden');
  $('#autre-panne').classList.add('hidden');
  $('#autre-panne').value = '';
  $('#form-message').textContent = '';
  document.querySelectorAll('#brands .chip, #faults .chip')
    .forEach((chip) => chip.classList.remove(...selectedChipClasses));
  autoFilledClientName = false;
  renderBrandOptions();
}

intakeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submittingIntake) return;
  const message = $('#form-message');
  const panne = $('#panne').value === 'Autre' ? $('#autre-panne').value.trim() : $('#panne').value;
  if (!panne) {
    message.textContent = 'Choisissez ou précisez la panne.';
    message.className = 'text-sm text-red-700';
    return;
  }
  const intakeData = {
    telephone: $('#telephone').value.trim(),
    nom: $('#nom').value.trim(),
    type_appareil: $('#type-appareil').value,
    marque: $('#marque').value,
    modele: $('#modele').value.trim(),
    panne,
    prix_convenu: $('#prix').value ? Number($('#prix').value) : null,
    urgent: $('#urgent').checked,
  };
  const previousBody = state.pendingIntake ? JSON.parse(state.pendingIntake.body) : null;
  const samePendingIntake = previousBody &&
    Object.keys(intakeData).every((key) => previousBody[key] === intakeData[key]);
  const body = { ...intakeData, id: samePendingIntake ? previousBody.id : newRequestKey() };
  const serializedBody = JSON.stringify(body);
  if (!state.pendingIntake || state.pendingIntake.body !== serializedBody) {
    state.pendingIntake = { body: serializedBody, key: newRequestKey() };
  }
  submittingIntake = true;
  intakeButton.disabled = true;
  intakeButton.textContent = 'Enregistrement…';
  intakeButton.classList.add('opacity-60');
  message.textContent = 'Enregistrement en cours…';
  message.className = 'text-sm text-slate-500';
  try {
    const device = await request('/api/appareils', {
      method: 'POST',
      body: serializedBody,
      headers: { 'Idempotency-Key': state.pendingIntake.key },
    });
    state.pendingIntake = null;
    resetIntakeForm();
    $('#intake-notice').textContent =
      `Dépôt enregistré : ${deviceTypeNames[device.type_appareil] || deviceTypeNames.TELEPHONE} · ${device.marque} ${device.modele || ''}`.trim();
    $('#intake-notice').classList.remove('hidden');
    window.clearTimeout(intakeNoticeTimer);
    intakeNoticeTimer = window.setTimeout(() => {
      $('#intake-notice').classList.add('hidden');
    }, 5000);
    showPage('dashboard', false, false);
    await refresh();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'text-sm text-red-700';
  } finally {
    submittingIntake = false;
    intakeButton.disabled = false;
    intakeButton.textContent = 'Enregistrer le dépôt';
    intakeButton.classList.remove('opacity-60');
  }
});

let submittingExpense = false;
$('#expense-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeDeviceId || submittingExpense) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const message = $('#expense-message');
  const deviceId = activeDeviceId;
  const usd = $('#device-expense-usd').value;
  const cdf = $('#device-expense-cdf').value;
  const body = {
    frais_usd: usd ? Number(usd) : 0,
    frais_cdf: cdf ? Number(cdf) : 0,
  };
  if ([body.frais_usd, body.frais_cdf].some((amount) =>
    !Number.isFinite(amount) || amount < 0 || amount > 9999999999.99 ||
    Math.round(amount * 100) !== amount * 100
  )) {
    message.textContent = 'Saisissez des totaux valides à deux décimales maximum.';
    message.className = 'text-sm text-red-700';
    return;
  }
  submittingExpense = true;
  button.disabled = true;
  button.textContent = 'Enregistrement…';
  message.textContent = 'Enregistrement des frais…';
  message.className = 'text-sm text-slate-600';
  try {
    const updated = await request(`/api/appareils/${deviceId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: activeDeviceVersion ? { 'X-Record-Version': activeDeviceVersion } : {},
    });
    activeDeviceVersion = updated.updated_at;
    $('#device-updated').textContent = formatDate(updated.updated_at);
    $('#device-expense-usd').value = Number(updated.frais_usd || 0) > 0
      ? String(updated.frais_usd)
      : '';
    $('#device-expense-cdf').value = Number(updated.frais_cdf || 0) > 0
      ? String(updated.frais_cdf)
      : '';
    message.textContent = 'Frais enregistrés; ils seront déduits de votre bilan personnel.';
    message.className = 'text-sm text-teal-800';
    await refresh();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'text-sm text-red-700';
  } finally {
    submittingExpense = false;
    button.disabled = false;
    button.textContent = 'Enregistrer le total des frais';
  }
});

let submittingPayment = false;
$('#payment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeDeviceId || submittingPayment) return;
  const deviceId = activeDeviceId;
  const form = event.currentTarget;
  const message = $('#payment-message');
  const button = form.querySelector('button[type="submit"]');
  const paymentBody = {
    montant: Number($('#payment-amount').value),
    devise: $('#payment-currency').value,
  };
  const serializedBody = JSON.stringify(paymentBody);
  if (
    !state.pendingPayment ||
    state.pendingPayment.deviceId !== deviceId ||
    state.pendingPayment.body !== serializedBody
  ) {
    state.pendingPayment = { deviceId, body: serializedBody, key: newRequestKey() };
  }
  submittingPayment = true;
  button.disabled = true;
  button.textContent = 'Enregistrement…';
  message.textContent = 'Enregistrement en cours…';
  message.className = 'text-sm text-slate-500';
  try {
    await request(`/api/appareils/${deviceId}/paiements`, {
      method: 'POST',
      body: serializedBody,
      headers: { 'Idempotency-Key': state.pendingPayment.key },
    });
    state.pendingPayment = null;
    form.reset();
    await openDevice(deviceId);
    $('#payment-message').textContent = 'Paiement enregistré.';
    $('#payment-message').className = 'text-sm text-teal-700';
    await refresh();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'text-sm text-red-700';
  } finally {
    submittingPayment = false;
    button.disabled = false;
    button.textContent = 'Enregistrer le paiement';
  }
});

const dialog = $('#approval-dialog');
const canvas = $('#signature-canvas');
const context = canvas.getContext('2d');
let drawingPointerId = null;
let activeStroke = null;
let signatureStrokes = [];
let signatureSize = { width: 0, height: 0 };

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}

function signatureCanvasPoint(point) {
  return { x: point.x * signatureSize.width, y: point.y * signatureSize.height };
}

function drawSignatureStroke(points) {
  if (!points.length) return;
  const first = signatureCanvasPoint(points[0]);
  context.beginPath();
  if (points.length === 1) {
    context.arc(first.x, first.y, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const previous = signatureCanvasPoint(points[index - 1]);
    const current = signatureCanvasPoint(points[index]);
    context.quadraticCurveTo(previous.x, previous.y, (previous.x + current.x) / 2, (previous.y + current.y) / 2);
  }
  const last = signatureCanvasPoint(points[points.length - 1]);
  context.lineTo(last.x, last.y);
  context.stroke();
}

function resizeSignatureCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
  const pixelWidth = Math.round(rect.width * pixelRatio);
  const pixelHeight = Math.round(rect.height * pixelRatio);
  signatureSize = { width: rect.width, height: rect.height };
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = 2.5;
  context.strokeStyle = '#0f172a';
  context.fillStyle = '#0f172a';
  context.clearRect(0, 0, signatureSize.width, signatureSize.height);
  signatureStrokes.forEach(drawSignatureStroke);
  if (activeStroke) {
    const points = activeStroke.points;
    const previous = signatureCanvasPoint(points[points.length - 2] || points[points.length - 1]);
    const current = signatureCanvasPoint(points[points.length - 1]);
    activeStroke.lastMidpoint = {
      x: (previous.x + current.x) / 2,
      y: (previous.y + current.y) / 2,
    };
  }
}

function pointerSamples(event) {
  const coalesced = event.getCoalescedEvents?.();
  return coalesced && coalesced.length ? coalesced : [event];
}

function addSignaturePoint(event) {
  const point = canvasPoint(event);
  const previous = activeStroke.points[activeStroke.points.length - 1];
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0001) return;
  activeStroke.points.push(point);
  const previousCanvasPoint = signatureCanvasPoint(previous);
  const currentCanvasPoint = signatureCanvasPoint(point);
  const midpoint = {
    x: (previousCanvasPoint.x + currentCanvasPoint.x) / 2,
    y: (previousCanvasPoint.y + currentCanvasPoint.y) / 2,
  };
  context.beginPath();
  context.moveTo(activeStroke.lastMidpoint.x, activeStroke.lastMidpoint.y);
  context.quadraticCurveTo(previousCanvasPoint.x, previousCanvasPoint.y, midpoint.x, midpoint.y);
  context.stroke();
  activeStroke.lastMidpoint = midpoint;
}

function finishSignatureStroke(event) {
  if (drawingPointerId === null || (event && event.pointerId !== drawingPointerId)) return;
  if (event) pointerSamples(event).forEach(addSignaturePoint);
  const last = signatureCanvasPoint(activeStroke.points[activeStroke.points.length - 1]);
  context.beginPath();
  context.moveTo(activeStroke.lastMidpoint.x, activeStroke.lastMidpoint.y);
  context.quadraticCurveTo(last.x, last.y, last.x, last.y);
  context.stroke();
  drawingPointerId = null;
  activeStroke = null;
}

canvas.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || drawingPointerId !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault();
  resizeSignatureCanvas();
  drawingPointerId = event.pointerId;
  const point = canvasPoint(event);
  activeStroke = { points: [point], lastMidpoint: signatureCanvasPoint(point) };
  signatureStrokes.push(activeStroke.points);
  context.beginPath();
  const start = signatureCanvasPoint(point);
  context.arc(start.x, start.y, context.lineWidth / 2, 0, Math.PI * 2);
  context.fill();
  state.hasSignature = true;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (event.pointerId !== drawingPointerId) return;
  pointerSamples(event).forEach(addSignaturePoint);
});
canvas.addEventListener('pointerup', (event) => finishSignatureStroke(event));
canvas.addEventListener('pointercancel', (event) => finishSignatureStroke(event));
canvas.addEventListener('lostpointercapture', (event) => finishSignatureStroke(event));
new ResizeObserver(resizeSignatureCanvas).observe(canvas);
window.addEventListener('resize', resizeSignatureCanvas);

function openApproval(device) {
  state.approvalId = device.id;
  state.approvalVersion = device.updated_at;
  state.hasSignature = false;
  drawingPointerId = null;
  activeStroke = null;
  signatureStrokes = [];
  $('#approval-device').textContent = `${device.marque} ${device.modele} — ${device.telephone}`;
  $('#approval-message').textContent = '';
  dialog.showModal();
  window.requestAnimationFrame(resizeSignatureCanvas);
}

function updatePaymentPlaceholder() {
  const currency = $('#payment-currency').value;
  $('#payment-amount').placeholder = currency === 'USD' ? 'Montant en dollars' : 'Montant en FC';
}

$('#payment-currency').addEventListener('change', updatePaymentPlaceholder);
updatePaymentPlaceholder();

$('#clear-signature').addEventListener('click', () => {
  signatureStrokes = [];
  drawingPointerId = null;
  activeStroke = null;
  context.clearRect(0, 0, signatureSize.width, signatureSize.height);
  state.hasSignature = false;
});

$('#save-approval').addEventListener('click', async () => {
  const message = $('#approval-message');
  if (!state.hasSignature) {
    message.textContent = 'La signature du client est requise.';
    message.className = 'mt-2 text-sm text-red-700';
    return;
  }
  try {
    await request(`/api/appareils/${state.approvalId}/approbation`, {
      method: 'POST',
      body: JSON.stringify({ signature_data: canvas.toDataURL('image/png') }),
      headers: state.approvalVersion ? { 'X-Record-Version': state.approvalVersion } : {},
    });
    dialog.close();
    showPage('archive', true, false);
    await refresh();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'mt-2 text-sm text-red-700';
  }
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(console.error));
}

// Paramètres pratiques pour un lien partagé ou encodé en QR code.
const prefill = new URLSearchParams(window.location.search);
['telephone', 'nom', 'modele'].forEach((field) => {
  const value = prefill.get(field);
  if (value) $(`#${field}`).value = value;
});
['marque', 'panne'].forEach((field) => {
  const value = prefill.get(field);
  if (!value) return;
  const option = [...document.querySelectorAll(`#${field === 'marque' ? 'brands' : 'faults'} .chip`)]
    .find((button) => button.dataset.value === value);
  if (option) {
    option.click();
  } else if (field === 'panne') {
    $('#panne').value = 'Autre';
    $('#autre-panne').value = value;
    $('#autre-panne').classList.remove('hidden');
  }
});

const resetToken = new URLSearchParams(window.location.search).get('reset_token');
if (resetToken) {
  state.passwordResetToken = resetToken;
  showAuthForm('password-reset-form');
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  $('#e-links-intro').dismiss();
} else {
  request('/api/auth/session')
    .then((result) => showApp(result.technicien, { expiresAt: result.session_expires_at }))
    .catch(async (error) => {
      if (error.offline) {
        const technician = await OfflineStore.getSession().catch(() => null);
        if (
          technician &&
          technician.account_id &&
          typeof technician.legacy_cache_owner === 'boolean'
        ) {
          await showApp(technician, { offline: true });
          return;
        }
        if (technician) {
          showLogin('Connectez-vous une fois en ligne pour séparer les données hors connexion de votre compte.');
          await $('#e-links-intro').dismiss();
          return;
        }
      }
      if (error.status !== 401) {
        showLogin('Le serveur est momentanément indisponible. Réessayez.');
      } else {
        await OfflineStore.clearSession().catch((storageError) =>
          console.error('Échec de suppression de la session hors ligne.', storageError),
        );
        showLogin();
      }
      await loadRegistrationSetup();
      await $('#e-links-intro').dismiss();
    });
}

window.addEventListener('online', () => {
  setOfflineMode(false);
  if (state.technician) syncPendingOperations();
});
window.addEventListener('offline', () => setOfflineMode(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && navigator.onLine && state.technician) {
    OfflineStore.getQueue().then((queue) => {
      if (state.isOffline || queue.length || Date.now() - state.lastSnapshotAt > 5 * 60 * 1000) {
        setOfflineMode(false);
        syncPendingOperations();
      }
    }).catch((error) => console.error('Échec de lecture de la file hors ligne.', error));
  }
});
window.setInterval(async () => {
  if (!navigator.onLine || !state.technician) return;
  try {
    const queue = await OfflineStore.getQueue();
    if (state.isOffline || queue.length || Date.now() - state.lastSnapshotAt > 5 * 60 * 1000) {
      setOfflineMode(false);
      syncPendingOperations();
    }
  } catch (error) {
    console.error('Échec de lecture de la file hors ligne.', error);
  }
}, 30000);
