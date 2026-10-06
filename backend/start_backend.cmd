@echo off

call .venv\Scripts\activate.bat

python -m uvicorn server:app --host 127.0.0.1 --port 8000 --reload --timeout-graceful-shutdown 3
