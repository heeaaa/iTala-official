<#
.SYNOPSIS
  Applies a phase zip to this working tree, including deletions.

.DESCRIPTION
  Expand-Archive only ever adds or overwrites. It cannot remove a file that a
  later phase deleted, so a stale module lingers, gets committed by `git add
  -A`, and then fails lint or typecheck for no visible reason. That is exactly
  what happened with SkeletonScreen.tsx.

  This script closes the gap. Every phase zip carries a MANIFEST.txt listing
  the files that phase tracks. Anything git currently tracks that is NOT in the
  manifest was deleted upstream, so it is removed here too.

  Only git-TRACKED files are ever deleted. Untracked local files - your .env,
  node_modules, scratch notes - are never touched.

.EXAMPLE
  ./tools/sync-phase.ps1 -Zip _phase3.zip
#>
param(
  [Parameter(Mandatory = $true)][string]$Zip,
  # Files the repo keeps but the zips deliberately do not ship.
  [string[]]$Keep = @('APP_CONTEXT_UPDATED.md', 'itala-logo.png', 'itala-logo-120x120.png')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Zip)) { throw "Zip not found: $Zip" }
if (-not (Test-Path '.git')) { throw 'Run this from the repository root.' }

Write-Host '==> Extracting' -ForegroundColor Cyan
Expand-Archive -Path $Zip -DestinationPath . -Force

if (-not (Test-Path 'MANIFEST.txt')) {
  throw 'MANIFEST.txt missing from the zip. Cannot safely work out what was deleted.'
}

$manifest = @{}
Get-Content 'MANIFEST.txt' | Where-Object { $_.Trim() -ne '' } | ForEach-Object {
  $manifest[$_.Trim()] = $true
}
foreach ($k in $Keep) { $manifest[$k] = $true }

Write-Host '==> Removing files deleted upstream' -ForegroundColor Cyan
$removed = 0
git ls-files | ForEach-Object {
  if (-not $manifest.ContainsKey($_)) {
    Write-Host "    deleted: $_" -ForegroundColor Yellow
    git rm --quiet -- $_
    $removed++
  }
}
if ($removed -eq 0) { Write-Host '    nothing to remove' -ForegroundColor DarkGray }

Remove-Item 'MANIFEST.txt' -Force
Remove-Item $Zip -Force

Write-Host '==> Staging' -ForegroundColor Cyan
git add -A

Write-Host ''
Write-Host "Done. $removed file(s) removed, everything else staged." -ForegroundColor Green
Write-Host 'Next:  pnpm install ; pnpm verify ; git commit -m "..." ; git push'
