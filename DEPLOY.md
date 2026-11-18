# Déploiement d’Atelier Express sur Render

## Préparer Neon

1. Crée une branche de test Neon pour vérifier la migration sans toucher aux données de production.
2. Dans un terminal avec les variables de cette branche, configure `DATABASE_URL` avec l’URL pooled et `DATABASE_URL_UNPOOLED` avec l’URL directe (sans `-pooler`).
3. Lance `npm run db:migrate`, puis vérifie `/readyz` et crée un compte avec `npm run create-user`.
4. Quand cette vérification est satisfaisante, répète la migration et la création de compte sur la branche de production. Les migrations sont versionnées dans `migrations/` et ne sont pas exécutées automatiquement par Render.

Le script lit `.env` en local. Il applique les migrations triées par nom sur l’URL directe. Ne déploie pas sans avoir d’abord appliqué et vérifié la migration sur une branche de test.

## Créer les comptes techniciens
Le premier compte peut être créé directement depuis « Créer un compte » sur l’écran de connexion ; ce compte devient administrateur. En local, l’inscription initiale est disponible dès que la base ne contient aucun technicien.

En production, configure d’abord `INITIAL_SETUP_CODE` (secret d’au moins 16 caractères) dans Render, puis saisis-le une seule fois dans le formulaire d’inscription. Après la création du premier compte, l’inscription demande `TECHNICIAN_INVITE_CODE` (secret d’au moins 16 caractères) pour créer un compte technicien ; communique ce code uniquement aux personnes autorisées et renouvelle-le dans Render s’il est divulgué. L’administrateur peut aussi créer ou désactiver les comptes individuels dans « Équipe et comptes », sans terminal.

Les comptes peuvent toujours être créés hors interface avec `npm run create-user` dans un terminal interactif. Les mots de passe et leurs confirmations sont saisis sans affichage et doivent contenir entre 6 et 12 caractères.

Pour désactiver un compte, connecte-toi à PostgreSQL et passe `techniciens.actif` à `FALSE` pour l’adresse concernée ; ses sessions cessent alors d’être acceptées.

## Créer le service Render

Le fichier `render.yaml` configure le service Node, la compilation CSS locale et la sonde de disponibilité. Dans Render, renseigne les variables secrètes :

- `DATABASE_URL` : URL pooled Neon destinée au trafic normal de l’application.
- `DATABASE_URL_UNPOOLED` : URL directe Neon réservée aux migrations et à la création des comptes.
- `NODE_ENV` : `production` (déjà défini dans le blueprint).
- `TECHNICIAN_INVITE_CODE` : secret d’au moins 16 caractères pour les inscriptions technicien par invitation.
- `APP_BASE_URL` : URL HTTPS publique de l’application, sans chemin ni paramètres.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM` : paramètres du serveur d’envoi.
- `SMTP_USER` et `SMTP_PASSWORD` : identifiants SMTP si le fournisseur en demande.

La commande de build est `npm ci --include=dev && npm run build`, la commande de démarrage est `npm start` et le health check est `/readyz`. La compilation inclut explicitement Tailwind, même si `NODE_ENV=production` est défini. Applique les migrations avant la mise en service : sans les tables d’authentification, Render ne déclarera pas l’application prête.

La production doit être servie en HTTPS. L’écran de connexion propose une session de 30 jours sur cet appareil (12 heures si la case est décochée) ; le bouton de déconnexion révoque la session. Les cookies sont HttpOnly, SameSite=Lax, Secure en production, et les jetons ne sont stockés en base que sous forme de hash. Les liens de récupération sont à usage unique et expirent après une heure ; un changement de mot de passe révoque toutes les sessions. Le formulaire « Mot de passe oublié » apparaît lorsque SMTP et `APP_BASE_URL` sont configurés. Ne mets jamais les identifiants SMTP dans le dépôt ou le chat : renseigne-les comme variables d’environnement Render.

Pour tester la récupération en local, configure `APP_BASE_URL` et les paramètres SMTP dans `.env`, puis applique la migration `20261116_account_recovery.sql` avec `npm run db:migrate`.

## Vérifications locales

```powershell
npm ci
npm run build
npm test
npm start
```

`/healthz` confirme que le processus tourne ; `/readyz` confirme aussi la connexion PostgreSQL et la présence du schéma complet.
