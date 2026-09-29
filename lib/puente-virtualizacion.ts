// Puente de virtualización y storage -> Accusys Cyber. Se instala en un servidor interno que llegue a vCenter y al storage.
// Lee vCenter con PowerCLI (usuario de solo lectura) y el storage IBM (V5000 / FlashSystem) con su API REST (usuario Monitor).
// No modifica nada. Las claves quedan solo en la carpeta protegida del servidor.
// Desde 1.1 también verifica los certificados internos cargados en Vencimientos (cada 6 horas).
// Reglas: el PowerShell es solo ASCII, sin la secuencia signo pesos + llave, sin comillas invertidas
// y sin here-strings (va dentro del here-string del instalador).
import { envolverEnCmd } from "./agente";

export const PUENTE_VIRT_VERSION = "1.1";

const PUENTE = String.raw`# Puente de virtualizacion y storage -> Accusys Cyber: lee vCenter (PowerCLI) y el storage IBM (API REST), solo lectura
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysPuenteVirtualizacion'
# vCenter (usuario de solo lectura) y storage (usuario con rol Monitor). Las claves quedan solo en este archivo.
$VCenter     = '__VCENTER__'
$VcUsuario   = '__VCUSUARIO__'
$VcClave     = '__VCCLAVE__'
$StoUrl      = '__STOURL__'
$StoUsuario  = '__STOUSUARIO__'
$StoClave    = '__STOCLAVE__'
$IgnorarCert = __IGNORAR__

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
$paso = 'inicio'
$avisos = New-Object System.Collections.ArrayList

function Iso($d) { if ($null -eq $d) { return $null } try { $x = [datetime]$d; if ($x.Year -lt 1990) { return $null } return $x.ToUniversalTime().ToString('o') } catch { return $null } }
function Num($v, $dec) { if ($null -eq $v -or [string]$v -eq '') { return $null } try { return [math]::Round([double]$v, $dec) } catch { return $null } }
function Prop($o, $n) { if ($null -ne $o -and $o.PSObject.Properties[$n]) { return $o.$n } return $null }
function Avisar($t) { [void]$avisos.Add($t) }

# ---------- vCenter ----------
function Leer-VCenter() {
  $script:paso = 'vCenter: PowerCLI'
  Import-Module VMware.VimAutomation.Core -ErrorAction Stop | Out-Null
  $cfg = @{ Scope = 'Session'; ParticipateInCEIP = $false; Confirm = $false }
  if ($IgnorarCert) { $cfg.InvalidCertificateAction = 'Ignore' }
  Set-PowerCLIConfiguration @cfg | Out-Null
  $script:paso = 'vCenter: conexion'
  $srv = Connect-VIServer -Server $VCenter -User $VcUsuario -Password $VcClave -ErrorAction Stop
  $r = [ordered]@{}
  try {
    $r.vcenter = [ordered]@{ nombre = [string]$srv.Name; version = [string]$srv.Version; build = [string]$srv.Build }

    $script:paso = 'vCenter: hosts'
    $r.hosts = @(Get-VMHost -Server $srv | ForEach-Object {
      $h = $_
      $ssh = $null; $shell = $null
      try {
        $svc = @(Get-VMHostService -VMHost $h -ErrorAction Stop)
        $s1 = $svc | Where-Object { $_.Key -eq 'TSM-SSH' } | Select-Object -First 1
        $s2 = $svc | Where-Object { $_.Key -eq 'TSM' } | Select-Object -First 1
        if ($s1) { $ssh = [ordered]@{ activo = [bool]$s1.Running; politica = [string]$s1.Policy } }
        if ($s2) { $shell = [ordered]@{ activo = [bool]$s2.Running; politica = [string]$s2.Policy } }
      } catch {}
      $ext = $h.ExtensionData
      $certVence = $null
      try { $cb = [byte[]]$ext.Config.Certificate; if ($cb) { $certVence = Iso ([System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cb)).NotAfter } } catch {}
      $sensores = @()
      try {
        $sensores = @($ext.Runtime.HealthSystemRuntime.SystemHealthInfo.NumericSensorInfo | Where-Object { $_.HealthState -and [string]$_.HealthState.Key -notin @('green', 'unknown') } |
          Select-Object -First 20 | ForEach-Object { [ordered]@{ nombre = [string]$_.Name; estado = [string]$_.HealthState.Key; tipo = [string]$_.SensorType } })
      } catch {}
      [ordered]@{
        nombre = [string]$h.Name; version = [string]$h.Version; build = [string]$h.Build; estado = [string]$h.ConnectionState
        energia = [string]$h.PowerState; fabricante = [string]$h.Manufacturer; modelo = [string]$h.Model
        cluster = [string](Prop $h.Parent 'Name'); salud = [string](Prop $ext 'OverallStatus')
        cpu_pct = $(if ($h.CpuTotalMhz) { Num (100 * $h.CpuUsageMhz / $h.CpuTotalMhz) 1 } else { $null })
        mem_pct = $(if ($h.MemoryTotalGB) { Num (100 * $h.MemoryUsageGB / $h.MemoryTotalGB) 1 } else { $null })
        mem_gb = Num $h.MemoryTotalGB 0; arranque = (Iso (Prop $ext.Runtime 'BootTime'))
        lockdown = [string](Prop $ext.Config 'LockdownMode'); ssh = $ssh; shell = $shell; cert_vence = $certVence; sensores = $sensores
      }
    })

    $script:paso = 'vCenter: maquinas virtuales'
    $vms = @(Get-VM -Server $srv)
    $r.vms = @($vms | ForEach-Object {
      $g = $_.ExtensionData.Guest
      $ip = $null
      try { $ip = @($_.Guest.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })[0] } catch {}
      [ordered]@{
        nombre = [string]$_.Name; host = [string](Prop $_.VMHost 'Name'); estado = [string]$_.PowerState; so = [string](Prop $_.Guest 'OSFullName')
        cpus = $_.NumCpu; mem_gb = Num $_.MemoryGB 1; disco_gb = Num $_.ProvisionedSpaceGB 0; usado_gb = Num $_.UsedSpaceGB 0
        tools = [string](Prop $g 'ToolsVersionStatus2'); tools_estado = [string](Prop $g 'ToolsRunningStatus'); ip = $ip
      }
    })

    $script:paso = 'vCenter: snapshots'
    $r.snapshots = @()
    try {
      $r.snapshots = @(Get-Snapshot -VM $vms -ErrorAction Stop | ForEach-Object {
        [ordered]@{ vm = [string]$_.VM.Name; nombre = [string]$_.Name; creado = (Iso $_.Created); tamano_gb = Num $_.SizeGB 1 }
      })
    } catch { Avisar ('snapshots: ' + $_.Exception.Message) }

    $script:paso = 'vCenter: datastores'
    $r.datastores = @(Get-Datastore -Server $srv | ForEach-Object {
      [ordered]@{ nombre = [string]$_.Name; tipo = [string]$_.Type; capacidad_gb = Num $_.CapacityGB 0; libre_gb = Num $_.FreeSpaceGB 0
        estado = [string]$_.State; hosts = @($_.ExtensionData.Host).Count }
    })

    $script:paso = 'vCenter: alarmas'
    $r.alarmas = @()
    try {
      $si = Get-View ServiceInstance -Server $srv
      $raiz = Get-View $si.Content.RootFolder -Server $srv
      $r.alarmas = @($raiz.TriggeredAlarmState | Select-Object -First 100 | ForEach-Object {
        $a = $_
        $nom = $null; $ent = $null
        try { $nom = (Get-View $a.Alarm -Property Info.Name -Server $srv).Info.Name } catch {}
        try { $ent = (Get-View $a.Entity -Property Name -Server $srv).Name } catch {}
        [ordered]@{ alarma = [string]$nom; entidad = [string]$ent; tipo = [string]$a.Entity.Type; estado = [string]$a.OverallStatus; fecha = (Iso $a.Time); reconocida = [bool]$a.Acknowledged }
      })
    } catch { Avisar ('alarmas: ' + $_.Exception.Message) }

    $script:paso = 'vCenter: licencias'
    $r.licencias = @()
    try {
      $lm = Get-View $si.Content.LicenseManager -Server $srv
      $r.licencias = @($lm.Licenses | Where-Object { $_.EditionKey -ne 'eval' } | ForEach-Object {
        $vto = $null
        foreach ($p in @($_.Properties)) { if ($p.Key -eq 'expirationDate') { $vto = Iso $p.Value } }
        [ordered]@{ producto = [string]$_.Name; edicion = [string]$_.EditionKey; usado = $_.Used; total = $_.Total; vence = $vto }
      })
    } catch { Avisar ('licencias: ' + $_.Exception.Message) }
  }
  finally { try { Disconnect-VIServer -Server $srv -Confirm:$false -Force | Out-Null } catch {} }
  return $r
}

# ---------- Storage IBM (Spectrum Virtualize: V5000 / FlashSystem) ----------
# Certificados internos cargados en Vencimientos (se leen desde la red interna, cada 6 horas)
function Certs-Internos() {
  $script:paso = 'certificados internos'
  $marca = Join-Path $Carpeta 'certificados-internos.txt'
  if ((Test-Path $marca) -and (((Get-Date) - (Get-Item $marca).LastWriteTime).TotalHours -lt 6)) { return $null }
  if (-not ('CertInterno' -as [type])) {
    $cs = @(
      'using System;', 'using System.Net.Sockets;', 'using System.Net.Security;', 'using System.Security.Authentication;',
      'using System.Security.Cryptography.X509Certificates;',
      'public static class CertInterno {',
      '  public static X509Certificate2 Leer(string host, int puerto, int ms) {',
      '    using (TcpClient tcp = new TcpClient()) {',
      '      IAsyncResult ar = tcp.BeginConnect(host, puerto, null, null);',
      '      if (!ar.AsyncWaitHandle.WaitOne(ms)) { throw new Exception("Sin respuesta en el puerto " + puerto); }',
      '      tcp.EndConnect(ar);',
      '      tcp.ReceiveTimeout = ms; tcp.SendTimeout = ms;',
      '      using (SslStream ssl = new SslStream(tcp.GetStream(), false, (a, b, c, d) => true)) {',
      '        ssl.AuthenticateAsClient(host, null, (SslProtocols)(3072 | 768 | 192), false);',
      '        if (ssl.RemoteCertificate == null) { throw new Exception("El servidor no presento certificado"); }',
      '        return new X509Certificate2(ssl.RemoteCertificate);',
      '      }',
      '    }',
      '  }',
      '}') -join [Environment]::NewLine
    Add-Type -TypeDefinition $cs
  }
  $headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }
  $lista = Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/venc_internos_pendientes') -Headers $headers -Body ('{"p_token":' + (ConvertTo-Json $Token) + '}') -ContentType 'application/json' -TimeoutSec 60
  $res = New-Object System.Collections.ArrayList
  foreach ($it in @($lista)) {
    if ($null -eq $it -or -not $it.host) { continue }
    $h = (([string]$it.host) -replace '^https?://', '') -replace '/.*$', ''
    $puerto = 443
    if ($h -match '^(.+):(\d+)$') { $h = $Matches[1]; $puerto = [int]$Matches[2] }
    try {
      $c = [CertInterno]::Leer($h, $puerto, 8000)
      $emisor = $c.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $true)
      [void]$res.Add([ordered]@{ id = $it.id; vence = $c.NotAfter.ToUniversalTime().ToString('o'); emisor = $emisor; error = $null })
    } catch {
      $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
      [void]$res.Add([ordered]@{ id = $it.id; vence = $null; emisor = $null; error = $e.Message })
    }
  }
  if ($res.Count) {
    $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_datos":' + (ConvertTo-Json -InputObject @($res) -Depth 4 -Compress) + '}'
    Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/venc_internos_reportar') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 60 | Out-Null
  }
  Set-Content -Path $marca -Value ('OK ' + (Get-Date).ToString('s') + ' ' + $res.Count + ' certificados')
  return $res.Count
}

function Bytes-GB($v) {
  if ($null -eq $v -or [string]$v -eq '') { return $null }
  $t = ([string]$v).Trim()
  if ($t -match '^\d+(\.\d+)?$') { return [math]::Round([double]$t / 1GB, 1) }
  if ($t -match '^([\d.]+)\s*(B|KB|MB|GB|TB|PB)$') {
    $m = @{ B = 1; KB = 1KB; MB = 1MB; GB = 1GB; TB = 1TB; PB = 1PB }
    return [math]::Round([double]$Matches[1] * $m[$Matches[2]] / 1GB, 1)
  }
  return $null
}
function Leer-Storage() {
  $script:paso = 'storage: autenticacion'
  $base = $StoUrl.TrimEnd('/')
  $auth = Invoke-RestMethod -Method Post -Uri ($base + '/rest/auth') -Headers @{ 'X-Auth-Username' = $StoUsuario; 'X-Auth-Password' = $StoClave } -TimeoutSec 60
  $tok = [string]$auth.token
  if (-not $tok) { throw 'El storage no devolvio token (revisar usuario y clave)' }
  $h = @{ 'X-Auth-Token' = $tok }
  function Sto($cmd, $cuerpo) {
    $script:paso = 'storage: ' + $cmd
    if ($null -eq $cuerpo) { $cuerpo = @{} }
    return @(Invoke-RestMethod -Method Post -Uri ($base + '/rest/' + $cmd) -Headers $h -Body (ConvertTo-Json $cuerpo -Compress) -ContentType 'application/json' -TimeoutSec 90)
  }
  function StoOpc($cmd, $cuerpo) { try { return (Sto $cmd $cuerpo) } catch { Avisar ($cmd + ': ' + $_.Exception.Message); return @() } }

  $r = [ordered]@{}
  $sys = @(Sto 'lssystem' $null)[0]
  $r.sistema = [ordered]@{ nombre = [string](Prop $sys 'name'); producto = [string](Prop $sys 'product_name'); version = [string](Prop $sys 'code_level')
    capacidad_gb = (Bytes-GB (Prop $sys 'total_mdisk_capacity')); libre_gb = (Bytes-GB (Prop $sys 'total_free_space')) }
  $r.pools = @(StoOpc 'lsmdiskgrp' $null | ForEach-Object {
    [ordered]@{ nombre = [string]$_.name; estado = [string]$_.status; capacidad_gb = (Bytes-GB $_.capacity); libre_gb = (Bytes-GB $_.free_capacity)
      usado_gb = (Bytes-GB $_.used_capacity); asignado_gb = (Bytes-GB $_.virtual_capacity) }
  })
  $r.discos = @(StoOpc 'lsdrive' $null | ForEach-Object {
    [ordered]@{ id = [string]$_.id; estado = [string]$_.status; uso = [string]$_.use; capacidad_gb = (Bytes-GB $_.capacity); tecnologia = [string]$_.tech_type
      gabinete = [string]$_.enclosure_id; bahia = [string]$_.slot_id; arreglo = [string]$_.mdisk_name }
  })
  $comp = New-Object System.Collections.ArrayList
  foreach ($n in (StoOpc 'lsnodecanister' $null)) { [void]$comp.Add([ordered]@{ tipo = 'nodo'; id = [string]$n.name; estado = [string]$n.status; detalle = $(if ([string]$n.config_node -eq 'yes') { 'nodo de configuracion' } else { $null }) }) }
  foreach ($n in (StoOpc 'lsenclosure' $null)) { [void]$comp.Add([ordered]@{ tipo = 'gabinete'; id = [string]$n.id; estado = [string]$n.status; detalle = [string](Prop $n 'product_MTM') }) }
  foreach ($n in (StoOpc 'lsenclosurepsu' $null)) { [void]$comp.Add([ordered]@{ tipo = 'fuente'; id = ([string]$n.enclosure_id + '-' + [string]$n.PSU_id); estado = [string]$n.status; detalle = $null }) }
  foreach ($n in (StoOpc 'lsenclosurebattery' $null)) { [void]$comp.Add([ordered]@{ tipo = 'bateria'; id = ([string]$n.enclosure_id + '-' + [string]$n.battery_id); estado = [string]$n.status; detalle = [string](Prop $n 'charging_status') }) }
  foreach ($n in (StoOpc 'lsmdisk' $null)) { [void]$comp.Add([ordered]@{ tipo = 'arreglo'; id = [string]$n.name; estado = [string]$n.status; detalle = [string](Prop $n 'mdisk_grp_name') }) }
  $r.componentes = $comp
  $r.volumenes = @(StoOpc 'lsvdisk' $null | ForEach-Object { [ordered]@{ nombre = [string]$_.name; estado = [string]$_.status; capacidad_gb = (Bytes-GB $_.capacity); pool = [string]$_.mdisk_grp_name } })
  $ev = @()
  try { $ev = @(Sto 'lseventlog' @{ fixed = 'no'; alert = 'yes' }) } catch { $ev = @(StoOpc 'lseventlog' $null | Where-Object { [string]$_.fixed -eq 'no' -and [string]$_.status -eq 'alert' }) }
  $r.eventos = @($ev | Select-Object -First 100 | ForEach-Object {
    $f = $null; $ts = [string]$_.last_timestamp
    if ($ts -match '^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$') { $f = ('20' + $Matches[1] + '-' + $Matches[2] + '-' + $Matches[3] + 'T' + $Matches[4] + ':' + $Matches[5] + ':' + $Matches[6]) }
    [ordered]@{ secuencia = [string]$_.sequence_number; fecha = $f; objeto = ([string]$_.object_type + ' ' + [string]$_.object_name).Trim(); codigo = [string]$_.error_code
      evento = [string]$_.event_id; descripcion = [string]$_.description }
  })
  return $r
}

# ---------- Certificados de fabrica: se aceptan solo para vCenter y el storage ----------
if ($IgnorarCert -and $StoUrl) {
  $cs = @(
    'using System.Net;', 'using System.Net.Security;', 'using System.Collections.Generic;', 'using System.Security.Cryptography.X509Certificates;',
    'public static class CertVirt {',
    '  public static HashSet<string> Hosts = new HashSet<string>(System.StringComparer.OrdinalIgnoreCase);',
    '  public static bool Validar(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) {',
    '    if (e == SslPolicyErrors.None) return true;',
    '    HttpWebRequest r = s as HttpWebRequest;',
    '    return r != null && Hosts.Contains(r.RequestUri.Host);',
    '  }',
    '  public static void Activar() { ServicePointManager.ServerCertificateValidationCallback = Validar; }',
    '}') -join [Environment]::NewLine
  if (-not ('CertVirt' -as [type])) { Add-Type -TypeDefinition $cs }
  [void][CertVirt]::Hosts.Add(([Uri]$StoUrl).Host)
  [CertVirt]::Activar()
}

try {
  $datos = [ordered]@{ version = $Version }
  $partes = @()
  if ($VCenter) {
    try { $v = Leer-VCenter; foreach ($k in $v.GetEnumerator()) { $datos[$k.Key] = $k.Value }; $partes += ('vCenter: ' + @($datos.hosts).Count + ' hosts, ' + @($datos.vms).Count + ' VMs') }
    catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; $datos.error_vcenter = ('[' + $paso + '] ' + $e.Message); $partes += ('vCenter ERROR: ' + $datos.error_vcenter) }
  }
  if ($StoUrl) {
    try { $datos.storage = Leer-Storage; $partes += ('storage: ' + @($datos.storage.discos).Count + ' discos, ' + @($datos.storage.pools).Count + ' pools') }
    catch {
      $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
      $d = $e.Message; if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $d = $d + ' | ' + $_.ErrorDetails.Message }
      $datos.error_storage = ('[' + $paso + '] ' + ($d -replace '\s+', ' ')); $partes += ('storage ERROR: ' + $datos.error_storage)
    }
  }
  $datos.avisos = @($avisos)

  $paso = 'envio a Accusys Cyber'
  $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_datos":' + (ConvertTo-Json -InputObject $datos -Depth 6 -Compress) + '}'
  $headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }
  Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/virt_reportar') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 120 | Out-Null
  try { $nc = Certs-Internos; if ($null -ne $nc) { $partes += ('certificados internos: ' + $nc) } }
  catch {
    $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
    $d = $e.Message; if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $d = $d + ' | ' + $_.ErrorDetails.Message }
    $partes += ('certificados internos ERROR: ' + ($d -replace '\s+', ' '))
  }
  $linea = 'OK ' + (Get-Date).ToString('s') + ' ' + ($partes -join ' | ')
  if ($avisos.Count) { $linea = $linea + ' | avisos: ' + ($avisos -join '; ') }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value $linea
}
catch {
  $d = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $d = $d + ' | ' + $_.ErrorDetails.Message }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' [' + $paso + '] ' + ($d -replace '\s+', ' '))
  exit 1
}
`;

const INSTALADOR = String.raw`# Instalador del puente de virtualizacion y storage -> Accusys Cyber (ejecutar como administrador en un servidor de la red)
$ErrorActionPreference = 'Stop'
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Ejecuta este instalador como administrador.' -ForegroundColor Red; exit 1 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (__CONVCENTER__ -and -not (Get-Module -ListAvailable -Name VMware.VimAutomation.Core)) {
  Write-Host 'Instalando VMware PowerCLI (una sola vez, puede tardar unos minutos)...'
  try {
    if (-not (Get-PackageProvider -ListAvailable -Name NuGet -ErrorAction SilentlyContinue)) { Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope AllUsers | Out-Null }
    Install-Module -Name VMware.PowerCLI -Scope AllUsers -Force -AllowClobber -SkipPublisherCheck
  } catch {
    Write-Host ('No se pudo instalar PowerCLI: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Este servidor necesita salida a Internet (PowerShell Gallery) una vez, o instalar PowerCLI a mano con:' -ForegroundColor Yellow
    Write-Host '  Install-Module VMware.PowerCLI -Scope AllUsers' -ForegroundColor Yellow
    exit 1
  }
}

$Carpeta = 'C:\ProgramData\AccusysPuenteVirtualizacion'
$Script  = Join-Path $Carpeta 'puente.ps1'
$Tarea   = 'AccusysPuenteVirtualizacion'

New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
# Carpeta solo para SYSTEM y Administradores: las claves no las puede leer un usuario comun
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
$config  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 12) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $Tarea -Action $accion -Trigger @($periodo, $inicio) -Principal $usuario -Settings $config -Force | Out-Null
Start-ScheduledTask -TaskName $Tarea

Write-Host 'Leyendo vCenter y el storage y enviando el primer estado (puede tardar un par de minutos)...'
$espera = 0
while ($espera -lt 300) {
  Start-Sleep -Seconds 5; $espera += 5
  if ((Get-ScheduledTask -TaskName $Tarea).State -ne 'Running') { break }
}
Write-Host ''
Write-Host 'Puente instalado. Resultado del primer envio:' -ForegroundColor Green
Get-Content (Join-Path $Carpeta 'ultimo-envio.txt') -ErrorAction SilentlyContinue
`;

const DESINSTALADOR = String.raw`# Desinstala el puente de virtualizacion y storage -> Accusys Cyber
Unregister-ScheduledTask -TaskName 'AccusysPuenteVirtualizacion' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysPuenteVirtualizacion' -ErrorAction SilentlyContinue
Write-Host 'Puente de virtualizacion y storage desinstalado.'
`;

// Los valores van entre comillas simples en PowerShell: se duplican las comillas simples
const ps = (v: string) => v.replace(/'/g, "''");
const conHttps = (u: string) => { const t = u.trim().replace(/\/+$/, ""); return !t ? "" : /^https?:\/\//i.test(t) ? t : "https://" + t; };

export function generarPuenteVirtualizacion(o: {
  url: string; anon: string; token: string; intervalo: number; ignorarCert: boolean;
  vcenter: string; vcUsuario: string; vcClave: string; stoUrl: string; stoUsuario: string; stoClave: string;
}) {
  const vc = o.vcenter.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const sto = o.stoUrl.trim() ? conHttps(o.stoUrl.includes(":", 8) ? o.stoUrl : o.stoUrl.trim().replace(/\/+$/, "") + ":7443") : "";
  const puente = PUENTE.replace("__URL__", () => ps(o.url.replace(/\/$/, "")))
    .replace("__ANON__", () => ps(o.anon))
    .replace("__TOKEN__", () => ps(o.token))
    .replace("__VERSION__", () => PUENTE_VIRT_VERSION)
    .replace("__VCENTER__", () => ps(vc))
    .replace("__VCUSUARIO__", () => ps(o.vcUsuario.trim()))
    .replace("__VCCLAVE__", () => ps(o.vcClave))
    .replace("__STOURL__", () => ps(sto))
    .replace("__STOUSUARIO__", () => ps(o.stoUsuario.trim()))
    .replace("__STOCLAVE__", () => ps(o.stoClave))
    .replace("__IGNORAR__", () => (o.ignorarCert ? "$true" : "$false"));
  const instalador = INSTALADOR.replace("__PUENTE__", () => puente).replace("__INTERVALO__", () => String(o.intervalo))
    .replace("__CONVCENTER__", () => (vc ? "$true" : "$false"));
  return envolverEnCmd("Instalador del puente de virtualizacion y storage de Accusys Cyber", instalador);
}

export function generarDesinstaladorPuenteVirtualizacion() {
  return envolverEnCmd("Desinstalador del puente de virtualizacion y storage de Accusys Cyber", DESINSTALADOR);
}
