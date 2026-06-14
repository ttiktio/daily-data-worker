import os
import requests
import json
import logging

# Configure logger
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("DataWorker")

class CloudflareKVClient:
    """
    A simple client for interacting with Cloudflare KV namespace via REST API.
    """
    def __init__(self, account_id: str, api_token: str, namespace_id: str):
        self.account_id = account_id
        self.api_token = api_token
        self.namespace_id = namespace_id
        self.base_url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/storage/kv/namespaces/{namespace_id}"
        
    def get_value(self, key: str) -> str | None:
        """
        Retrieves the value for a given key from KV.
        """
        url = f"{self.base_url}/values/{key}"
        headers = {
            "Authorization": f"Bearer {self.api_token}"
        }
        try:
            logger.info(f"Fetching key '{key}' from Cloudflare KV...")
            res = requests.get(url, headers=headers, timeout=10)
            if res.status_code == 200:
                return res.text
            elif res.status_code == 404:
                logger.info(f"Key '{key}' not found in KV (404).")
                return None
            else:
                logger.error(f"Failed to fetch key '{key}' (HTTP {res.status_code}): {res.text}")
                return None
        except Exception as e:
            logger.error(f"Exception while fetching key '{key}' from KV: {e}")
            return None

    def set_value(self, key: str, value: str | dict | list) -> bool:
        """
        Sets the value for a given key in KV.
        """
        url = f"{self.base_url}/values/{key}"
        headers = {
            "Authorization": f"Bearer {self.api_token}"
        }
        
        if isinstance(value, (dict, list)):
            payload = json.dumps(value, ensure_ascii=False)
        else:
            payload = str(value)
            
        try:
            logger.info(f"Writing key '{key}' to Cloudflare KV...")
            res = requests.put(
                url, 
                headers=headers, 
                data=payload.encode('utf-8'),
                timeout=15
            )
            if res.status_code == 200:
                logger.info(f"Successfully wrote key '{key}' to Cloudflare KV.")
                return True
            else:
                logger.error(f"Failed to write key '{key}' (HTTP {res.status_code}): {res.text}")
                return False
        except Exception as e:
            logger.error(f"Exception while writing key '{key}' to KV: {e}")
            return False
