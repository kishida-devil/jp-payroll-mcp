@echo off
REM RapidAPI 手動ログイン（初回 / セッション切れ時のみ）
cd /d "%~dp0.."
python pipeline\rapidapi\login.py
pause
