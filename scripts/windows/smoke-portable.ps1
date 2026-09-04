# Run only in a fresh GitHub-hosted Windows job; see README.md for local diagnosis.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ArchivePath,
    [Parameter(Mandatory)][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ passed = $false; reason = ''; pid = $null; elapsedSeconds = 0 }
$appProcess = $null
$timer = [Diagnostics.Stopwatch]::StartNew()
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputPath) {
    throw "Smoke output directory must be new: $outputPath"
}
New-Item -ItemType Directory -Path $outputPath | Out-Null
$logPath = Join-Path $outputPath 'aqbot.log'

# File.ReadAllText opens with FileShare.Read, which Windows rejects while AQBot
# holds an append handle. Keep ReadWrite share; pwsh wraps IOException, so unwrap it.
function Read-SharedLogText([string]$Path) {
    try {
        $stream = [IO.FileStream]::new(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::ReadWrite
        )
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $true)
        try {
            return $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
        }
    } catch {
        $current = $_.Exception
        while ($null -ne $current) {
            if ($current -is [IO.IOException]) { return $null }
            $current = $current.InnerException
        }
        throw
    }
}

try {
    if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
        throw 'This test requires a fresh GitHub-hosted Windows runner; do not run against a personal profile'
    }
    if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
        throw 'This smoke test executes only the Windows x64 portable archive'
    }

    # dirs::home_dir/document_dir use SHGetKnownFolderPath on Windows, not HOME or
    # USERPROFILE overrides; use the disposable runner profile without redirecting it.
    $profileDirectory = [Environment]::GetFolderPath('UserProfile')
    $documentsDirectory = [Environment]::GetFolderPath('MyDocuments')
    $localDataDirectory = [Environment]::GetFolderPath('LocalApplicationData')
    $roamingDataDirectory = [Environment]::GetFolderPath('ApplicationData')
    foreach ($directory in @($profileDirectory, $documentsDirectory, $localDataDirectory, $roamingDataDirectory)) {
        if ([string]::IsNullOrWhiteSpace($directory)) { throw 'A Windows known folder could not be resolved' }
    }
    if ([IO.Path]::GetFullPath($env:USERPROFILE) -ne [IO.Path]::GetFullPath($profileDirectory)) {
        throw 'USERPROFILE differs from the Windows profile known folder; isolated runner required'
    }
    $configFile = Join-Path $PSScriptRoot '../../src-tauri/tauri.conf.json'
    $bundleIdentifier = (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json).identifier
    if ([string]::IsNullOrWhiteSpace($bundleIdentifier)) { throw 'Tauri bundle identifier is missing' }
    $appDirectories = @(
        (Join-Path $profileDirectory '.aqbot'),
        (Join-Path $documentsDirectory 'aqbot'),
        (Join-Path $localDataDirectory $bundleIdentifier),
        (Join-Path $roamingDataDirectory $bundleIdentifier)
    )
    foreach ($directory in $appDirectories) {
        if (Test-Path -LiteralPath $directory) { throw "Refusing to use existing AQBot data: $directory" }
    }
    if (@(Get-Process | Where-Object ProcessName -eq 'AQBot').Count -gt 0) {
        throw 'An AQBot process already exists; this test will not stop it or reuse its instance'
    }

    $archive = (Resolve-Path -LiteralPath $ArchivePath).Path
    $result.archiveSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    $result.windowsVersion = (Get-CimInstance Win32_OperatingSystem).Version
    $extractDirectory = Join-Path $outputPath 'unpacked'
    Expand-Archive -LiteralPath $archive -DestinationPath $extractDirectory
    $executable = Join-Path $extractDirectory 'AQBot.exe'
    if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Portable ZIP does not contain AQBot.exe at its root' }

    $probePath = Join-Path $outputPath 'share-probe.log'
    $writer = [IO.FileStream]::new($probePath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    try {
        $payload = [Text.Encoding]::UTF8.GetBytes("shared-log-probe`n")
        $writer.Write($payload, 0, $payload.Length)
        $writer.Flush()
        if ((Read-SharedLogText -Path $probePath) -notmatch 'shared-log-probe') {
            throw 'Shared log reader could not see bytes from a live append handle'
        }
    } finally {
        $writer.Dispose()
        Remove-Item -LiteralPath $probePath -ErrorAction SilentlyContinue
    }

    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class AQBotSmokeNative {
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
    public static bool HasVisibleMainWindow(uint processId) {
        bool found = false;
        bool enumerated = EnumWindows((window, parameter) => {
            uint ownerProcessId;
            GetWindowThreadProcessId(window, out ownerProcessId);
            if (ownerProcessId == processId && IsWindowVisible(window) && !IsIconic(window)) {
                var title = new StringBuilder(256);
                GetWindowText(window, title, title.Capacity);
                if (title.ToString() == "AQBot") found = true;
            }
            return true;
        }, IntPtr.Zero);
        if (!enumerated) throw new Win32Exception(Marshal.GetLastWin32Error());
        return found;
    }
}
'@

    $startInfo = [Diagnostics.ProcessStartInfo]::new($executable)
    $startInfo.UseShellExecute = $false
    $startInfo.WorkingDirectory = $extractDirectory
    $startInfo.Environment['AQBOT_LOG_FILE'] = $logPath
    $startInfo.Environment['RUST_LOG'] = 'info'
    $startInfo.Environment['NO_COLOR'] = '1'
    $appProcess = [Diagnostics.Process]::Start($startInfo)
    $result.pid = $appProcess.Id
    $launchTimer = [Diagnostics.Stopwatch]::StartNew()
    while ($launchTimer.Elapsed.TotalSeconds -lt 60) {
        $appProcess.Refresh()
        if ($appProcess.HasExited) { throw "AQBot exited before startup completed, code $($appProcess.ExitCode)" }
        $lines = @()
        if (Test-Path -LiteralPath $logPath) {
            $text = Read-SharedLogText -Path $logPath
            if ($null -ne $text) {
                $text = $text -replace '\x1b\[[0-9;]*m', ''
                $lines = @($text -split "`n" | Where-Object { $_ -match 'AQBot startup surface presented' })
            }
        }
        if (@($lines | Where-Object { $_ -match '\bsurface="?error"?(\s|$)' }).Count -gt 0) {
            throw 'AQBot presented a startup error surface; this is not a successful launch'
        }
        $ready = @($lines | Where-Object {
            $_ -match '\bwindow="?main"?(\s|$)' -and
            $_ -match '\bsurface="?app"?(\s|$)' -and
            $_ -match '\bvisible=true(\s|$)'
        }).Count -gt 0
        if ($ready -and [AQBotSmokeNative]::HasVisibleMainWindow($appProcess.Id)) {
            $appProcess.Refresh()
            if ($appProcess.HasExited) { throw 'AQBot exited after its startup presentation signal' }
            $result.passed = $true
            $result.reason = 'Frontend committed the app surface and the same process owns a visible AQBot main window'
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (!$result.passed) { throw 'Timed out after 60 seconds waiting for the committed app surface and visible main window' }
} catch {
    $result.reason = $_.Exception.Message
} finally {
    if ($null -ne $appProcess) {
        try {
            if (!$appProcess.HasExited) {
                # Only this Process object and its descendants; never kill by name.
                $appProcess.Kill($true)
                if (!$appProcess.WaitForExit(5000)) { throw 'Test-owned AQBot process did not exit after cleanup' }
            }
        } catch {
            $result.passed = $false
            $result.reason += "; cleanup failed: $($_.Exception.Message)"
        }
        $appProcess.Dispose()
    }
    $result.elapsedSeconds = [Math]::Round($timer.Elapsed.TotalSeconds, 2)
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputPath 'result.json') -Encoding utf8
}

if (!$result.passed) { throw $result.reason }
Write-Host "Windows portable smoke passed: $($result.reason)"
