[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$OutputDirectory = "",
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$packageName = "ComfyUI-ControlPanel"
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = if ([string]::IsNullOrWhiteSpace($env:GITHUB_REF_NAME)) {
        "manual"
    }
    else {
        $env:GITHUB_REF_NAME
    }
}

$Version = $Version.Trim()
if ($Version -notmatch "\A[A-Za-z0-9][A-Za-z0-9._-]*\z") {
    throw "Version may contain only letters, numbers, dots, underscores, and hyphens: '$Version'"
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repositoryRoot "release"
}
elseif (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory = Join-Path $repositoryRoot $OutputDirectory
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)

$packageItems = @(
    "__init__.py",
    "backend",
    "dist",
    "assets",
    "pyproject.toml",
    "README.md",
    "LICENSE"
)

foreach ($item in $packageItems) {
    $sourcePath = Join-Path $repositoryRoot $item
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        throw "Required release item was not found: $sourcePath"
    }
}

$frontendBundle = Join-Path $repositoryRoot "dist/index.js"
if (-not (Test-Path -LiteralPath $frontendBundle -PathType Leaf)) {
    throw "The frontend bundle is missing. Run 'pnpm build' before creating the zip."
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$destinationPath = Join-Path $outputRoot "$packageName-$Version.zip"
if ((Test-Path -LiteralPath $destinationPath) -and -not $Force) {
    throw "Release archive already exists: $destinationPath. Pass -Force to replace it."
}

$systemTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$stagingRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $systemTempRoot "$packageName-package-$([System.Guid]::NewGuid().ToString('N'))")
)
$tempBoundary = $systemTempRoot.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar
if (-not $stagingRoot.StartsWith($tempBoundary, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a staging directory outside the system temporary directory: $stagingRoot"
}

$packageRoot = Join-Path $stagingRoot $packageName

try {
    New-Item -ItemType Directory -Path $packageRoot | Out-Null
    foreach ($item in $packageItems) {
        Copy-Item -LiteralPath (Join-Path $repositoryRoot $item) -Destination $packageRoot -Recurse -Force
    }

    Get-ChildItem -LiteralPath $packageRoot -Directory -Recurse -Force |
        Where-Object { $_.Name -eq "__pycache__" } |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }

    Get-ChildItem -LiteralPath $packageRoot -File -Recurse -Force |
        Where-Object { $_.Extension -in ".pyc", ".pyo" } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

    Compress-Archive -LiteralPath $packageRoot -DestinationPath $destinationPath -CompressionLevel Optimal -Force:$Force
}
finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        $resolvedStagingRoot = [System.IO.Path]::GetFullPath($stagingRoot)
        if ($resolvedStagingRoot.StartsWith($tempBoundary, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedStagingRoot -Recurse -Force
        }
    }
}

Write-Host "Created custom_nodes package: $destinationPath"
Write-Output $destinationPath
