// Puente de temperatura y humedad -> Accusys Cyber. Se instala en un servidor de la red que llegue a los sensores,
// los consulta por SNMP (v2c, o v1 si el equipo no habla v2c) en modo solo lectura y envía todo lo numérico
// que publican en su rama de fabricante (1.3.6.1.4.1). En la app se elige qué valor es la temperatura y cuál
// la humedad, así funciona con sensores que no publican su MIB (como el Xiolab Sense).
// Reglas: el PowerShell es solo ASCII, sin la secuencia signo pesos + llave, sin comillas invertidas
// y sin here-strings (va dentro del here-string del instalador).
import { envolverEnCmd } from "./agente";
import { CLIENTE_SNMP } from "./puente-switches";

export const PUENTE_AMBIENTE_VERSION = "1.0";

const PUENTE = String.raw`# Puente de temperatura y humedad -> Accusys Cyber: lee los sensores por SNMP (solo lectura) y envia los valores
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$Community   = '__COMMUNITY__'
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysPuenteAmbiente'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not ('SnmpAccusys' -as [type])) {
  try { Add-Type -TypeDefinition ([Text.Encoding]::ASCII.GetString([Convert]::FromBase64String('__CLIENTE__'))) -IgnoreWarnings }
  catch { Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' [cliente SNMP] ' + $_.Exception.Message); exit 1 }
}
[SnmpAccusys]::Timeout = 2000
[SnmpAccusys]::Reintentos = 1

# Lee la rama del fabricante y se queda con los valores que tienen numeros (temperatura, humedad, estados)
function Leer-Rama($h, $p, $ver) {
  [SnmpAccusys]::Version = $ver
  $datos = [ordered]@{}
  foreach ($v in [SnmpAccusys]::Walk($h, $p, $Community, '1.3.6.1.4.1', 400)) {
    $t = [SnmpAccusys]::Texto($v)
    if ($t -match '\d' -and $t.Length -le 32) { $datos[$v.Oid] = $t }
  }
  $descr = ''
  try { $s = [SnmpAccusys]::Get($h, $p, $Community, [string[]]@('1.3.6.1.2.1.1.1.0')); if ($s.Count) { $descr = [SnmpAccusys]::Texto($s[0]) } } catch {}
  return @{ datos = $datos; descr = $descr }
}

function Consultar-Sensor($obj) {
  $h = [string]$obj.ip
  $p = 161
  if ($h -match '^(.+):(\d+)$') { $h = $Matches[1]; $p = [int]$Matches[2] }
  $r = [ordered]@{ ip = $obj.ip; ok = $false }
  # Primero la version que funciono la vez anterior; si no responde, la otra
  $orden = @(1, 0)
  if ([string]$obj.version -eq '1') { $orden = @(0, 1) }
  $ultimo = ''
  foreach ($ver in $orden) {
    try {
      $x = Leer-Rama $h $p $ver
      if ($x.datos.Count -eq 0) { throw 'El sensor responde por SNMP pero no publico valores en la rama del fabricante' }
      $r.datos = $x.datos
      $r.sys_descr = $x.descr
      $r.version = $(if ($ver -eq 0) { '1' } else { '2c' })
      $r.ok = $true
      return $r
    } catch {
      $e = $_.Exception
      while ($e.InnerException) { $e = $e.InnerException }
      $ultimo = $e.Message
      if ($ultimo -like 'Sin respuesta SNMP*') { $ultimo = 'Sin respuesta SNMP (revisar IP, community y que el sensor permita consultas desde este servidor)' }
    }
  }
  $r.error = $ultimo
  return $r
}

$headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }
try {
  $objetivos = Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/amb_objetivos') -Headers $headers -Body ('{"p_token":' + (ConvertTo-Json $Token) + '}') -ContentType 'application/json; charset=utf-8' -TimeoutSec 60
  $resultados = New-Object System.Collections.ArrayList
  foreach ($o in @($objetivos)) { if ($o) { [void]$resultados.Add((Consultar-Sensor $o)) } }
  $datos = [ordered]@{ version = $Version; equipos = $resultados }
  $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_datos":' + (ConvertTo-Json -InputObject $datos -Depth 6 -Compress) + '}'
  Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/amb_reportar') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 60 | Out-Null

  $partes = @()
  foreach ($x in $resultados) {
    if ($x.ok) { $partes += ($x.ip + ': ' + $x.datos.Count + ' valores leidos por SNMP v' + $x.version + ' (' + $x.sys_descr + ')') }
    else { $partes += ($x.ip + ': ' + $x.error) }
  }
  if ($resultados.Count -eq 0) { $partes += 'No hay sensores cargados en la app' }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value (@('OK ' + (Get-Date).ToString('s')) + $partes)
}
catch {
  $d = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $d = $d + ' | ' + $_.ErrorDetails.Message }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + ($d -replace '\s+', ' '))
  exit 1
}
`;

const INSTALADOR = String.raw`# Instalador del puente de temperatura y humedad -> Accusys Cyber (ejecutar como administrador en un servidor de la red)
$ErrorActionPreference = 'Stop'
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Ejecuta este instalador como administrador.' -ForegroundColor Red; exit 1 }

$Carpeta = 'C:\ProgramData\AccusysPuenteAmbiente'
$Script  = Join-Path $Carpeta 'puente.ps1'
$Tarea   = 'AccusysPuenteAmbiente'

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

Write-Host 'Leyendo los sensores y enviando el primer estado...'
$espera = 0
while ($espera -lt 90) {
  Start-Sleep -Seconds 3; $espera += 3
  if ((Get-ScheduledTask -TaskName $Tarea).State -ne 'Running') { break }
}
Write-Host ''
Write-Host 'Puente instalado. Resultado del primer envio:' -ForegroundColor Green
Get-Content (Join-Path $Carpeta 'ultimo-envio.txt') -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Ahora, en la app, elegi cual de los valores leidos es la temperatura y cual la humedad.' -ForegroundColor Cyan
`;

const DESINSTALADOR = String.raw`# Desinstala el puente de temperatura y humedad -> Accusys Cyber
Unregister-ScheduledTask -TaskName 'AccusysPuenteAmbiente' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysPuenteAmbiente' -ErrorAction SilentlyContinue
Write-Host 'Puente de temperatura y humedad desinstalado.'
`;

// Los valores van entre comillas simples en PowerShell: se duplican las comillas simples
const ps = (v: string) => v.replace(/'/g, "''");
const base64 = (t: string) => (typeof btoa === "function" ? btoa(t) : Buffer.from(t, "latin1").toString("base64"));

export function generarPuenteAmbiente(o: { url: string; anon: string; token: string; community: string; intervalo: number }) {
  const puente = PUENTE.replace("__URL__", () => ps(o.url.replace(/\/$/, "")))
    .replace("__ANON__", () => ps(o.anon))
    .replace("__TOKEN__", () => ps(o.token))
    .replace("__COMMUNITY__", () => ps(o.community))
    .replace("__VERSION__", () => PUENTE_AMBIENTE_VERSION)
    .replace("__CLIENTE__", () => base64(CLIENTE_SNMP));
  const instalador = INSTALADOR.replace("__PUENTE__", () => puente).replace("__INTERVALO__", () => String(o.intervalo));
  return envolverEnCmd("Instalador del puente de temperatura y humedad de Accusys Cyber", instalador);
}

export function generarDesinstaladorPuenteAmbiente() {
  return envolverEnCmd("Desinstalador del puente de temperatura y humedad de Accusys Cyber", DESINSTALADOR);
}
