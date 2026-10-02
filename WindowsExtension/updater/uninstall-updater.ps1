# Removes the scheduled task created by install-updater.ps1.
$TaskName = "AdTrackerBlockerRulesUpdate"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed task '$TaskName'."
} else {
    Write-Host "Task '$TaskName' isn't installed."
}
