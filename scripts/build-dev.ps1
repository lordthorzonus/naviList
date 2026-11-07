param(
    [string]$Distro = 'archlinux',
    [ValidatePattern('^[a-z0-9][a-z0-9_.-]{0,100}$')]
    [string]$Tag = ('dev-' + (Get-Date -Format 'yyyyMMdd-HHmmss')),
    [switch]$Export
)

$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$image = "docker.io/library/navilist:$Tag"

function Invoke-Wsl {
    param([string[]]$Arguments)
    & wsl.exe -d $Distro -- @Arguments
    if ($LASTEXITCODE -ne 0) { throw "WSL command failed (exit $LASTEXITCODE): $($Arguments[0])" }
}

$linuxRepository = (Invoke-Wsl -Arguments @('wslpath', '-a', $repository.Replace('\', '/')) | Out-String).Trim()
Invoke-Wsl -Arguments @('docker', 'info', '--format', '{{.ServerVersion}}')
Invoke-Wsl -Arguments @('docker', 'build', '--platform', 'linux/amd64', '-t', $image, $linuxRepository)
Invoke-Wsl -Arguments @('docker', 'run', '--rm', '--entrypoint', 'node', $image, '--test', '--test-reporter=dot')

if ($Export) {
    $directory = Join-Path $env:LOCALAPPDATA 'Temp\opencode\navilist-images'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $archive = Join-Path $directory "navilist-$Tag.tar"
    $linuxArchive = (Invoke-Wsl -Arguments @('wslpath', '-a', $archive.Replace('\', '/')) | Out-String).Trim()
    Invoke-Wsl -Arguments @('docker', 'image', 'save', '-o', $linuxArchive, $image)
    Write-Host "Archive: $archive"
}

Write-Host "Built and tested: $image"
Write-Host 'No registry push, image transfer, or Kubernetes changes performed.'
