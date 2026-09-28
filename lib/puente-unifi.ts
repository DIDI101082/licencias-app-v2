// Puente UniFi (UDM Pro) -> Accusys Cyber. Se instala en un servidor o PC de la red que llegue a la UDM,
// consulta su API local con una clave de API (o un usuario local de solo lectura) y envía a la app:
// equipos UniFi, redes WiFi (sin contraseñas), clientes conectados y redes vecinas.
// Reglas: el PowerShell es solo ASCII, sin la secuencia signo pesos + llave, sin comillas invertidas
// y sin here-strings (va dentro del here-string del instalador).
import { envolverEnCmd } from "./agente";

export const PUENTE_UNIFI_VERSION = "1.0";

const PUENTE = String.raw`# Puente UniFi -> Accusys Cyber: envia el estado de la red UniFi a la app cada pocos minutos
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$UdmUrl      = '__UDM__'
$ApiKey      = '__APIKEY__'
$Usuario     = '__USUARIO__'
$Clave       = '__CLAVE__'
$IgnorarCert = __IGNORAR__
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysPuenteUnifi'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($IgnorarCert) {
  # La UDM usa un certificado propio: se acepta SOLO para la UDM; Supabase se valida normalmente
  $nl = [Environment]::NewLine
  $cs = @(
    'using System.Net;',
    'using System.Net.Security;',
    'using System.Security.Cryptography.X509Certificates;',
    'public static class CertUnifi {',
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
  if (-not ('CertUnifi' -as [type])) { Add-Type -TypeDefinition $cs }
  [CertUnifi]::Activar(([Uri]$UdmUrl).Host)
}

$Base = $UdmUrl.TrimEnd('/')
$sesion = $null
if (-not $ApiKey) {
  # Alternativa sin clave de API: usuario local de la UDM (conviene que sea de solo lectura)
  $login = ConvertTo-Json @{ username = $Usuario; password = $Clave; rememberMe = $false } -Compress
  Invoke-WebRequest -Uri ($Base + '/api/auth/login') -Method Post -Body $login -ContentType 'application/json' -SessionVariable sesion -UseBasicParsing -TimeoutSec 30 | Out-Null
}

function Unifi($ruta) {
  $u = $Base + '/proxy/network' + $ruta
  if ($ApiKey) {
    $r = Invoke-RestMethod -Uri $u -Method Get -Headers @{ 'X-API-KEY' = $ApiKey; 'Accept' = 'application/json' } -TimeoutSec 90
  } else {
    $r = Invoke-RestMethod -Uri $u -Method Get -WebSession $sesion -Headers @{ 'Accept' = 'application/json' } -TimeoutSec 90
  }
  if ($null -ne $r -and $r.PSObject.Properties['data']) { return @($r.data) }
  return @($r)
}
function Texto($v) { if ($null -eq $v) { return $null } return [string]$v }

$equipos = New-Object System.Collections.ArrayList
$redes   = New-Object System.Collections.ArrayList
$clientes = New-Object System.Collections.ArrayList
$vecinas = New-Object System.Collections.ArrayList
$avisos  = New-Object System.Collections.ArrayList

try {
  $sitios = @()
  try { $sitios = @(Unifi '/api/self/sites') } catch { $sitios = @(Unifi '/api/stat/sites') }

  foreach ($s in $sitios) {
    $sid = [string]$s.name
    if (-not $sid) { continue }
    $sitio = [string]$s.desc
    if (-not $sitio) { $sitio = $sid }

    foreach ($d in @(Unifi ('/api/s/' + $sid + '/stat/device'))) {
      $bss = @()
      if ($d.vap_table) { $bss = @($d.vap_table | ForEach-Object { [string]$_.bssid } | Where-Object { $_ }) }
      [void]$equipos.Add([ordered]@{
        sitio = $sitio; mac = (Texto $d.mac); nombre = (Texto $d.name); modelo = (Texto $d.model); tipo = (Texto $d.type)
        ip = (Texto $d.ip); firmware = (Texto $d.version); estado = $d.state; serie = (Texto $d.serial)
        actualizable = $d.upgradable; clientes = $d.num_sta; bssids = $bss
      })
    }

    foreach ($c in @(Unifi ('/api/s/' + $sid + '/stat/sta'))) {
      [void]$clientes.Add([ordered]@{
        sitio = $sitio; mac = (Texto $c.mac); hostname = (Texto $c.hostname); nombre = (Texto $c.name); ip = (Texto $c.ip)
        ssid = (Texto $c.essid); ap_mac = (Texto $c.ap_mac); sw_mac = (Texto $c.sw_mac); cableado = [bool]$c.is_wired
        invitado = [bool]$c.is_guest; fabricante = (Texto $c.oui); red = (Texto $c.network); senal = $c.signal
        primera = $c.first_seen; ultima = $c.last_seen
      })
    }

    # Redes WiFi: SOLO datos de configuracion. La contrasena (x_passphrase) nunca se envia.
    try {
      foreach ($w in @(Unifi ('/api/s/' + $sid + '/rest/wlanconf'))) {
        [void]$redes.Add([ordered]@{
          sitio = $sitio; ssid = (Texto $w.name); seguridad = (Texto $w.security); wpa = (Texto $w.wpa_mode)
          wpa3 = $w.wpa3_support; wpa3_transicion = $w.wpa3_transition; invitados = [bool]$w.is_guest
          habilitada = ($w.enabled -ne $false); oculta = $w.hide_ssid
        })
      }
    } catch { [void]$avisos.Add('redes WiFi: ' + $_.Exception.Message) }

    try {
      $ro = @(Unifi ('/api/s/' + $sid + '/stat/rogueap')) | Sort-Object -Property last_seen -Descending | Select-Object -First 1500
      foreach ($v in $ro) {
        $senal = $v.signal
        if ($null -eq $senal) { $senal = $v.rssi }
        [void]$vecinas.Add([ordered]@{
          sitio = $sitio; bssid = (Texto $v.bssid); ssid = (Texto $v.essid); canal = $v.channel; senal = $senal
          seguridad = (Texto $v.security); fabricante = (Texto $v.oui); visto_por = (Texto $v.ap_mac)
          es_rogue = [bool]$v.is_rogue; ultima = $v.last_seen
        })
      }
    } catch { [void]$avisos.Add('redes vecinas: ' + $_.Exception.Message) }
  }

  $datos = [ordered]@{ version = $Version; equipos = $equipos; redes = $redes; clientes = $clientes; vecinas = $vecinas }
  $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_datos":' + (ConvertTo-Json -InputObject $datos -Depth 6 -Compress) + '}'
  $headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }
  Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/unifi_reportar') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 90 | Out-Null
  $linea = 'OK ' + (Get-Date).ToString('s') + ' ' + $equipos.Count + ' equipos UniFi, ' + $clientes.Count + ' clientes, ' + $vecinas.Count + ' redes vecinas'
  if ($avisos.Count) { $linea = $linea + ' | avisos: ' + ($avisos -join '; ') }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value $linea
}
catch {
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
  exit 1
}
`;

const INSTALADOR = String.raw`# Instalador del puente UniFi -> Accusys Cyber (ejecutar como administrador en un servidor de la red)
$ErrorActionPreference = 'Stop'
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Ejecuta este instalador como administrador.' -ForegroundColor Red; exit 1 }

$Carpeta = 'C:\ProgramData\AccusysPuenteUnifi'
$Script  = Join-Path $Carpeta 'puente.ps1'
$Tarea   = 'AccusysPuenteUnifi'

New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
# Carpeta solo para SYSTEM y Administradores: la clave de la UDM y el token no los puede leer un usuario comun
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
$config  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $Tarea -Action $accion -Trigger @($periodo, $inicio) -Principal $usuario -Settings $config -Force | Out-Null
Start-ScheduledTask -TaskName $Tarea

Write-Host 'Consultando la UDM y enviando el primer estado...'
Start-Sleep -Seconds 25
Write-Host ''
Write-Host 'Puente instalado. Resultado del primer envio:' -ForegroundColor Green
Get-Content (Join-Path $Carpeta 'ultimo-envio.txt') -ErrorAction SilentlyContinue
`;

const DESINSTALADOR = String.raw`# Desinstala el puente UniFi -> Accusys Cyber
Unregister-ScheduledTask -TaskName 'AccusysPuenteUnifi' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysPuenteUnifi' -ErrorAction SilentlyContinue
Write-Host 'Puente UniFi desinstalado.'
`;

// Los valores van entre comillas simples en PowerShell: se duplican las comillas simples
const ps = (v: string) => v.replace(/'/g, "''");

export function generarPuenteUnifi(o: {
  url: string; anon: string; token: string; udmUrl: string; apiKey: string; usuario: string; clave: string;
  ignorarCert: boolean; intervalo: number;
}) {
  const puente = PUENTE.replace("__URL__", () => ps(o.url.replace(/\/$/, "")))
    .replace("__ANON__", () => ps(o.anon))
    .replace("__TOKEN__", () => ps(o.token))
    .replace("__UDM__", () => ps(o.udmUrl.replace(/\/$/, "")))
    .replace("__APIKEY__", () => ps(o.apiKey))
    .replace("__USUARIO__", () => ps(o.usuario))
    .replace("__CLAVE__", () => ps(o.clave))
    .replace("__IGNORAR__", () => (o.ignorarCert ? "$true" : "$false"))
    .replace("__VERSION__", () => PUENTE_UNIFI_VERSION);
  const instalador = INSTALADOR.replace("__PUENTE__", () => puente).replace("__INTERVALO__", () => String(o.intervalo));
  return envolverEnCmd("Instalador del puente UniFi de Accusys Cyber", instalador);
}

export function generarDesinstaladorPuenteUnifi() {
  return envolverEnCmd("Desinstalador del puente UniFi de Accusys Cyber", DESINSTALADOR);
}
