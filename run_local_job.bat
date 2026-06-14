@echo off
echo =======================================================
echo Running Scheduled Data Worker Python Job Locally
echo =======================================================
echo.
set TARGET_URL=https://httpbin.org/status/200
set TARGET_CONFIG={"user_agent": "LocalDataWorker/1.0"}
set CLOUDFLARE_API_TOKEN=local_token_mock
set CLOUDFLARE_ACCOUNT_ID=local_account_mock
set CLOUDFLARE_KV_NAMESPACE_ID=local_kv_mock
set LOCAL_DEV_URL=http://127.0.0.1:8787

python src/main.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Warning: Failed using 'python'. Attempting 'py'...
    py src/main.py
)
echo.
echo Job execution completed.
pause
