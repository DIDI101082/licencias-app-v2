// Puente del grupo electrógeno -> Accusys Cyber. Se instala en un servidor de la red que llegue al DSE855,
// lee el controlador (DSE4520 MKII) por Modbus TCP y envía los registros a la app cada pocos minutos.
// SOLO LECTURA: usa únicamente la función Modbus 03 (leer registros). Nunca escribe ni manda comandos.
// La interpretación de los registros (GenComm de Deep Sea) se hace en Supabase (ge_reportar).
// Reglas: el PowerShell es solo ASCII, sin la secuencia signo pesos + llave, sin comillas invertidas
// y sin here-strings (va dentro del here-string del instalador).
import { envolverEnCmd } from "./agente";

export const PUENTE_GRUPO_VERSION = "1.0";

const PUENTE = String.raw`# Puente grupo electrogeno -> Accusys Cyber: lee el DSE855 por Modbus TCP (solo lectura) y envia el estado
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$Equipo      = '__IP__'
$Puerto      = __PUERTO__
$Unidades    = @(__UNIDADES__)
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysPuenteGrupo'

# Bloques GenComm: pagina 3 (modo y estado), 4 (motor, generador y red), 6 (potencia) y 7 (horas y arranques)
$Bloques = @(@(1024, 42), @(768, 8), @(1536, 2), @(1798, 12))

function Leer-Exacto($s, $buf, $n) {
  $leido = 0
  while ($leido -lt $n) {
    $k = $s.Read($buf, $leido, $n - $leido)
    if ($k -le 0) { throw 'El equipo cerro la conexion' }
    $leido += $k
  }
}

# Funcion Modbus 03 (Read Holding Registers). Es la unica que usa el puente.
function Leer-Registros($unidad, $inicio, $cantidad) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect($Equipo, $Puerto, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(5000)) { throw ('No se pudo conectar a ' + $Equipo + ':' + $Puerto + ' (sin respuesta)') }
    try { $c.EndConnect($iar) } catch { throw ('No se pudo conectar a ' + $Equipo + ':' + $Puerto + ' (conexion rechazada: revisar que Modbus TCP este habilitado)') }
    $c.ReceiveTimeout = 5000
    $c.SendTimeout = 5000
    $s = $c.GetStream()
    $tx = Get-Random -Minimum 1 -Maximum 65000
    $pedido = [byte[]]@(
      [byte](($tx -shr 8) -band 255), [byte]($tx -band 255), 0, 0, 0, 6, [byte]$unidad, 3,
      [byte](($inicio -shr 8) -band 255), [byte]($inicio -band 255),
      [byte](($cantidad -shr 8) -band 255), [byte]($cantidad -band 255))
    $s.Write($pedido, 0, $pedido.Length)
    $cab = New-Object byte[] 7
    Leer-Exacto $s $cab 7
    $largo = [int]$cab[4] * 256 + [int]$cab[5]
    if ($largo -lt 3 -or $largo -gt 260) { throw 'Respuesta Modbus invalida' }
    $resto = New-Object byte[] ($largo - 1)
    Leer-Exacto $s $resto ($largo - 1)
    if ([int]$resto[0] -ge 128) { throw ('El equipo rechazo la lectura (codigo ' + [int]$resto[1] + ')') }
    $n = [int]$resto[1] / 2
    $vals = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $n; $i++) { [void]$vals.Add([int]$resto[2 + 2 * $i] * 256 + [int]$resto[3 + 2 * $i]) }
    return ,$vals
  } finally { $c.Close() }
}

$datos = [ordered]@{ version = $Version; ip = $Equipo; ok = $false }
$registros = [ordered]@{}
$avisos = New-Object System.Collections.ArrayList
$unidadOk = $null
try {
  # Busca el numero de unidad (slave ID) que responde, empezando por el que funciono la vez anterior
  $archivoUnidad = Join-Path $Carpeta 'unidad.txt'
  $previa = $null
  if (Test-Path $archivoUnidad) { $previa = [int](Get-Content $archivoUnidad -TotalCount 1) }
  $candidatas = @()
  if ($previa -ne $null) { $candidatas += $previa }
  $candidatas += @($Unidades | Where-Object { $_ -ne $previa })
  $ultimoError = ''
  foreach ($u in $candidatas) {
    try {
      $v = Leer-Registros $u $Bloques[0][0] $Bloques[0][1]
      for ($i = 0; $i -lt $v.Count; $i++) { $registros[[string]($Bloques[0][0] + $i)] = $v[$i] }
      $unidadOk = $u
      break
    } catch { $ultimoError = $_.Exception.Message; if ($ultimoError -like 'No se pudo conectar*') { throw $ultimoError } }
  }
  if ($unidadOk -eq $null) { throw ('El grupo no respondio por Modbus: ' + $ultimoError) }
  Set-Content -Path $archivoUnidad -Value $unidadOk

  for ($b = 1; $b -lt $Bloques.Count; $b++) {
    try {
      $v = Leer-Registros $unidadOk $Bloques[$b][0] $Bloques[$b][1]
      for ($i = 0; $i -lt $v.Count; $i++) { $registros[[string]($Bloques[$b][0] + $i)] = $v[$i] }
    } catch { [void]$avisos.Add([string]$Bloques[$b][0] + ': ' + $_.Exception.Message) }
  }
  $datos.ok = $true
  $datos.registros = $registros
} catch {
  $e = $_.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  $datos.error = $e.Message
}

# Resumen legible para comparar con la pagina web del DSE855
function Reg($a) { if ($registros.Contains([string]$a)) { return $registros[[string]$a] } else { return $null } }
function Doble($a) { $h = Reg $a; $l = Reg ($a + 1); if ($h -eq $null -or $l -eq $null -or $h -ge 65535) { return $null }; return $h * 65536 + $l }
$resumen = ''
if ($datos.ok) {
  $modos = @('Stop', 'Auto', 'Manual', 'Prueba con carga', 'Auto restauracion manual', 'Config', 'Prueba sin carga', 'Off')
  $m = Reg 772
  $modo = if ($m -ne $null -and $m -lt $modos.Count) { $modos[$m] } else { [string]$m }
  $red = Doble 1060
  $arr = Doble 1808
  $partes = @(
    ('Modo ' + $modo),
    ('Combustible ' + (Reg 1027) + '%'),
    ('Bateria ' + ((Reg 1029) / 10) + ' V'),
    ('Red L1 ' + $(if ($red -ne $null) { $red / 10 } else { '-' }) + ' V ' + ((Reg 1059) / 10) + ' Hz'),
    ('Motor ' + (Reg 1030) + ' RPM'),
    ('Arranques ' + $(if ($arr -ne $null) { $arr } else { '-' })),
    ('Unidad Modbus ' + $unidadOk))
  $resumen = ' | ' + ($partes -join ' | ')
  if ($avisos.Count) { $resumen = $resumen + ' | sin leer: ' + ($avisos -join '; ') }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }
try {
  $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_datos":' + (ConvertTo-Json -InputObject $datos -Depth 4 -Compress) + '}'
  Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/ge_reportar') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 60 | Out-Null
  if ($datos.ok) { $linea = 'OK ' + (Get-Date).ToString('s') + $resumen }
  else { $linea = 'SIN RESPUESTA DEL GRUPO ' + (Get-Date).ToString('s') + ' ' + $datos.error }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value $linea
}
catch {
  $d = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $d = $d + ' | ' + $_.ErrorDetails.Message }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + ($d -replace '\s+', ' '))
  exit 1
}
`;

const INSTALADOR = String.raw`# Instalador del puente del grupo electrogeno -> Accusys Cyber (ejecutar como administrador en un servidor de la red)
$ErrorActionPreference = 'Stop'
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Ejecuta este instalador como administrador.' -ForegroundColor Red; exit 1 }

$Carpeta = 'C:\ProgramData\AccusysPuenteGrupo'
$Script  = Join-Path $Carpeta 'puente.ps1'
$Tarea   = 'AccusysPuenteGrupo'

Write-Host 'Probando la conexion con el DSE855 (__IP__:__PUERTO__)...'
$prueba = New-Object System.Net.Sockets.TcpClient
try {
  $iar = $prueba.BeginConnect('__IP__', __PUERTO__, $null, $null)
  if (-not $iar.AsyncWaitHandle.WaitOne(5000)) { throw 'sin respuesta' }
  $prueba.EndConnect($iar)
  Write-Host 'Conexion OK.' -ForegroundColor Green
} catch {
  Write-Host ('No se pudo conectar a __IP__:__PUERTO__. Revisa que Modbus TCP este habilitado en el DSE855 y que el firewall permita el puerto desde este servidor.') -ForegroundColor Yellow
} finally { $prueba.Close() }

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
$config  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $Tarea -Action $accion -Trigger @($periodo, $inicio) -Principal $usuario -Settings $config -Force | Out-Null
Start-ScheduledTask -TaskName $Tarea

Write-Host 'Leyendo el grupo y enviando el primer estado...'
$espera = 0
while ($espera -lt 60) {
  Start-Sleep -Seconds 3; $espera += 3
  if ((Get-ScheduledTask -TaskName $Tarea).State -ne 'Running') { break }
}
Write-Host ''
Write-Host 'Puente instalado. Resultado del primer envio:' -ForegroundColor Green
Get-Content (Join-Path $Carpeta 'ultimo-envio.txt') -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Compara estos valores con la pagina web del DSE855 (combustible, bateria, red y arranques).' -ForegroundColor Cyan
Write-Host 'Si coinciden, ya esta. Si no, avisale a Ciberseguridad con este resultado.'
`;

const DESINSTALADOR = String.raw`# Desinstala el puente del grupo electrogeno -> Accusys Cyber
Unregister-ScheduledTask -TaskName 'AccusysPuenteGrupo' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysPuenteGrupo' -ErrorAction SilentlyContinue
Write-Host 'Puente del grupo electrogeno desinstalado.'
`;

// Los valores van entre comillas simples en PowerShell: se duplican las comillas simples
const ps = (v: string) => v.replace(/'/g, "''");

export function generarPuenteGrupo(o: { url: string; anon: string; token: string; ip: string; puerto: number; unidad: number | null; intervalo: number }) {
  // Si no se indica el número de unidad, el puente prueba los habituales de DSE
  const unidades = o.unidad != null ? String(o.unidad) : "10, 1, 255, 0";
  const puente = PUENTE.replace("__URL__", () => ps(o.url.replace(/\/$/, "")))
    .replace("__ANON__", () => ps(o.anon))
    .replace("__TOKEN__", () => ps(o.token))
    .replace("__IP__", () => ps(o.ip))
    .replace("__PUERTO__", () => String(o.puerto))
    .replace("__UNIDADES__", () => unidades)
    .replace("__VERSION__", () => PUENTE_GRUPO_VERSION);
  const instalador = INSTALADOR.replace("__PUENTE__", () => puente)
    .replace(/__IP__/g, () => ps(o.ip))
    .replace(/__PUERTO__/g, () => String(o.puerto))
    .replace("__INTERVALO__", () => String(o.intervalo));
  return envolverEnCmd("Instalador del puente del grupo electrogeno de Accusys Cyber", instalador);
}

export function generarDesinstaladorPuenteGrupo() {
  return envolverEnCmd("Desinstalador del puente del grupo electrogeno de Accusys Cyber", DESINSTALADOR);
}
