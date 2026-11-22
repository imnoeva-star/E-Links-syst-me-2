# Déploiement d’Atelier Express sur Render

## Préparer Neon

1. Crée une branche de test Neon pour vérifier la migration sans toucher aux données de production.
2. Dans un terminal avec les variables de cette branche, configure `DATABASE_URL` avec l’URL pooled et `DATABASE_URL_UNPOOLED` avec l’URL directe (sans `-pooler`).
3. Lance `npm run db:migrate`, puis vérifie `/readyz` et crée un compte avec `npm run create-user`.
4. Quand cette vérification est satisfaisante, répète la migration et la création de compte sur la branche de production. Les migrations sont versionnées dans `migrations/` et ne sont pas exécutées automatiquement par Render.

Le script lit `.env` en local. Il applique les migrations triées par nom sur l’URL directe. Ne déploie pas sans avoir d’abord appliqué et vérifié la migration sur une branche de test.

## Créer les comptes et ateliers
Chaque inscription depuis « Créer un compte » crée un atelier privé avec son propre administrateur et ses propres données. En local, l’inscription initiale est disponible dès que la base ne contient aucun technicien.

En production, configure d’abord `INITIAL_SETUP_CODE` (secret d’au moins 16 caractères) dans Render, puis saisis-le une seule fois dans le formulaire d’inscription. Les inscriptions suivantes demandent `TECHNICIAN_INVITE_CODE` (secret d’au moins 16 caractères) et créent aussi un nouvel atelier indépendant. Pour partager les données d’un atelier avec un employé, son administrateur doit créer son accès dans « Équipe et comptes » ; ne lui donne pas le code d’inscription indépendant.

La commande `npm run create-user` crée un employé dans le premier atelier. Les mots de passe et leurs confirmations sont saisis sans affichage et doivent contenir entre 6 et 12 caractères.

Pour désactiver un compte, connecte-toi à PostgreSQL et passe `techniciens.actif` à `FALSE` pour l’adresse concernée ; ses sessions cessent alors d’être acceptées.

## Créer le service Render

Le fichier `render.yaml` configure le service Node sur le plan gratuit, la compilation CSS locale et la sonde de disponibilité. Render déconseille ce plan pour la production : le service s’endort après 15 minutes sans trafic et son redémarrage peut prendre environ une minute. Le système de fichiers du service est éphémère ; les données métier doivent rester dans Neon. Le SMTP sortant sur les ports 25, 465 et 587 est bloqué sur le plan gratuit, ce qui peut empêcher la récupération de compte par e-mail.

Pour passer à un plan payant, modifie `plan` dans `render.yaml` et ajoute un moyen de paiement dans Render. Dans Render, renseigne les variables secrètes :

- `DATABASE_URL` : URL pooled Neon destinée au trafic normal de l’application.
- `DATABASE_URL_UNPOOLED` : URL directe Neon réservée aux migrations et à la création des comptes.
- `NODE_ENV` : `production` (déjà défini dans le blueprint).
- `TECHNICIAN_INVITE_CODE` : secret d’au moins 16 caractères pour les inscriptions technicien par invitation.
- `APP_BASE_URL` : URL HTTPS publique de l’application, sans chemin ni paramètres.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT` : clés Web Push pour les alertes client. Génère une paire avec `npx web-push generate-vapid-keys`; garde la clé privée uniquement dans les variables secrètes Render. Le sujet doit être une adresse `mailto:` ou une URL HTTPS.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM` : paramètres du serveur d’envoi.
- `SMTP_USER` et `SMTP_PASSWORD` : identifiants SMTP si le fournisseur en demande.

La commande de build est `npm ci --include=dev && npm run build`, la commande de démarrage est `npm start` et le health check est `/readyz`. La compilation inclut explicitement Tailwind, même si `NODE_ENV=production` est défini. Applique les migrations avant la mise en service : sans les tables d’authentification, Render ne déclarera pas l’application prête.

La production doit être servie en HTTPS. L’écran de connexion propose une session de 30 jours sur cet appareil (12 heures si la case est décochée) ; le bouton de déconnexion révoque la session. Les cookies sont HttpOnly, SameSite=Lax, Secure en production, et les jetons ne sont stockés en base que sous forme de hash. Les liens de récupération sont à usage unique et expirent après une heure ; un changement de mot de passe révoque toutes les sessions. Le formulaire « Mot de passe oublié » apparaît lorsque SMTP et `APP_BASE_URL` sont configurés. Ne mets jamais les identifiants SMTP dans le dépôt ou le chat : renseigne-les comme variables d’environnement Render.

Pour tester la récupération en local, configure `APP_BASE_URL` et les paramètres SMTP dans `.env`, puis applique la migration `20261116_account_recovery.sql` avec `npm run db:migrate`. Pour les alertes Push, configure aussi les variables VAPID et applique la migration `20261121_push_notifications.sql` avant de déployer.

La migration `20261122_account_isolation.sql` attribue l’historique existant au premier atelier, crée un espace privé pour chaque compte déjà présent, puis cloisonne clients, appareils, paiements et actes. Teste-la sur une branche Neon avant la production ; les caches hors ligne sont également séparés par espace.

Cette migration et le nouveau serveur doivent être mis en service ensemble : l’ancienne version ne renseigne pas `account_id` et la nouvelle exige ces colonnes. Pour la migration de comptes, prévois une courte maintenance : suspends temporairement l’accès à l’application, applique la migration sur la branche de production avec l’URL directe, déploie le nouveau code, vérifie `/readyz` et les deux comptes, puis réouvre l’accès. Ne lance pas la migration de production seule.

Le QR de suivi est un lien de capacité basé sur l’identifiant UUID aléatoire du dossier. La page publique n’affiche que la marque, le modèle et le statut ; le téléphone, le nom, la panne et les paiements restent privés. Le client doit autoriser les notifications dans son navigateur après avoir scanné le QR.

## Vérifications locales

```powershell
npm ci
npm run build
npm test
npm start
```

`/healthz` confirme que le processus tourne ; `/readyz` confirme aussi la connexion PostgreSQL et la présence du schéma complet.
