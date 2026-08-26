@echo off
REM 出典の変化と改定時期の週次チェック（Discordへ通知）
cd /d "%~dp0.."
python pipeline\watch_sources.py
