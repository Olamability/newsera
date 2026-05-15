# RSS Engine VPS Deployment (Ubuntu 22.04)

## 1) Base packages

```bash
sudo apt update
sudo apt install -y git nginx curl
```

## 2) Node.js LTS + pnpm + PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
sudo corepack prepare pnpm@latest --activate
sudo npm install -g pm2
```

## 3) Deploy + install

```bash
git clone https://github.com/Olamability/newsera.git
cd newsera
cp .env.example .env
# Edit .env with real SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY values.
pnpm install
```

## 4) Start background RSS worker

```bash
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

## 5) Operations

```bash
pm2 status
pm2 logs rss-engine
pm2 restart rss-engine
```
