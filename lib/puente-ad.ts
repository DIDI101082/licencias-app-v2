// Puente Active Directory -> Accusys Cyber. Se instala en cada controlador de dominio (solo lectura):
// cada hora envía el inventario del dominio (usuarios, equipos, grupos privilegiados, política) y en cada
// ejecución los eventos de seguridad de ese DC (altas, cambios de grupos, bloqueos, intentos fallidos, borrado del log).
// No modifica nada en el dominio. El token queda solo en la carpeta protegida del DC.
// Reglas: el PowerShell es solo ASCII, sin la secuencia signo pesos + llave, sin comillas invertidas
// y sin here-strings (va dentro del here-string del instalador).
import { envolverEnCmd } from "./agente";

export const PUENTE_AD_VERSION = "1.0";

const PUENTE = String.raw`# Puente Active Directory -> Accusys Cyber: lee el dominio (solo lectura) y los eventos de seguridad de este controlador de dominio
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysPuenteAD'
$MinutosInventario = 60
$MaxEventos = 3000

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
$paso = 'inicio'
$avisos = New-Object System.Collections.ArrayList

function Fecha($d) {
  if ($null -eq $d) { return $null }
  try { $x = [datetime]$d; if ($x.Year -lt 1990) { return $null } return $x.ToUniversalTime().ToString('o') } catch { return $null }
}
function FechaFT($v) {
  if ($null -eq $v) { return $null }
  try { $n = [int64]$v; if ($n -le 0 -or $n -ge 9223372036854775807) { return $null } return [DateTime]::FromFileTimeUtc($n).ToString('o') } catch { return $null }
}
function Flag($uac, $bit) { return (([int64]$uac -band $bit) -ne 0) }
function Leer($nombre) { $p = Join-Path $Carpeta $nombre; if (Test-Path $p) { return (Get-Content $p -Raw).Trim() } return $null }
function Guardar($nombre, $valor) { Set-Content -Path (Join-Path $Carpeta $nombre) -Value $valor }
function CN($dn) { if ($dn -match '^CN=((?:[^,]|\\,)+)') { return ($Matches[1] -replace '\\,', ',') } return $dn }

# ---------- Inventario del dominio (cada hora) ----------
function Inventario() {
  Import-Module ActiveDirectory -ErrorAction Stop
  $inv = [ordered]@{}
  $script:paso = 'dominio'
  $dom = Get-ADDomain
  $for = Get-ADForest
  $sid = $dom.DomainSID.Value
  $papelera = $false
  try { $papelera = @((Get-ADOptionalFeature -Filter "Name -eq 'Recycle Bin Feature'").EnabledScopes).Count -gt 0 } catch {}
  $pol = $null
  try { $pol = Get-ADDefaultDomainPasswordPolicy } catch { [void]$avisos.Add('politica de contrasenas: ' + $_.Exception.Message) }
  $krb = $null
  try { $krb = Get-ADUser -Identity krbtgt -Properties pwdLastSet } catch {}
  $inv.dominio = [ordered]@{
    dns = [string]$dom.DNSRoot; netbios = [string]$dom.NetBIOSName; nivel_dominio = [string]$dom.DomainMode; nivel_bosque = [string]$for.ForestMode
    pdc = [string]$dom.PDCEmulator; papelera = $papelera; krbtgt_pwd = (FechaFT $krb.pwdLastSet)
    pwd_min = $(if ($pol) { [int]$pol.MinPasswordLength } else { $null })
    pwd_max_dias = $(if ($pol -and $pol.MaxPasswordAge) { [int]$pol.MaxPasswordAge.TotalDays } else { $null })
    pwd_historial = $(if ($pol) { [int]$pol.PasswordHistoryCount } else { $null })
    pwd_complejidad = $(if ($pol) { [bool]$pol.ComplexityEnabled } else { $null })
    bloqueo_umbral = $(if ($pol) { [int]$pol.LockoutThreshold } else { $null })
  }

  $script:paso = 'controladores de dominio'
  $inv.dcs = @(Get-ADDomainController -Filter * | ForEach-Object {
    [ordered]@{ nombre = [string]$_.Name; host = [string]$_.HostName; so = [string]$_.OperatingSystem; sitio = [string]$_.Site
      gc = [bool]$_.IsGlobalCatalog; ip = [string]$_.IPv4Address; roles = (@($_.OperationMasterRoles | ForEach-Object { [string]$_ }) -join ', ') }
  })

  $script:paso = 'usuarios'
  $props = @('userAccountControl', 'lastLogonTimestamp', 'pwdLastSet', 'whenCreated', 'servicePrincipalName', 'adminCount', 'mail',
             'userPrincipalName', 'displayName', 'department', 'title', 'lockoutTime', 'objectSid')
  $inv.usuarios = @(Get-ADUser -Filter * -Properties $props -ResultSetSize 20000 | ForEach-Object {
    $uac = [int64]$_.userAccountControl
    [ordered]@{
      sam = [string]$_.SamAccountName; upn = [string]$_.userPrincipalName; nombre = [string]$_.displayName; mail = [string]$_.mail
      habilitado = -not (Flag $uac 2); ultimo_logon = (FechaFT $_.lastLogonTimestamp); pwd_cambiada = (FechaFT $_.pwdLastSet); creado = (Fecha $_.whenCreated)
      pwd_no_vence = (Flag $uac 0x10000); pwd_no_requerida = (Flag $uac 0x20); reversible = (Flag $uac 0x80); sin_preauth = (Flag $uac 0x400000)
      delegacion = (Flag $uac 0x80000); spn = (@($_.servicePrincipalName).Count -gt 0); admin_count = ([int]$_.adminCount -eq 1)
      bloqueado = ($null -ne $_.lockoutTime -and [int64]$_.lockoutTime -gt 0); departamento = [string]$_.department; cargo = [string]$_.title
      rid500 = ([string]$_.objectSid.Value).EndsWith('-500')
    }
  })

  $script:paso = 'equipos'
  $pc = @('operatingSystem', 'operatingSystemVersion', 'lastLogonTimestamp', 'userAccountControl', 'whenCreated', 'primaryGroupID')
  $equipos = $null
  $conLaps = $true
  try { $equipos = @(Get-ADComputer -Filter * -Properties ($pc + @('ms-Mcs-AdmPwdExpirationTime', 'msLAPS-PasswordExpirationTime')) -ResultSetSize 20000) }
  catch { $conLaps = $false }
  if (-not $conLaps) {
    try { $equipos = @(Get-ADComputer -Filter * -Properties ($pc + @('ms-Mcs-AdmPwdExpirationTime')) -ResultSetSize 20000); $conLaps = $true }
    catch { $equipos = @(Get-ADComputer -Filter * -Properties $pc -ResultSetSize 20000) }
  }
  $inv.equipos = @($equipos | ForEach-Object {
    $uac = [int64]$_.userAccountControl
    $laps = $null
    if ($conLaps) { $laps = ($null -ne $_.'ms-Mcs-AdmPwdExpirationTime') -or ($null -ne $_.'msLAPS-PasswordExpirationTime') }
    [ordered]@{
      nombre = [string]$_.Name; so = [string]$_.operatingSystem; version = [string]$_.operatingSystemVersion; habilitado = -not (Flag $uac 2)
      ultimo_logon = (FechaFT $_.lastLogonTimestamp); creado = (Fecha $_.whenCreated); delegacion = (Flag $uac 0x80000)
      es_dc = ([int]$_.primaryGroupID -eq 516); laps = $laps
    }
  })

  $script:paso = 'grupos privilegiados'
  $objetivos = @(
    @{ k = 'domain_admins'; id = ($sid + '-512') }, @{ k = 'enterprise_admins'; id = ($sid + '-519') }, @{ k = 'schema_admins'; id = ($sid + '-518') },
    @{ k = 'administrators'; id = 'S-1-5-32-544' }, @{ k = 'account_operators'; id = 'S-1-5-32-548' }, @{ k = 'server_operators'; id = 'S-1-5-32-549' },
    @{ k = 'backup_operators'; id = 'S-1-5-32-551' }, @{ k = 'print_operators'; id = 'S-1-5-32-550' }, @{ k = 'gpo_creators'; id = ($sid + '-520') },
    @{ k = 'key_admins'; id = ($sid + '-526') }, @{ k = 'enterprise_key_admins'; id = ($sid + '-527') }, @{ k = 'protected_users'; id = ($sid + '-525') },
    @{ k = 'dnsadmins'; id = 'DnsAdmins' }
  )
  $grupos = New-Object System.Collections.ArrayList
  foreach ($o in $objetivos) {
    $g = $null
    try { $g = Get-ADGroup -Identity $o.id } catch { continue }
    $miembros = @()
    try { $miembros = @(Get-ADGroupMember -Identity $g -Recursive) }
    catch { try { $miembros = @(Get-ADGroupMember -Identity $g) } catch { [void]$avisos.Add('grupo ' + $g.Name + ': ' + $_.Exception.Message) } }
    [void]$grupos.Add([ordered]@{
      clave = $o.k; nombre = [string]$g.Name
      miembros = @($miembros | ForEach-Object { [ordered]@{ sam = [string]$_.SamAccountName; nombre = [string]$_.Name; tipo = [string]$_.objectClass } })
    })
  }
  $inv.grupos = $grupos
  return $inv
}

# ---------- Eventos de seguridad de este DC (desde el ultimo leido) ----------
$Ids = @(1102, 4625, 4720, 4722, 4724, 4725, 4726, 4728, 4729, 4732, 4733, 4739, 4740, 4756, 4757, 4771, 4776, 4794)
$Tipo = @{
  1102 = 'log_borrado'; 4625 = 'fallo_inicio'; 4720 = 'usuario_creado'; 4722 = 'usuario_habilitado'; 4724 = 'contrasena_restablecida'
  4725 = 'usuario_deshabilitado'; 4726 = 'usuario_eliminado'; 4728 = 'miembro_agregado'; 4732 = 'miembro_agregado'; 4756 = 'miembro_agregado'
  4729 = 'miembro_quitado'; 4733 = 'miembro_quitado'; 4757 = 'miembro_quitado'; 4739 = 'politica_dominio'; 4740 = 'bloqueo'
  4771 = 'fallo_kerberos'; 4776 = 'fallo_ntlm'; 4794 = 'dsrm'
}
function Eventos() {
  $script:paso = 'eventos de seguridad'
  $ultimo = Leer 'ultimo-evento.txt'
  $filtroIds = ($Ids | ForEach-Object { 'EventID=' + $_ }) -join ' or '
  if ($ultimo -match '^\d+$') { $xp = '*[System[(' + $filtroIds + ') and EventRecordID > ' + $ultimo + ']]' }
  else { $xp = '*[System[(' + $filtroIds + ') and TimeCreated[timediff(@SystemTime) <= 86400000]]]' }
  $evs = @()
  try { $evs = @(Get-WinEvent -LogName Security -FilterXPath $xp -Oldest -MaxEvents $MaxEventos) }
  catch { if ($_.FullyQualifiedErrorId -notmatch 'NoMatchingEventsFound' -and $_.Exception.Message -notmatch 'No events|No se encontraron') { throw } }
  $lista = New-Object System.Collections.ArrayList
  $max = $ultimo
  foreach ($e in $evs) {
    $d = @{}
    try { foreach ($n in ([xml]$e.ToXml()).Event.EventData.Data) { $d[[string]$n.Name] = [string]$n.'#text' } } catch {}
    $id = [int]$e.Id
    $usuario = $d['TargetUserName']; $actor = $d['SubjectUserName']; $grupo = $null; $ip = $d['IpAddress']; $equipo = $d['WorkstationName']; $motivo = $d['Status']
    if ($id -in @(4728, 4732, 4756, 4729, 4733, 4757)) { $grupo = $d['TargetUserName']; $usuario = (CN $d['MemberName']); if (-not $usuario) { $usuario = $d['MemberSid'] } }
    if ($id -eq 4740) { $equipo = $d['TargetDomainName'] }
    if ($id -eq 4776) { $equipo = $d['Workstation']; $motivo = $d['Status']; if ($motivo -eq '0x0') { continue } }
    if ($id -eq 4625) { if ($d['SubStatus'] -and $d['SubStatus'] -ne '0x0') { $motivo = $d['SubStatus'] } }
    if ($id -eq 1102) { $actor = $null; try { $actor = ([xml]$e.ToXml()).Event.UserData.LogFileCleared.SubjectUserName } catch {} }
    if ($ip) { $ip = ($ip -replace '^::ffff:', ''); if ($ip -in @('-', '::1', '127.0.0.1')) { $ip = $null } }
    [void]$lista.Add([ordered]@{
      record_id = [int64]$e.RecordId; fecha = $e.TimeCreated.ToUniversalTime().ToString('o'); evento = $id; tipo = $Tipo[$id]
      usuario = $usuario; actor = $actor; grupo = $grupo; ip = $ip; equipo = $equipo; motivo = $motivo
    })
    if (-not $max -or [int64]$e.RecordId -gt [int64]$max) { $max = [string]$e.RecordId }
  }
  return @{ lista = $lista; ultimo = $max; lleno = ($evs.Count -ge $MaxEventos) }
}

try {
  $datos = [ordered]@{ version = $Version; dc = $env:COMPUTERNAME }
  $ev = Eventos
  $datos.eventos = $ev.lista
  $ultInv = Leer 'ultimo-inventario.txt'
  $toca = $true
  if ($ultInv -match '^\d+$') { $toca = ((Get-Date).ToUniversalTime().Ticks - [int64]$ultInv) -ge ([TimeSpan]::FromMinutes($MinutosInventario - 2).Ticks) }
  if ($toca) { foreach ($k in (Inventario).GetEnumerator()) { $datos[$k.Key] = $k.Value } }
  $datos.avisos = @($avisos)

  $paso = 'envio a Accusys Cyber'
  $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_datos":' + (ConvertTo-Json -InputObject $datos -Depth 6 -Compress) + '}'
  $headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }
  Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/ad_reportar') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 120 | Out-Null

  if ($ev.ultimo) { Guardar 'ultimo-evento.txt' $ev.ultimo }
  if ($toca) { Guardar 'ultimo-inventario.txt' ([string](Get-Date).ToUniversalTime().Ticks) }
  $linea = 'OK ' + (Get-Date).ToString('s') + ' ' + $env:COMPUTERNAME + ': ' + $ev.lista.Count + ' eventos'
  if ($toca) { $linea = $linea + ', inventario: ' + @($datos.usuarios).Count + ' usuarios, ' + @($datos.equipos).Count + ' equipos' }
  if ($ev.lleno) { $linea = $linea + ' (quedan eventos pendientes: se envian en la proxima ejecucion)' }
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

const INSTALADOR = String.raw`# Instalador del puente Active Directory -> Accusys Cyber (ejecutar como administrador en CADA controlador de dominio)
$ErrorActionPreference = 'Stop'
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Ejecuta este instalador como administrador.' -ForegroundColor Red; exit 1 }
if (-not (Get-Module -ListAvailable -Name ActiveDirectory)) {
  Write-Host 'Este equipo no tiene el modulo ActiveDirectory de PowerShell. Instalalo en un controlador de dominio.' -ForegroundColor Red; exit 1
}

$Carpeta = 'C:\ProgramData\AccusysPuenteAD'
$Script  = Join-Path $Carpeta 'puente.ps1'
$Tarea   = 'AccusysPuenteAD'

New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
# Carpeta solo para SYSTEM y Administradores: el token no lo puede leer un usuario comun
& icacls.exe $Carpeta /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
Get-ChildItem -Path $Carpeta -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
  & takeown.exe /F $_.FullName /A 2>&1 | Out-Null
  & icacls.exe $_.FullName /reset /Q 2>&1 | Out-Null
}
# Un token nuevo reemplaza al anterior: se vuelve a enviar el inventario en la primera ejecucion
Remove-Item -Path (Join-Path $Carpeta 'ultimo-inventario.txt') -Force -ErrorAction SilentlyContinue

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

Write-Host 'Leyendo el dominio y enviando el primer estado (puede tardar un par de minutos)...'
$espera = 0
while ($espera -lt 240) {
  Start-Sleep -Seconds 5; $espera += 5
  if ((Get-ScheduledTask -TaskName $Tarea).State -ne 'Running') { break }
}
Write-Host ''
Write-Host 'Puente instalado. Resultado del primer envio:' -ForegroundColor Green
Get-Content (Join-Path $Carpeta 'ultimo-envio.txt') -ErrorAction SilentlyContinue
`;

const DESINSTALADOR = String.raw`# Desinstala el puente Active Directory -> Accusys Cyber
Unregister-ScheduledTask -TaskName 'AccusysPuenteAD' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysPuenteAD' -ErrorAction SilentlyContinue
Write-Host 'Puente de Active Directory desinstalado.'
`;

// Los valores van entre comillas simples en PowerShell: se duplican las comillas simples
const ps = (v: string) => v.replace(/'/g, "''");

export function generarPuenteAD(o: { url: string; anon: string; token: string; intervalo: number }) {
  const puente = PUENTE.replace("__URL__", () => ps(o.url.replace(/\/$/, "")))
    .replace("__ANON__", () => ps(o.anon))
    .replace("__TOKEN__", () => ps(o.token))
    .replace("__VERSION__", () => PUENTE_AD_VERSION);
  const instalador = INSTALADOR.replace("__PUENTE__", () => puente).replace("__INTERVALO__", () => String(o.intervalo));
  return envolverEnCmd("Instalador del puente de Active Directory de Accusys Cyber", instalador);
}

export function generarDesinstaladorPuenteAD() {
  return envolverEnCmd("Desinstalador del puente de Active Directory de Accusys Cyber", DESINSTALADOR);
}
