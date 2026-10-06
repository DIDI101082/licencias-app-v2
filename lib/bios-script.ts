// Script que corre en cada notebook (PDQ Deploy, como SYSTEM) para ponerle su clave de BIOS.
// No lleva ningún secreto: el equipo se identifica con la clave propia del agente (equipo.key).
// Nota: el código PowerShell es solo ASCII (sin tildes) para que Windows PowerShell 5.1 lo lea bien.

const SCRIPT = String.raw`# Clave de BIOS por equipo - Accusys Cyber
# Va en la misma carpeta que cctk.exe (Dell Command | Configure). Ejecutar como SYSTEM o administrador.
#   powershell -ExecutionPolicy Bypass -File bios-clave.ps1
#   powershell -ExecutionPolicy Bypass -File bios-clave.ps1 -ClaveAnterior "clave actual"   (equipos que ya tienen una)
param([string]$ClaveAnterior = '')
$ErrorActionPreference = 'Stop'
$App          = '__APP__'
$ArchivoClave = 'C:\ProgramData\AccusysAgente\equipo.key'
$Cctk         = Join-Path $PSScriptRoot 'cctk.exe'

function Salir($codigo, $texto) { Write-Output $texto; exit $codigo }

if (-not (Test-Path $Cctk)) { Salir 11 'No se encontro cctk.exe junto al script.' }
if (-not (Test-Path $ArchivoClave)) { Salir 10 'El agente de Accusys no esta instalado o todavia no reporto.' }
$Secreto = (Get-Content -Path $ArchivoClave -Raw).Trim()
$csp = Get-CimInstance Win32_ComputerSystemProduct
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Llamar($datos) {
  $datos.uuid = [string]$csp.UUID
  $datos.hostname = $env:COMPUTERNAME
  $datos.secreto = $Secreto
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($datos | ConvertTo-Json -Compress))
  Invoke-RestMethod -Method Post -Uri ($App + '/api/bios/clave') -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
}
function Motivo($e) {
  try { return [string](($e.ErrorDetails.Message | ConvertFrom-Json).error) } catch { return [string]$e.Exception.Message }
}
function Ejecutar($argumentos) {
  $p = Start-Process -FilePath $Cctk -ArgumentList $argumentos -Wait -PassThru -WindowStyle Hidden
  return $p.ExitCode
}

try { $r = Llamar @{ accion = 'reservar' } } catch { Salir 20 ('La app no entrego la clave: ' + (Motivo $_)) }
$clave = [string]$r.clave
if (-not $clave) { Salir 21 'La app no devolvio una clave.' }

# 1) equipo sin clave  2) equipo con la clave anterior indicada  3) reintento: ya tiene la clave nueva
$intentos = @(, @("--SetupPwd=$clave"))
if ($ClaveAnterior) { $intentos += , @("--SetupPwd=$clave", "--ValSetupPwd=$ClaveAnterior") }
$intentos += , @("--SetupPwd=$clave", "--ValSetupPwd=$clave")

$codigo = -1
foreach ($a in $intentos) {
  $codigo = Ejecutar $a
  if ($codigo -eq 0) { break }
}

if ($codigo -ne 0) {
  $clave = $null
  try { Llamar @{ accion = 'confirmar'; ok = $false; usb = $false; detalle = ('cctk devolvio ' + $codigo + ' (el equipo puede tener otra clave de BIOS)') } | Out-Null } catch { }
  Salir 30 ('No se pudo aplicar la clave de BIOS. cctk devolvio ' + $codigo)
}

$usb = Ejecutar @('--UsbEmu=Disabled', "--ValSetupPwd=$clave")
$clave = $null
try {
  Llamar @{ accion = 'confirmar'; ok = $true; usb = ($usb -eq 0); detalle = '' } | Out-Null
} catch {
  Salir 40 ('La clave se aplico pero no se pudo avisar a la app: ' + (Motivo $_) + '. Volve a ejecutar el paquete.')
}
Salir 0 ('Clave de BIOS aplicada. Arranque por USB deshabilitado: ' + $(if ($usb -eq 0) { 'si' } else { 'no (cctk devolvio ' + $usb + ')' }))
`;

export const generarScriptBios = (urlApp: string) => SCRIPT.replace("__APP__", urlApp.replace(/\/+$/, ""));
