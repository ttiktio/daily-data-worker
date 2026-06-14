import os
import sys
import time
import json
from datetime import datetime, timezone
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

def main():
    logger.info("Starting Scheduled Data Worker job...")
    
    # 1. Load Configurations from environment variables (provided via GitHub Secrets)
    target_url = os.getenv("TARGET_URL")
    target_config_raw = os.getenv("TARGET_CONFIG", "{}")
    
    cf_api_token = os.getenv("CLOUDFLARE_API_TOKEN")
    cf_account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID")
    cf_kv_namespace_id = os.getenv("CLOUDFLARE_KV_NAMESPACE_ID")
    
    # Validation
    if not cf_api_token or not cf_account_id or not cf_kv_namespace_id:
        logger.error("Missing Cloudflare Configuration. Please ensure CLOUDFLARE_API_TOKEN, "
                     "CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_KV_NAMESPACE_ID are set.")
        sys.exit(1)
        
    if not target_url:
        logger.warning("TARGET_URL is not set. Using default test endpoint for execution.")
        target_url = "https://httpbin.org/status/200"
        
    # Initialize Cloudflare KV client
    kv_client = CloudflareKVClient(
        account_id=cf_account_id,
        api_token=cf_api_token,
        namespace_id=cf_kv_namespace_id
    )
    
    logger.info(f"Target URL: {mask_url(target_url)}")
    
    # Parse target configuration if present
    target_config = {}
    if target_config_raw:
        try:
            target_config = json.loads(target_config_raw)
            logger.info("Loaded custom configuration parameters.")
        except json.JSONDecodeError:
            logger.warning("TARGET_CONFIG is not a valid JSON. Treating as raw string.")
            target_config = {"raw_config": target_config_raw}

    # 2. Perform request / work (e.g., scrape, check status)
    status = "success"
    message = "Data sync completed successfully."
    response_code = None
    content_length = 0
    duration_ms = 0
    extracted_data = {}
    
    headers = {
        "User-Agent": target_config.get("user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    }
    
    start_time = time.perf_counter()
    try:
        logger.info("Sending request to target...")
        response = requests.get(target_url, headers=headers, timeout=30)
        response_code = response.status_code
        content_length = len(response.content)
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        
        logger.info(f"Received response: Status {response_code}, Size {content_length} bytes in {duration_ms}ms")
        
        # Simple simulation of data extraction based on target configuration
        # For demonstration: extract some headers or specific elements
        extracted_data = {
            "server": response.headers.get("Server", "Unknown"),
            "content_type": response.headers.get("Content-Type", "Unknown"),
        }
        
        # If response is JSON, parse and extract sample data securely
        if "application/json" in response.headers.get("Content-Type", ""):
            try:
                json_body = response.json()
                extracted_data["keys_found"] = list(json_body.keys())[:5]
            except Exception:
                pass
                
        if response_code >= 400:
            status = "error"
            message = f"Target returned error status code: {response_code}"
            
    except Exception as e:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        status = "error"
        message = f"Failed to fetch target URL: {str(e)}"
        logger.error(message)

    # 3. Compile report
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
    
    # 4. Upload to Cloudflare KV
    # Write latest run
    kv_client.set_value("latest_data", report)
    
    # Write to history logs (keep last 50 entries)
    history_raw = kv_client.get_value("history_data")
    history = []
    if history_raw:
        try:
            history = json.loads(history_raw)
            if not isinstance(history, list):
                history = []
        except Exception:
            logger.warning("Could not parse existing history data, resetting list.")
            history = []
            
    # Insert new report at index 0 and truncate
    history.insert(0, report)
    history = history[:50]
    
    kv_client.set_value("history_data", history)
    
    # Write last updated timestamp
    kv_client.set_value("last_update", timestamp_iso)
    
    logger.info("Job execution complete. Results uploaded successfully.")

if __name__ == "__main__":
    main()
