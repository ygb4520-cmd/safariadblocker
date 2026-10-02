# Creates a Windows Task Scheduler task that runs update-rules.ps1 every day
# at 9:00 AM (or as soon as possible afterwards if the PC was off/asleep),
# under your own account, no admin rights needed. Safe to re-run.
#   powershell -ExecutionPolicy Bypass -File install-updater.ps1

$ErrorActionPreference = "Stop"

$UpdaterDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $UpdaterDir "update-rules.ps1"
$TaskName = "AdTrackerBlockerRulesUpdate"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""
$trigger = New-ScheduledTaskTrigger -Daily -At 9:00AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description "Refreshes Ad & Tracker Blocker filter rules" -Force | Out-Null

Write-Host "Installed task '$TaskName': runs daily at 9:00 AM (or when the PC next wakes)."
Write-Host "Run it right now to test:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Logs: $(Join-Path $UpdaterDir 'logs')"
Write-Host "Remove later with: uninstall-updater.ps1"
