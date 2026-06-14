# Scheduled Data Sync Worker

A secure, scheduled utility workflow that performs data synchronization, health checks, and status monitoring.

## System Architecture

This repository is designed to run completely within a public environment (like public GitHub Actions) without exposing any private target details, configurations, or credentials.

- **GitHub Repository**: Stores generic, open-source code and workflow actions.
- **GitHub Secrets**: Stores sensitive environment variables (API tokens, Cloudflare credentials, target configurations, target URL).
- **Cloudflare KV**: Secure external storage where results, metrics, and logs are persisted.
- **Cloudflare Worker**: A lightweight serverless API and secure dashboard providing authorized access to view execution logs.

```text
GitHub Actions (Job Execution)
      │
      ▼
Cloudflare KV (Secure Storage)
      ▲
      │
Cloudflare Worker (Auth Gateway & Admin Console)
      ▲
      │
Authorized Administrator (You)
```

## Repository Structure

```text
├── .github/
│   └── workflows/
│       └── run.yml           # GitHub Actions schedule/dispatch pipeline
├── src/
│   ├── main.py               # Main Python execution script
│   └── utils.py              # Cloudflare KV Client and utility methods
├── cloudflare-worker/        # Cloudflare serverless dashboard application
│   ├── src/
│   │   └── index.js          # Serverless routing, session management, and dashboard templates
│   ├── wrangler.toml         # Wrangler configuration template
│   └── package.json
├── requirements.txt          # Python dependencies
└── .gitignore
```

## Setup & Deployment

### 1. External Storage (Cloudflare KV)
1. Create a **KV Namespace** in your Cloudflare account (e.g. named `data-worker-kv`).
2. Make a note of the **Namespace ID** and your **Account ID**.

### 2. GitHub Actions Configuration
Configure the following **Repository Secrets** in your GitHub repository (`Settings` -> `Secrets and variables` -> `Actions`):

| Secret Key | Description | Example |
| :--- | :--- | :--- |
| `TARGET_URL` | The private URL or endpoint to scrape / sync / monitor. | `https://api.private.com/v1/sync` |
| `TARGET_CONFIG` | Optional JSON configuration string for requests headers, agents etc. | `{"user_agent": "CustomBot/1.0"}` |
| `CLOUDFLARE_API_TOKEN` | API Token with Edit KV permissions. | `cf_api_...` |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID. | `123456789abcdef...` |
| `CLOUDFLARE_KV_NAMESPACE_ID` | The ID of the KV Namespace created above. | `abcdef123456...` |

### 3. Deploying the Dashboard (Cloudflare Worker)
Navigate to the `cloudflare-worker` directory and deploy using Wrangler:
```bash
cd cloudflare-worker
npm install
npx wrangler deploy
```

#### Configuring Worker Secrets:
For security, do not store plain secrets in `wrangler.toml`. Inject them using Wrangler CLI or your Cloudflare Dashboard:
1. Set the Session Key (for signing security cookies):
   ```bash
   npx wrangler secret put SESSION_SECRET
   ```
2. Set the Admin Password Hash (SHA-256):
   To generate a SHA-256 hash of your chosen password, you can use online tools or terminal:
   `echo -n "your_password" | shasum -a 256` (on macOS/Linux) or via PowerShell:
   `[System.BitConverter]::ToString((New-Object System.Security.Cryptography.SHA256Managed).ComputeHash([System.Text.Encoding]::UTF8.GetBytes("your_password"))).Replace("-","").ToLower()`
   
   Apply the generated hash to the Worker:
   ```bash
   npx wrangler secret put PASSWORD_HASH
   ```
3. (Optional) GitHub Dispatch integration:
   To trigger jobs directly from the dashboard:
   - Create a GitHub Personal Access Token (PAT) with `workflow` scope.
   - Run:
     ```bash
     npx wrangler secret put GITHUB_PAT
     ```
   - Update `wrangler.toml` (or env variables in dashboard) with `GITHUB_OWNER` and `GITHUB_REPO`.

## Features
- **Privacy First**: Target URLs, headers, and detailed configurations are never committed to git or printed in action logs.
- **Secure Dashboard**: Password protection using client-less secure state session signing.
- **Dispatch Logs**: Detailed dashboard metrics showing response latency, status codes, payload sizes, and complete JSON logs.
- **Workflow Dispatch**: Optional manual trigger button linked with GitHub API to fire actions directly.
