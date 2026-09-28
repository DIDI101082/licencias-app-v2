// Puente FortiGate -> Accusys Cyber. Se instala en un servidor interno que llegue a la interfaz de administración
// de cada FortiGate, los lee por su API REST con un usuario de API de solo lectura y envía el estado a la app.
// Las claves de API quedan solo en ese servidor (carpeta protegida); a la app llega únicamente el resultado.
// El backup de configuración (opcional) también queda en el servidor: a la app solo va qué líneas cambiaron,
// con contraseñas, claves y communities tapadas.
// Reglas: el PowerShell es solo ASCII, sin la secuencia signo pesos + llave, sin comillas invertidas
// y sin here-strings (va dentro del here-string del instalador).
import { envolverEnCmd } from "./agente";

export const PUENTE_FORTIGATE_VERSION = "1.4";

export type EquipoFortiGate = {
  nombre: string;       // cómo se va a ver en la app (ej. "Reconquista")
  url: string;          // https://ip-de-administracion[:puerto]
  clave: string;        // token del usuario de API REST
  ignorarCert: boolean; // aceptar el certificado de fábrica del FortiGate (solo para esa dirección)
  backup: boolean;      // bajar la configuración para detectar cambios (requiere permiso de backup)
};

const PUENTE = String.raw`# Puente FortiGate -> Accusys Cyber: lee el estado de los FortiGate por su API REST (solo lectura) y lo envia a la app
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysPuenteFortiGate'
# Equipos: nombre, direccion y clave de API de cada FortiGate (la clave queda solo en este archivo)
$Equipos = @(
__EQUIPOS__
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# Los FortiGate suelen usar su certificado de fabrica: se acepta SOLO para sus direcciones; Supabase se valida normalmente
$nl = [Environment]::NewLine
$cs = @(
  'using System.Net;',
  'using System.Net.Security;',
  'using System.Collections.Generic;',
  'using System.Security.Cryptography.X509Certificates;',
  'public static class CertForti {',
  '  public static HashSet<string> Hosts = new HashSet<string>(System.StringComparer.OrdinalIgnoreCase);',
  '  public static bool Validar(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) {',
  '    if (e == SslPolicyErrors.None) return true;',
  '    HttpWebRequest r = s as HttpWebRequest;',
  '    return r != null && Hosts.Contains(r.RequestUri.Host);',
  '  }',
  '  public static void Activar() { ServicePointManager.ServerCertificateValidationCallback = Validar; }',
  '}'
) -join $nl
if (-not ('CertForti' -as [type])) { Add-Type -TypeDefinition $cs }
foreach ($e in $Equipos) { if ($e.ignorarCert) { [void][CertForti]::Hosts.Add(([Uri]$e.url).Host) } }
[CertForti]::Activar()

$avisos = $null
function Api($eq, $ruta) {
  $u = $eq.url.TrimEnd('/') + $ruta
  return Invoke-RestMethod -Uri $u -Method Get -Headers @{ Authorization = ('Bearer ' + $eq.clave); Accept = 'application/json' } -TimeoutSec 90
}
function Intentar($eq, $ruta, $parte) {
  try { return (Api $eq $ruta) } catch {
    $m = $_.Exception.Message
    try { $st = [int]$_.Exception.Response.StatusCode; if ($st -eq 401 -or $st -eq 403) { $m = 'sin permiso (' + $st + ')' } elseif ($st -eq 404) { $m = 'no disponible en esta version (404)' } } catch {}
    [void]$script:avisos.Add($parte + ': ' + $m)
    return $null
  }
}
function Nombres($lista) { return @($lista | ForEach-Object { [string]$_.name }) -join ', ' }
function Prop($o, $n) { if ($null -ne $o -and $o.PSObject.Properties[$n]) { return $o.$n } return $null }
# Resultados que FortiOS devuelve como lista o como objeto con una propiedad por nombre -> tabla nombre = objeto
function Mapa($res, $campos) {
  $m = @{}
  if ($null -eq $res) { return $m }
  if ($res -is [array]) {
    foreach ($x in $res) { foreach ($c in $campos) { $n = [string](Prop $x $c); if ($n) { $m[$n] = $x; break } } }
  } else {
    foreach ($p in $res.PSObject.Properties) { if ($p.Value -is [psobject]) { $m[[string]$p.Name] = $p.Value } }
  }
  return $m
}
# Primer campo con valor entre varios nombres posibles
function Primero($o, $campos) { foreach ($c in $campos) { $v = Prop $o $c; if ($null -ne $v -and [string]$v -ne '') { return $v } } return $null }
# Guarda una muestra de la respuesta en el servidor (una sola vez) para poder ajustar el puente a la version de FortiOS
function Muestra($eq, $nombre, $obj) {
  try {
    $dir = Join-Path $Carpeta 'muestras'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $arch = Join-Path $dir (($eq.nombre -replace '[^A-Za-z0-9]', '_') + '-' + $nombre + '.json')
    if (-not (Test-Path $arch) -and $null -ne $obj) { Set-Content -Path $arch -Value (ConvertTo-Json -InputObject $obj -Depth 6) -Encoding UTF8 }
  } catch {}
}

# ---------- Configuracion: backup local y cambios (con secretos tapados) ----------
# Campos cuyo valor nunca sale del servidor (se reemplaza por ****)
$Secretos = '^(password|passwd|.*secret.*|psk.*|pre-shared-key|private-key|passphrase|auth-pwd.*|priv-pwd.*|key|.*-key|token|.*password.*|ldap-password)$'
$NL = [string][char]10
function Lineas-Config($texto) {
  # Devuelve "ruta | linea" por cada ajuste, con la ruta config/edit y los secretos tapados
  $salida = New-Object System.Collections.Generic.List[string]
  $pila = New-Object System.Collections.Generic.List[string]
  $pend = $null
  foreach ($crudo in ($texto -split $NL)) {
    $l = $crudo.TrimEnd([char]13)
    if ($null -ne $pend) {
      $pend = $pend + ' ' + $l.Trim()
      if ((($pend.ToCharArray() | Where-Object { $_ -eq '"' }).Count % 2) -eq 0) { $l = $pend; $pend = $null } else { continue }
    }
    $t = $l.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    if ((($t.ToCharArray() | Where-Object { $_ -eq '"' }).Count % 2) -eq 1) { $pend = $t; continue }
    if ($t -match '^config\s+(.+)$') { $pila.Add('config ' + $Matches[1]); continue }
    if ($t -match '^edit\s+(.+)$') { $pila.Add('edit ' + $Matches[1]); continue }
    if ($t -eq 'next' -or $t -eq 'end') { if ($pila.Count) { $pila.RemoveAt($pila.Count - 1) }; continue }
    if ($t -match '^(set|unset)\s+(\S+)') {
      $verbo = $Matches[1]; $campo = $Matches[2]
      $ruta = $pila -join ' > '
      $esSecreto = ($campo -match $Secretos) -or ($t -match '\sENC\s') -or ($t -match 'BEGIN [A-Z ]*(KEY|CERTIFICATE)') -or ($ruta -match 'snmp community' -and $campo -eq 'name')
      if ($esSecreto -and $verbo -eq 'set') { $t = 'set ' + $campo + ' ****' }
    }
    $salida.Add((($pila -join ' > ') + ' | ' + $t))
  }
  return ,$salida
}
function Revisar-Config($eq, $serial) {
  $dir = Join-Path $Carpeta ('backups\' + $serial)
  $marca = Join-Path $dir 'ultima-revision.txt'
  if ((Test-Path $marca) -and ((Get-Date) - (Get-Item $marca).LastWriteTime).TotalMinutes -lt 30) { return $null }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Set-Content -Path $marca -Value (Get-Date).ToString('s')
  $u = $eq.url.TrimEnd('/') + '/api/v2/monitor/system/config/backup?scope=global'
  try {
    $resp = Invoke-WebRequest -Uri $u -Method Get -Headers @{ Authorization = ('Bearer ' + $eq.clave) } -UseBasicParsing -TimeoutSec 120
    $texto = $resp.Content
    if ($texto -is [byte[]]) { $texto = [Text.Encoding]::UTF8.GetString($texto) }
  } catch {
    $m = $_.Exception.Message
    try { $st = [int]$_.Exception.Response.StatusCode; if ($st -eq 401 -or $st -eq 403) { $m = 'el usuario de API no tiene permiso de backup (requiere super administrador)' } } catch {}
    [void]$script:avisos.Add('backup de configuracion: ' + $m)
    return $null
  }
  if (-not $texto -or $texto -notmatch 'config ') { [void]$script:avisos.Add('backup de configuracion: respuesta vacia'); return $null }
  $actual = Lineas-Config $texto
  $sha = [Security.Cryptography.SHA256]::Create()
  $hash = (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($actual -join $NL))) | ForEach-Object { $_.ToString('x2') }) -join '')
  $ultimoHash = Join-Path $dir 'ultimo.hash'
  $ultimoLineas = Join-Path $dir 'ultimo.lineas'
  if ((Test-Path $ultimoHash) -and ((Get-Content $ultimoHash -Raw).Trim() -eq $hash)) { return $null }
  # Cambio (o primera vez): se guarda el backup completo SOLO en este servidor
  $archivo = Join-Path $dir ((Get-Date).ToString('yyyyMMdd-HHmm') + '.conf')
  Set-Content -Path $archivo -Value $texto -Encoding UTF8
  Get-ChildItem $dir -Filter '*.conf' | Sort-Object Name -Descending | Select-Object -Skip 90 | Remove-Item -Force -ErrorAction SilentlyContinue
  $cambio = [ordered]@{ hash = $hash; inicial = $true; agregadas = 0; quitadas = 0; detalle = @() }
  if (Test-Path $ultimoLineas) {
    $antes = New-Object System.Collections.Generic.HashSet[string]
    foreach ($x in (Get-Content $ultimoLineas)) { [void]$antes.Add($x) }
    $ahora = New-Object System.Collections.Generic.HashSet[string]
    foreach ($x in $actual) { [void]$ahora.Add($x) }
    $det = New-Object System.Collections.ArrayList
    $nA = 0; $nQ = 0
    foreach ($x in $actual) { if (-not $antes.Contains($x)) { $nA++; if ($det.Count -lt 300) { [void]$det.Add([ordered]@{ signo = '+'; ruta = $x.Split('|')[0].Trim(); linea = ($x.Substring($x.IndexOf('|') + 1)).Trim() }) } } }
    foreach ($x in $antes) { if (-not $ahora.Contains($x)) { $nQ++; if ($det.Count -lt 300) { [void]$det.Add([ordered]@{ signo = '-'; ruta = $x.Split('|')[0].Trim(); linea = ($x.Substring($x.IndexOf('|') + 1)).Trim() }) } } }
    $cambio.inicial = $false; $cambio.agregadas = $nA; $cambio.quitadas = $nQ; $cambio.detalle = $det
  }
  Set-Content -Path $ultimoLineas -Value $actual -Encoding UTF8
  Set-Content -Path $ultimoHash -Value $hash
  if (-not $cambio.inicial -and $cambio.agregadas -eq 0 -and $cambio.quitadas -eq 0) { return $null }
  return $cambio
}

# ---------- Logs (desde FortiAnalyzer a traves del FortiGate; si no, del disco o la memoria) ----------
function Logs($eq, $tipos, $filas, $desdeMs) {
  # $tipos: una o varias rutas posibles (ej. 'ips'); se prueba FortiAnalyzer, disco y memoria
  $ultimo = ''
  foreach ($origen in @('fortianalyzer', 'disk', 'memory')) {
    foreach ($tipo in @($tipos)) {
      try {
        $r = Api $eq ('/api/v2/log/' + $origen + '/' + $tipo + '?rows=' + $filas + '&filter=' + [Uri]::EscapeDataString('_metadata.timestamp>=' + $desdeMs))
        if ($null -ne $r -and $r.PSObject.Properties['results']) { return @{ origen = $origen; filas = @($r.results) } }
      } catch {
        $st = $null; try { $st = [int]$_.Exception.Response.StatusCode } catch {}
        if ($st) { $ultimo = $origen + ' ' + $st } else { $ultimo = $origen + ' ' + $_.Exception.Message }
      }
    }
  }
  $txt = 'no se pudieron leer'
  if ($ultimo -match ' (401|403)$') { $txt = 'sin permiso (revisar que el perfil tenga lectura de Log & Report)' } elseif ($ultimo) { $txt = $txt + ' (' + $ultimo + ')' }
  [void]$script:avisos.Add('logs ' + (@($tipos)[0]) + ': ' + $txt)
  return @{ origen = $null; filas = @() }
}

function Consultar-FortiGate($eq) {
  $script:avisos = New-Object System.Collections.ArrayList
  $r = [ordered]@{ nombre = $eq.nombre; ok = $false }
  try {
    $st = Api $eq '/api/v2/monitor/system/status'
    $res = Prop $st 'results'
    $r.serial = [string](Prop $st 'serial')
    $r.version = [string](Prop $st 'version')
    $r.build = [string](Prop $st 'build')
    $r.hostname = [string](Prop $res 'hostname')
    $r.modelo = [string](Prop $res 'model_name')
    if (Prop $res 'model_number') { $r.modelo = $r.modelo + ' ' + [string](Prop $res 'model_number') }
    $r.ok = $true
  } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    $r.error = $e.Message
    return $r
  }

  # Recursos
  $u = Intentar $eq '/api/v2/monitor/system/resource/usage?interval=1-min' 'uso de recursos'
  if ($u) {
    $rr = Prop $u 'results'
    foreach ($k in @('cpu', 'mem', 'session')) { $v = Prop $rr $k; if ($v) { $r[$k] = (@($v)[0]).current } }
  }

  # Alta disponibilidad
  $ha = Intentar $eq '/api/v2/cmdb/system/ha' 'HA'
  if ($ha) { $r.ha_modo = [string](Prop (Prop $ha 'results') 'mode') }
  if ($r.ha_modo -and $r.ha_modo -ne 'standalone') {
    $chk = Intentar $eq '/api/v2/monitor/system/ha-checksums' 'HA'
    if ($chk) {
      $miembros = @(Prop $chk 'results') | ForEach-Object { [ordered]@{ serial = [string](Prop $_ 'serial_no'); primario = [bool](Prop $_ 'is_root_primary'); checksum = [string](Prop (Prop $_ 'checksum') 'all') } }
      $r.ha_miembros = @($miembros)
    }
    $peer = Intentar $eq '/api/v2/monitor/system/ha-peer' 'HA'
    if ($peer) { $r.ha_peers = @(@(Prop $peer 'results') | ForEach-Object { [ordered]@{ serial = [string](Prop $_ 'serial_no'); hostname = [string](Prop $_ 'hostname'); prioridad = (Prop $_ 'priority') } }) }
  }

  # Licencias de FortiGuard y soporte
  $lic = Intentar $eq '/api/v2/monitor/license/status' 'licencias'
  if ($lic -and (Prop $lic 'results')) {
    $lista = New-Object System.Collections.ArrayList
    foreach ($p in (Prop $lic 'results').PSObject.Properties) {
      $v = $p.Value
      if ($null -eq $v -or $v -isnot [psobject]) { continue }
      if (Prop $v 'expires') { [void]$lista.Add([ordered]@{ servicio = $p.Name; estado = [string](Prop $v 'status'); vence = (Prop $v 'expires') }) }
      $sop = Prop $v 'support'
      if ($sop) { foreach ($q in $sop.PSObject.Properties) { if (Prop $q.Value 'expires') { [void]$lista.Add([ordered]@{ servicio = ($p.Name + ' ' + $q.Name); estado = [string](Prop $q.Value 'status'); vence = (Prop $q.Value 'expires') }) } } }
    }
    $r.licencias = $lista
  }

  # Certificados propios
  $cer = Intentar $eq '/api/v2/monitor/system/available-certificates?scope=global' 'certificados'
  if ($cer) {
    $r.certificados = @(@(Prop $cer 'results') | Where-Object { [string](Prop $_ 'source') -notmatch 'factory|fortiguard|fortinet' -and [string](Prop $_ 'name') -notmatch '^Fortinet_' } | ForEach-Object {
      $vto = Prop $_ 'valid_to'; if (-not $vto) { $vto = Prop $_ 'expiry' }
      [ordered]@{ nombre = [string](Prop $_ 'name'); tipo = [string](Prop $_ 'type'); vence = $vto }
    })
  }

  # Interfaces con acceso de administracion
  $itf = Intentar $eq '/api/v2/cmdb/system/interface?format=name|alias|role|allowaccess|ip|status|type' 'interfaces'
  if ($itf) { $r.interfaces = @(@(Prop $itf 'results') | ForEach-Object { [ordered]@{ nombre = [string]$_.name; alias = [string](Prop $_ 'alias'); rol = [string](Prop $_ 'role'); acceso = [string](Prop $_ 'allowaccess'); ip = [string](Prop $_ 'ip'); estado = [string](Prop $_ 'status') } }) }

  # Administradores
  $adm = Intentar $eq '/api/v2/cmdb/system/admin' 'administradores'
  if ($adm) {
    $r.admins = @(@(Prop $adm 'results') | ForEach-Object {
      $a = $_
      $th = @(1..10 | ForEach-Object { [string](Prop $a ('trusthost' + $_)) } | Where-Object { $_ -and $_ -notmatch '^0\.0\.0\.0 0\.0\.0\.0$' })
      [ordered]@{ nombre = [string]$a.name; perfil = [string](Prop $a 'accprofile'); dos_factores = [string](Prop $a 'two-factor'); trusthosts = $th }
    })
  }

  # Politicas y su uso
  $pol = Intentar $eq '/api/v2/cmdb/firewall/policy?format=policyid|name|srcintf|dstintf|srcaddr|dstaddr|service|action|status|logtraffic|comments|schedule' 'politicas'
  $uso = Intentar $eq '/api/v2/monitor/firewall/policy' 'uso de politicas'
  $usoPor = @{}
  if ($uso) { foreach ($x in @(Prop $uso 'results')) { $usoPor[[string](Prop $x 'policyid')] = $x } }
  if ($pol) {
    $r.politicas = @(@(Prop $pol 'results') | Select-Object -First 3000 | ForEach-Object {
      $x = $usoPor[[string]$_.policyid]
      [ordered]@{
        id = $_.policyid; nombre = [string](Prop $_ 'name'); desde = (Nombres (Prop $_ 'srcintf')); hacia = (Nombres (Prop $_ 'dstintf'))
        origen = (Nombres (Prop $_ 'srcaddr')); destino = (Nombres (Prop $_ 'dstaddr')); servicio = (Nombres (Prop $_ 'service'))
        accion = [string](Prop $_ 'action'); estado = [string](Prop $_ 'status'); log = [string](Prop $_ 'logtraffic'); comentario = [string](Prop $_ 'comments')
        hits = (Prop $x 'hit_count'); ultimo_uso = (Prop $x 'last_used'); bytes = (Prop $x 'bytes')
      }
    })
  }

  # VPN: sesiones activas (SSL e IPsec de FortiClient)
  $ses = New-Object System.Collections.ArrayList
  $ssl = Intentar $eq '/api/v2/monitor/vpn/ssl' 'VPN SSL'
  if ($ssl) { foreach ($s in @(Prop $ssl 'results')) { [void]$ses.Add([ordered]@{ tipo = 'SSL'; usuario = [string](Prop $s 'user_name'); ip_publica = [string](Prop $s 'remote_host'); ip_tunel = [string](Prop (@(Prop $s 'subsessions')[0]) 'aip'); desde = (Prop $s 'last_login_timestamp') }) } }
  $ips = Intentar $eq '/api/v2/monitor/vpn/ipsec' 'VPN IPsec'
  if ($ips) { foreach ($s in @(Prop $ips 'results')) { $usr = [string](Prop $s 'xauth_user'); if (-not $usr) { $usr = [string](Prop $s 'username') }; if ($usr) { [void]$ses.Add([ordered]@{ tipo = 'IPsec'; usuario = $usr; ip_publica = [string](Prop $s 'rgwy'); ip_tunel = [string](Prop $s 'tun_id'); desde = (Prop $s 'creation_time') }) } } }
  $r.vpn = $ses

  # VPN: intentos fallidos de las ultimas 2 horas
  $desde = [long](([DateTimeOffset]::UtcNow.AddHours(-2)).ToUnixTimeMilliseconds())
  $lv = Logs $eq 'event/vpn' 1000 $desde
  $r.origen_logs = $lv.origen
  $r.vpn_fallos = @($lv.filas | Where-Object { [string](Prop $_ 'action') -match 'fail' -or [string](Prop $_ 'status') -match 'fail|error|negotiate_error' } | Select-Object -First 500 | ForEach-Object {
    [ordered]@{ fecha = (Prop $_ 'eventtime'); fecha_txt = ([string](Prop $_ 'date') + ' ' + [string](Prop $_ 'time')); usuario = [string](Prop $_ 'user'); ip = [string](Prop $_ 'remip'); motivo = [string](Prop $_ 'reason'); accion = [string](Prop $_ 'action') }
  })

  # Amenazas (IPS y antivirus) de las ultimas 2 horas
  $am = New-Object System.Collections.ArrayList
  foreach ($x in (Logs $eq @('ips', 'utm/ips') 300 $desde).filas) { [void]$am.Add([ordered]@{ tipo = 'IPS'; fecha = (Prop $x 'eventtime'); fecha_txt = ([string](Prop $x 'date') + ' ' + [string](Prop $x 'time')); severidad = [string](Prop $x 'severity'); nombre = [string](Prop $x 'attack'); accion = [string](Prop $x 'action'); origen = [string](Prop $x 'srcip'); destino = [string](Prop $x 'dstip'); usuario = [string](Prop $x 'user') }) }
  foreach ($x in (Logs $eq @('virus', 'utm/virus') 200 $desde).filas) { [void]$am.Add([ordered]@{ tipo = 'Antivirus'; fecha = (Prop $x 'eventtime'); fecha_txt = ([string](Prop $x 'date') + ' ' + [string](Prop $x 'time')); severidad = [string](Prop $x 'crlevel'); nombre = [string](Prop $x 'virus'); accion = [string](Prop $x 'action'); origen = [string](Prop $x 'srcip'); destino = [string](Prop $x 'dstip'); usuario = [string](Prop $x 'user') }) }
  $r.amenazas = $am

  # SD-WAN: estado de cada enlace en cada chequeo de salud
  $sd = Intentar $eq '/api/v2/monitor/virtual-wan/health-check' 'SD-WAN'
  if ($sd -and (Prop $sd 'results')) {
    $lista = New-Object System.Collections.ArrayList
    foreach ($hc in (Prop $sd 'results').PSObject.Properties) {
      if ($hc.Value -isnot [psobject]) { continue }
      foreach ($m in $hc.Value.PSObject.Properties) {
        $v = $m.Value
        if ($v -isnot [psobject]) { continue }
        [void]$lista.Add([ordered]@{ chequeo = $hc.Name; enlace = $m.Name; estado = [string](Prop $v 'status'); latencia = (Prop $v 'latency'); jitter = (Prop $v 'jitter'); perdida = (Prop $v 'packet_loss') })
      }
    }
    $r.sdwan = $lista
  }

  # Trafico de los enlaces: contadores de bytes de las interfaces WAN y de los miembros de SD-WAN (la app calcula el consumo)
  $wan = New-Object System.Collections.ArrayList
  if ($r.interfaces) { foreach ($i in $r.interfaces) { if ($i.rol -eq 'wan' -and $wan -notcontains $i.nombre) { [void]$wan.Add($i.nombre) } } }
  $mie = Intentar $eq '/api/v2/monitor/virtual-wan/members' 'miembros de SD-WAN'
  Muestra $eq 'sdwan-miembros' $mie
  $miembros = Mapa (Prop $mie 'results') @('interface', 'name')
  foreach ($k in $miembros.Keys) { if ($wan -notcontains $k) { [void]$wan.Add($k) } }
  if ($r.sdwan) { foreach ($x in $r.sdwan) { if ($x.enlace -and $wan -notcontains $x.enlace) { [void]$wan.Add($x.enlace) } } }
  if ($wan.Count -eq 0 -and $r.interfaces) { foreach ($i in $r.interfaces) { if ($i.nombre -match '^wan') { [void]$wan.Add($i.nombre) } } }
  # Redes internas (VLAN y puertos con rol LAN) para ver cuanto consume cada una
  $lan = New-Object System.Collections.ArrayList
  if ($r.interfaces) { foreach ($i in $r.interfaces) { if ($i.rol -eq 'lan' -and $i.estado -ne 'down' -and $wan -notcontains $i.nombre) { [void]$lan.Add($i.nombre) } } }
  if ($wan.Count -gt 0 -or $lan.Count -gt 0) {
    $est = Intentar $eq '/api/v2/monitor/system/interface?include_vlan=true&include_aggregate=true' 'trafico de interfaces'
    Muestra $eq 'interfaces' $est
    $stats = Mapa (Prop $est 'results') @('name', 'id')
    $tr = New-Object System.Collections.ArrayList
    foreach ($n in (@($wan) + @($lan))) {
      $s = $stats[$n]; $m = $miembros[$n]
      if ($null -eq $s -and $null -eq $m) { continue }
      [void]$tr.Add([ordered]@{
        interfaz = $n
        rx_bytes = (Primero $s @('rx_bytes')); tx_bytes = (Primero $s @('tx_bytes'))
        rx_bps = (Primero $m @('rx_bandwidth')); tx_bps = (Primero $m @('tx_bandwidth'))
        velocidad = (Primero $s @('speed')); enlace = (Primero $s @('link'))
      })
    }
    $r.trafico = $tr
  }

  # Lo que mas consume ahora (FortiView en tiempo real: aplicaciones y origenes)
  $top = New-Object System.Collections.ArrayList
  foreach ($por in @('application', 'source')) {
    $fv = Intentar $eq ('/api/v2/monitor/fortiview/statistics?realtime=true&report_by=' + $por + '&sort_by=bytes&count=10') 'consumo por aplicacion'
    Muestra $eq ('fortiview-' + $por) $fv
    $res = Prop $fv 'results'
    $filas = Prop $res 'details'; if ($null -eq $filas) { $filas = $res }
    if ($filas -isnot [array]) { $filas = @($filas) }
    foreach ($x in ($filas | Select-Object -First 10)) {
      if ($null -eq $x -or $x -isnot [psobject]) { continue }
      if ($por -eq 'application') { $nom = Primero $x @('app_name', 'appname', 'application', 'app', 'name') }
      else { $nom = Primero $x @('user', 'username', 'unauthuser', 'srcaddr', 'source', 'saddr', 'hostname') ; $ip = Primero $x @('srcaddr', 'source', 'saddr') ; if ($ip -and [string]$ip -ne [string]$nom) { $nom = [string]$nom + ' (' + [string]$ip + ')' } }
      if (-not $nom) { continue }
      $bytes = Primero $x @('bytes'); if ($null -eq $bytes) { $bytes = [double](Primero $x @('sent_bytes', 'tx_bytes')) + [double](Primero $x @('received_bytes', 'rx_bytes')) }
      [void]$top.Add([ordered]@{ tipo = $(if ($por -eq 'application') { 'app' } else { 'origen' }); nombre = [string]$nom; bytes = $bytes; sesiones = (Primero $x @('sessions', 'session_count')); bps = (Primero $x @('bandwidth')) })
    }
  }
  if ($top.Count -gt 0) { $r.top = $top }

  # Cambios de configuracion (si el usuario de API tiene permiso de backup)
  if ($eq.backup) { $c = Revisar-Config $eq $r.serial; if ($c) { $r.cambio_config = $c } }

  $r.avisos = @($script:avisos | Select-Object -Unique)
  return $r
}

New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
$headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }
try {
  $resultados = New-Object System.Collections.ArrayList
  foreach ($eq in $Equipos) { [void]$resultados.Add((Consultar-FortiGate $eq)) }
  $datos = [ordered]@{ version = $Version; equipos = $resultados }
  $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_datos":' + (ConvertTo-Json -InputObject $datos -Depth 8 -Compress) + '}'
  Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/fg_reportar') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 120 | Out-Null
  $linea = 'OK ' + (Get-Date).ToString('s') + ' ' + (@($resultados | ForEach-Object { $_.nombre + ': ' + $(if ($_.ok) { 'responde' + $(if (@($_.avisos).Count) { ' (avisos: ' + (@($_.avisos) -join '; ') + ')' } else { '' }) } else { 'ERROR ' + $_.error }) }) -join ' | ')
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value $linea
}
catch {
  $detalle = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detalle = $detalle + ' | ' + $_.ErrorDetails.Message }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $detalle)
  exit 1
}
`;

const INSTALADOR = String.raw`# Instalador del puente FortiGate -> Accusys Cyber (ejecutar como administrador en un servidor de la red)
$ErrorActionPreference = 'Stop'
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Ejecuta este instalador como administrador.' -ForegroundColor Red; exit 1 }

$Carpeta = 'C:\ProgramData\AccusysPuenteFortiGate'
$Script  = Join-Path $Carpeta 'puente.ps1'
$Tarea   = 'AccusysPuenteFortiGate'

New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
# Carpeta solo para SYSTEM y Administradores: las claves de API y los backups no los puede leer un usuario comun
& icacls.exe $Carpeta /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
Get-ChildItem -Path $Carpeta -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
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
$config  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 8) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $Tarea -Action $accion -Trigger @($periodo, $inicio) -Principal $usuario -Settings $config -Force | Out-Null
Start-ScheduledTask -TaskName $Tarea

Write-Host 'Consultando los FortiGate y enviando el primer estado (puede tardar un par de minutos)...'
$espera = 0
while ($espera -lt 180) {
  Start-Sleep -Seconds 5; $espera += 5
  if ((Get-ScheduledTask -TaskName $Tarea).State -ne 'Running') { break }
}
Write-Host ''
Write-Host 'Puente instalado. Resultado del primer envio:' -ForegroundColor Green
Get-Content (Join-Path $Carpeta 'ultimo-envio.txt') -ErrorAction SilentlyContinue
`;

const DESINSTALADOR = String.raw`# Desinstala el puente FortiGate -> Accusys Cyber
# Los backups de configuracion quedan en C:\ProgramData\AccusysPuenteFortiGate\backups: se borran con la carpeta.
Unregister-ScheduledTask -TaskName 'AccusysPuenteFortiGate' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysPuenteFortiGate' -ErrorAction SilentlyContinue
Write-Host 'Puente FortiGate desinstalado.'
`;

// Los valores van entre comillas simples en PowerShell: se duplican las comillas simples
const ps = (v: string) => v.replace(/'/g, "''");
const booleano = (b: boolean) => (b ? "$true" : "$false");

export function normalizarUrlFortiGate(u: string) {
  let t = u.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(t)) t = "https://" + t;
  return t;
}

export function generarPuenteFortiGate(o: { url: string; anon: string; token: string; equipos: EquipoFortiGate[]; intervalo: number }) {
  const equipos = o.equipos
    .map((e) =>
      "  @{ nombre = '" + ps(e.nombre.trim()) + "'; url = '" + ps(normalizarUrlFortiGate(e.url)) + "'; clave = '" + ps(e.clave.trim()) +
      "'; ignorarCert = " + booleano(e.ignorarCert) + "; backup = " + booleano(e.backup) + " }"
    )
    .join(",\n");
  const puente = PUENTE.replace("__URL__", () => ps(o.url.replace(/\/$/, "")))
    .replace("__ANON__", () => ps(o.anon))
    .replace("__TOKEN__", () => ps(o.token))
    .replace("__VERSION__", () => PUENTE_FORTIGATE_VERSION)
    .replace("__EQUIPOS__", () => equipos);
  const instalador = INSTALADOR.replace("__PUENTE__", () => puente).replace("__INTERVALO__", () => String(o.intervalo));
  return envolverEnCmd("Instalador del puente FortiGate de Accusys Cyber", instalador);
}

export function generarDesinstaladorPuenteFortiGate() {
  return envolverEnCmd("Desinstalador del puente FortiGate de Accusys Cyber", DESINSTALADOR);
}
