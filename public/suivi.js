const statusDetails = {
  DEPOT: {
    title: 'Dépôt enregistré',
    description: 'Votre appareil a bien été confié à notre atelier.',
    progress: 0,
  },
  EN_COURS: {
    title: 'En cours',
    description: 'Notre équipe travaille actuellement sur votre appareil.',
    progress: 1,
  },
  PRET: {
    title: 'Prêt à récupérer',
    description: 'La réparation est terminée. Vous pouvez passer à l’atelier.',
    progress: 2,
  },
  LIVRE: {
    title: 'Appareil restitué',
    description: 'Votre appareil vous a été remis. Merci de votre confiance.',
    progress: 3,
  },
};
const deviceTypeNames = {
  TELEPHONE: 'Téléphone',
  TABLETTE: 'Tablette',
  ORDINATEUR: 'Ordinateur',
};
const message = document.querySelector('#tracking-message');
const details = document.querySelector('#tracking-details');
const statusCard = document.querySelector('#tracking-status-card');
const notificationPanel = document.querySelector('#notification-panel');
const notificationCopy = document.querySelector('#notification-copy');
const notificationUnavailable = document.querySelector('#notification-unavailable');
const enableButton = document.querySelector('#enable-notifications');
const disableButton = document.querySelector('#disable-notifications');
const appareilId = new URLSearchParams(window.location.search).get('appareil');
let pushPublicKey = null;
let currentStatus = null;

function showMessage(text, isError = false) {
  message.textContent = text;
  message.className = `tracking-message${isError ? ' is-error' : ''}`;
}

function decodeApplicationKey(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function loadTracking() {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(appareilId || '')) {
    throw new Error('Le lien de suivi est invalide.');
  }
  const response = await fetch(`/api/public/appareils/${encodeURIComponent(appareilId)}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.erreur || 'Impossible de charger le dossier.');

  const appareil = result.appareil;
  currentStatus = appareil.statut;
  pushPublicKey = result.push_public_key;
  const status = statusDetails[currentStatus];
  if (!status) throw new Error('Le statut de cette réparation est indisponible.');

  document.querySelector('#tracking-device').textContent =
    `${deviceTypeNames[appareil.type_appareil] || deviceTypeNames.TELEPHONE} · ${appareil.marque} ${appareil.modele}`.trim();
  statusCard.dataset.status = currentStatus;
  document.querySelector('#tracking-status').textContent = status.title;
  document.querySelector('#tracking-status-description').textContent = status.description;
  document.querySelector('#tracking-updated').textContent =
    `Mis à jour le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(appareil.updated_at))}`;
  document.querySelectorAll('.tracking-step').forEach((step, index) => {
    const state = index < status.progress ? 'complete' : index === status.progress ? 'current' : 'pending';
    step.dataset.state = state;
    if (state === 'current') step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
  details.classList.remove('hidden');
  showMessage('Le suivi est à jour.');

  if (currentStatus === 'PRET' || currentStatus === 'LIVRE') {
    notificationPanel.classList.add('hidden');
    return;
  }

  notificationPanel.classList.remove('hidden');
  if (!pushPublicKey) {
    enableButton.classList.add('hidden');
    notificationUnavailable.classList.remove('hidden');
    notificationUnavailable.textContent = 'Les alertes ne sont pas disponibles pour le moment.';
    return;
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    enableButton.classList.add('hidden');
    notificationUnavailable.classList.remove('hidden');
    notificationUnavailable.textContent = 'Ce navigateur ne prend pas en charge les alertes Push.';
    return;
  }

  if (Notification.permission === 'denied') {
    enableButton.classList.add('hidden');
    notificationUnavailable.classList.remove('hidden');
    notificationUnavailable.textContent = 'Les notifications sont bloquées. Autorisez-les dans les réglages de votre navigateur.';
    return;
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = registration && await registration.pushManager.getSubscription();
    if (subscription && Notification.permission === 'granted') {
      enableButton.classList.add('hidden');
      disableButton.classList.remove('hidden');
      notificationCopy.textContent = 'L’alerte est activée sur cet appareil. Nous vous préviendrons quand la réparation sera prête.';
    }
  } catch (error) {
    console.error('Impossible de vérifier l’abonnement Push existant.', error);
    showMessage('Le suivi est à jour, mais l’état de l’alerte n’a pas pu être vérifié.');
  }
}

enableButton.addEventListener('click', async () => {
  enableButton.disabled = true;
  try {
    if (!pushPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      throw new Error('Les notifications ne sont pas prises en charge par ce navigateur.');
    }
    const permission = Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
    if (permission !== 'granted') throw new Error('Autorisez les notifications dans les réglages du navigateur.');
    await navigator.serviceWorker.register('/service-worker.js');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription() ||
      await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationKey(pushPublicKey),
      });
    const response = await fetch(`/api/public/appareils/${encodeURIComponent(appareilId)}/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.erreur || 'Impossible d’activer l’alerte.');
    enableButton.classList.add('hidden');
    disableButton.classList.remove('hidden');
    notificationCopy.textContent = 'L’alerte est activée sur cet appareil. Nous vous préviendrons quand la réparation sera prête.';
    showMessage('Alerte activée sur cet appareil.');
  } catch (error) {
    showMessage(error.message || 'Impossible d’activer l’alerte.', true);
  } finally {
    if (!enableButton.classList.contains('hidden')) enableButton.disabled = false;
  }
});

disableButton.addEventListener('click', async () => {
  disableButton.disabled = true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const response = await fetch(`/api/public/appareils/${encodeURIComponent(appareilId)}/notifications`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.erreur || 'Impossible de désactiver l’alerte.');
      }
    }
    disableButton.classList.add('hidden');
    enableButton.classList.remove('hidden');
    notificationCopy.textContent = 'Activez l’alerte pour être prévenu dès que votre téléphone est prêt.';
    showMessage('Alerte désactivée pour ce dossier.');
  } catch (error) {
    showMessage(error.message || 'Impossible de désactiver l’alerte.', true);
  } finally {
    disableButton.disabled = false;
  }
});

loadTracking().catch((error) => {
  showMessage(error.message || 'Impossible de charger le dossier.', true);
});
