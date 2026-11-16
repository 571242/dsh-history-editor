param(
  [ValidateSet('Verify','Install','Rollback')][string]$Mode = 'Verify',
  [switch]$AcknowledgeHistoryDependency
)
$ErrorActionPreference = 'Stop'
if ($Mode -ne 'Rollback') {
  throw 'LEGACY 0.2.1-rc.2 archive installer disabled. Do not deploy host-patch/app.asar to rc.3. Use build-current.mjs and current/manifest.json; see CURRENT.md for entry-span deployment.'
}
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$target = [IO.Path]::GetFullPath($manifest.target)
if ($target -ne [IO.Path]::GetFullPath('F:/EXE/DeepSeek/resources/app.asar')) { throw 'Unexpected target path.' }
$package = Join-Path $PSScriptRoot 'app.asar'
$backup = $target + '.history-editor-backup'
function HashOf([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$current = HashOf $target
$packageHash = HashOf $package
if ($packageHash -ne $manifest.patchedSha256) { throw 'Patch package hash mismatch.' }
if ($current -ne $manifest.originalSha256 -and $current -ne $manifest.patchedSha256) { throw 'Installed app version differs. Do NOT apply this patch to an updated app.' }
if ($Mode -eq 'Verify') {
  Write-Output ('Package verified. Installed=' + ($current -eq $manifest.patchedSha256))
  Write-Output 'No files changed. Exit DSH completely before installing.'
  exit 0
}
if (-not $AcknowledgeHistoryDependency) { throw 'Edited histories require this patched protocol. Read README.md, then pass -AcknowledgeHistoryDependency.' }
$running = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -like '*DeepSeek*' -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith([IO.Path]::GetFullPath('F:/EXE/DeepSeek/'),[StringComparison]::OrdinalIgnoreCase))
}
if ($running) { throw 'DSH is still running. Exit it completely, then run this script again. Nothing changed.' }
if ($Mode -eq 'Install') {
  if ($current -eq $manifest.patchedSha256) { Write-Output 'Already installed.'; exit 0 }
  if (Test-Path -LiteralPath $backup) {
    if ((HashOf $backup) -ne $manifest.originalSha256) { throw 'A different backup exists; refusing to overwrite it.' }
  } else { Copy-Item -LiteralPath $target -Destination $backup }
  if ((HashOf $backup) -ne $manifest.originalSha256) { throw 'Backup verification failed.' }
  $source = $package
  $expected = $manifest.patchedSha256
} else {
  if ($current -eq $manifest.originalSha256) { Write-Output 'Already original.'; exit 0 }
  if (-not (Test-Path -LiteralPath $backup)) { throw 'Original backup is missing.' }
  if ((HashOf $backup) -ne $manifest.originalSha256) { throw 'Original backup hash mismatch.' }
  $source = $backup
  $expected = $manifest.originalSha256
  Write-Warning 'Software rollback does not undo history edits; edited sessions may require re-installing the patch to load.'
}
$temp = Join-Path ([IO.Path]::GetDirectoryName($target)) ('app.asar.history-editor-' + [guid]::NewGuid().ToString('N') + '.pending')
try {
  Copy-Item -LiteralPath $source -Destination $temp
  if ((HashOf $temp) -ne $expected) { throw 'Staged copy hash mismatch.' }
  [IO.File]::Replace($temp, $target, $null)
  if ((HashOf $target) -ne $expected) { throw 'Installed file hash mismatch; keep the backup and restore it before starting DSH.' }
  Write-Output ($Mode + ' complete. Start DSH manually, then hard-refresh the Web GUI.')
} finally {
  if ((Test-Path -LiteralPath $temp) -and [IO.Path]::GetDirectoryName($temp) -eq [IO.Path]::GetDirectoryName($target) -and $temp.EndsWith('.pending')) { Remove-Item -LiteralPath $temp }
}
