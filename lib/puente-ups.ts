// Puente de UPS -> Accusys Cyber. Se instala en un servidor de la red que llegue a las UPS,
// las consulta por SNMP v2c (solo lectura) con la MIB estándar de UPS (RFC 1628) y envía los valores a la app.
// La lista de UPS se toma de la app en cada ejecución; la community queda solo en este servidor.
// Usa el mismo cliente SNMP que el puente de switches (va dentro del script, no se descarga nada).
// Reglas: el PowerShell es solo ASCII, sin la secuencia signo pesos + llave, sin comillas invertidas
// y sin here-strings (va dentro del here-string del instalador).
import { envolverEnCmd } from "./agente";
import { CLIENTE_SNMP } from "./puente-switches";

export const PUENTE_UPS_VERSION = "1.0";

const PUENTE = String.raw`# Puente de UPS -> Accusys Cyber: consulta las UPS por SNMP (solo lectura) y envia el estado a la app
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$Community   = '__COMMUNITY__'
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysPuenteUPS'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not ('SnmpAccusys' -as [type])) {
  try { Add-Type -TypeDefinition ([Text.Encoding]::ASCII.GetString([Convert]::FromBase64String('__CLIENTE__'))) -IgnoreWarnings }
  catch { Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' [cliente SNMP] ' + $_.Exception.Message); exit 1 }
}

# Lee toda la rama UPS-MIB (1.3.6.1.2.1.33.1): identificacion, bateria, entrada, salida, alarmas y test
function Consultar-Ups($obj, $Community) {
  $hostUps = [string]$obj.ip
  $puertoSnmp = 161
  if ($hostUps -match '^(.+):(\d+)$') { $hostUps = $Matches[1]; $puertoSnmp = [int]$Matches[2] }
  $r = [ordered]@{ id = $obj.id; ip = $obj.ip; ok = $false }
  try {
    $raiz = '1.3.6.1.2.1.33.1'
    $datos = [ordered]@{}
    foreach ($v in [SnmpAccusys]::Walk($hostUps, $puertoSnmp, $Community, $raiz, 600)) {
      $datos[[SnmpAccusys]::Sufijo($v, $raiz)] = [SnmpAccusys]::Texto($v)
    }
    if ($datos.Count -eq 0) { throw 'La UPS responde por SNMP pero no publica la MIB estandar de UPS (RFC 1628). Revisar la configuracion de la placa de red.' }
    $r.datos = $datos
    $r.ok = $true
  } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    $m = $e.Message
    if ($m -like 'Sin respuesta SNMP*') { $m = 'Sin respuesta SNMP (revisar IP, community y que la placa de red de la UPS permita consultas desde este servidor)' }
    $r.error = $m
  }
  return $r
}

$headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }
try {
  $objetivos = Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/ups_objetivos') -Headers $headers -Body ('{"p_token":' + (ConvertTo-Json $Token) + '}') -ContentType 'application/json; charset=utf-8' -TimeoutSec 60
  $resultados = New-Object System.Collections.ArrayList
  foreach ($o in @($objetivos)) { if ($o) { [void]$resultados.Add((Consultar-Ups $o $Community)) } }
  $datos = [ordered]@{ version = $Version; ups = $resultados }
  $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_datos":' + (ConvertTo-Json -InputObject $datos -Depth 6 -Compress) + '}'
  Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/ups_reportar') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 60 | Out-Null

  # Resumen legible para comparar con la pagina web de cada UPS
  $partes = @()
  foreach ($x in $resultados) {
    if ($x.ok) {
      $d = $x.datos
      $partes += ($x.ip + ': ' + $d['1.2.0'] + ' | bateria ' + $d['2.4.0'] + '% | autonomia ' + $d['2.3.0'] + ' min | carga ' + $d['4.4.1.5.1'] + '% | entrada ' + $d['3.3.1.3.1'] + ' V | ' + $d.Count + ' valores')
    } else { $partes += ($x.ip + ': ' + $x.error) }
  }
  if ($resultados.Count -eq 0) { $partes += 'No hay UPS cargadas en la app' }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value (@('OK ' + (Get-Date).ToString('s')) + $partes)
}
catch {
  $d = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $d = $d + ' | ' + $_.ErrorDetails.Message }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + ($d -replace '\s+', ' '))
  exit 1
}
`;

const INSTALADOR = String.raw`# Instalador del puente de UPS -> Accusys Cyber (ejecutar como administrador en un servidor de la red)
$ErrorActionPreference = 'Stop'
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Ejecuta este instalador como administrador.' -ForegroundColor Red; exit 1 }

$Carpeta = 'C:\ProgramData\AccusysPuenteUPS'
$Script  = Join-Path $Carpeta 'puente.ps1'
$Tarea   = 'AccusysPuenteUPS'

New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
# Carpeta solo para SYSTEM y Administradores: la community y el token no los puede leer un usuario comun
& icacls.exe $Carpeta /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
Get-ChildItem -Path $Carpeta -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
  & takeown.exe /F $_.FullName /A 2>&1 | Out-Null
  & icacls.exe $_.FullName /reset /Q 2>&1 | Out-Null
}

$puente = @'
__PUENTE__
'@
Set-Content -Path $Script -Value $puente -Encoding UTF8

$accion  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Script + '"')
$periodo = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes __INTERVALO__)
$inicio  = New-ScheduledTaskTrigger -AtStartup
$usuario = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$config  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $Tarea -Action $accion -Trigger @($periodo, $inicio) -Principal $usuario -Settings $config -Force | Out-Null
Start-ScheduledTask -TaskName $Tarea

Write-Host 'Consultando las UPS y enviando el primer estado...'
$espera = 0
while ($espera -lt 90) {
  Start-Sleep -Seconds 3; $espera += 3
  if ((Get-ScheduledTask -TaskName $Tarea).State -ne 'Running') { break }
}
Write-Host ''
Write-Host 'Puente instalado. Resultado del primer envio:' -ForegroundColor Green
Get-Content (Join-Path $Carpeta 'ultimo-envio.txt') -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Compara bateria, autonomia y carga con la pagina web de cada UPS.' -ForegroundColor Cyan
`;

const DESINSTALADOR = String.raw`# Desinstala el puente de UPS -> Accusys Cyber
Unregister-ScheduledTask -TaskName 'AccusysPuenteUPS' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysPuenteUPS' -ErrorAction SilentlyContinue
Write-Host 'Puente de UPS desinstalado.'
`;

// Los valores van entre comillas simples en PowerShell: se duplican las comillas simples
const ps = (v: string) => v.replace(/'/g, "''");
const base64 = (t: string) => (typeof btoa === "function" ? btoa(t) : Buffer.from(t, "latin1").toString("base64"));

export function generarPuenteUps(o: { url: string; anon: string; token: string; community: string; intervalo: number }) {
  const puente = PUENTE.replace("__URL__", () => ps(o.url.replace(/\/$/, "")))
    .replace("__ANON__", () => ps(o.anon))
    .replace("__TOKEN__", () => ps(o.token))
    .replace("__COMMUNITY__", () => ps(o.community))
    .replace("__VERSION__", () => PUENTE_UPS_VERSION)
    .replace("__CLIENTE__", () => base64(CLIENTE_SNMP));
  const instalador = INSTALADOR.replace("__PUENTE__", () => puente).replace("__INTERVALO__", () => String(o.intervalo));
  return envolverEnCmd("Instalador del puente de UPS de Accusys Cyber", instalador);
}

export function generarDesinstaladorPuenteUps() {
  return envolverEnCmd("Desinstalador del puente de UPS de Accusys Cyber", DESINSTALADOR);
}
