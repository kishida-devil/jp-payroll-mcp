# 週次で出典監視を回すタスクを登録する。
#   powershell -ExecutionPolicy Bypass -File scripts\register_watch_task.ps1
# 解除は:
#   Unregister-ScheduledTask -TaskName "tsumugi-source-watch" -Confirm:$false

$repo = Split-Path -Parent $PSScriptRoot
$bat  = Join-Path $repo "scripts\watch_sources.bat"
$name = "tsumugi-source-watch"

if (-not (Test-Path $bat)) { Write-Error "見つかりません: $bat"; exit 1 }

$action  = New-ScheduledTaskAction -Execute $bat -WorkingDirectory $repo
# 月曜 09:00。改定は年度替わりと10月に集中するので週次で十分。
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
    -Settings $settings -Description "tsumugi: 出典URLの変化と法改正時期を監視しDiscordへ通知" -Force | Out-Null

Write-Output "登録しました: $name (毎週月曜 09:00)"
Write-Output "手動実行: Start-ScheduledTask -TaskName $name"
