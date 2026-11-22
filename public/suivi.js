const statusNames = { DEPOT: 'Dépôt enregistré', EN_COURS: 'Réparation en cours', PRET: 'Prêt à être récupéré', LIVRE: 'Appareil restitué' };
const message = document.querySelector('#tracking-message');
const details = document.querySelector('#tracking-details');
const enableButton = document.querySelector('#enable-notifications');
const disableButton = document.querySelector('#disable-notifications');
const appareilId = new URLSearchParams(window.location.search).get('appareil');
let pushPublicKey = null;
let currentStatus = null;

function showMessage(text, isError = false) {
  message.textContent = text;
  message.className = `text-sm ${isError ? 'text-red-700' : 'text-slate-600'}`;
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
  document.querySelector('#tracking-device').textContent = `${appareil.marque} ${appareil.modele}`.trim();
  document.querySelector('#tracking-status').textContent = statusNames[appareil.statut] || 'Statut indisponible';
  document.querySelector('#tracking-updated').textContent =
    `Mis à jour le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(appareil.updated_at))}`;
  details.classList.remove('hidden');
  if (!pushPublicKey) {
    enableButton.disabled = true;
    enableButton.textContent = 'Notifications indisponibles';
    showMessage('Le suivi fonctionne, mais l’atelier n’a pas encore activé les notifications Push.');
  } else if (currentStatus === 'LIVRE') {
    enableButton.disabled = true;
    enableButton.textContent = 'Appareil déjà restitué';
    showMessage('La réparation est terminée.');
  } else {
    showMessage('Le suivi est à jour.');
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
    showMessage('Alerte activée sur cet appareil.');
  } catch (error) {
    showMessage(error.message || 'Impossible d’activer l’alerte.', true);
  } finally {
    enableButton.disabled = false;
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
    showMessage('Alerte désactivée pour ce dossier.');
  } catch (error) {
    showMessage(error.message || 'Impossible de désactiver l’alerte.', true);
  } finally {
    disableButton.disabled = false;
  }
});

loadTracking().catch((error) => showMessage(error.message || 'Impossible de charger le dossier.', true));
