param([string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
$SourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'github_workbench_update.ps1')
if (-not $EvidenceDirectory) { $EvidenceDirectory = Join-Path $SourceRoot 'data\verification\20261102-github-delivery' }
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$FixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('WG-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
$Checks = New-Object 'System.Collections.Generic.List[string]'
function Assert-WBTest([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Expect-WBFailure([scriptblock]$Action) {
    $Failed = $false
    try { $null = & $Action } catch { $Failed = $true }
    if (-not $Failed) { throw 'Expected a rejected unsafe or invalid operation.' }
}
function Write-WBFixture([string]$Path, [string]$Text) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}
function New-WBAsset([string]$Name, [long]$Size = 123) {
    return [pscustomobject]@{ name = $Name; state = 'uploaded'; size = $Size;
        browser_download_url = 'https://github.com/BMingyue/Temu-/releases/download/v2026.11.02.1/' + $Name }
}
function New-WBRelease {
    return [pscustomobject]@{ tag_name = 'v2026.11.02.1'; draft = $false; prerelease = $false;
        assets = @((New-WBAsset 'TextileWorkbench-Setup-2026.11.02.1.zip'),
                   (New-WBAsset 'TextileWorkbench-Update-from-2026.10.30.1-to-2026.11.02.1.zip'),
                   (New-WBAsset 'SHA256SUMS.txt')) }
}
function New-WBZip([string]$Name, $Entries) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.IO.Compression
    $Path = Join-Path $FixtureRoot $Name
    $File = [IO.File]::Open($Path, [IO.FileMode]::CreateNew)
    $Zip = New-Object IO.Compression.ZipArchive($File, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($Pair in $Entries.GetEnumerator()) {
            $Entry = $Zip.CreateEntry([string]$Pair.Key)
            $Stream = $Entry.Open(); $Bytes = [Text.Encoding]::UTF8.GetBytes([string]$Pair.Value)
            try { $Stream.Write($Bytes, 0, $Bytes.Length) } finally { $Stream.Dispose() }
        }
    } finally { $Zip.Dispose(); $File.Dispose() }
    return $Path
}

$InstalledRoot = Join-Path $FixtureRoot '原工作台 Space'
foreach ($Relative in @('launcher.py', 'runtime\python\python.exe', 'web-dist\index.html')) {
    Write-WBFixture (Join-Path $InstalledRoot $Relative) 'not executable; isolated fixture only'
}
Write-WBFixture (Join-Path $InstalledRoot 'workbench-release.json') '{"product":"temu-workbench","version":"2026.10.30.1"}'
Write-WBFixture (Join-Path $InstalledRoot 'data\sentinel.txt') 'private-data-must-remain-identical'
$SentinelHash = Get-WBFileHash (Join-Path $InstalledRoot 'data\sentinel.txt')
$Installed = Get-WBInstalled $InstalledRoot
$Release = New-WBRelease
$FreshPlan = Select-WBPlan $Release $null
$DeltaPlan = Select-WBPlan $Release $Installed
$Unsupported = [pscustomobject]@{Root = $InstalledRoot; Version = '2026.10.28.1'}
Assert-WBTest ($FreshPlan.Kind -eq 'setup' -and $DeltaPlan.Kind -eq 'delta' -and (Select-WBPlan $Release $Unsupported).Kind -eq 'full_update') 'setup/delta/fallback selection failed'
$Checks.Add('fresh install, exact existing baseline and unsupported baseline select setup/delta/data-preserving full_update correctly')

Assert-WBTest ((Select-WBPlan $Release ([pscustomobject]@{Root=$InstalledRoot;Version='2026.11.02.1'})).Kind -eq 'up_to_date') 'same version did not stop'
Expect-WBFailure { Select-WBPlan $Release ([pscustomobject]@{Root=$InstalledRoot;Version='2026.11.03.1'}) }
Expect-WBFailure { Select-WBPlan $Release $null 'Update' }
$Checks.Add('same version skips deployment, newer local version rejects downgrade, explicit Update requires an installation')

$BadRelease = New-WBRelease; $BadRelease.draft = $true
Expect-WBFailure { Select-WBPlan $BadRelease $null }
$BadRelease = New-WBRelease; $BadRelease.tag_name = 'main'
Expect-WBFailure { Select-WBPlan $BadRelease $null }
$BadRelease = New-WBRelease; $BadRelease.assets[0].browser_download_url = 'https://evil.example/payload.zip'
Expect-WBFailure { Select-WBPlan $BadRelease $null }
$BadRelease = New-WBRelease; $BadRelease.assets += $BadRelease.assets[0]
Expect-WBFailure { Select-WBPlan $BadRelease $null }
$Checks.Add('draft, non-release tag, foreign asset URL and duplicate asset names are rejected')

New-Item -ItemType Directory -Path (Join-Path $InstalledRoot '.git') | Out-Null
Expect-WBFailure { Get-WBInstalled $InstalledRoot }
Remove-Item -LiteralPath (Join-Path $InstalledRoot '.git')
Expect-WBFailure { Find-WBInstalled (Join-Path $FixtureRoot 'missing-install') }
$Checks.Add('source clone cannot be an overwrite target; nonexistent installation target is rejected')

$ChecksumPath = Join-Path $FixtureRoot 'checksums.txt'
Write-WBFixture $ChecksumPath (('a' * 64) + '  file.zip' + "`n")
Assert-WBTest ((Get-WBChecksum $ChecksumPath 'file.zip') -eq ('a' * 64)) 'valid checksum rejected'
Write-WBFixture $ChecksumPath ((('a' * 64) + '  使用说明 中文.txt' + "`n") + (('b' * 64) + '  file.zip' + "`n"))
Assert-WBTest ((Get-WBChecksum $ChecksumPath 'file.zip') -eq ('b' * 64)) 'unrelated Unicode release note broke checksum lookup'
Write-WBFixture $ChecksumPath ((('a' * 64) + '  file.zip' + "`n") * 2)
Expect-WBFailure { Get-WBChecksum $ChecksumPath 'file.zip' }
Write-WBFixture $ChecksumPath 'not-a-checksum file.zip'
Expect-WBFailure { Get-WBChecksum $ChecksumPath 'file.zip' }
Write-WBFixture $ChecksumPath (('a' * 64) + '  other.zip')
Expect-WBFailure { Get-WBChecksum $ChecksumPath 'file.zip' }
$Checks.Add('SHA256 list exact matching rejects malformed, duplicate and missing checksums')

$SetupZip = New-WBZip 'setup-fixture.zip' @{'INSTALL.cmd'='fixture';'安装织品工作台.cmd'='fixture';'setup.ps1'='fixture';'请先阅读.txt'='fixture';'workbench.zip'='fixture'}
$DeltaZip = New-WBZip 'delta-fixture.zip' @{'delta/update.ps1'='fixture';'delta/delta-manifest.json'='{"product":"temu-workbench","base_version":"2026.10.30.1","target_version":"2026.11.02.1"}';'delta/delta_update_workbench.py'='fixture';'delta/workbench_processes.py'='fixture';'delta/files/中文 name.txt'='fixture'}
$SetupEntry = Expand-WBVerifiedPackage $SetupZip (Join-Path $FixtureRoot 'setup 解压 Space') 'setup'
$DeltaEntry = Expand-WBVerifiedPackage $DeltaZip (Join-Path $FixtureRoot 'delta 解压 Space') 'delta'
Assert-WBTest ((Test-Path -LiteralPath $SetupEntry) -and (Test-Path -LiteralPath $DeltaEntry)) 'valid zip extraction failed'
$Checks.Add('verified setup and delta structures extract correctly under Chinese and space paths')

$Traversal = New-WBZip 'traversal.zip' @{'../outside.txt'='bad'}
Expect-WBFailure { Expand-WBVerifiedPackage $Traversal (Join-Path $FixtureRoot 'traversal-out') 'setup' }
$CaseEntries = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
$CaseEntries.Add('INSTALL.cmd', 'a'); $CaseEntries.Add('install.cmd', 'b')
$CaseDuplicate = New-WBZip 'duplicate-case.zip' $CaseEntries
Expect-WBFailure { Expand-WBVerifiedPackage $CaseDuplicate (Join-Path $FixtureRoot 'duplicate-out') 'setup' }
$WrongStructure = New-WBZip 'wrong-structure.zip' @{'evil.ps1'='fixture'}
Expect-WBFailure { Expand-WBVerifiedPackage $WrongStructure (Join-Path $FixtureRoot 'wrong-out') 'setup' }
Assert-WBTest (-not (Test-Path -LiteralPath (Join-Path $FixtureRoot 'outside.txt'))) 'zip escaped staging root'
$Checks.Add('zip traversal, case-colliding members and missing verified entry points are rejected before extraction')

$FullSource = Join-Path $FixtureRoot '完整新版 Space'
Write-WBFixture (Join-Path $FullSource 'runtime\python\python.exe') 'not executable; fixture only'
Write-WBFixture (Join-Path $FullSource 'update_workbench.py') 'not executable; fixture only'
Write-WBFixture (Join-Path $FullSource 'workbench-release.json') '{"product":"temu-workbench","version":"2026.11.02.1"}'
$FullPlan = Select-WBPlan $Release $Unsupported
$FullCheckJson = [pscustomobject]@{package_complete=$true;source=$FullSource} | ConvertTo-Json -Compress
Assert-WBTest ((Get-WBFullUpdateSource $FullPlan @('fixture output', $FullCheckJson)) -eq $FullSource) 'full update source validation failed'
Expect-WBFailure { Get-WBFullUpdateSource $FullPlan @(([pscustomobject]@{package_complete=$false;source=$FullSource} | ConvertTo-Json -Compress)) }
Expect-WBFailure { Get-WBFullUpdateSource $FullPlan @(([pscustomobject]@{package_complete=$true;source=$InstalledRoot} | ConvertTo-Json -Compress)) }
Write-WBFixture (Join-Path $FullSource 'workbench-release.json') '{"product":"temu-workbench","version":"2026.10.30.1"}'
Expect-WBFailure { Get-WBFullUpdateSource $FullPlan @($FullCheckJson) }
Write-WBFixture (Join-Path $FullSource 'workbench-release.json') '{"product":"temu-workbench","version":"2026.11.02.1"}'
$Checks.Add('full update accepts only verified matching release outside target, rejects failed checks, wrong versions and overlapping source')

$script:SetupCheckInvocations = 0
function Invoke-WBSetupCheck([string]$EntryPoint) { $script:SetupCheckInvocations++; return @($FullCheckJson) }
Invoke-WBVerifiedPackage $FullPlan $SetupEntry -OnlyCheck
Assert-WBTest ($script:SetupCheckInvocations -eq 1 -and (Get-WBFileHash (Join-Path $InstalledRoot 'data\sentinel.txt')) -eq $SentinelHash) 'full check executed updater or changed data'
$Checks.Add('full_update CheckOnly runs package check without launching installer, updater or changing original data')

# Mock transport only. All planning, checksum, path and archive validation remains real.
$script:FixtureRelease = New-WBRelease
$script:TransportSources = @{}
$script:InvocationCount = 0
foreach ($Asset in $script:FixtureRelease.assets) {
    if ($Asset.name -like '*Setup*') { $script:TransportSources[$Asset.name] = $SetupZip; $Asset.size = (Get-Item -LiteralPath $SetupZip).Length }
    elseif ($Asset.name -like '*Update*') { $script:TransportSources[$Asset.name] = $DeltaZip; $Asset.size = (Get-Item -LiteralPath $DeltaZip).Length }
}
$MainChecksums = Join-Path $FixtureRoot 'main-checksums.txt'
$Lines = @()
$Lines += ((Get-WBFileHash $SetupZip) + '  TextileWorkbench-Setup-2026.11.02.1.zip')
$Lines += ((Get-WBFileHash $DeltaZip) + '  TextileWorkbench-Update-from-2026.10.30.1-to-2026.11.02.1.zip')
Write-WBFixture $MainChecksums (($Lines -join "`n") + "`n")
$script:TransportSources['SHA256SUMS.txt'] = $MainChecksums
$script:FixtureRelease.assets[-1].size = (Get-Item -LiteralPath $MainChecksums).Length
function Get-WBRelease { return $script:FixtureRelease }
function Save-WBRemoteFile($Asset, [string]$Path) {
    Copy-Item -LiteralPath $script:TransportSources[[string]$Asset.name] -Destination $Path
    if ((Get-Item -LiteralPath $Path).Length -ne [long]$Asset.size) { throw 'fixture incomplete download' }
}
function Invoke-WBVerifiedPackage($Plan, [string]$EntryPoint, [switch]$OnlyCheck) {
    $script:InvocationCount++
    Assert-WBTest ($Plan.Kind -eq 'delta' -and $Plan.Target -eq $InstalledRoot -and $OnlyCheck) 'unexpected real install or wrong target dispatch'
}
$Downloaded = Invoke-WBOnlineUpdate $InstalledRoot 'Auto' (Join-Path $FixtureRoot '下载 缓存 Space') -OnlyDownload
Assert-WBTest ($Downloaded.Kind -eq 'delta' -and $Downloaded.DownloadOnly -and $script:InvocationCount -eq 0 -and (Test-Path -LiteralPath $Downloaded.EntryPoint)) 'DownloadOnly performed an install or failed to prepare payload'
Assert-WBTest ((Get-WBFileHash (Join-Path $InstalledRoot 'data\sentinel.txt')) -eq $SentinelHash) 'DownloadOnly changed private target data'
$Checks.Add('DownloadOnly verifies and stages a delta without invoking an installer or changing target data')

Write-WBFixture (Join-Path $InstalledRoot 'workbench-release.json') '{"product":"temu-workbench","version":"2026.10.28.1"}'
$BeforeFullDownload = $script:SetupCheckInvocations
$FullDownloaded = Invoke-WBOnlineUpdate $InstalledRoot 'Auto' (Join-Path $FixtureRoot 'full-download-cache') -OnlyDownload
Assert-WBTest ($FullDownloaded.Kind -eq 'full_update' -and $script:InvocationCount -eq 0 -and $script:SetupCheckInvocations -eq $BeforeFullDownload) 'full DownloadOnly executed package or installation'
Assert-WBTest ((Get-WBFileHash (Join-Path $InstalledRoot 'data\sentinel.txt')) -eq $SentinelHash) 'full DownloadOnly changed original data'
Write-WBFixture (Join-Path $InstalledRoot 'workbench-release.json') '{"product":"temu-workbench","version":"2026.10.30.1"}'
$Checks.Add('unsupported baseline DownloadOnly stages full_update without running setup check or risking existing data')

$BadChecksums = Join-Path $FixtureRoot 'bad-checksums.txt'
Write-WBFixture $BadChecksums ((('0' * 64) + '  TextileWorkbench-Update-from-2026.10.30.1-to-2026.11.02.1.zip') + "`n")
$script:TransportSources['SHA256SUMS.txt'] = $BadChecksums
$script:FixtureRelease.assets[-1].size = (Get-Item -LiteralPath $BadChecksums).Length
Expect-WBFailure { Invoke-WBOnlineUpdate $InstalledRoot 'Auto' (Join-Path $FixtureRoot 'bad-sha-cache') -OnlyDownload }
Assert-WBTest ($script:InvocationCount -eq 0 -and (Get-WBFileHash (Join-Path $InstalledRoot 'data\sentinel.txt')) -eq $SentinelHash) 'bad SHA changed target or invoked installer'
$Checks.Add('bad download SHA stops before extraction or execution and preserves existing private data')

$script:TransportSources['SHA256SUMS.txt'] = $MainChecksums
$script:FixtureRelease.assets[-1].size = (Get-Item -LiteralPath $MainChecksums).Length
$null = Invoke-WBOnlineUpdate $InstalledRoot 'Auto' (Join-Path $FixtureRoot 'check-cache') -OnlyCheck
Assert-WBTest ($script:InvocationCount -eq 1) 'CheckOnly did not delegate to the original read-only package check'
$Checks.Add('CheckOnly delegates to the verified existing updater with the original target')
Expect-WBFailure { Invoke-WBOnlineUpdate $InstalledRoot 'Auto' (Join-Path $InstalledRoot 'data\unsafe-cache') -OnlyDownload }
$Checks.Add('download cache inside the existing installation is rejected before writing or updating')

$BeforeNetworkFailure = $script:InvocationCount
function Get-WBRelease { throw 'fixture network unavailable' }
Expect-WBFailure { Invoke-WBOnlineUpdate $InstalledRoot 'Auto' (Join-Path $FixtureRoot 'offline-cache') -OnlyDownload }
Assert-WBTest ($script:InvocationCount -eq $BeforeNetworkFailure) 'network failure executed updater'
$Checks.Add('network failure keeps the original installation intact and performs no updater invocation')

$Evidence = [pscustomobject]@{ at=[DateTimeOffset]::Now.ToString('o'); passed=$Checks.Count; failed=0; checks=$Checks;
    fixture_root=$FixtureRoot; mode='isolated fixtures; release and transport mocked; installers never executed; no platform or user data access';
    existing_target_private_data_unchanged=((Get-WBFileHash (Join-Path $InstalledRoot 'data\sentinel.txt')) -eq $SentinelHash) }
[IO.File]::WriteAllText((Join-Path $EvidenceDirectory 'validation.json'), ($Evidence | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
Write-Host ('PASS: ' + $Checks.Count + ' isolated delivery checks; evidence: ' + $EvidenceDirectory)
