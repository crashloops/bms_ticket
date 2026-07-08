# BookMyShow Showtime Monitor

Free Cloudflare Worker monitor for a BookMyShow cinema page. It checks the page on a cron schedule, extracts showtimes for a target movie, stores the last known state in Cloudflare KV, and sends Telegram alerts only when showtimes are added or removed.

## What this project does

- Runs in the cloud with Cloudflare Workers.
- Uses a Cron Trigger every 2 minutes: `*/2 * * * *`.
- Sends Telegram alerts.
- Uses Cloudflare KV to prevent duplicate alerts.
- Provides `/test`, `/debug`, `/seed`, `/last`, and `/telegram-test` routes.
- Does not book tickets, bypass CAPTCHA, bypass queues, login, or overload BookMyShow.

## Required Cloudflare bindings/secrets

### KV binding

```txt
BMS_STATE
```

### Worker secrets

```txt
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

Optional:

```txt
ADMIN_KEY
```

## Local commands

Install dependencies:

```bash
npm install
```

Login to Cloudflare:

```bash
npx wrangler login
```

Create KV namespace:

```bash
npm run kv:create
```

Copy the returned namespace ID into `wrangler.jsonc` here:

```jsonc
"kv_namespaces": [
  {
    "binding": "BMS_STATE",
    "id": "YOUR_KV_NAMESPACE_ID"
  }
]
```

Add secrets:

```bash
npm run secret:telegram-token
npm run secret:telegram-chat
npm run secret:admin-key
```

Deploy:

```bash
npm run deploy
```

## Routes

Replace the host with your Worker URL.

```txt
https://YOUR-WORKER.workers.dev/test
https://YOUR-WORKER.workers.dev/debug
https://YOUR-WORKER.workers.dev/seed?key=YOUR_ADMIN_KEY
https://YOUR-WORKER.workers.dev/last
https://YOUR-WORKER.workers.dev/telegram-test?key=YOUR_ADMIN_KEY
```

## Important first run

Run `/seed` once after deployment. This stores the current showtimes as the baseline so future alerts only fire when there is a change.

## Config

Edit the top of `src/index.js`:

```js
const CONFIG = {
  targetUrl: "https://in.bookmyshow.com/cinemas/HYD/prasads-multiplex-hyderabad/buytickets/PRHN/20260730",
  targetMovie: "Spider-Man: Brand New Day",
  targetFormat: "",
  targetTime: ""
};
```

## Limitation

Cloudflare Worker `fetch()` receives raw HTML. It does not run a full browser. If BookMyShow renders showtimes only through JavaScript after page load, `/debug` may not show the timings even though your browser shows them. In that case this ethical free Worker approach may not be able to monitor the rendered section reliably.
