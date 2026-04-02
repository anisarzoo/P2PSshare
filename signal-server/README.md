# ConnectVia Signaling Server

Use this service for:
- Online room signaling with stable uptime.
- Offline/LAN mode when internet is unavailable.

Netlify can host your static web app, but this signaling process must run on an always-on Node host (Render/Fly/Railway/VPS/etc.).

## Start locally
1. `cd signal-server`
2. `npm install`
3. Copy `.env.example` to `.env` and adjust values.
4. `npm run start`

Health checks:
- `http://<host>:9000/health`
- `http://<host>:9000/ready`

## Required environment
- `PORT`
- `HOST`
- `PEER_PATH`
- `TRUST_PROXY`
- `CORS_ORIGIN`

## Production recommendations
- Put server behind Nginx/Caddy/Traefik with TLS.
- Set `TRUST_PROXY=true` behind reverse proxy.
- Restrict `CORS_ORIGIN` to your exact app origins (comma-separated).
- Keep `ALLOW_DISCOVERY=false` unless you explicitly need peer listing.
- Monitor process and auto-restart (PM2/systemd/container orchestration).

## Optional direct TLS
You can run HTTPS directly in Node with:
- `ENABLE_HTTPS=true`
- `TLS_KEY_FILE=<path>`
- `TLS_CERT_FILE=<path>`
- `TLS_CA_FILE=<path>` (optional)

Reverse-proxy TLS is still preferred for most deployments.

