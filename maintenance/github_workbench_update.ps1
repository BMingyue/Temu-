[CmdletBinding()]
param(
    [string]$Target,
    [ValidateSet('Auto', 'Install', 'Update')][string]$Mode = 'Auto',
    [string]$CacheRoot,
    [switch]$DownloadOnly,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$script:WBRepository = 'BMingyue/Temu-'
$script:WBApi = 'https://api.github.com/repos/BMingyue/Temu-/releases/latest'

function Get-WBVersion([string]$Value) {
    if ($Value -notmatch '^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$') { throw '发布版本号无效。' }
    return [version]$Value
}

function Get-WBFullPath([string]$Value) {
    if (-not $Value) { throw '文件夹路径为空。' }
    $Path = [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
    if (-not [IO.Path]::IsPathRooted($Path)) { throw '请选择完整的本机文件夹路径。' }
    $Current = $Path
    while ($Current) {
        if ([IO.File]::Exists($Current) -or [IO.Directory]::Exists($Current)) {
            $Attributes = [IO.File]::GetAttributes($Current)
            if (($Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw ('路径含目录链接，请选择真实目录：' + $Current)
            }
        }
        $Parent = [IO.Path]::GetDirectoryName($Current)
        if ($Parent -eq $Current) { break }
        $Current = $Parent
    }
    return $Path
}

function Get-WBInstalled([string]$Path) {
    if (-not $Path) { return $null }
    $Root = Get-WBFullPath $Path
    if (Test-Path -LiteralPath (Join-Path $Root '.git')) { throw '所选目录是维护源码仓库；请保留源码，选择同事工作台安装目录。' }
    foreach ($Name in @('workbench-release.json', 'launcher.py', 'runtime\python\python.exe', 'web-dist\index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $Name) -PathType Leaf)) { return $null }
    }
    $Info = Get-Content -LiteralPath (Join-Path $Root 'workbench-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Info.product -ne 'temu-workbench') { throw '所选目录不是织品工作台。' }
    $null = Get-WBVersion ([string]$Info.version)
    return [pscustomobject]@{ Root = $Root; Version = [string]$Info.version }
}

function Find-WBInstalled([string]$ExplicitTarget) {
    if ($ExplicitTarget) {
        $Installed = Get-WBInstalled $ExplicitTarget
        if (-not $Installed) { throw '指定的目标不是完整安装目录，请选择含 runtime、web-dist 的原工作台目录。' }
        return $Installed
    }
    $SourceRoot = Split-Path -Parent $PSScriptRoot
    if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot '.git'))) {
        $Installed = Get-WBInstalled $SourceRoot
        if ($Installed) { return $Installed }
    }
    $LinkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) '织品工作台.lnk'
    if (Test-Path -LiteralPath $LinkPath -PathType Leaf) {
        $Shell = New-Object -ComObject WScript.Shell
        try {
            $Shortcut = $Shell.CreateShortcut($LinkPath)
            try { return Get-WBInstalled ([string]$Shortcut.WorkingDirectory) }
            finally { [Runtime.InteropServices.Marshal]::ReleaseComObject($Shortcut) | Out-Null }
        } finally { [Runtime.InteropServices.Marshal]::ReleaseComObject($Shell) | Out-Null }
    }
    return $null
}

function Get-WBRelease {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    return Invoke-RestMethod -Uri $script:WBApi -Headers @{
        'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'TextileWorkbench-Installer'; 'Cache-Control' = 'no-cache'
    } -TimeoutSec 30
}

function Get-WBAsset($Release, [string]$Name) {
    $Matches = @($Release.assets | Where-Object { $_.name -ceq $Name })
    if ($Matches.Count -ne 1) { throw ('发布包缺少唯一文件：' + $Name + '。请使用负责人提供的完整离线安装包。') }
    $Asset = $Matches[0]
    $Uri = $null
    if (-not [Uri]::TryCreate([string]$Asset.browser_download_url, [UriKind]::Absolute, [ref]$Uri)) { throw '发布文件地址无效。' }
    $ExpectedPath = '/BMingyue/Temu-/releases/download/' + [string]$Release.tag_name + '/' + $Name
    if ($Uri.Scheme -ne 'https' -or $Uri.Host -cne 'github.com' -or $Uri.Port -ne 443 -or $Uri.UserInfo -or
        $Uri.Query -or $Uri.Fragment -or [Uri]::UnescapeDataString($Uri.AbsolutePath) -cne $ExpectedPath) {
        throw ('发布文件地址不属于指定仓库和版本：' + $Name)
    }
    if ($Asset.state -cne 'uploaded' -or [long]$Asset.size -le 0 -or [long]$Asset.size -gt 2147483648) {
        throw ('发布文件尚未完成或大小无效：' + $Name)
    }
    return $Asset
}

function Select-WBPlan($Release, $Installed, [string]$RequestedMode = 'Auto') {
    if ($Release.draft -isnot [bool] -or $Release.draft -or $Release.prerelease -isnot [bool] -or $Release.prerelease -or
        [string]$Release.tag_name -notmatch '^v(\d{4}\.\d{2}\.\d{2}\.\d{1,4})$') {
        throw 'GitHub 尚无可用正式发布版，请使用负责人提供的完整安装包。'
    }
    $Version = ([string]$Release.tag_name).Substring(1)
    $Latest = Get-WBVersion $Version
    $Names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($Item in @($Release.assets)) {
        if (-not $Item.name -or -not $Names.Add([string]$Item.name)) { throw '发布文件名为空或重复。' }
    }
    if ($RequestedMode -eq 'Update' -and -not $Installed) {
        throw '没有识别到原工作台。请用 -Target 指定原安装目录，或首次安装时使用默认入口。'
    }
    $Current = ''
    $TargetPath = ''
    if ($Installed) {
        $Current = [string]$Installed.Version; $TargetPath = [string]$Installed.Root
        $CurrentNumber = Get-WBVersion $Current
        if ($CurrentNumber -gt $Latest) { throw '当前安装版本比GitHub正式版新，已拒绝降级。' }
        if ($CurrentNumber -eq $Latest -and $RequestedMode -ne 'Install') {
            return [pscustomobject]@{ Kind = 'up_to_date'; Version = $Version; Target = $TargetPath; CurrentVersion = $Current }
        }
    }
    $Name = 'TextileWorkbench-Setup-' + $Version + '.zip'
    $Kind = if ($Installed) { 'full_update' } else { 'setup' }
    if ($Installed -and $RequestedMode -ne 'Install') {
        $DeltaName = 'TextileWorkbench-Update-from-' + $Current + '-to-' + $Version + '.zip'
        if (@($Release.assets | Where-Object { $_.name -ceq $DeltaName }).Count -gt 0) { $Name = $DeltaName; $Kind = 'delta' }
    }
    return [pscustomobject]@{
        Kind = $Kind; Version = $Version; CurrentVersion = $Current; Target = $TargetPath;
        Asset = Get-WBAsset $Release $Name; Checksums = Get-WBAsset $Release 'SHA256SUMS.txt'; Tag = [string]$Release.tag_name
    }
}

function Save-WBRemoteFile($Asset, [string]$Path) {
    $Client = New-Object Net.WebClient
    $Client.Headers['User-Agent'] = 'TextileWorkbench-Installer'
    try { $Client.DownloadFile([string]$Asset.browser_download_url, $Path) }
    finally { $Client.Dispose() }
    if ((Get-Item -LiteralPath $Path).Length -ne [long]$Asset.size) { throw ('文件下载不完整：' + $Asset.name) }
}

function Get-WBChecksum([string]$Path, [string]$Name) {
    $Found = @()
    $Names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($Line in [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)) {
        if (-not $Line.Trim()) { continue }
        if ($Line -notmatch '^([a-fA-F0-9]{64})  (.+)$') { throw '发布校验清单格式无效。' }
        $Hash, $FileName = $Matches[1].ToLowerInvariant(), $Matches[2]
        if ($FileName -match '[\x00-\x1f\\/:*?"<>|]' -or $FileName.TrimEnd(' ', '.') -cne $FileName -or
            $FileName -in @('.', '..')) { throw '发布校验清单含不安全文件名。' }
        if (-not $Names.Add($FileName)) { throw '发布校验清单含重复文件名。' }
        if ($FileName -ceq $Name) { $Found += $Hash }
    }
    if ($Found.Count -ne 1) { throw ('发布校验清单缺少唯一匹配：' + $Name) }
    return $Found[0]
}

function Get-WBFileHash([string]$Path) {
    $Hasher = [Security.Cryptography.SHA256]::Create(); $Stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
    finally { $Stream.Dispose(); $Hasher.Dispose() }
}

function Expand-WBVerifiedPackage([string]$Archive, [string]$Destination, [string]$Kind) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    $Entries = @()
    $Seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $RootPrefix = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    try {
        foreach ($Entry in $Zip.Entries) {
            $Name = $Entry.FullName
            $Parts = $Name.TrimEnd('/').Split('/')
            if (-not $Name -or $Name.StartsWith('/') -or $Name.Contains('\') -or
                @($Parts | Where-Object { -not $_ -or $_ -eq '.' -or $_ -eq '..' -or $_.Contains(':') -or $_.TrimEnd(' ', '.') -cne $_ }).Count -gt 0 -or
                -not $Seen.Add($Name.TrimEnd('/')) -or (($Entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw ('压缩包含不安全或重复路径：' + $Name)
            }
            $TargetPath = [IO.Path]::GetFullPath((Join-Path $Destination ($Name.Replace('/', '\'))))
            if (-not $TargetPath.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase) -or $TargetPath.Length -gt 245) {
                throw ('解压路径过长或超出临时目录，请指定较短 -CacheRoot：' + $Name)
            }
            $Entries += $Name
        }
        if ($Kind -in @('setup', 'full_update')) {
            $Expected = @('INSTALL.cmd', '安装织品工作台.cmd', 'setup.ps1', '请先阅读.txt', 'workbench.zip')
            if ($Entries.Count -ne $Expected.Count -or @($Entries | Where-Object { $_ -cnotin $Expected }).Count -gt 0) {
                throw '完整安装包结构与正式安装入口不一致。'
            }
            $EntryPoint = Join-Path $Destination 'setup.ps1'
        } else {
            $Roots = @($Entries | ForEach-Object { $_.Split('/')[0] } | Select-Object -Unique)
            if ($Roots.Count -ne 1) { throw '小更新包必须只有一个根目录。' }
            $Folder = $Roots[0]
            foreach ($Required in @('update.ps1', 'delta-manifest.json', 'delta_update_workbench.py', 'workbench_processes.py')) {
                if (($Folder + '/' + $Required) -cnotin $Entries) { throw ('小更新包缺少必要文件：' + $Required) }
            }
            $EntryPoint = Join-Path (Join-Path $Destination $Folder) 'update.ps1'
        }
    } finally { $Zip.Dispose() }
    if (Test-Path -LiteralPath $Destination) { throw '临时解压目录已经存在，本次未覆盖。' }
    New-Item -ItemType Directory -Path $Destination | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
    return $EntryPoint
}

function Invoke-WBSetupCheck([string]$EntryPoint) {
    $OutputPath = Join-Path (Split-Path -Parent $EntryPoint) 'online-check.stdout.txt'
    $ErrorPath = Join-Path (Split-Path -Parent $EntryPoint) 'online-check.stderr.txt'
    $PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $Process = Start-Process -FilePath $PowerShell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $EntryPoint + '"'), '-CheckOnly') `
        -WindowStyle Hidden -RedirectStandardOutput $OutputPath -RedirectStandardError $ErrorPath -PassThru -Wait
    if ($Process.ExitCode -ne 0) { throw ('完整包检查失败，未运行旧版更新。请保留日志：' + $OutputPath) }
    return [IO.File]::ReadAllLines($OutputPath, [Text.Encoding]::UTF8)
}

function Get-WBFullUpdateSource($Plan, $CheckOutput) {
    $JsonLines = @($CheckOutput | ForEach-Object { [string]$_ } | Where-Object { $_.StartsWith('{') -and $_.Contains('"package_complete"') })
    if ($JsonLines.Count -ne 1) { throw '完整包检查没有返回唯一已验证目录，未运行更新。' }
    $Check = $JsonLines[0] | ConvertFrom-Json
    if ($Check.package_complete -isnot [bool] -or -not $Check.package_complete -or -not $Check.source) { throw '完整包检查未明确成功。' }
    $Source = Get-WBFullPath ([string]$Check.source)
    $TargetRoot = Get-WBFullPath ([string]$Plan.Target)
    if ($Source -eq $TargetRoot -or $Source.StartsWith($TargetRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $TargetRoot.StartsWith($Source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '完整更新必须在原目录之外校验，未覆盖原程序。' }
    foreach ($Name in @('runtime\python\python.exe', 'update_workbench.py', 'workbench-release.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Source $Name) -PathType Leaf)) { throw ('已验证完整包缺少更新文件：' + $Name) }
    }
    $Info = Get-Content -LiteralPath (Join-Path $Source 'workbench-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Info.product -cne 'temu-workbench' -or $Info.version -cne $Plan.Version) { throw '已验证完整包版本与发布版本不符。' }
    return $Source
}

function Invoke-WBVerifiedPackage($Plan, [string]$EntryPoint, [switch]$OnlyCheck) {
    if ($Plan.Kind -eq 'delta') {
        if ($OnlyCheck) { & $EntryPoint -Target $Plan.Target -CheckOnly }
        else { & $EntryPoint -Target $Plan.Target }
    } elseif ($Plan.Kind -eq 'full_update') {
        $CheckOutput = Invoke-WBSetupCheck $EntryPoint
        $Source = Get-WBFullUpdateSource $Plan $CheckOutput
        if ($OnlyCheck) { Write-Host ('完整包校验通过，未运行更新或停止服务：' + $Source); return }
        $Python = Join-Path $Source 'runtime\python\python.exe'
        & $Python -E -X utf8 -B (Join-Path $Source 'update_workbench.py') --target $Plan.Target
    } elseif ($OnlyCheck) { & $EntryPoint -CheckOnly }
    else { & $EntryPoint }
    if ($LASTEXITCODE -ne 0) { throw '安装或更新未完成，请保留上面的提示和已下载文件。' }
}

function Invoke-WBOnlineUpdate([string]$TargetPath, [string]$RequestedMode = 'Auto', [string]$DownloadRoot,
                              [switch]$OnlyDownload, [switch]$OnlyCheck) {
    if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Major -lt 10 -or
        $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        throw '本安装包适用于Windows 10/11、Intel/AMD 64位电脑。'
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $Installed = Find-WBInstalled $TargetPath
    $Release = Get-WBRelease
    $Plan = Select-WBPlan $Release $Installed $RequestedMode
    if ($Plan.Kind -eq 'up_to_date') { Write-Host ('已是最新正式版 ' + $Plan.Version + '，原数据保持。'); return $Plan }
    if (-not $DownloadRoot) { $DownloadRoot = Join-Path ([IO.Path]::GetTempPath()) 'TWO' }
    $Cache = Get-WBFullPath $DownloadRoot
    if ($Installed) {
        $Prefix = $Installed.Root.TrimEnd('\') + '\'
        if ($Cache -eq $Installed.Root -or $Cache.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw '下载缓存必须在原工作台目录之外，不能覆盖原程序或数据。'
        }
    }
    $Stage = Join-Path $Cache ([Guid]::NewGuid().ToString('N').Substring(0, 10))
    if (Test-Path -LiteralPath $Stage) { throw '本次临时目录已存在，请重试入口。' }
    New-Item -ItemType Directory -Path $Stage -Force | Out-Null
    Write-Host ('正在下载正式版 ' + $Plan.Version + '：' + $Plan.Asset.name)
    Write-Host ('下载和校验目录：' + $Stage)
    $Checksums = Join-Path $Stage 'SHA256SUMS.txt'
    Save-WBRemoteFile $Plan.Checksums $Checksums
    $Expected = Get-WBChecksum $Checksums ([string]$Plan.Asset.name)
    $Partial = Join-Path $Stage ($Plan.Asset.name + '.download')
    Save-WBRemoteFile $Plan.Asset $Partial
    $Actual = Get-WBFileHash $Partial
    if ($Actual -cne $Expected) { throw ('下载文件SHA256不符，未解压或运行。请保留目录并重新下载：' + $Stage) }
    $Archive = Join-Path $Stage $Plan.Asset.name
    Move-Item -LiteralPath $Partial -Destination $Archive
    $EntryPoint = Expand-WBVerifiedPackage $Archive (Join-Path $Stage 'package') $Plan.Kind
    if ($Plan.Kind -eq 'delta') {
        $Manifest = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $EntryPoint) 'delta-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($Manifest.product -cne 'temu-workbench' -or $Manifest.base_version -cne $Plan.CurrentVersion -or $Manifest.target_version -cne $Plan.Version) {
            throw '小更新包声明版本与所选安装目录不一致，未运行更新。'
        }
    }
    $Result = [pscustomobject]@{ Kind = $Plan.Kind; Version = $Plan.Version; CurrentVersion = $Plan.CurrentVersion;
        Target = $Plan.Target; Archive = $Archive; Sha256 = $Actual; EntryPoint = $EntryPoint; DownloadOnly = [bool]$OnlyDownload }
    Write-Host '下载、SHA256和包结构检查通过。'
    if ($OnlyDownload) { Write-Host ('仅下载模式：未安装、未更新、未停止任何服务。入口：' + $EntryPoint); return $Result }
    if ($Plan.Kind -eq 'full_update') {
        Write-Host ('将校验完整包，再打开保留数据的原地更新向导，目标：' + $Installed.Root)
    } elseif ($Plan.Kind -eq 'setup') {
        Write-Host '未识别到旧安装，将打开首次安装向导。若已有旧版，请先关闭向导，再用 -Target 指定原安装位置更新，以保留旧数据。'
    } else { Write-Host '将使用原更新器核对基线和运行任务，保留账号、店铺、图片及浏览器资料；不满足条件会停止。' }
    Invoke-WBVerifiedPackage $Plan $EntryPoint -OnlyCheck:$OnlyCheck
    return $Result
}

# Dot-sourcing exposes the pure validation functions for isolated tests; no network or install is started.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
        $OutputEncoding = [Console]::OutputEncoding
        Invoke-WBOnlineUpdate $Target $Mode $CacheRoot -OnlyDownload:$DownloadOnly -OnlyCheck:$CheckOnly
        exit 0
    } catch {
        Write-Host ('安装/更新未完成：' + $_.Exception.Message) -ForegroundColor Red
        Write-Host '没有强制覆盖原程序。网络不可达时可从同一GitHub Release页面获取完整离线安装包；不要使用源码ZIP代替安装包。'
        exit 1
    }
}
