// Script para el servidor de Veeam Backup & Replication: lee el resultado de los trabajos
// con el módulo de PowerShell de Veeam y lo envía a Accusys Cyber. Corre como tarea programada cada hora.
// Solo ASCII en el PowerShell (sin tildes) para evitar problemas de codificación en Windows PowerShell 5.1.

export const VEEAM_VERSION = "1.0";

const SCRIPT = String.raw`# Accusys Cyber - reporte de backups de Veeam (version __VERSION__)
# Se ejecuta en el servidor de Veeam Backup & Replication como tarea programada.
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysBackups'
$Log         = Join-Path $Carpeta 'reporte.log'

New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
function Log($t) { Add-Content -Path $Log -Value ((Get-Date -Format 's') + '  ' + $t) }
if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 1MB) { Remove-Item $Log -Force }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

try {
  if (Get-Module -ListAvailable -Name Veeam.Backup.PowerShell) {
    Import-Module Veeam.Backup.PowerShell -WarningAction SilentlyContinue -DisableNameChecking
  } else {
    Add-PSSnapin VeeamPSSnapin
  }
} catch {
  Log ('No se pudo cargar el modulo de PowerShell de Veeam: ' + $_.Exception.Message)
  exit 1
}

function Utc($d) {
  if ($null -ne $d -and $d -is [datetime] -and $d.Year -gt 2000) { return $d.ToUniversalTime().ToString('o') }
  return $null
}
function Motivo($s) {
  $m = $null
  try { $m = $s.Info.Reason } catch {}
  if (-not $m) { try { $m = $s.Description } catch {} }
  if ($m) { $m = ([string]$m -replace '\s+', ' ').Trim(); if ($m.Length -gt 400) { $m = $m.Substring(0, 400) } }
  return $m
}

$desde = (Get-Date).AddDays(-14)
$trabajos = New-Object System.Collections.ArrayList

# Trabajos de VM, archivos y copias
try {
  $sesiones = @(Get-VBRBackupSession | Where-Object { $_.CreationTime -gt $desde })
  foreach ($j in @(Get-VBRJob -WarningAction SilentlyContinue)) {
    $propias = @($sesiones | Where-Object { $_.JobId -eq $j.Id } | Sort-Object CreationTime -Descending)
    $ultima = $propias | Select-Object -First 1
    $exito = $propias | Where-Object { [string]$_.Result -in @('Success', 'Warning') } | Select-Object -First 1
    $hab = $true
    try { $hab = [bool]$j.IsScheduleEnabled } catch {}
    [void]$trabajos.Add(@{
      nombre = $j.Name; tipo = [string]$j.JobType; habilitado = $hab
      resultado = $(if ($ultima) { [string]$ultima.Result } else { $null })
      inicio = $(if ($ultima) { Utc $ultima.CreationTime } else { $null })
      fin = $(if ($ultima) { Utc $ultima.EndTime } else { $null })
      ultimo_exito = $(if ($exito) { Utc $exito.EndTime } else { $null })
      detalle = $(if ($ultima -and [string]$ultima.Result -ne 'Success') { Motivo $ultima } else { $null })
    })
  }
} catch { Log ('Error leyendo trabajos de VM: ' + $_.Exception.Message) }

# Trabajos de agentes (equipos fisicos / servidores con Veeam Agent administrados por el servidor)
try {
  if (Get-Command Get-VBRComputerBackupJob -ErrorAction SilentlyContinue) {
    foreach ($j in @(Get-VBRComputerBackupJob)) {
      $propias = @(Get-VBRComputerBackupJobSession -Name $j.Name -ErrorAction SilentlyContinue | Where-Object { $_.CreationTime -gt $desde } | Sort-Object CreationTime -Descending)
      $ultima = $propias | Select-Object -First 1
      $exito = $propias | Where-Object { [string]$_.Result -in @('Success', 'Warning') } | Select-Object -First 1
      $hab = $true
      try { $hab = [bool]$j.JobEnabled } catch {}
      [void]$trabajos.Add(@{
        nombre = $j.Name; tipo = 'Agente'; habilitado = $hab
        resultado = $(if ($ultima) { [string]$ultima.Result } else { $null })
        inicio = $(if ($ultima) { Utc $ultima.CreationTime } else { $null })
        fin = $(if ($ultima) { Utc $ultima.EndTime } else { $null })
        ultimo_exito = $(if ($exito) { Utc $exito.EndTime } else { $null })
        detalle = $null
      })
    }
  }
} catch { Log ('Error leyendo trabajos de agentes: ' + $_.Exception.Message) }

$verVeeam = $null
try { $verVeeam = (Get-Item 'C:\Program Files\Veeam\Backup and Replication\Backup\Veeam.Backup.Shell.exe').VersionInfo.ProductVersion } catch {}

$cuerpo = @{ p_token = $Token; p_datos = @{ servidor = $env:COMPUTERNAME; version = $verVeeam; script = $Version; trabajos = $trabajos } }
$json = ConvertTo-Json $cuerpo -Depth 6 -Compress
try {
  $r = Invoke-RestMethod -Method Post -Uri ($SupabaseUrl.TrimEnd('/') + '/rest/v1/rpc/backups_reportar') -TimeoutSec 60 -Headers @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
  Log ('OK: ' + $trabajos.Count + ' trabajos enviados')
} catch {
  Log ('Error enviando a Accusys Cyber: ' + $_.Exception.Message)
  exit 1
}
`;

export function generarScriptVeeam(p: { url: string; anon: string; token: string }) {
  return SCRIPT.replaceAll("__URL__", p.url).replaceAll("__ANON__", p.anon).replaceAll("__TOKEN__", p.token).replaceAll("__VERSION__", VEEAM_VERSION)
    .replace(/\n/g, "\r\n");
}

export const TAREA_VEEAM =
  'schtasks /Create /F /TN "Accusys Cyber - Backups Veeam" /SC HOURLY /RU SYSTEM /RL HIGHEST ' +
  '/TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\AccusysBackups\\reporte-veeam.ps1"';
