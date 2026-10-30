param(
    [string]$SupervisorTaskName = 'Temu Workbench Supervisor',
    [string]$RecoveryTaskName = 'Temu Workbench Supervisor Recovery'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonw = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\pythonw.exe'
$ensureSupervisor = Join-Path $root 'ensure_supervisor.py'
$supervisor = Join-Path $root 'service_supervisor.py'

if (-not (Test-Path -LiteralPath $pythonw -PathType Leaf)) {
    throw "Workbench Python runtime not found: $pythonw"
}
if (-not (Test-Path -LiteralPath $ensureSupervisor -PathType Leaf)) {
    throw "Workbench supervisor recovery script not found: $ensureSupervisor"
}
if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) {
    throw "Workbench supervisor not found: $supervisor"
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$supervisorAction = New-ScheduledTaskAction -Execute $pythonw -Argument ('"{0}"' -f $supervisor) -WorkingDirectory $root
$recoveryAction = New-ScheduledTaskAction -Execute $pythonw -Argument ('"{0}"' -f $ensureSupervisor) -WorkingDirectory $root
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$periodicTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5) `
    -RepetitionInterval (New-TimeSpan -Minutes 1)
$recoveryTriggers = @($logonTrigger, $periodicTrigger)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$supervisorSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)
$recoverySettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -MultipleInstances IgnoreNew
$supervisorTask = New-ScheduledTask -Action $supervisorAction -Trigger $logonTrigger `
    -Principal $principal -Settings $supervisorSettings `
    -Description 'Runs the D-drive Temu workbench supervisor.'
$recoveryTask = New-ScheduledTask -Action $recoveryAction -Trigger $recoveryTriggers `
    -Principal $principal -Settings $recoverySettings `
    -Description 'Checks every minute and starts the supervisor task if its exact process is missing.'

Register-ScheduledTask -TaskName $SupervisorTaskName -InputObject $supervisorTask -Force | Out-Null
Register-ScheduledTask -TaskName $RecoveryTaskName -InputObject $recoveryTask -Force | Out-Null
Start-ScheduledTask -TaskName $SupervisorTaskName
Get-ScheduledTask -TaskName $SupervisorTaskName, $RecoveryTaskName | Get-ScheduledTaskInfo
