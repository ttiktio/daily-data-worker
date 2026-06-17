import os
import sys
import time
import json
from datetime import datetime, timezone, timedelta
import urllib.parse
import requests
from utils import logger, CloudflareKVClient

def mask_url(url: str) -> str:
    """
    Masks sensitive parts of a URL for safe logging.
    """
    if not url:
        return "None"
    try:
        parsed = urllib.parse.urlparse(url)
        return f"{parsed.scheme}://{parsed.netloc}/..."
    except Exception:
        return "***"

def generate_calculator_html(thai_time_str, calc_val_a, calc_val_b, calc_result):
    return f"""<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Secure Calculator - Sent by GitHub Actions</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {{
            --bg-main: #0b0f19;
            --bg-card: rgba(22, 28, 45, 0.7);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-primary: #f3f4f6;
            --text-secondary: #9ca3af;
            --color-primary: #6366f1;
            --color-success: #10b981;
        }}
        * {{
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Plus Jakarta Sans', sans-serif;
        }}
        body {{
            background-color: var(--bg-main);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 20px;
            background: radial-gradient(circle at top right, rgba(99, 102, 241, 0.1), transparent 50%),
                        radial-gradient(circle at bottom left, rgba(16, 185, 129, 0.05), transparent 50%);
        }}
        .glass-card {{
            background: var(--bg-card);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 30px;
            width: 100%;
            max-width: 420px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
            text-align: center;
        }}
        h2 {{
            font-size: 20px;
            margin-bottom: 15px;
            color: #fff;
            font-weight: 700;
        }}
        .meta-info {{
            font-size: 13px;
            color: var(--text-secondary);
            margin-bottom: 20px;
            text-align: left;
            background: rgba(0, 0, 0, 0.2);
            padding: 12px;
            border-radius: 8px;
            border: 1px solid var(--border-color);
            line-height: 1.6;
        }}
        .meta-val {{
            font-weight: 600;
            color: var(--color-success);
            font-family: monospace;
        }}
        .calculator {{
            display: flex;
            flex-direction: column;
            gap: 12px;
        }}
        .calc-screen {{
            width: 100%;
            height: 60px;
            background-color: #090d16;
            border: 1px solid var(--border-color);
            border-radius: 8px;
            color: #fff;
            font-size: 24px;
            text-align: right;
            padding: 15px;
            font-family: monospace;
            outline: none;
        }}
        .calc-grid {{
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
        }}
        button {{
            padding: 14px;
            font-size: 18px;
            font-weight: 600;
            border-radius: 8px;
            border: 1px solid var(--border-color);
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
            cursor: pointer;
            transition: all 0.2s;
        }}
        button:hover {{
            background: rgba(255, 255, 255, 0.15);
        }}
        button.operator {{
            background: rgba(99, 102, 241, 0.15);
            color: #818cf8;
            border-color: rgba(99, 102, 241, 0.25);
        }}
        button.operator:hover {{
            background: rgba(99, 102, 241, 0.3);
        }}
        button.equal {{
            background: var(--color-success);
            color: #fff;
            grid-column: span 2;
        }}
        button.equal:hover {{
            background: #059669;
        }}
        button.clear {{
            background: rgba(239, 68, 68, 0.15);
            color: #f87171;
            border-color: rgba(239, 68, 68, 0.25);
        }}
        button.clear:hover {{
            background: rgba(239, 68, 68, 0.3);
        }}
        .back-link {{
            color: var(--text-secondary);
            text-decoration: none;
            font-size: 14px;
            margin-top: 15px;
            display: inline-block;
            transition: color 0.2s;
        }}
        .back-link:hover {{
            color: #fff;
        }}
    </style>
</head>
<body>
    <div class="glass-card">
        <h2>🧮 เครื่องคิดเลขระบบปิด (Secure Calculator)</h2>
        <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 15px;">
            หน้านี้สร้างและส่งมาอย่างปลอดภัยโดย GitHub Actions ผ่าน Cloudflare KV
        </p>

        <div class="meta-info">
            📌 <b>เวลาประมวลผลบน GitHub Actions:</b><br>
            <span class="meta-val">{thai_time_str}</span><br>
            📌 <b>ทดสอบคำนวณจาก Actions ({calc_val_a} × {calc_val_b}):</b><br>
            <span class="meta-val">{calc_result}</span><br>
            📌 <b>เวลาบนเบราว์เซอร์ปัจจุบัน (เรียลไทม์):</b><br>
            <span id="live-time" class="meta-val">กำลังโหลด...</span>
        </div>

        <div class="calculator">
            <input type="text" id="screen" class="calc-screen" readonly value="0">
            <div class="calc-grid">
                <button class="clear" onclick="clearScreen()">C</button>
                <button class="operator" onclick="press('/')">÷</button>
                <button class="operator" onclick="press('*')">×</button>
                <button class="operator" onclick="press('-')">-</button>
                
                <button onclick="press('7')">7</button>
                <button onclick="press('8')">8</button>
                <button onclick="press('9')">9</button>
                <button class="operator" onclick="press('+')">+</button>
                
                <button onclick="press('4')">4</button>
                <button onclick="press('5')">5</button>
                <button onclick="press('6')">6</button>
                <button class="equal" onclick="calculate()">=</button>
                
                <button onclick="press('1')">1</button>
                <button onclick="press('2')">2</button>
                <button onclick="press('3')">3</button>
                <button onclick="press('0')">0</button>
            </div>
        </div>
        
        <a href="/" class="back-link">← กลับไปหน้าหลัก Dashboard</a>
    </div>

    <script>
        // Real-time Browser Time
        function updateLiveTime() {{
            const now = new Date();
            document.getElementById('live-time').textContent = now.toLocaleString('th-TH');
        }}
        setInterval(updateLiveTime, 1000);
        updateLiveTime();

        // Calculator Logic
        const screen = document.getElementById('screen');
        let currentInput = '';

        function press(val) {{
            if (screen.value === '0' && !isNaN(val)) {{
                currentInput = val;
            }} else {{
                currentInput += val;
            }}
            screen.value = currentInput;
        }}

        function clearScreen() {{
            currentInput = '';
            screen.value = '0';
        }}

        function calculate() {{
            try {{
                const result = eval(currentInput);
                screen.value = result;
                currentInput = String(result);
            }} catch (e) {{
                screen.value = 'Error';
                currentInput = '';
            }}
        }}
    </script>
</body>
</html>"""

def run_job_iteration(kv_client, target_url, target_config):
    """
    Performs one iteration of the data sync job.
    """
    logger.info("Executing job iteration...")
    
    status = "success"
    message = "Data sync iteration completed successfully."
    response_code = None
    content_length = 0
    duration_ms = 0
    extracted_data = {}
    
    headers = {
        "User-Agent": target_config.get("user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    }
    
    start_time_perf = time.perf_counter()
    try:
        logger.info(f"Sending request to target: {mask_url(target_url)}")
        response = requests.get(target_url, headers=headers, timeout=30)
        response_code = response.status_code
        content_length = len(response.content)
        duration_ms = int((time.perf_counter() - start_time_perf) * 1000)
        
        logger.info(f"Received response: Status {response_code}, Size {content_length} bytes in {duration_ms}ms")
        
        # Simulated news severity for testing
        import random
        severity_levels = ["Low", "Medium", "High", "Critical"]
        news_severity = random.choice(severity_levels)
        
        extracted_data = {
            "server": response.headers.get("Server", "Unknown"),
            "content_type": response.headers.get("Content-Type", "Unknown"),
            "news_severity": news_severity
        }
        
        if response_code >= 400:
            status = "error"
            message = f"Target returned error status code: {response_code}"
            
    except Exception as e:
        duration_ms = int((time.perf_counter() - start_time_perf) * 1000)
        status = "error"
        message = f"Failed to fetch target URL: {str(e)}"
        logger.error(message)

    timestamp_iso = datetime.now(timezone.utc).isoformat()
    
    report = {
        "timestamp": timestamp_iso,
        "status": status,
        "url_masked": mask_url(target_url),
        "response_time_ms": duration_ms,
        "metrics": {
            "status_code": response_code,
            "content_length": content_length,
            "extracted": extracted_data
        },
        "message": message
    }
    
    # Upload latest iteration data
    kv_client.set_value("latest_data", report)

    # Generate and Upload Calculator Page with Live Thai Time
    thai_time_str = "Unknown"
    try:
        time_res = requests.get("http://worldtimeapi.org/api/timezone/Asia/Bangkok", timeout=5)
        if time_res.status_code == 200:
            time_data = time_res.json()
            dt = datetime.fromisoformat(time_data.get("datetime"))
            thai_time_str = dt.strftime("%Y-%m-%d %H:%M:%S") + " (Bangkok)"
    except Exception:
        utc_now = datetime.now(timezone.utc)
        thai_now = utc_now + timedelta(hours=7)
        thai_time_str = thai_now.strftime("%Y-%m-%d %H:%M:%S") + " (Local +7 Fallback)"

    calc_val_a = 15
    calc_val_b = 27
    calc_result = calc_val_a * calc_val_b
    calculator_html = generate_calculator_html(thai_time_str, calc_val_a, calc_val_b, calc_result)
    kv_client.set_value("calculator_page", calculator_html)
    
    # Update history
    history_raw = kv_client.get_value("history_data")
    history = []
    if history_raw:
        try:
            history = json.loads(history_raw)
            if not isinstance(history, list): history = []
        except Exception: history = []
            
    history.insert(0, report)
    history = history[:50]
    
    kv_client.set_value("history_data", history)
    kv_client.set_value("last_update", timestamp_iso)
    
    logger.info("Iteration complete and results uploaded.")
    return status

def main():
    logger.info("Starting Persistent Data Worker (1 Hour Runtime)...")
    
    target_url = os.getenv("TARGET_URL")
    target_config_raw = os.getenv("TARGET_CONFIG", "{}")
    cf_api_token = os.getenv("CLOUDFLARE_API_TOKEN")
    cf_account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID")
    cf_kv_namespace_id = os.getenv("CLOUDFLARE_KV_NAMESPACE_ID")
    
    if not cf_api_token or not cf_account_id or not cf_kv_namespace_id:
        logger.error("Missing Cloudflare Configuration.")
        sys.exit(1)
        
    if not target_url:
        target_url = "https://httpbin.org/status/200"
        
    kv_client = CloudflareKVClient(cf_account_id, cf_api_token, cf_kv_namespace_id)

    # Check for pending calculation request
    calc_req_raw = kv_client.get_value("calc_request")
    if calc_req_raw:
        try:
            calc_req = json.loads(calc_req_raw)
            if isinstance(calc_req, dict) and calc_req.get("status") == "pending":
                logger.info(f"Found pending calculation request: {calc_req.get('expression')}")
                expression = calc_req.get("expression")
                
                # Validate expression pattern
                import re
                clean_expr = expression.strip()
                if not re.match(r'^[0-9+\-*/().\s]+$', clean_expr):
                    raise ValueError("Invalid math expression. Only digits and basic operators (+,-,*,/,parentheses) allowed.")
                
                # Perform calculation
                result = eval(clean_expr, {"__builtins__": None}, {})
                
                # Fetch Thai Time
                thai_time_str = "Unknown"
                timestamp_iso = datetime.now(timezone.utc).isoformat()
                try:
                    time_res = requests.get("http://worldtimeapi.org/api/timezone/Asia/Bangkok", timeout=5)
                    if time_res.status_code == 200:
                        time_data = time_res.json()
                        dt = datetime.fromisoformat(time_data.get("datetime"))
                        thai_time_str = dt.strftime("%Y-%m-%d %H:%M:%S") + " (Bangkok)"
                except Exception as e:
                    logger.warning(f"Could not fetch Thai time: {e}")
                    utc_now = datetime.now(timezone.utc)
                    thai_now = utc_now + timedelta(hours=7)
                    thai_time_str = thai_now.strftime("%Y-%m-%d %H:%M:%S") + " (Local +7 Fallback)"

                # Save calculation result
                calc_result = {
                    "expression": expression,
                    "result": str(result),
                    "thai_time": thai_time_str,
                    "calculated_at": timestamp_iso
                }
                kv_client.set_value("calc_result", calc_result)
                
                # Update request status to completed
                calc_req["status"] = "completed"
                kv_client.set_value("calc_request", calc_req)
                logger.info(f"Successfully calculated: {expression} = {result}. Results updated.")
                
                # Also save to generic history log
                report = {
                    "timestamp": timestamp_iso,
                    "status": "success",
                    "url_masked": "Math Calculation",
                    "response_time_ms": 0,
                    "metrics": {
                        "status_code": 200,
                        "content_length": 0,
                        "extracted": {"calculation": calc_result}
                    },
                    "message": f"Calculated: {expression} = {result}"
                }
                kv_client.set_value("latest_data", report)
                
                # Update history list
                history_raw = kv_client.get_value("history_data")
                history = []
                if history_raw:
                    try:
                        history = json.loads(history_raw)
                        if not isinstance(history, list): history = []
                    except Exception: history = []
                history.insert(0, report)
                history = history[:50]
                kv_client.set_value("history_data", history)
                kv_client.set_value("last_update", timestamp_iso)
                
                logger.info("Calculation request processing finished. Exiting.")
                sys.exit(0)
        except Exception as e:
            logger.error(f"Calculation failed: {e}")
            try:
                calc_req["status"] = "error"
                calc_req["error"] = str(e)
                kv_client.set_value("calc_request", calc_req)
            except Exception:
                pass
            sys.exit(1)
    
    try:
        target_config = json.loads(target_config_raw)
    except Exception:
        target_config = {}

    # Set default interval to 120 seconds (2 minutes)
    interval_seconds = int(os.getenv("RUN_INTERVAL_SECONDS", "120"))
    
    # Set default runtime to 1 second as requested by the user
    duration_limit = timedelta(seconds=1)
    start_time = datetime.now(timezone.utc)
    end_time = start_time + duration_limit
    
    logger.info(f"Job will run until {end_time.isoformat()} (Duration: {duration_limit}, Interval: {interval_seconds}s)")

    # Fetch custom worker script once at startup to optimize KV read quota
    logger.info("Checking for custom worker script in KV at startup...")
    worker_script = None
    try:
        worker_script = kv_client.get_value("worker_script")
    except Exception as e:
        logger.error(f"Failed to fetch custom worker script from KV: {e}")

    iteration_count = 0
    while datetime.now(timezone.utc) < end_time:
        iteration_count += 1
        logger.info(f"--- Starting Iteration #{iteration_count} ---")
        
        if worker_script:
            logger.info("Found custom worker script. Executing dynamically...")
            try:
                local_scope = {}
                # Execute script in its own global scope
                exec(worker_script, local_scope)
                if "run" in local_scope:
                    local_scope["run"](kv_client, logger)
                    logger.info("Custom worker script executed successfully.")
                else:
                    logger.warning("Custom worker script does not contain a 'run(kv_client, logger)' entry point.")
            except Exception as e:
                logger.error(f"Error executing custom worker script: {e}")
        else:
            logger.info("No custom worker script found in KV. Running default status check iteration...")
            run_job_iteration(kv_client, target_url, target_config)
            
        remaining_time = end_time - datetime.now(timezone.utc)
        if remaining_time.total_seconds() <= 0:
            break
            
        sleep_time = min(interval_seconds, remaining_time.total_seconds())
        logger.info(f"Iteration #{iteration_count} finished. Sleeping for {int(sleep_time)} seconds.")
        time.sleep(sleep_time)

    logger.info(f"Persistent job completed after {iteration_count} iterations.")

if __name__ == "__main__":
    main()
