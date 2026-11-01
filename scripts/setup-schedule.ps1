# Lanbo 影视基地 - Windows 定时更新配置
# 以管理员或当前用户运行一次即可注册每天 8:00 / 13:00 / 18:00 的定时任务
# 用法: 右键 PowerShell 运行  scripts\setup-schedule.ps1

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $projectDir 'scripts\fetch.mjs'

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$script`"" -WorkingDirectory $projectDir
$triggers = @(
  New-ScheduledTaskTrigger -Daily -At '08:00'
  New-ScheduledTaskTrigger -Daily -At '13:00'
  New-ScheduledTaskTrigger -Daily -At '18:00'
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName 'LanboMoviesUpdate' -Action $action -Trigger $triggers -Settings $settings -Description 'Lanbo 影视基地每天三次更新豆瓣高分影视数据' -Force

Write-Host "✅ 定时任务 'LanboMoviesUpdate' 已注册：每天 08:00 / 13:00 / 18:00 自动更新"
Write-Host "   如需删除: Unregister-ScheduledTask -TaskName 'LanboMoviesUpdate'"
