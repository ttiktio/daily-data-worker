// Cloudflare Worker for Public GitHub Actions Private Access Dashboard

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Get configuration / secrets
    const sessionSecret = (env.SESSION_SECRET || "default_session_secret_change_in_prod").trim();
    const passwordHash = (env.PASSWORD_HASH || "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918").trim(); // default hash of "admin"

    // 0. Handle local KV development API (only allowed for localhost or when token is matched)
    if (url.pathname.startsWith("/api/kv/")) {
      const key = url.pathname.substring("/api/kv/".length);
      if (!key) {
        return new Response("Key required", { status: 400 });
      }

      const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      const authHeader = request.headers.get("Authorization");
      const hasLocalToken = authHeader && authHeader === `Bearer ${sessionSecret}`;

      if (!isLocal && !hasLocalToken) {
        return new Response("Unauthorized KV API access", { status: 401 });
      }

      if (request.method === "GET") {
        if (!env.DATA_KV) {
          return new Response("DATA_KV namespace not bound", { status: 500 });
        }
        const value = await env.DATA_KV.get(key);
        if (value === null) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(value, { status: 200 });
      } else if (request.method === "PUT") {
        if (!env.DATA_KV) {
          return new Response("DATA_KV namespace not bound", { status: 500 });
        }
        const value = await request.text();
        await env.DATA_KV.put(key, value);
        return new Response("OK", { status: 200 });
      } else {
        return new Response("Method not allowed", { status: 405 });
      }
    }

    // 0.5 Handle Calculator GET
    if (url.pathname === "/calculator") {
      const isAuth = await isAuthenticated(request, sessionSecret);
      if (!isAuth) {
        return serveLoginPage();
      }

      if (!env.DATA_KV) {
        return serveErrorPage("KV Namespace 'DATA_KV' is not bound. Please configure bindings in wrangler.toml.");
      }

      const calculatorHtml = await env.DATA_KV.get("calculator_page");
      if (!calculatorHtml) {
        return new Response("<h3>Calculator page not found. Please run the GitHub Actions workflow or the local sync job first to generate it.</h3>", {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      return new Response(calculatorHtml, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 1. Handle Logout
    if (url.pathname === "/logout") {
      return new Response("", {
        status: 302,
        headers: {
          "Location": "/",
          "Set-Cookie": "session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        }
      });
    }

    // 2. Handle Login POST
    if (url.pathname === "/login" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const password = formData.get("password");
        
        if (!password) {
          return serveLoginPage("Password is required", 400);
        }

        const inputHash = await sha256(password);
        if (inputHash === passwordHash) {
          const cookieHeader = await generateSessionCookie(sessionSecret);
          return new Response("", {
            status: 302,
            headers: {
              "Location": "/",
              "Set-Cookie": cookieHeader
            }
          });
        } else {
          return serveLoginPage("Invalid password. Please try again.", 401);
        }
      } catch (err) {
        return serveLoginPage(`Login Error: ${err.message}`, 500);
      }
    }

    // 2.5 Handle API Calculate POST
    if (url.pathname === "/api/calculate" && request.method === "POST") {
      const isAuth = await isAuthenticated(request, sessionSecret);
      if (!isAuth) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (!env.DATA_KV) {
        return new Response(JSON.stringify({ error: "KV Storage not configured" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        const body = await request.json();
        const expression = body.expression;

        if (!expression) {
          return new Response(JSON.stringify({ error: "Expression is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Validate basic math characters to prevent shell injection/eval risks
        const safePattern = /^[0-9+\-*\/().\s]+$/;
        if (!safePattern.test(expression)) {
          return new Response(JSON.stringify({ error: "Invalid math expression. Only numbers and basic operators (+, -, *, /, parentheses) are allowed." }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Set status to pending in KV
        const calcRequest = {
          expression: expression,
          status: "pending",
          requested_at: Date.now()
        };
        await env.DATA_KV.put("calc_request", JSON.stringify(calcRequest));

        // Trigger GitHub Actions
        if (!env.GITHUB_OWNER || !env.GITHUB_REPO || !env.GITHUB_PAT) {
          return new Response(JSON.stringify({ 
            success: true, 
            localOnly: true,
            message: "Request saved to KV. GitHub integration not configured, please run local job to process." 
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        const ghRes = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/run.yml/dispatches`, {
          method: "POST",
          headers: {
            "Authorization": `token ${env.GITHUB_PAT}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Cloudflare-Worker-Dashboard",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ ref: "main" })
        });

        if (ghRes.status === 204) {
          return new Response(JSON.stringify({ 
            success: true, 
            message: "Calculation queued! GitHub Actions has been triggered to process the calculation." 
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        } else {
          const errMsg = await ghRes.text();
          return new Response(JSON.stringify({ error: `GitHub API error (${ghRes.status}): ${errMsg}` }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }

      } catch (e) {
        return new Response(JSON.stringify({ error: `Exception: ${e.message}` }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 2.6 Handle API Status GET
    if (url.pathname === "/api/status" && request.method === "GET") {
      const isAuth = await isAuthenticated(request, sessionSecret);
      if (!isAuth) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (!env.DATA_KV) {
        return new Response(JSON.stringify({ error: "KV Storage not configured" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }

      const calcRequestRaw = await env.DATA_KV.get("calc_request");
      const calcResultRaw = await env.DATA_KV.get("calc_result");

      return new Response(JSON.stringify({
        request: calcRequestRaw ? JSON.parse(calcRequestRaw) : null,
        result: calcResultRaw ? JSON.parse(calcResultRaw) : null
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 3. Handle API Trigger POST (GitHub dispatch)
    if (url.pathname === "/api/trigger" && request.method === "POST") {
      const isAuth = await isAuthenticated(request, sessionSecret);
      if (!isAuth) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (!env.GITHUB_OWNER || !env.GITHUB_REPO || !env.GITHUB_PAT) {
        return new Response(JSON.stringify({ error: "GitHub integration is not fully configured in Wrangler secrets." }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        const ghRes = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/run.yml/dispatches`, {
          method: "POST",
          headers: {
            "Authorization": `token ${env.GITHUB_PAT}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Cloudflare-Worker-Dashboard",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ ref: "main" })
        });

        if (ghRes.status === 204) {
          return new Response(JSON.stringify({ success: true, message: "Sync job triggered successfully via GitHub Actions." }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        } else {
          const errMsg = await ghRes.text();
          return new Response(JSON.stringify({ error: `GitHub API error (${ghRes.status}): ${errMsg}` }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
      } catch (e) {
        return new Response(JSON.stringify({ error: `Exception during fetch: ${e.message}` }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 4. Default: Serve Dashboard or Login Page
    const isAuth = await isAuthenticated(request, sessionSecret);
    if (!isAuth) {
      return serveLoginPage();
    }

    // Fetch data from KV binding
    if (!env.DATA_KV) {
      return serveErrorPage("KV Namespace 'DATA_KV' is not bound to this worker. Please configure bindings in wrangler.toml.");
    }

    const latestDataRaw = await env.DATA_KV.get("latest_data");
    const historyDataRaw = await env.DATA_KV.get("history_data");
    const lastUpdate = await env.DATA_KV.get("last_update");

    let latestData = null;
    let historyData = [];

    try {
      if (latestDataRaw) latestData = JSON.parse(latestDataRaw);
      if (historyDataRaw) historyData = JSON.parse(historyDataRaw);
    } catch (e) {
      console.error("Error parsing KV JSON data:", e);
    }

    const hasGithubConfig = env.GITHUB_OWNER && env.GITHUB_REPO && env.GITHUB_PAT;

    return serveDashboardPage(latestData, historyData, lastUpdate, hasGithubConfig, env.GITHUB_OWNER, env.GITHUB_REPO);
  }
};

// --- Helper Functions ---

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach(cookie => {
    const parts = cookie.split("=");
    if (parts.length >= 2) {
      list[parts[0].trim()] = parts.slice(1).join("=").trim();
    }
  });
  return list;
}

async function generateSessionCookie(secret, maxAgeSeconds = 86400) {
  const expiry = Date.now() + maxAgeSeconds * 1000;
  const signatureInput = `${expiry}:${secret}`;
  const sig = await sha256(signatureInput);
  const cookieValue = `${expiry}_${sig}`;
  return `session=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

async function isAuthenticated(request, secret) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return false;
  
  const cookies = parseCookies(cookieHeader);
  const session = cookies["session"];
  if (!session) return false;
  
  const parts = session.split("_");
  if (parts.length !== 2) return false;
  
  const [expiryStr, sig] = parts;
  const expiry = parseInt(expiryStr, 10);
  if (isNaN(expiry) || expiry < Date.now()) {
    return false; // Expired or invalid
  }
  
  const signatureInput = `${expiry}:${secret}`;
  const expectedSig = await sha256(signatureInput);
  return sig === expectedSig;
}

// --- HTML Templates ---

function getCommonHead(title) {
  return `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
      :root {
        --bg-main: #0b0f19;
        --bg-card: rgba(22, 28, 45, 0.7);
        --bg-input: #111827;
        --border-color: rgba(255, 255, 255, 0.08);
        --text-primary: #f3f4f6;
        --text-secondary: #9ca3af;
        --color-primary: #6366f1;
        --color-primary-hover: #4f46e5;
        --color-success: #10b981;
        --color-error: #ef4444;
        --color-warning: #f59e0b;
        --glow-green: rgba(16, 185, 129, 0.15);
        --glow-red: rgba(239, 68, 68, 0.15);
        --glow-primary: rgba(99, 102, 241, 0.15);
      }

      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      body {
        font-family: 'Plus Jakarta Sans', sans-serif;
        background-color: var(--bg-main);
        color: var(--text-primary);
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        overflow-x: hidden;
        position: relative;
      }

      /* Premium Background Gradients */
      body::before {
        content: "";
        position: absolute;
        top: -10%;
        left: -10%;
        width: 40%;
        height: 40%;
        background: radial-gradient(circle, rgba(99, 102, 241, 0.15) 0%, transparent 70%);
        z-index: -1;
        pointer-events: none;
      }

      body::after {
        content: "";
        position: absolute;
        bottom: -10%;
        right: -10%;
        width: 50%;
        height: 50%;
        background: radial-gradient(circle, rgba(16, 185, 129, 0.08) 0%, transparent 70%);
        z-index: -1;
        pointer-events: none;
      }

      .glass-card {
        background: var(--bg-card);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid var(--border-color);
        border-radius: 16px;
        box-shadow: 0 10px 30px -5px rgba(0, 0, 0, 0.3);
      }
    </style>
  `;
}

function serveLoginPage(errorMessage = "", statusCode = 200) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  ${getCommonHead("Dashboard - Sign In")}
  <style>
    .login-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .login-card {
      width: 100%;
      max-width: 400px;
      padding: 40px 32px;
      text-align: center;
      animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .logo-area {
      display: flex;
      justify-content: center;
      align-items: center;
      margin-bottom: 32px;
    }

    .logo-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, var(--color-primary) 0%, #a855f7 100%);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 20px -4px rgba(99, 102, 241, 0.4);
      margin-right: 12px;
    }

    .logo-icon svg {
      width: 24px;
      height: 24px;
      fill: none;
      stroke: white;
      stroke-width: 2;
    }

    .logo-text {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(to right, #ffffff, #9ca3af);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    h2 {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #fff;
    }

    p.subtitle {
      font-size: 14px;
      color: var(--text-secondary);
      margin-bottom: 24px;
    }

    .form-group {
      margin-bottom: 20px;
      text-align: left;
    }

    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .input-wrapper {
      position: relative;
    }

    input[type="password"] {
      width: 100%;
      padding: 14px 16px 14px 44px;
      background-color: var(--bg-input);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      color: #fff;
      font-family: inherit;
      font-size: 15px;
      transition: all 0.2s;
    }

    input[type="password"]:focus {
      outline: none;
      border-color: var(--color-primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }

    .input-icon {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-secondary);
    }

    .btn-submit {
      width: 100%;
      padding: 14px;
      background: linear-gradient(to right, var(--color-primary), var(--color-primary-hover));
      border: none;
      border-radius: 8px;
      color: white;
      font-family: inherit;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2);
    }

    .btn-submit:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.35);
    }

    .btn-submit:active {
      transform: translateY(1px);
    }

    .error-banner {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-radius: 8px;
      padding: 12px;
      font-size: 14px;
      color: var(--color-error);
      margin-bottom: 20px;
      text-align: left;
      display: flex;
      align-items: center;
      animation: shake 0.3s;
    }

    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-4px); }
      75% { transform: translateX(4px); }
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-card glass-card">
      <div class="logo-area">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <span class="logo-text">Admin Console</span>
      </div>
      
      <h2>Access Required</h2>
      <p class="subtitle">Enter password to decrypt and view system logs.</p>
      
      ${errorMessage ? `
      <div class="error-banner">
        <svg style="width:18px;height:18px;margin-right:8px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        ${errorMessage}
      </div>` : ""}

      <form action="/login" method="POST">
        <div class="form-group">
          <label for="password">Security Password</label>
          <div class="input-wrapper">
            <svg class="input-icon" style="width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <input type="password" id="password" name="password" placeholder="••••••••••••" required autofocus>
          </div>
        </div>
        
        <button type="submit" class="btn-submit">Decrypt Console</button>
      </form>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function serveErrorPage(message) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  ${getCommonHead("Configuration Error")}
  <style>
    .error-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .error-card {
      width: 100%;
      max-width: 500px;
      padding: 40px;
      border-color: rgba(239, 68, 68, 0.2);
    }
    h1 {
      color: var(--color-error);
      font-size: 24px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
    }
    p {
      color: var(--text-secondary);
      line-height: 1.6;
      margin-bottom: 24px;
      font-size: 15px;
    }
    .code-box {
      background: #090d16;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      font-family: monospace;
      font-size: 13px;
      color: #fb7185;
      overflow-x: auto;
      margin-bottom: 24px;
    }
  </style>
</head>
<body>
  <div class="error-container">
    <div class="error-card glass-card">
      <h1>
        <svg style="width:28px;height:28px;margin-right:12px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        Deployment Error
      </h1>
      <p>A configuration error is preventing this dashboard from rendering properly. Please review the error detail below:</p>
      <div class="code-box">${message}</div>
      <p style="font-size: 13px;">Hint: Ensure KV Bindings are configured inside wrangler.toml and deployed to Cloudflare.</p>
    </div>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 500,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function serveDashboardPage(latest, history, lastUpdate, hasGithub, ghOwner, ghRepo) {
  const statusColor = (latest && latest.status === "success") ? "var(--color-success)" : "var(--color-error)";
  const statusGlow = (latest && latest.status === "success") ? "var(--glow-green)" : "var(--glow-red)";
  const statusName = (latest && latest.status === "success") ? "Healthy" : (latest ? "Unhealthy" : "No Data Yet");
  
  // Format dates nicely on client side, but give fallback for SSR
  const formattedLastUpdate = lastUpdate ? new Date(lastUpdate).toLocaleString() : "Never";

  // Build History Rows
  let historyHtml = "";
  if (history && history.length > 0) {
    history.forEach((run, index) => {
      const isSuccess = run.status === "success";
      const badgeClass = isSuccess ? "badge-success" : "badge-error";
      const icon = isSuccess 
        ? `<svg style="width:16px;height:16px;color:var(--color-success);stroke:currentColor;fill:none;stroke-width:2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>`
        : `<svg style="width:16px;height:16px;color:var(--color-error);stroke:currentColor;fill:none;stroke-width:2.5" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      
      // Masking URL details if they aren't already
      const targetUrlMasked = run.url_masked || "Hidden";
      const runTime = new Date(run.timestamp).toLocaleString();

      historyHtml += `
        <tr class="history-row">
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              ${icon}
              <span class="badge ${badgeClass}">${run.status}</span>
            </div>
          </td>
          <td class="font-mono" style="font-size: 13px; color: var(--text-primary);">${targetUrlMasked}</td>
          <td>${runTime}</td>
          <td class="font-mono">${run.response_time_ms} ms</td>
          <td class="font-mono">${run.metrics?.status_code || "N/A"}</td>
          <td>
            <button class="btn-detail" onclick="showRunDetails(${index})">View Details</button>
          </td>
        </tr>
      `;
    });
  } else {
    historyHtml = `
      <tr>
        <td colspan="6" style="text-align:center;padding:40px;color:var(--text-secondary)">
          No history logged in Cloudflare KV. Trigger a workflow execution to begin.
        </td>
      </tr>
    `;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  ${getCommonHead("Admin Console - Status Dashboard")}
  <style>
    header {
      background: rgba(11, 15, 25, 0.7);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-color);
      position: sticky;
      top: 0;
      z-index: 100;
      padding: 16px 24px;
    }

    .nav-container {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .brand-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, var(--color-primary) 0%, #a855f7 100%);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .brand-icon svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: white;
      stroke-width: 2;
    }

    .brand-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.3px;
    }

    .nav-actions {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .btn-secondary {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 8px 16px;
      border-radius: 8px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .btn-primary {
      background: var(--color-primary);
      color: white;
      border: none;
      padding: 9px 18px;
      border-radius: 8px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.25);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .btn-primary:hover {
      background: var(--color-primary-hover);
      box-shadow: 0 6px 16px rgba(99, 102, 241, 0.35);
      transform: translateY(-1px);
    }

    .btn-primary:active {
      transform: translateY(1px);
    }

    main {
      flex: 1;
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
      padding: 32px 24px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 24px;
    }

    /* Grid Layouts */
    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 24px;
    }

    /* Status Card Custom styles */
    .status-overview-card {
      padding: 24px;
      display: flex;
      align-items: center;
      gap: 24px;
      position: relative;
      overflow: hidden;
    }

    .status-overview-card::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      width: 6px;
      height: 100%;
      background-color: ${statusColor};
    }

    .pulse-indicator {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: ${statusGlow};
      display: flex;
      align-items: center;
      justify-content: center;
      animation: pulse-animation 2s infinite;
    }

    .pulse-dot {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: ${statusColor};
    }

    @keyframes pulse-animation {
      0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 ${statusGlow}; }
      50% { transform: scale(1.1); box-shadow: 0 0 16px 8px ${statusGlow}; }
    }

    .status-info h3 {
      font-size: 14px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .status-info .status-val {
      font-size: 24px;
      font-weight: 800;
      color: #fff;
    }

    .status-info .last-updated {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 4px;
    }

    /* Metrics Mini Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }

    .metric-card {
      padding: 16px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .metric-label {
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 8px;
      font-weight: 500;
    }

    .metric-value {
      font-size: 18px;
      font-weight: 700;
      color: #fff;
    }

    /* Info Banner */
    .info-banner-card {
      padding: 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .info-content {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .info-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: var(--glow-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--color-primary);
    }

    /* History Table Styles */
    .history-card {
      padding: 28px 24px;
    }

    .history-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .history-title {
      font-size: 18px;
      font-weight: 700;
    }

    .table-container {
      width: 100%;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }

    th {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border-color);
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    td {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      font-size: 14px;
      color: var(--text-secondary);
    }

    tr.history-row:hover {
      background-color: rgba(255, 255, 255, 0.015);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .badge-success {
      background: rgba(16, 185, 129, 0.1);
      color: var(--color-success);
      border: 1px solid rgba(16, 185, 129, 0.2);
    }

    .badge-error {
      background: rgba(239, 68, 68, 0.1);
      color: var(--color-error);
      border: 1px solid rgba(239, 68, 68, 0.2);
    }

    .font-mono {
      font-family: monospace;
    }

    .btn-detail {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: all 0.2s;
    }

    .btn-detail:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
    }

    /* Modal Styles */
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(8px);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .modal-content {
      width: 100%;
      max-width: 600px;
      padding: 32px;
      animation: modalFadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes modalFadeIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .modal-title {
      font-size: 20px;
      font-weight: 700;
    }

    .btn-close {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 24px;
      cursor: pointer;
    }

    .btn-close:hover {
      color: #fff;
    }

    .json-box {
      background: #090d16;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 20px;
      font-family: monospace;
      font-size: 13px;
      color: #38bdf8;
      overflow-x: auto;
      max-height: 400px;
      white-space: pre-wrap;
    }

    /* Toast Notification */
    .toast {
      visibility: hidden;
      min-width: 280px;
      background: #1e293b;
      color: #fff;
      text-align: center;
      border-radius: 8px;
      padding: 16px;
      position: fixed;
      z-index: 2000;
      right: 24px;
      bottom: 24px;
      border: 1px solid var(--color-primary);
      box-shadow: 0 10px 30px rgba(99, 102, 241, 0.25);
      opacity: 0;
      transition: opacity 0.3s, visibility 0.3s, transform 0.3s;
      transform: translateY(20px);
    }

    .toast.show {
      visibility: visible;
      opacity: 1;
      transform: translateY(0);
    }

    /* Mobile Responsive design */
    @media (max-width: 768px) {
      .dashboard-grid {
        grid-template-columns: 1fr;
      }
      .metrics-grid {
        grid-template-columns: 1fr;
      }
      .info-banner-card {
        flex-direction: column;
        align-items: flex-start;
      }
      .btn-primary {
        width: 100%;
        justify-content: center;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="nav-container">
      <div class="brand">
        <div class="brand-icon">
          <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <span class="brand-title">Admin Console</span>
      </div>
      <div class="nav-actions">
        <a href="/calculator" class="btn-primary" style="text-decoration: none; display: inline-flex; align-items: center; gap: 8px; width: auto; background: linear-gradient(135deg, var(--color-primary) 0%, #a855f7 100%);">
          <svg style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>
          </svg>
          Open Calculator Page
        </a>
        <a href="/logout" class="btn-secondary" style="text-decoration: none; display: inline-flex; align-items: center; gap: 8px;">
          <svg style="width:16px;height:16px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          Logout
        </a>
      </div>
    </div>
  </header>

  <main>
    <div class="dashboard-grid">
      <!-- Status Overview -->
      <div class="status-overview-card glass-card">
        <div class="pulse-indicator">
          <div class="pulse-dot"></div>
        </div>
        <div class="status-info">
          <h3>Sync Monitor Status</h3>
          <div class="status-val">${statusName}</div>
          <div class="last-updated">Last Run Check: <span id="sync-time">${formattedLastUpdate}</span></div>
        </div>
      </div>

      <!-- Quick Metrics -->
      <div class="glass-card" style="padding: 24px; display: flex; flex-direction: column; justify-content: center;">
        <div class="metrics-grid">
          <div class="metric-card">
            <span class="metric-label">Latency</span>
            <span class="metric-value font-mono">${latest ? latest.response_time_ms + " ms" : "N/A"}</span>
          </div>
          <div class="metric-card">
            <span class="metric-label">HTTP Code</span>
            <span class="metric-value font-mono">${latest?.metrics?.status_code || "N/A"}</span>
          </div>
          <div class="metric-card">
            <span class="metric-label">Body Size</span>
            <span class="metric-value font-mono">${latest?.metrics?.content_length !== undefined ? latest.metrics.content_length + " B" : "N/A"}</span>
          </div>
        </div>
      </div>
      
      <!-- Secure Cloud Calculator (GitHub Actions Brain) -->
      <div class="glass-card" style="padding: 24px; display: flex; flex-direction: column; gap: 16px;">
        <h3 style="font-size: 15px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px;">
          <svg style="width:18px;height:18px;color:var(--color-primary);stroke:currentColor;fill:none;stroke-width:2" viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>
          </svg>
          GitHub Actions Calculator (The Brain)
        </h3>
        
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <input type="text" id="calc-expression" placeholder="เช่น 12 * (34 - 5) + 6" style="width: 100%; padding: 12px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 8px; color: #fff; font-family: monospace; font-size: 15px; outline: none; transition: border-color 0.2s;" onfocus="this.style.borderColor='var(--color-primary)'" onblur="this.style.borderColor='var(--border-color)'">
          
          <button class="btn-primary" id="btn-calculate" onclick="requestCalculation()" style="width: 100%; padding: 12px; display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 700;">
            <svg style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Compute on GitHub Actions
          </button>
        </div>

        <div id="calc-status-area" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; font-size: 13px; line-height: 1.6; display: none;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: var(--text-secondary);">สถานะประมวลผล:</span>
            <span id="calc-status-badge" style="font-weight: 700; color: var(--color-warning);">Idle</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: var(--text-secondary);">สูตรคำนวณล่าสุด:</span>
            <span id="calc-expr-display" style="font-family: monospace; font-weight: 600; color: #fff;">-</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: var(--text-secondary);">ผลลัพธ์คำนวณ:</span>
            <span id="calc-result-display" style="font-family: monospace; font-weight: 700; color: var(--color-success); font-size: 15px;">-</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--text-secondary);">เวลาประมวลผล (Actions):</span>
            <span id="calc-time-display" style="font-family: monospace; font-weight: 600; color: #fff;">-</span>
          </div>
        </div>
      </div>
    </div>

    <!-- GitHub Trigger Section -->
    <div class="info-banner-card glass-card">
      <div class="info-content">
        <div class="info-icon">
          <svg style="width:20px;height:20px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </div>
        <div>
          <h4 style="font-size: 15px; font-weight: 600; margin-bottom: 2px;">Sync Schedule Details</h4>
          <p style="font-size: 13px; color: var(--text-secondary);">
            Jobs run automatically on schedule via public GitHub Actions. 
            ${hasGithub ? `Configured repository: <span class="font-mono" style="color:var(--color-primary);font-weight:600;">${ghOwner}/${ghRepo}</span>.` : "Setup GITHUB secrets to trigger runs manually from this console."}
          </p>
        </div>
      </div>
      
      ${hasGithub ? `
      <button class="btn-primary" id="btn-trigger" onclick="triggerGithubWorkflow()">
        <svg style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        Trigger Sync Now
      </button>` : ""}
    </div>

    <!-- Execution Logs History -->
    <div class="history-card glass-card">
      <div class="history-header">
        <span class="history-title">Recent Synchronizations</span>
        <span style="font-size: 13px; color: var(--text-secondary); font-weight: 500;">Showing last 50 events</span>
      </div>
      
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Endpoint Domain</th>
              <th>Execution Timestamp</th>
              <th>Response Time</th>
              <th>HTTP Code</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${historyHtml}
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <!-- Details Modal -->
  <div class="modal" id="details-modal">
    <div class="modal-content glass-card">
      <div class="modal-header">
        <div class="modal-title">Sync Details</div>
        <button class="btn-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="json-box" id="modal-json"></div>
    </div>
  </div>

  <!-- Toast Element -->
  <div id="toast" class="toast">Job successfully triggered!</div>

  <script>
    // Embed parsed history data from worker directly for easy detail browsing
    const runHistory = ${JSON.stringify(history)};

    function showRunDetails(index) {
      const run = runHistory[index];
      if (!run) return;
      
      const modal = document.getElementById("details-modal");
      const jsonBox = document.getElementById("modal-json");
      
      jsonBox.textContent = JSON.stringify(run, null, 2);
      modal.style.display = "flex";
    }

    function closeModal() {
      document.getElementById("details-modal").style.display = "none";
    }

    // Close modal if user clicks outside of modal-content
    window.onclick = function(event) {
      const modal = document.getElementById("details-modal");
      if (event.target === modal) {
        closeModal();
      }
    }

    function showToast(message, isError = false) {
      const toast = document.getElementById("toast");
      toast.textContent = message;
      if (isError) {
        toast.style.borderColor = "var(--color-error)";
        toast.style.boxShadow = "0 10px 30px rgba(239, 68, 68, 0.25)";
      } else {
        toast.style.borderColor = "var(--color-primary)";
        toast.style.boxShadow = "0 10px 30px rgba(99, 102, 241, 0.25)";
      }
      toast.className = "toast show";
      setTimeout(function(){ 
        toast.className = toast.className.replace("toast show", "toast"); 
      }, 4000);
    }

    async function triggerGithubWorkflow() {
      const btn = document.getElementById("btn-trigger");
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.style.opacity = "0.7";
      btn.innerHTML = "Triggering...";

      try {
        const res = await fetch("/api/trigger", { method: "POST" });
        const data = await res.json();
        
        if (res.ok && data.success) {
          showToast(data.message || "Execution dispatched successfully!");
        } else {
          showToast(data.error || "Failed to trigger execution.", true);
        }
      } catch (err) {
        showToast("Error sending request: " + err.message, true);
      } finally {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.innerHTML = originalText;
      }
    }

    let pollInterval = null;

    async function requestCalculation() {
      const exprInput = document.getElementById("calc-expression");
      const btn = document.getElementById("btn-calculate");
      const statusArea = document.getElementById("calc-status-area");
      const statusBadge = document.getElementById("calc-status-badge");
      const exprDisplay = document.getElementById("calc-expr-display");
      const resultDisplay = document.getElementById("calc-result-display");
      const timeDisplay = document.getElementById("calc-time-display");

      const expression = exprInput.value.trim();
      if (!expression) {
        showToast("กรุณากรอกสูตรคำนวณ", true);
        return;
      }

      btn.disabled = true;
      btn.innerHTML = "Queuing to GitHub...";
      btn.style.opacity = "0.7";

      try {
        const res = await fetch("/api/calculate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expression: expression })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          showToast(data.message || "ส่งคำขอสำเร็จ!");
          statusArea.style.display = "block";
          statusBadge.textContent = "QUEUED (Running GitHub Actions...)";
          statusBadge.style.color = "var(--color-warning)";
          exprDisplay.textContent = expression;
          resultDisplay.textContent = "กำลังคำนวณ...";
          timeDisplay.textContent = "กำลังดึงเวลา...";
          
          startPollingStatus();
        } else {
          showToast(data.error || "เกิดข้อผิดพลาดในการส่งคำขอ", true);
          btn.disabled = false;
          btn.style.opacity = "1";
          btn.innerHTML = '<svg style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> Compute on GitHub Actions';
        }
      } catch (err) {
        showToast("เกิดข้อผิดพลาด: " + err.message, true);
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.innerHTML = '<svg style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> Compute on GitHub Actions';
      }
    }

    function startPollingStatus() {
      if (pollInterval) clearInterval(pollInterval);
      
      pollInterval = setInterval(async () => {
        try {
          const res = await fetch("/api/status");
          const data = await res.json();

          if (res.ok && data.request) {
            const req = data.request;
            const statusBadge = document.getElementById("calc-status-badge");
            const resultDisplay = document.getElementById("calc-result-display");
            const timeDisplay = document.getElementById("calc-time-display");
            const btn = document.getElementById("btn-calculate");

            if (req.status === "completed") {
              clearInterval(pollInterval);
              statusBadge.textContent = "COMPLETED";
              statusBadge.style.color = "var(--color-success)";
              
              if (data.result) {
                resultDisplay.textContent = data.result.result;
                timeDisplay.textContent = data.result.thai_time;
              }
              
              btn.disabled = false;
              btn.style.opacity = "1";
              btn.innerHTML = '<svg style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> Compute on GitHub Actions';
              showToast("คำนวณสำเร็จโดย GitHub Actions!");
            } else if (req.status === "error") {
              clearInterval(pollInterval);
              statusBadge.textContent = "ERROR";
              statusBadge.style.color = "var(--color-error)";
              resultDisplay.textContent = req.error || "เกิดข้อผิดพลาดในการคำนวณ";
              
              btn.disabled = false;
              btn.style.opacity = "1";
              btn.innerHTML = '<svg style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> Compute on GitHub Actions';
              showToast("การคำนวณล้มเหลว", true);
            }
          }
        } catch (e) {
          console.error("Error polling status:", e);
        }
      }, 3000);
    }
    
    async function checkInitialStatus() {
      try {
        const res = await fetch("/api/status");
        const data = await res.json();
        if (res.ok && data.request) {
          const req = data.request;
          const statusArea = document.getElementById("calc-status-area");
          const statusBadge = document.getElementById("calc-status-badge");
          const exprDisplay = document.getElementById("calc-expr-display");
          const resultDisplay = document.getElementById("calc-result-display");
          const timeDisplay = document.getElementById("calc-time-display");

          statusArea.style.display = "block";
          exprDisplay.textContent = req.expression;

          if (req.status === "pending") {
            statusBadge.textContent = "QUEUED (Running GitHub Actions...)";
            statusBadge.style.color = "var(--color-warning)";
            resultDisplay.textContent = "กำลังคำนวณ...";
            timeDisplay.textContent = "กำลังดึงเวลา...";
            document.getElementById("btn-calculate").disabled = true;
            document.getElementById("btn-calculate").style.opacity = "0.7";
            document.getElementById("btn-calculate").innerHTML = "Queuing to GitHub...";
            startPollingStatus();
          } else if (req.status === "completed" && data.result) {
            statusBadge.textContent = "COMPLETED";
            statusBadge.style.color = "var(--color-success)";
            resultDisplay.textContent = data.result.result;
            timeDisplay.textContent = data.result.thai_time;
          } else if (req.status === "error") {
            statusBadge.textContent = "ERROR";
            statusBadge.style.color = "var(--color-error)";
            resultDisplay.textContent = req.error || "คำนวณล้มเหลว";
          }
        }
      } catch (e) {
        console.error("Error checking initial status:", e);
      }
    }
    window.addEventListener("load", checkInitialStatus);
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
