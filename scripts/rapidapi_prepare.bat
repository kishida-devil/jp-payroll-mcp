@echo off
REM 出品準備（spec生成 + 本番疎通確認 + 通知）
cd /d "%~dp0.."
python pipeline\rapidapi\prepare.py --all
pause
