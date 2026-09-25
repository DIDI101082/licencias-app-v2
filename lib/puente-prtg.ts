// Puente PRTG -> Accusys Cyber. Se instala en el servidor de PRTG (o en una PC de la red),
// consulta la API local de PRTG con una clave de SOLO LECTURA y envía el estado a la app.
// Reglas: el PowerShell es solo ASCII, sin la secuencia signo pesos + llave, sin comillas invertidas
// y sin here-strings (va dentro del here-string del instalador).
import { envolverEnCmd } from "./agente";

export const PUENTE_VERSION = "1.0";

const PUENTE = String.raw`# Puente PRTG -> Accusys Cyber: envia el estado de PRTG a la app cada pocos minutos
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$PrtgUrl     = '__PRTG__'
$PrtgClave   = '__PRTGKEY__'
$IgnorarCert = __IGNORAR__
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysPuentePRTG'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($IgnorarCert) {
  # Acepta el certificado propio SOLO para el servidor de PRTG; Supabase se valida normalmente
  $nl = [Environment]::NewLine
  $cs = @(
    'using System.Net;',
    'using System.Net.Security;',
    'using System.Security.Cryptography.X509Certificates;',
    'public static class CertPrtg {',
    '  public static string Servidor;',
    '  public static bool Validar(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) {',
    '    if (e == SslPolicyErrors.None) return true;',
    '    HttpWebRequest r = s as HttpWebRequest;',
    '    return r != null && string.Equals(r.RequestUri.Host, Servidor, System.StringComparison.OrdinalIgnoreCase);',
    '  }',
    '  public static void Activar(string servidor) {',
    '    Servidor = servidor;',
    '    ServicePointManager.ServerCertificateValidationCallback = Validar;',
    '  }',
    '}'
  ) -join $nl
  if (-not ('CertPrtg' -as [type])) { Add-Type -TypeDefinition $cs }
  [CertPrtg]::Activar(([Uri]$PrtgUrl).Host)
}

function Prtg($consulta) {
  $u = $PrtgUrl.TrimEnd('/') + '/api/table.json?' + $consulta + '&count=5000&apitoken=' + [Uri]::EscapeDataString($PrtgClave)
  Invoke-RestMethod -Uri $u -Method Get -TimeoutSec 90
}
function N($v) { if ($null -eq $v -or [string]$v -eq '') { 0 } else { [int]$v } }
function EstadoSensor($raw) {
  switch ([int]$raw) {
    3 { 'ok' } 4 { 'advertencia' } 5 { 'caido' } 10 { 'inusual' } 13 { 'caido_reconocido' } 14 { 'caido' }
    7 { 'pausado' } 8 { 'pausado' } 9 { 'pausado' } 12 { 'pausado' } default { 'desconocido' }
  }
}
function EstadoEquipo($d) {
  if (@(7, 8, 9, 12) -contains (N $d.status_raw)) { return 'pausado' }
  if ((N $d.downsens) + (N $d.partialdownsens) -gt 0) { return 'caido' }
  if ((N $d.downacksens) -gt 0) { return 'caido_reconocido' }
  if ((N $d.warnsens) -gt 0) { return 'advertencia' }
  if ((N $d.unusualsens) -gt 0) { return 'inusual' }
  if ((N $d.totalsens) -gt 0 -and (N $d.pausedsens) -ge (N $d.totalsens)) { return 'pausado' }
  if ((N $d.upsens) -gt 0) { return 'ok' }
  return 'desconocido'
}

try {
  $sondas = @((Prtg 'content=probenodes&columns=objid,name').probenodes | ForEach-Object {
    [ordered]@{ objid = N $_.objid; nombre = [string]$_.name }
  })
  $grupos = @((Prtg 'content=groups&columns=objid,name,parentid').groups | ForEach-Object {
    [ordered]@{ objid = N $_.objid; nombre = [string]$_.name; padre = N $_.parentid }
  })
  $cols = 'objid,name,host,parentid,group,probe,status_raw,upsens,warnsens,downsens,partialdownsens,downacksens,pausedsens,unusualsens,undefinedsens,totalsens,location'
  $equipos = @((Prtg ('content=devices&columns=' + $cols)).devices | ForEach-Object {
    [ordered]@{
      objid = N $_.objid; nombre = [string]$_.name; host = [string]$_.host; padre = N $_.parentid
      grupo = [string]$_.group; sonda = [string]$_.probe; estado = (EstadoEquipo $_)
      ok = N $_.upsens; advertencia = N $_.warnsens; caido = (N $_.downsens) + (N $_.partialdownsens) + (N $_.downacksens)
      inusual = N $_.unusualsens; pausado = N $_.pausedsens; total = N $_.totalsens
      ubicacion = [string]$_.location
    }
  })
  $filtro = 'filter_status=4&filter_status=5&filter_status=10&filter_status=13&filter_status=14'
  $sensores = @((Prtg ('content=sensors&columns=objid,name,parentid,status_raw,message_raw,lastvalue,downtimesince&' + $filtro)).sensors |
    Select-Object -First 500 | ForEach-Object {
      [ordered]@{
        objid = N $_.objid; nombre = [string]$_.name; dispositivo = N $_.parentid; estado = (EstadoSensor $_.status_raw)
        mensaje = ([string]$_.message_raw -replace '<[^>]+>', ''); valor = [string]$_.lastvalue; desde = [string]$_.downtimesince
      }
    })

  $datos = [ordered]@{ version = $Version; prtg = $PrtgUrl; sondas = $sondas; grupos = $grupos; dispositivos = $equipos; sensores = $sensores }
  $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_datos":' + (ConvertTo-Json -InputObject $datos -Depth 6 -Compress) + '}'
  $headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }
  Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/red_reportar_prtg') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 60 | Out-Null
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('OK ' + (Get-Date).ToString('s') + ' ' + $equipos.Count + ' equipos, ' + $sensores.Count + ' sensores con problemas')
}
catch {
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
  exit 1
}
`;

const INSTALADOR = String.raw`# Instalador del puente PRTG -> Accusys Cyber (ejecutar como administrador en el servidor de PRTG)
$ErrorActionPreference = 'Stop'
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Ejecuta este instalador como administrador.' -ForegroundColor Red; exit 1 }

$Carpeta = 'C:\ProgramData\AccusysPuentePRTG'
$Script  = Join-Path $Carpeta 'puente.ps1'
$Tarea   = 'AccusysPuentePRTG'

New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
# Carpeta solo para SYSTEM y Administradores: la clave de PRTG y el token no los puede leer un usuario comun
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

Write-Host 'Consultando PRTG y enviando el primer estado...'
Start-Sleep -Seconds 20
Write-Host ''
Write-Host 'Puente instalado. Resultado del primer envio:' -ForegroundColor Green
Get-Content (Join-Path $Carpeta 'ultimo-envio.txt') -ErrorAction SilentlyContinue
`;

const DESINSTALADOR = String.raw`# Desinstala el puente PRTG -> Accusys Cyber
Unregister-ScheduledTask -TaskName 'AccusysPuentePRTG' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysPuentePRTG' -ErrorAction SilentlyContinue
Write-Host 'Puente desinstalado.'
`;

// Los valores van entre comillas simples en PowerShell: se duplican las comillas simples
const ps = (v: string) => v.replace(/'/g, "''");

export function generarPuente(o: {
  url: string; anon: string; token: string; prtgUrl: string; prtgClave: string; ignorarCert: boolean; intervalo: number;
}) {
  const puente = PUENTE.replace("__URL__", () => ps(o.url.replace(/\/$/, "")))
    .replace("__ANON__", () => ps(o.anon))
    .replace("__TOKEN__", () => ps(o.token))
    .replace("__PRTG__", () => ps(o.prtgUrl.replace(/\/$/, "")))
    .replace("__PRTGKEY__", () => ps(o.prtgClave))
    .replace("__IGNORAR__", () => (o.ignorarCert ? "$true" : "$false"))
    .replace("__VERSION__", () => PUENTE_VERSION);
  const instalador = INSTALADOR.replace("__PUENTE__", () => puente).replace("__INTERVALO__", () => String(o.intervalo));
  return envolverEnCmd("Instalador del puente PRTG de Accusys Cyber", instalador);
}

export function generarDesinstaladorPuente() {
  return envolverEnCmd("Desinstalador del puente PRTG de Accusys Cyber", DESINSTALADOR);
}
