// Puente DNS -> Accusys Cyber. Se instala en UN servidor DNS del dominio (un controlador de dominio), solo lectura:
// lee las zonas y los registros A, AAAA, CNAME y PTR, prueba si cada IP responde (ping y, si no, puertos comunes)
// y lo envía a la app, que lo cruza con Active Directory y el inventario para decir qué registros están en uso.
// No crea, cambia ni borra nada en el DNS. El token queda solo en la carpeta protegida del servidor.
// Reglas: el PowerShell es solo ASCII, sin la secuencia signo pesos + llave, sin comillas invertidas
// y sin here-strings (va dentro del here-string del instalador).
import { envolverEnCmd } from "./agente";

export const PUENTE_DNS_VERSION = "1.0";

const PUENTE = String.raw`# Puente DNS -> Accusys Cyber: lee las zonas y registros del DNS interno (solo lectura) y prueba si cada IP responde
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$Version     = '__VERSION__'
$Intervalo   = __INTERVALO__
$Carpeta     = 'C:\ProgramData\AccusysPuenteDNS'
$MaxRegistros = 20000
$Puertos = @(445, 135, 3389, 22, 443, 80)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
$paso = 'inicio'
$avisos = New-Object System.Collections.ArrayList

function Fecha($d) {
  if ($null -eq $d) { return $null }
  try { $x = [datetime]$d; if ($x.Year -lt 1990) { return $null } return $x.ToUniversalTime().ToString('o') } catch { return $null }
}
function Guardar($nombre, $valor) { Set-Content -Path (Join-Path $Carpeta $nombre) -Value $valor }
function Limpio($n) { return ([string]$n).Trim().TrimEnd('.').ToLower() }

# IP de un registro inverso: 25 en la zona 1.168.192.in-addr.arpa -> 192.168.1.25
function IpDeInverso($nombre, $zona) {
  $t = (Limpio ($nombre + '.' + $zona)) -replace '\.in-addr\.arpa$', ''
  $p = @($t.Split('.'))
  if ($p.Count -ne 4) { return $null }
  [array]::Reverse($p)
  return ($p -join '.')
}

function Esperar($tareas, $ms) {
  if ($tareas.Count -eq 0) { return }
  try { [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$tareas.ToArray(), $ms) } catch {}
}

# Ping a todas las IP en tandas. Devuelve las que respondieron.
function Probar-Ping($ips) {
  $ok = @{}
  for ($i = 0; $i -lt $ips.Count; $i += 150) {
    $tanda = @($ips | Select-Object -Skip $i -First 150)
    $tareas = New-Object System.Collections.ArrayList
    $de = New-Object System.Collections.ArrayList
    foreach ($ip in $tanda) {
      try {
        $dir = [System.Net.IPAddress]::Parse($ip)
        [void]$tareas.Add((New-Object System.Net.NetworkInformation.Ping).SendPingAsync($dir, 1500))
        [void]$de.Add($ip)
      } catch {}
    }
    Esperar $tareas 8000
    for ($k = 0; $k -lt $tareas.Count; $k++) {
      $t = $tareas[$k]
      if ($t.Status -eq 'RanToCompletion' -and $t.Result -and $t.Result.Status -eq 'Success') { $ok[$de[$k]] = $true }
    }
  }
  return $ok
}

# Para las que no responden ping (muchos equipos lo bloquean): intento de conexion a puertos comunes.
# Cuenta como "responde" si el puerto abre o si el equipo rechaza la conexion (hay algo vivo en esa IP).
function Probar-Tcp($ips) {
  $ok = @{}
  for ($i = 0; $i -lt $ips.Count; $i += 50) {
    $tanda = @($ips | Select-Object -Skip $i -First 50)
    $tareas = New-Object System.Collections.ArrayList
    $de = New-Object System.Collections.ArrayList
    $clientes = New-Object System.Collections.ArrayList
    foreach ($ip in $tanda) {
      $dir = $null
      try { $dir = [System.Net.IPAddress]::Parse($ip) } catch { continue }
      foreach ($pto in $Puertos) {
        try {
          $c = New-Object System.Net.Sockets.TcpClient($dir.AddressFamily)
          [void]$clientes.Add($c)
          [void]$tareas.Add($c.ConnectAsync($dir, $pto))
          [void]$de.Add(@($ip, $pto))
        } catch {}
      }
    }
    Esperar $tareas 2500
    for ($k = 0; $k -lt $tareas.Count; $k++) {
      $t = $tareas[$k]; $ip = $de[$k][0]
      if ($ok.ContainsKey($ip)) { continue }
      if ($t.Status -eq 'RanToCompletion') { $ok[$ip] = ('tcp:' + $de[$k][1]) }
      elseif ($t.IsFaulted) {
        $e = $t.Exception
        while ($e.InnerException) { $e = $e.InnerException }
        if ($e -is [System.Net.Sockets.SocketException] -and $e.SocketErrorCode -eq 'ConnectionRefused') { $ok[$ip] = 'rechazo' }
      }
    }
    foreach ($c in $clientes) { try { $c.Close() } catch {} }
  }
  return $ok
}

# Destinos de los alias: se comprueba que resuelvan
function Probar-Nombres($nombres) {
  $ok = @{}
  for ($i = 0; $i -lt $nombres.Count; $i += 50) {
    $tanda = @($nombres | Select-Object -Skip $i -First 50)
    $tareas = New-Object System.Collections.ArrayList
    $de = New-Object System.Collections.ArrayList
    foreach ($n in $tanda) {
      try { [void]$tareas.Add([System.Net.Dns]::GetHostAddressesAsync($n)); [void]$de.Add($n) } catch {}
    }
    Esperar $tareas 20000
    for ($k = 0; $k -lt $tareas.Count; $k++) {
      $t = $tareas[$k]
      if ($t.Status -eq 'RanToCompletion' -and @($t.Result).Count -gt 0) { $ok[$de[$k]] = $true }
    }
  }
  return $ok
}

try {
  $paso = 'modulo DnsServer'
  Import-Module DnsServer -ErrorAction Stop

  $paso = 'zonas'
  $zonas = New-Object System.Collections.ArrayList
  $registros = New-Object System.Collections.ArrayList
  $todas = @(Get-DnsServerZone | Where-Object {
    -not $_.IsAutoCreated -and [string]$_.ZoneType -eq 'Primary' -and $_.ZoneName -ne 'TrustAnchors' -and $_.ZoneName -notlike '_msdcs.*' -and $_.ZoneName -notlike '*.ip6.arpa'
  })
  foreach ($z in $todas) {
    $nombreZona = Limpio $z.ZoneName
    $paso = 'zona ' + $nombreZona
    $inversa = [bool]$z.IsReverseLookupZone
    $aging = $null
    try { $aging = [bool](Get-DnsServerZoneAging -Name $z.ZoneName).AgingEnabled } catch {}
    $leida = $true
    $n = 0
    try {
      $tipos = @('A', 'AAAA', 'CNAME')
      if ($inversa) { $tipos = @('PTR') }
      $rrs = @(Get-DnsServerResourceRecord -ZoneName $z.ZoneName -ErrorAction Stop | Where-Object { $tipos -contains [string]$_.RecordType })
      foreach ($r in $rrs) {
        $h = [string]$r.HostName
        $tipo = [string]$r.RecordType
        if ($h -eq '@' -or $h -like '_*' -or $h -like '*._*' -or $h -match '^(DomainDnsZones|ForestDnsZones)(\.|$)') { continue }
        $dato = $null; $ip = $null
        if ($tipo -eq 'A') { $dato = [string]$r.RecordData.IPv4Address }
        elseif ($tipo -eq 'AAAA') { $dato = [string]$r.RecordData.IPv6Address }
        elseif ($tipo -eq 'CNAME') { $dato = Limpio $r.RecordData.HostNameAlias }
        else { $dato = Limpio $r.RecordData.PtrDomainName; $ip = IpDeInverso $h $nombreZona }
        if (-not $dato) { continue }
        $ttl = $null
        try { $ttl = [int]$r.TimeToLive.TotalSeconds } catch {}
        [void]$registros.Add([ordered]@{
          zona = $nombreZona; nombre = (Limpio $h); fqdn = (Limpio ($h + '.' + $nombreZona)); tipo = $tipo; dato = $dato; ip = $ip
          estatico = ($null -eq $r.Timestamp); ts = (Fecha $r.Timestamp); ttl = $ttl; responde = $null; via = $null
        })
        $n++
      }
    } catch {
      $leida = $false
      [void]$avisos.Add('zona ' + $nombreZona + ': ' + ($_.Exception.Message -replace '\s+', ' '))
    }
    [void]$zonas.Add([ordered]@{
      nombre = $nombreZona; tipo = [string]$z.ZoneType; integrada = [bool]$z.IsDsIntegrated; inversa = $inversa
      dinamica = [string]$z.DynamicUpdate; aging = $aging; leida = $leida; registros = $n
    })
  }
  if ($registros.Count -gt $MaxRegistros) {
    [void]$avisos.Add('hay ' + $registros.Count + ' registros: se envian los primeros ' + $MaxRegistros)
    $corte = New-Object System.Collections.ArrayList
    foreach ($x in @($registros | Select-Object -First $MaxRegistros)) { [void]$corte.Add($x) }
    $registros = $corte
  }

  $paso = 'ping'
  $ips = @($registros | Where-Object { $_.tipo -eq 'A' -or $_.tipo -eq 'AAAA' } | ForEach-Object { $_.dato } | Sort-Object -Unique)
  $ping = @{}
  if ($ips.Count) {
    $ping = Probar-Ping $ips
    # segundo intento para las que no respondieron (un paquete perdido no las deja afuera)
    $faltan = @($ips | Where-Object { -not $ping.ContainsKey($_) })
    if ($faltan.Count) { foreach ($k in (Probar-Ping $faltan).Keys) { $ping[$k] = $true } }
  }
  $paso = 'puertos'
  $faltan = @($ips | Where-Object { -not $ping.ContainsKey($_) })
  $tcp = @{}
  if ($faltan.Count) { $tcp = Probar-Tcp $faltan }

  $paso = 'alias'
  $destinos = @($registros | Where-Object { $_.tipo -eq 'CNAME' } | ForEach-Object { $_.dato } | Sort-Object -Unique)
  $resuelve = @{}
  if ($destinos.Count) { $resuelve = Probar-Nombres $destinos }

  $vivos = 0
  foreach ($r in $registros) {
    if ($r.tipo -eq 'A' -or $r.tipo -eq 'AAAA') {
      if ($ping.ContainsKey($r.dato)) { $r.responde = $true; $r.via = 'ping'; $vivos++ }
      elseif ($tcp.ContainsKey($r.dato)) { $r.responde = $true; $r.via = $tcp[$r.dato]; $vivos++ }
      else { $r.responde = $false }
    }
    elseif ($r.tipo -eq 'CNAME') {
      $r.responde = $resuelve.ContainsKey($r.dato)
      if ($r.responde) { $r.via = 'dns' }
    }
  }

  $paso = 'envio a Accusys Cyber'
  $datos = [ordered]@{ version = $Version; servidor = $env:COMPUTERNAME; intervalo = $Intervalo; zonas = $zonas; registros = $registros; avisos = @($avisos) }
  $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_datos":' + (ConvertTo-Json -InputObject $datos -Depth 6 -Compress) + '}'
  $headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }
  Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/dns_reportar') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 180 | Out-Null

  $linea = 'OK ' + (Get-Date).ToString('s') + ' ' + $env:COMPUTERNAME + ': ' + $zonas.Count + ' zonas, ' + $registros.Count + ' registros, ' + $vivos + ' de ' + $ips.Count + ' IP responden'
  if ($avisos.Count) { $linea = $linea + ' | avisos: ' + ($avisos -join '; ') }
  Guardar 'ultimo-envio.txt' $linea
}
catch {
  $d = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $d = $d + ' | ' + $_.ErrorDetails.Message }
  Guardar 'ultimo-envio.txt' ('ERROR ' + (Get-Date).ToString('s') + ' [' + $paso + '] ' + ($d -replace '\s+', ' '))
  exit 1
}
`;

const INSTALADOR = String.raw`# Instalador del puente DNS -> Accusys Cyber (ejecutar como administrador en UN servidor DNS del dominio)
$ErrorActionPreference = 'Stop'
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Ejecuta este instalador como administrador.' -ForegroundColor Red; exit 1 }
if (-not (Get-Module -ListAvailable -Name DnsServer)) {
  Write-Host 'Este equipo no tiene el modulo DnsServer de PowerShell. Instalalo en un servidor DNS (un controlador de dominio).' -ForegroundColor Red; exit 1
}
if (-not (Get-Service -Name DNS -ErrorAction SilentlyContinue)) {
  Write-Host 'Este equipo no tiene el rol de servidor DNS. Instalalo en un controlador de dominio que sea servidor DNS.' -ForegroundColor Red; exit 1
}

$Carpeta = 'C:\ProgramData\AccusysPuenteDNS'
$Script  = Join-Path $Carpeta 'puente.ps1'
$Tarea   = 'AccusysPuenteDNS'

New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
# Carpeta solo para SYSTEM y Administradores: el token no lo puede leer un usuario comun
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
$config  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 25) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $Tarea -Action $accion -Trigger @($periodo, $inicio) -Principal $usuario -Settings $config -Force | Out-Null
Start-ScheduledTask -TaskName $Tarea

Write-Host 'Leyendo el DNS y probando las IP (puede tardar unos minutos)...'
$espera = 0
while ($espera -lt 600) {
  Start-Sleep -Seconds 5; $espera += 5
  if ((Get-ScheduledTask -TaskName $Tarea).State -ne 'Running') { break }
}
Write-Host ''
Write-Host 'Puente instalado. Resultado del primer envio:' -ForegroundColor Green
Get-Content (Join-Path $Carpeta 'ultimo-envio.txt') -ErrorAction SilentlyContinue
`;

const DESINSTALADOR = String.raw`# Desinstala el puente DNS -> Accusys Cyber
Unregister-ScheduledTask -TaskName 'AccusysPuenteDNS' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysPuenteDNS' -ErrorAction SilentlyContinue
Write-Host 'Puente de DNS desinstalado.'
`;

// Los valores van entre comillas simples en PowerShell: se duplican las comillas simples
const ps = (v: string) => v.replace(/'/g, "''");

export function generarPuenteDns(o: { url: string; anon: string; token: string; intervalo: number }) {
  const puente = PUENTE.replace("__URL__", () => ps(o.url.replace(/\/$/, "")))
    .replace("__ANON__", () => ps(o.anon))
    .replace("__TOKEN__", () => ps(o.token))
    .replace("__VERSION__", () => PUENTE_DNS_VERSION)
    .replace("__INTERVALO__", () => String(o.intervalo));
  const instalador = INSTALADOR.replace("__PUENTE__", () => puente).replace("__INTERVALO__", () => String(o.intervalo));
  return envolverEnCmd("Instalador del puente de DNS de Accusys Cyber", instalador);
}

export function generarDesinstaladorPuenteDns() {
  return envolverEnCmd("Desinstalador del puente de DNS de Accusys Cyber", DESINSTALADOR);
}
