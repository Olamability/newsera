# NewsEra Release Workflow

This document is the single source of truth for releasing every part of the NewsEra platform. Follow the steps in order. Each section is self-contained so you can jump straight to the part you need.

---

## Table of Contents

1. [Overview](#overview)
2. [Version Bumping Guide](#version-bumping-guide)
3. [Environment Handling](#environment-handling)
4. [Mobile App Release (EAS + Android)](#mobile-app-release-eas--android)
5. [Admin Panel Deployment](#admin-panel-deployment)
6. [RSS Engine Deployment](#rss-engine-deployment)
7. [Rollback Procedures](#rollback-procedures)

---

## Overview

```
┌────────────────────────────────────────────────────────┐
│                   NewsEra Monorepo                     │
│                                                        │
│  apps/mobile-app   →  Expo EAS  →  Google Play Store  │
│  apps/admin-panel  →  Vercel / VPS Nginx               │
│  services/rss-engine  →  VPS (PM2)                     │
└────────────────────────────────────────────────────────┘
```

**Environments:**

| Label | Purpose | EAS profile |
|-------|---------|-------------|
| `development` | Local dev / Expo Go | `development` |
| `staging` | Internal QA / preview builds | `preview` |
| `production` | End users / Play Store | `production` |

---

## Version Bumping Guide

### Mobile App

Version is defined in two places:

| Field | File | Notes |
|-------|------|-------|
| `version` (semver) | `mobile-app/app.config.js` | User-facing string, e.g. `"1.2.0"` |
| `versionCode` | `mobile-app/app.config.js` | Android integer, must increase every upload |

**For a patch release (bug fix):** bump `version` patch segment (e.g. `1.0.0` → `1.0.1`) and increment `versionCode` by 1 for local/manual builds.

**For a minor release (new feature):** bump `version` minor segment (e.g. `1.0.0` → `1.1.0`), reset patch to `0`, and increment `versionCode` for local/manual builds.

**For EAS production builds**, enable `"autoIncrement": true` in `eas.json` (already set) — EAS will automatically increment `versionCode` so you only need to manage it manually for local builds not going through EAS.

### Admin Panel & RSS Engine

Both follow semver in their respective `package.json` files. There is no automated versioning — bump `version` manually before each production release.

---

## Environment Handling

### Mobile App (`mobile-app/`)

Copy the example file and fill in your credentials:

```bash
cp mobile-app/.env.example mobile-app/.env
```

Required variables:

```
EXPO_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
```

> **Note:** Variables prefixed with `EXPO_PUBLIC_` are embedded in the JS bundle at build time. Never put service-role keys or other secrets here.

For EAS builds, set secrets in the EAS dashboard (**eas.dev → Project → Secrets**) rather than committing `.env` files.

### Admin Panel (`admin-panel/`)

```bash
cp admin-panel/.env.example admin-panel/.env
```

Required variables:

```
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

> **Note:** `VITE_*` variables are embedded in the built JS bundle. Only use the Supabase **anon/public** key here — never the service-role key.

For Vercel deployment, set these as **Environment Variables** in the Vercel dashboard.

### RSS Engine (`rss-engine/`)

```bash
cp rss-engine/.env.example rss-engine/.env
```

Required variables:

```
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

> **Warning:** The service-role key bypasses row-level security. Keep it secret and never expose it to the browser or mobile app.

---

## Mobile App Release (EAS + Android)

### Prerequisites

1. Install the EAS CLI: `npm install -g eas-cli`
2. Log in: `eas login`
3. Make sure your EAS project ID is set in `mobile-app/app.config.js` → `extra.eas.projectId`, or set via `EAS_PROJECT_ID` environment variable.

### Step 1 — Run CI checks locally

```bash
cd mobile-app
npm ci
npm run typecheck
```

Fix any type errors before building.

### Step 2 — Bump the version

Edit `mobile-app/app.config.js`:

```js
version: '1.x.y',            // bump as needed (semver string)
versionCode: 2,               // increment by 1 for local/manual builds only
```

> **EAS builds:** When submitting via `eas build --profile production`, the `autoIncrement: true` setting in `eas.json` handles `versionCode` automatically. You do not need to edit this value for EAS builds.

Commit the change: `git commit -am "chore: bump mobile version to 1.x.y"`

### Step 3 — Build a preview (internal QA)

```bash
cd mobile-app
eas build --profile preview --platform android
```

Install the generated APK on a test device or share via EAS internal distribution.

### Step 4 — Build for production

```bash
eas build --profile production --platform android
```

This produces an **AAB** (Android App Bundle) suitable for Google Play.

> EAS will automatically increment `versionCode` because `"autoIncrement": true` is set in `eas.json`.

### Step 5 — Submit to Google Play

```bash
eas submit --platform android --latest
```

Or download the AAB from **eas.dev** and upload manually in the Google Play Console.

### Step 6 — Tag the release

```bash
git tag mobile-v1.x.y
git push origin mobile-v1.x.y
```

---

## Admin Panel Deployment

### Option A — Vercel (recommended)

1. Connect the repository to Vercel.
2. Set **Root Directory** to `admin-panel`.
3. Set **Build Command** to `npm run build`.
4. Set **Output Directory** to `dist`.
5. Add environment variables in Vercel dashboard:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
6. Every push to `main` triggers an automatic deployment.

The included `admin-panel/vercel.json` already handles SPA routing (all paths serve `index.html`).

### Option B — VPS / Nginx

**Build the app:**

```bash
cd admin-panel
npm ci
VITE_SUPABASE_URL=<url> VITE_SUPABASE_ANON_KEY=<key> npm run build
```

**Upload** the `admin-panel/dist/` directory to your server (e.g., via `rsync`):

```bash
rsync -avz --delete admin-panel/dist/ user@your-server:/var/www/newsera-admin/
```

**Nginx configuration** (place in `/etc/nginx/sites-available/admin`):

```nginx
server {
    listen 80;
    server_name admin.yourdomain.com;
    root /var/www/newsera-admin;
    index index.html;

    # SPA fallback — all routes serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets aggressively
    location ~* \.(js|css|png|jpg|svg|ico|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

Reload nginx: `sudo nginx -s reload`

### Step — Tag the release

```bash
git tag admin-v1.x.y
git push origin admin-v1.x.y
```

---

## RSS Engine Deployment

The RSS engine is a Node.js worker that must run continuously on your VPS. It is managed by **PM2**.

### Prerequisites

- Node.js 18+ on the server
- PM2 installed globally: `npm install -g pm2`

### Step 1 — Push the latest code

```bash
git pull origin main
```

### Step 2 — Install dependencies

```bash
cd rss-engine
npm ci --omit=dev
```

### Step 3 — Set environment variables

Create `/opt/newsera/rss-engine/.env` (outside the repo is safer):

```
NODE_ENV=production
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
RSS_INGESTION_INTERVAL_MS=600000
```

Or export them in the server shell before starting PM2.

### Step 4 — Start with PM2

From the repo root (where `ecosystem.config.js` lives):

```bash
pm2 start ecosystem.config.js
pm2 save          # persist across reboots
pm2 startup       # configure auto-start on reboot (follow the printed command)
```

### Step 5 — Verify

```bash
pm2 status
pm2 logs rss-engine --lines 50
```

You should see `[RSS] Ingestion completed` lines in the log.

### Updating the RSS Engine

```bash
git pull origin main
cd rss-engine && npm ci --omit=dev && cd ..
pm2 reload rss-engine   # zero-downtime reload
```

### Step — Tag the release

```bash
git tag rss-v1.x.y
git push origin rss-v1.x.y
```

---

## Rollback Procedures

### Mobile App

You cannot un-publish a Play Store release, but you can:

1. **Halt the rollout** in Google Play Console → Release → Managed publishing.
2. Build and submit the previous working version (use the previous git tag):
   ```bash
   git checkout mobile-v<previous>
   cd mobile-app
   eas build --profile production --platform android
   eas submit --platform android --latest
   ```

### Admin Panel

**Vercel:** Go to the Vercel dashboard → Deployments → click the previous deployment → **Promote to Production**.

**VPS:** Re-run the deploy steps using the previous git tag:

```bash
git checkout admin-v<previous>
cd admin-panel && npm ci && npm run build
rsync -avz --delete dist/ user@server:/var/www/newsera-admin/
```

### RSS Engine

```bash
git checkout rss-v<previous>
cd rss-engine && npm ci --omit=dev && cd ..
pm2 reload rss-engine
```

To verify the rollback, check logs:

```bash
pm2 logs rss-engine --lines 100
```

---

## Quick Reference

| Task | Command |
|------|---------|
| Run all CI checks locally (admin + rss) | `pnpm run typecheck && pnpm run lint` |
| Run mobile type check | `cd mobile-app && npm run typecheck` |
| Build admin panel | `cd admin-panel && npm run build` |
| EAS preview build (Android APK) | `cd mobile-app && eas build --profile preview --platform android` |
| EAS production build (Android AAB) | `cd mobile-app && eas build --profile production --platform android` |
| Submit to Play Store | `cd mobile-app && eas submit --platform android --latest` |
| Restart RSS engine | `pm2 reload rss-engine` |
| View RSS logs | `pm2 logs rss-engine` |
