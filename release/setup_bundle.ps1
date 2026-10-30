param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ExpectedHash = '__PAYLOAD_SHA256__'
$PayloadName = 'workbench.zip'
$PayloadFolder = '__PAYLOAD_FOLDER__'
$RunId = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$LogRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TemuWorkbenchInstaller\logs'
New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
$LogPath = Join-Path $LogRoot ($RunId + '.log')
$TranscriptStarted = $false
try {
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $TranscriptStarted = $true
    Write-Host '织品工作台：正在检查完整压缩包，请稍候……'
    $Payload = Join-Path $PSScriptRoot $PayloadName
    if (-not (Test-Path -LiteralPath $Payload -PathType Leaf)) {
        throw '缺少 workbench.zip。请完整解压新安装包，保留 INSTALL.cmd、setup.ps1 和 workbench.zip 在同一文件夹。'
    }
    # Use .NET directly: Windows PowerShell can inherit a module search path
    # from another host which makes the optional Get-FileHash cmdlet unavailable.
    $Hasher = [Security.Cryptography.SHA256]::Create()
    $PayloadStream = [IO.File]::OpenRead($Payload)
    try { $ActualHash = [BitConverter]::ToString($Hasher.ComputeHash($PayloadStream)).Replace('-', '').ToLowerInvariant() }
    finally { $PayloadStream.Dispose(); $Hasher.Dispose() }
    if ($ActualHash -ne $ExpectedHash) {
        throw ('workbench.zip 与发布文件不一致，请重新传输本次安装包。实际 SHA256：' + $ActualHash)
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead($Payload)
    try {
        $Prefix = $PayloadFolder + '/'
        $Longest = 0
        foreach ($Entry in $Zip.Entries) {
            if (-not $Entry.FullName.StartsWith($Prefix, [StringComparison]::Ordinal) -or
                $Entry.FullName.Contains('\') -or
                ($Entry.FullName.Split('/') | Where-Object { $_ -eq '..' -or $_.Contains(':') })) {
                throw ('压缩包路径不正确：' + $Entry.FullName)
            }
            $Longest = [Math]::Max($Longest, $Entry.FullName.Length)
        }
    } finally { $Zip.Dispose() }
    $CacheRoot = Join-Path ([IO.Path]::GetTempPath()) 'TW'
    $Stage = Join-Path $CacheRoot $RunId
    if (($Stage.Length + 1 + $Longest) -gt 250) {
        Add-Type -AssemblyName System.Windows.Forms
        $Picker = New-Object System.Windows.Forms.FolderBrowserDialog
        $Picker.Description = '临时目录路径过长，请选择较短、可写的临时解压位置（不会清理这里的旧文件）。'
        if ($Picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { throw '已取消选择临时解压目录。' }
        $Stage = Join-Path $Picker.SelectedPath ('TW-' + $RunId)
        $Picker.Dispose()
        if (($Stage.Length + 1 + $Longest) -gt 250) { throw '所选目录仍过长，请选择磁盘根目录下的短路径。' }
    }
    if (Test-Path -LiteralPath $Stage) { throw '临时目录已存在，请重新运行安装入口。' }
    New-Item -ItemType Directory -Path $Stage | Out-Null
    Write-Host ('正在自动解压到：' + $Stage)
    [IO.Compression.ZipFile]::ExtractToDirectory($Payload, $Stage)
    $Source = Join-Path $Stage $PayloadFolder
    $Python = Join-Path $Source 'runtime\python\python.exe'
    if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
        throw '解压后缺少 Python 运行文件；请查看 Windows 安全中心的保护历史是否隔离了文件。'
    }
    foreach ($Name in @('PYTHONHOME','PYTHONPATH','TCL_LIBRARY','TK_LIBRARY','TEMU_WORKBENCH_DATA')) {
        [Environment]::SetEnvironmentVariable($Name, $null, 'Process')
    }
    $env:PYTHONUTF8 = '1'
    $env:PYTHONDONTWRITEBYTECODE = '1'
    Write-Host '正在逐文件检查并验证安装窗口……'
    & $Python -E -X utf8 -B (Join-Path $Source 'install_workbench.py') --check 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw '解压后的文件检查失败。上方列出了具体文件；请保留本日志，旧工作台尚未因本次检查而改变。'
    }
    Write-Host '完整检查通过。'
    if ($CheckOnly) {
        Write-Output (@{ package_complete=$true; source=$Source; log=$LogPath; payload_sha256=$ActualHash } | ConvertTo-Json -Compress)
    } else {
        Write-Host '正在打开安装向导。首次使用保持推荐位置，点击“安装并打开”即可。'
        & $Python -E -X utf8 -B (Join-Path $Source 'install_workbench.py') 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw '安装向导未正常完成，请提供本日志。' }
    }
    Write-Host ('日志已保存：' + $LogPath)
    exit 0
} catch {
    Write-Host ''
    Write-Host ('安装未完成：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ('请把此日志发给提供者：' + $LogPath)
    exit 1
} finally {
    if ($TranscriptStarted) { Stop-Transcript | Out-Null }
}
