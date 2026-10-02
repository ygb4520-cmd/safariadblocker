# Refreshes this extension's blocking rules (rules\*.json) from the public
# filter lists, using the same converter as the Mac version. Run by the
# scheduled task that install-updater.ps1 creates; safe to run by hand too:
#   powershell -ExecutionPolicy Bypass -File update-rules.ps1
#
# The converter's self-healing check refuses to overwrite a rules file with
# an empty/much-smaller download, so a bad day leaves yesterday's rules in
# place. When meta.json changes (it is written last), the extension notices
# and reloads itself -- see checkForRuleUpdate() in background.js.

$ErrorActionPreference = "Stop"

$UpdaterDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtensionDir = Split-Path -Parent $UpdaterDir
$RulesDir = Join-Path $ExtensionDir "rules"
$LogDir = Join-Path $UpdaterDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("update-" + (Get-Date -Format "yyyy-MM-dd") + ".log")

function Write-Log($msg) {
    "$(Get-Date -Format 's')  $msg" | Tee-Object -FilePath $LogFile -Append
}

# Find Python 3: the "py" launcher first (python.org installer), then "python".
$python = $null
foreach ($candidate in @("py", "python")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { $python = $cmd.Source; break }
}
if (-not $python) {
    Write-Log "ERROR: Python 3 not found. Install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH')."
    exit 2
}

Write-Log "=== starting rules refresh (python: $python) ==="
$argsList = @((Join-Path $UpdaterDir "convert_filterlists.py"), "--output-dir", $RulesDir)
if ($python -like "*\py.exe" -or $python -eq "py") { $argsList = @("-3") + $argsList }

# Windows PowerShell 5.1 turns any stderr line from a native program into a
# terminating error while $ErrorActionPreference is "Stop" -- relax that for
# just this call, and force UTF-8 so Python can't choke on a non-ASCII print.
$env:PYTHONUTF8 = "1"
$ErrorActionPreference = "Continue"
& $python @argsList 2>&1 | ForEach-Object { Write-Log "$_" }
$code = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($code -ne 0) {
    Write-Log "FINISHED WITH ERRORS (exit $code) -- files that failed the self-healing check were left unchanged."
    exit $code
}
Write-Log "=== refresh finished OK ==="

# Keep 90 days of logs.
Get-ChildItem $LogDir -Filter "update-*.log" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } |
    Remove-Item -ErrorAction SilentlyContinue
