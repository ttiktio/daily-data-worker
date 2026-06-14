@echo off
echo =======================================================
echo Starting Cloudflare Worker Dashboard Locally (Wrangler)
echo =======================================================
echo.
cd cloudflare-worker
npx wrangler dev --port 8787 --ip 127.0.0.1
