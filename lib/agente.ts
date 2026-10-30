// Plantillas del agente de Windows. Se completan con la URL de Supabase,
// la clave pública y el token al momento de descargar el instalador.
// Nota: el código PowerShell es solo ASCII (sin tildes) para que Windows
// PowerShell 5.1 lo lea bien en cualquier configuración regional.

export const AGENTE_VERSION = "2.8";

// Diagnostico del disco C (agente 2.1): que ocupa el espacio y en que estado fisico esta el disco.
// Recorrer todo C: puede tardar varios minutos, asi que corre en una tarea programada aparte
// (la del agente tiene un limite de 3 minutos), con prioridad baja, y deja el resultado en disco.json.
// Solo lee: no borra ni cambia nada en el equipo. Solo ASCII.
const DISCO_ANALIZAR = String.raw`# Diagnostico del disco C - lo lanza el agente de Accusys Cyber. Solo lectura: no borra nada.
$ErrorActionPreference = 'Stop'
$Dir = 'C:\ProgramData\AccusysAgente\disco'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch { }
$inicio = Get-Date
$GB = 1GB
# Ojo: no usar "R" como nombre de funcion: en PowerShell "r" es un alias de Invoke-History y tiene prioridad

function Guardar($o) { Set-Content -Path (Join-Path $Dir 'disco.json') -Value ($o | ConvertTo-Json -Depth 6 -Compress) -Encoding UTF8 }
function A-GB($b) { if ($null -eq $b) { return $null }; return [math]::Round($b / $GB, 2) }

try {
  # ---------- 1. Volumen C ----------
  $vol = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
  $volumen = [ordered]@{ total_gb = A-GB $vol.Size; libre_gb = A-GB $vol.FreeSpace }

  # ---------- 2. Disco fisico donde esta C y su salud ----------
  $fisico = [ordered]@{}
  try {
    $nro = (Get-Partition -DriveLetter C -ErrorAction Stop | Select-Object -First 1).DiskNumber
    $pd = Get-PhysicalDisk -ErrorAction Stop | Where-Object { [string]$_.DeviceId -eq [string]$nro } | Select-Object -First 1
    if ($pd) {
      $fisico.modelo = ([string]$pd.FriendlyName).Trim()
      $fisico.tipo = [string]$pd.MediaType
      $fisico.bus = [string]$pd.BusType
      $fisico.tamano_gb = A-GB $pd.Size
      $fisico.salud = [string]$pd.HealthStatus
      $fisico.estado = (@($pd.OperationalStatus) | ForEach-Object { [string]$_ }) -join ', '
      try {
        $rc = $pd | Get-StorageReliabilityCounter -ErrorAction Stop
        $fisico.desgaste_pct = $rc.Wear
        $fisico.temperatura = $rc.Temperature
        $fisico.horas_uso = $rc.PowerOnHours
        $fisico.errores_lectura = $rc.ReadErrorsUncorrected
        $fisico.errores_escritura = $rc.WriteErrorsUncorrected
      } catch { }
    }
    # SSD/HDD sin tipo informado: se deduce por la velocidad de rotacion
    if (-not $fisico.tipo -or $fisico.tipo -eq 'Unspecified') {
      try {
        $md = Get-CimInstance -Namespace root\Microsoft\Windows\Storage -ClassName MSFT_PhysicalDisk -ErrorAction Stop | Where-Object { [string]$_.DeviceId -eq [string]$nro } | Select-Object -First 1
        if ($md -and $md.SpindleSpeed -eq 0) { $fisico.tipo = 'SSD' } elseif ($md -and $md.SpindleSpeed -gt 0) { $fisico.tipo = 'HDD' }
      } catch { }
    }
  } catch { $fisico.error = $_.Exception.Message }
  # Alerta SMART de prediccion de falla (la que da el propio disco)
  try {
    $smart = @(Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop)
    if ($smart.Count -gt 0) { $fisico.smart_falla = [bool]($smart | Where-Object { $_.PredictFailure }) }
  } catch { }

  # ---------- 3. Que ocupa el espacio (un solo recorrido de C:) ----------
  # Rutas puntuales que interesan, ademas de cada carpeta de la raiz y cada perfil de usuario
  $interes = @{}
  @('C:\Windows', 'C:\Windows\Temp', 'C:\Windows\SoftwareDistribution\Download', 'C:\Windows\Installer', 'C:\Windows\WinSxS',
    'C:\Windows\Minidump', 'C:\Windows\LiveKernelReports', 'C:\Windows.old', 'C:\$Recycle.Bin', 'C:\$WINDOWS.~BT', 'C:\W11Setup',
    'C:\ProgramData\Microsoft\Windows\WER', 'C:\Program Files', 'C:\Program Files (x86)') | ForEach-Object { $interes[$_.ToLower()] = $true }
  $porPerfil = @('Downloads', 'Desktop', 'Documents', 'Pictures', 'Videos', 'AppData\Local\Temp', 'AppData\Local\Microsoft\Outlook',
    'AppData\Local\Packages\MSTeams_8wekyb3d8bbwe', 'AppData\Roaming\Microsoft\Teams', 'AppData\Local\Microsoft\Teams',
    'AppData\Local\Google\Chrome\User Data', 'AppData\Local\Microsoft\Edge\User Data', 'AppData\Local\CrashDumps')
  $perfiles = @(Get-ChildItem -LiteralPath 'C:\Users' -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
  foreach ($p in $perfiles) {
    $interes[$p.FullName.ToLower()] = $true
    foreach ($s in $porPerfil) { $interes[(Join-Path $p.FullName $s).ToLower()] = $true }
    Get-ChildItem -LiteralPath $p.FullName -Directory -Force -Filter 'OneDrive*' -ErrorAction SilentlyContinue | ForEach-Object { $interes[$_.FullName.ToLower()] = $true }
  }

  $tam = @{}
  $grandes = New-Object System.Collections.ArrayList
  $script:archivos = 0
  $script:sinAcceso = 0
  # Atributos de archivos de OneDrive que no estan bajados al equipo (no ocupan disco)
  $NoLocal = 0x400000 -bor 0x1000 -bor 0x40000

  function Medir([IO.DirectoryInfo]$d, [int]$prof) {
    [long]$suma = 0
    $hijos = $null
    try { $hijos = $d.EnumerateFileSystemInfos() } catch { $script:sinAcceso++; return [long]0 }
    try {
      foreach ($h in $hijos) {
        if ($h -is [IO.DirectoryInfo]) {
          # Puntos de union y accesos directos de carpetas: se saltean para no contar dos veces
          if ($h.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
          $suma += Medir $h ($prof + 1)
        } else {
          $script:archivos++
          if (([int]$h.Attributes) -band $NoLocal) { continue }
          $suma += $h.Length
          if ($h.Length -ge 1GB) { [void]$grandes.Add([ordered]@{ ruta = $h.FullName; gb = A-GB $h.Length; fecha = $h.LastWriteTime.ToString('yyyy-MM-dd') }) }
        }
      }
    } catch { $script:sinAcceso++ }
    $clave = $d.FullName.TrimEnd('\').ToLower()
    if ($prof -le 1 -or $interes.ContainsKey($clave)) { $tam[$clave] = $suma }
    return $suma
  }

  $raiz = New-Object IO.DirectoryInfo 'C:\'
  [void](Medir $raiz 0)

  # Archivos de sistema que no se ven al recorrer (o que conviene informar aparte)
  $sistema = [ordered]@{}
  foreach ($f in @('hiberfil.sys', 'pagefile.sys', 'swapfile.sys')) {
    try { $i = Get-Item -LiteralPath ('C:\' + $f) -Force -ErrorAction Stop; $sistema[$f] = A-GB $i.Length } catch { }
  }
  try { $i = Get-Item -LiteralPath 'C:\Windows\MEMORY.DMP' -Force -ErrorAction Stop; $sistema['MEMORY.DMP'] = A-GB $i.Length } catch { }
  # Puntos de restauracion / instantaneas (no se ven como archivos)
  try {
    $volC = Get-CimInstance Win32_Volume -Filter "DriveLetter='C:'" -ErrorAction Stop
    $sombra = Get-CimInstance Win32_ShadowStorage -ErrorAction Stop | Where-Object { [string]$_.Volume.DeviceID -eq [string]$volC.DeviceID } |
      ForEach-Object { $_.UsedSpace } | Measure-Object -Sum
    if ($sombra.Sum) { $sistema['puntos_restauracion'] = A-GB $sombra.Sum }
  } catch { }

  $raizItems = @($tam.GetEnumerator() | Where-Object { $_.Key -match '^c:\\[^\\]+$' } |
    Sort-Object Value -Descending | Select-Object -First 15 | ForEach-Object { [ordered]@{ ruta = $_.Key; gb = A-GB $_.Value } })
  $rutas = @($tam.GetEnumerator() | Where-Object { $_.Key -notmatch '^c:\\[^\\]+$' -and $_.Value -ge 50MB } |
    Sort-Object Value -Descending | ForEach-Object { [ordered]@{ ruta = $_.Key; gb = A-GB $_.Value } })

  Guardar ([ordered]@{
    estado = 'ok'; reportado = $false; fecha = (Get-Date).ToString('s')
    duracion_seg = [int]((Get-Date) - $inicio).TotalSeconds
    volumen = $volumen; fisico = $fisico; sistema = $sistema
    raiz = $raizItems; rutas = $rutas
    grandes = @($grandes | Sort-Object { $_.gb } -Descending | Select-Object -First 15)
    archivos = $script:archivos; sin_acceso = $script:sinAcceso
  })
}
catch {
  Guardar ([ordered]@{ estado = 'error'; reportado = $false; fecha = (Get-Date).ToString('s'); detalle = $_.Exception.Message })
  exit 1
}
`;

// Actualización a Windows 11 (modo mixto: carpeta de la red local o, si no se llega, Asistente de Microsoft por internet).
// El agente la escribe en el equipo y la ejecuta en una tarea programada aparte
// (la tarea del agente tiene un límite de 3 minutos y el upgrade tarda entre 30 y 90).
// Solo se lanza si Accusys Cyber lo ordena; exige que el instalador esté firmado por Microsoft.
// Se embebe en base64 para no romper el here-string del instalador. Solo ASCII.
const W11_ACTUALIZAR = String.raw`# Actualizacion a Windows 11 - la lanza el agente de Accusys Cyber cuando un administrador la ordena
# Modo mixto: si el equipo llega a la carpeta compartida, actualiza desde la red local (rapido en la oficina);
# si no llega (home office) y esta permitido, baja el Asistente de instalacion de Windows 11 desde Microsoft.
$ErrorActionPreference = 'Stop'
$Carpeta = 'C:\ProgramData\AccusysAgente'
$Dir   = Join-Path $Carpeta 'w11'
$Logs  = Join-Path $Dir 'logs'
$Cache = 'C:\W11Setup'
$UrlAsistente = 'https://go.microsoft.com/fwlink/?linkid=2171764'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

function Informar($estado, $detalle, $compat, $progreso = $null) {
  $o = [ordered]@{ estado = $estado; detalle = $detalle; compat = $compat; progreso = $progreso; fecha = (Get-Date).ToString('s'); reportado = $false }
  Set-Content -Path (Join-Path $Dir 'estado.json') -Value ($o | ConvertTo-Json -Compress) -Encoding UTF8
}
# Avance general (0-100) para la barra de Accusys Cyber:
#   copia del instalador 0-15, instalacion de Windows (incluye la verificacion de compatibilidad) 15-100 (o 5-100 por internet)
function Avance-Setup {
  try { return [int](Get-ItemProperty 'HKLM:\SYSTEM\Setup\MoSetup\Volatile' -ErrorAction Stop).SetupProgress } catch { return $null }
}
# Espera a que termine un proceso informando el avance cada 30 segundos. $calc devuelve el % general (o $null)
function Esperar-Con-Avance($proc, $estado, $detalle, $compat, [scriptblock]$calc) {
  $null = $proc.Handle   # necesario para leer ExitCode al final
  $ultimo = -1
  while (-not $proc.WaitForExit(30000)) {
    $pct = & $calc
    if ($null -ne $pct -and $pct -ne $ultimo) { Informar $estado $detalle $compat ([int][math]::Min(99, [math]::Max(0, $pct))); $ultimo = $pct }
  }
  return $proc.ExitCode
}
# Como Esperar-Con-Avance, pero vigila que setup.exe no quede colgado: con algunos builds, SetupHost termina
# y setup.exe queda abierto sin hacer nada. Si SetupHost aparecio y despues lleva 10 minutos cerrado, se toma
# el resultado del log de Panther y se cierra setup.exe.
function Esperar-Setup($proc, $estado, $detalle, $compat, [scriptblock]$calc) {
  $null = $proc.Handle
  $ultimo = -1; $vioHost = $false; $sinHost = 0
  while (-not $proc.WaitForExit(30000)) {
    $pct = & $calc
    if ($null -ne $pct -and $pct -ne $ultimo) { Informar $estado $detalle $compat ([int][math]::Min(99, [math]::Max(0, $pct))); $ultimo = $pct }
    if (Get-Process -Name SetupHost -ErrorAction SilentlyContinue) { $vioHost = $true; $sinHost = 0 }
    elseif ($vioHost) { $sinHost += 30 }
    if ($sinHost -ge 600) {
      $codigo = -2
      $log = 'C:\$WINDOWS.~BT\Sources\Panther\setupact.log'
      $m = Select-String -Path $log -Pattern 'CSetupHost::Execute\(\d+\): Result = 0x([0-9A-Fa-f]+)' -ErrorAction SilentlyContinue | Select-Object -Last 1
      if ($m) {
        $v = [Convert]::ToInt64($m.Matches[0].Groups[1].Value, 16)
        if ($v -gt 0x7FFFFFFF) { $v -= 0x100000000 }
        $codigo = [int]$v
      }
      # setup.exe lanza setupprep.exe: si queda abierto, bloquea cualquier instalacion nueva (0x80070652)
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Get-Process -Name setupprep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      return $codigo
    }
  }
  return $proc.ExitCode
}
# ---- Aviso al usuario conectado (notificacion de Windows) ----
# El agente corre como SYSTEM en una sesion invisible: el aviso se lanza con una tarea que corre como el usuario
# que tiene la sesion abierta (grupo Usuarios). La notificacion queda en pantalla hasta que la cierra.
# Solo ASCII en este archivo: las letras acentuadas se arman con [char].
$a_ = [char]0xE1; $e_ = [char]0xE9; $i_ = [char]0xED; $o_ = [char]0xF3; $u_ = [char]0xFA
function Avisar-Usuario($titulo, $texto) {
  try {
    if (-not (Get-CimInstance Win32_ComputerSystem).UserName) { return }   # nadie conectado
    $dirAviso = Join-Path $env:ProgramData 'AccusysAviso'
    New-Item -ItemType Directory -Force -Path $dirAviso | Out-Null
    $ps = Join-Path $dirAviso 'aviso.ps1'
    $xml = '<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>' + [Security.SecurityElement]::Escape($titulo) +
           '</text><text>' + [Security.SecurityElement]::Escape($texto) + '</text></binding></visual>' +
           '<actions><action content="Entendido" arguments="dismiss" activationType="system"/></actions></toast>'
    $cod = @'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('__XML__')
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
'@
    Set-Content -Path $ps -Value $cod.Replace('__XML__', $xml.Replace("'", "''")) -Encoding UTF8
    $grupo = (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')).Translate([Security.Principal.NTAccount]).Value
    $acc = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps + '"')
    $usr = New-ScheduledTaskPrincipal -GroupId $grupo -RunLevel Limited
    Register-ScheduledTask -TaskName 'AccusysAvisoW11' -Action $acc -Principal $usr -Force | Out-Null
    Start-ScheduledTask -TaskName 'AccusysAvisoW11'
    Start-Sleep -Seconds 20
    Unregister-ScheduledTask -TaskName 'AccusysAvisoW11' -Confirm:$false -ErrorAction SilentlyContinue
  } catch { }
}
function Aviso-Inicio {
  $t = "Actualizaci$($o_)n a Windows 11 en curso"
  $b = "El $($a_)rea de Tecnolog$($i_)a est$($a_) actualizando tu equipo. Pod$($e_)s seguir trabajando. No lo apagues ni lo desenchufes."
  if ($orden.reiniciar) { $b += " Al terminar se va a reiniciar solo: guard$($a_) tu trabajo." }
  Avisar-Usuario $t $b
}
function Aviso-Fin {
  $t = "Windows 11 listo: falta reiniciar"
  if ($orden.reiniciar) {
    $b = "El equipo se va a reiniciar para terminar la actualizaci$($o_)n. Tarda entre 20 y 40 minutos; no lo apagues."
  } else {
    $b = "Guard$($a_) tu trabajo y reinici$($a_) el equipo cuando puedas. El reinicio tarda entre 20 y 40 minutos; no lo apagues."
  }
  if ($cifradoEset) { $b += " Te va a pedir la clave de inicio del cifrado, posiblemente m$($a_)s de una vez." }
  Avisar-Usuario $t $b
}

function Texto-Compat($hex) {
  switch ($hex) {
    '0xC1900208' { return 'Aplicacion incompatible' }
    '0xC1900204' { return 'No se pueden conservar apps y datos (idioma o edicion distinta)' }
    '0xC1900200' { return 'No cumple los requisitos minimos' }
    '0xC190020E' { return 'Falta espacio en disco' }
    '0xC1900202' { return 'No cumple los requisitos minimos' }
  }
  return $null
}
function Firmado-Microsoft($ruta) {
  $f = Get-AuthenticodeSignature -FilePath $ruta
  return ($f.Status -eq 'Valid' -and $f.SignerCertificate.Subject -match 'O=Microsoft Corporation')
}

try {
  $orden  = Get-Content (Join-Path $Dir 'orden.json') -Raw | ConvertFrom-Json
  $origen = ([string]$orden.origen).TrimEnd('\')
  if ([int](Get-CimInstance Win32_OperatingSystem).BuildNumber -ge 22000) { exit 0 }

  # 1. Notebook enchufada (sin bateria = equipo de escritorio)
  try {
    $bat = Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus -ErrorAction Stop | Select-Object -First 1
    if ($bat -and -not $bat.PowerOnline) { Informar 'pospuesto' 'Notebook a bateria: se reintenta cuando este enchufada' $null; exit 0 }
  } catch { }

  # 2. Espacio libre
  $libre = [math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace / 1GB, 1)
  if ($libre -lt 25) { Informar 'pospuesto' ('Solo ' + $libre + ' GB libres en C: (se necesitan 25 GB)') $null; exit 0 }

  # Cifrado de disco de ESET (Endpoint Encryption o Full Disk Encryption): segun ESET, setup.exe tiene que cargar
  # el driver de cifrado (/ReflectDrivers) y no tocar la particion de recuperacion; si no, falla con 0xC1900101-0x20017.
  $DriversEset = 'C:\Windows\System32\dlpcore\Upgrade\'
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $cifradoEset = (Test-Path $DriversEset) -or (Test-Path (Join-Path $env:ProgramData 'ESET\ESET Full Disk Encryption')) -or
                 (Test-Path (Join-Path $env:ProgramFiles 'ESET Endpoint Encryption')) -or ($pf86 -and (Test-Path (Join-Path $pf86 'ESET Endpoint Encryption')))
  $extraEset = @()
  if ($cifradoEset) {
    if (-not (Get-ChildItem -Path $DriversEset -ErrorAction SilentlyContinue)) {
      Informar 'bloqueado' ('Disco cifrado con ESET pero no esta la carpeta de drivers para el upgrade (' + $DriversEset + '): actualizar el cliente de cifrado de ESET') $null
      exit 0
    }
    # Sin barra final: con "\" al final setup.exe rechaza el parametro (0x80070057)
    $extraEset = @(('/ReflectDrivers ' + $DriversEset.TrimEnd('\')), '/ResizeRecoveryPartition Disable')
  }

  # 3. Camino: red local si se llega a la carpeta; si no, internet (si esta permitido)
  $porRed = $false
  if ($origen) {
    if ($origen -notmatch '^\\\\[^\\]+\\') { Informar 'error' 'Origen del instalador invalido: tiene que ser un recurso compartido de la red' $null; exit 1 }
    if (Test-Path (Join-Path $origen 'setup.exe')) { $porRed = $true }
  }
  if (-not $porRed -and $cifradoEset) {
    Informar 'pospuesto' 'Disco cifrado con ESET: se actualiza solo desde la carpeta de la red (el asistente de Microsoft no carga el driver de cifrado). Se reintenta cuando el equipo este en la red o la VPN' $null
    exit 0
  }
  if (-not $porRed -and -not $orden.internet) {
    Informar 'pospuesto' ('No se accede a ' + $origen + ' (fuera de la red o sin permiso) y la descarga desde internet esta deshabilitada') $null
    exit 0
  }
  New-Item -ItemType Directory -Force -Path $Cache | Out-Null

  if ($porRed) {
    # ---------- Desde la red local ----------
    $setupRed = Join-Path $origen 'setup.exe'
    if (-not (Firmado-Microsoft $setupRed)) { Informar 'error' 'El setup.exe de la carpeta no tiene una firma valida de Microsoft: upgrade NO lanzado' $null; exit 1 }

    Informar 'en_curso' 'Red local: copiando el instalador al equipo' $null 0
    Aviso-Inicio
    $totalOrigen = (Get-ChildItem -LiteralPath $origen -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    $pr = Start-Process -FilePath 'robocopy.exe' -PassThru -WindowStyle Hidden -ArgumentList @(('"' + $origen + '"'), ('"' + $Cache + '"'),
            '/MIR', '/Z', '/R:10', '/W:30', '/NP', '/NFL', '/NDL', ('/LOG:"' + (Join-Path $Logs 'robocopy.log') + '"'))
    $rc = Esperar-Con-Avance $pr 'en_curso' 'Red local: copiando el instalador al equipo' $null {
      if (-not $totalOrigen) { return $null }
      $copiado = (Get-ChildItem -LiteralPath $Cache -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
      return [int](15 * $copiado / $totalOrigen)
    }
    if ($rc -ge 8) { Informar 'pospuesto' ('Fallo la copia del instalador (robocopy ' + $rc + '): se reintenta') $null; exit 0 }
    $setup = Join-Path $Cache 'setup.exe'
    if (-not (Firmado-Microsoft $setup)) { Informar 'error' 'El setup.exe copiado no tiene una firma valida de Microsoft: upgrade NO lanzado' $null; exit 1 }

    if ($orden.sha256) {
      $img = @('install.wim', 'install.esd') | ForEach-Object { Join-Path $Cache ('sources\' + $_) } | Where-Object { Test-Path $_ } | Select-Object -First 1
      $hash = $null
      if ($img) { $hash = (Get-FileHash -Path $img -Algorithm SHA256).Hash }
      if ($hash -ne ([string]$orden.sha256).ToUpper()) { Informar 'error' ('La huella de la imagen no coincide (' + $hash + '): upgrade NO lanzado') $null; exit 1 }
    }

    $notaEset = ''
    if ($cifradoEset) { $notaEset = ' - disco cifrado con ESET: se carga el driver de cifrado y en cada reinicio se pide la clave de pre-arranque' }
    $detInst = 'Red local: instalando Windows 11 (puede tardar entre 30 y 90 minutos)' + $notaEset
    # Sin escaneo previo aparte: la instalacion hace la misma verificacion de compatibilidad y frena con los mismos codigos
    Informar 'en_curso' $detInst $null 15
    # /DynamicUpdate Disable (asi, con mayusculas): no baja actualizaciones de Microsoft durante la instalacion (ahorra ~40 min)
    $parametros = @('/auto upgrade', '/quiet', '/eula accept', '/DynamicUpdate Disable', '/showoobe none', '/telemetry disable',
                    ('/copylogs "' + (Join-Path $Logs 'upgrade') + '"')) + $extraEset
    if (-not $orden.reiniciar) { $parametros += '/noreboot' }
    # Restos de un intento anterior colgado (si quedan abiertos, setup.exe responde 0x80070652 "ya hay otra instalacion")
    Get-Process -Name setupprep, SetupHost -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process -Name setup -ErrorAction SilentlyContinue | Where-Object { $_.Path -like 'C:\W11Setup\*' } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 5
    $p = Start-Process -FilePath $setup -PassThru -WindowStyle Hidden -ArgumentList $parametros
    $codigo = Esperar-Setup $p 'en_curso' $detInst $null { $s = Avance-Setup; if ($null -eq $s) { return $null }; return [int](15 + 0.85 * $s) }
    $hex = '0x{0:X8}' -f $codigo
    $compat = Texto-Compat $hex
    if ($codigo -eq 0 -or $codigo -eq 3010) {
      Informar 'pendiente_reinicio' 'Red local: Windows 11 preparado, se completa cuando se reinicie el equipo' 'OK' 100
      Aviso-Fin
    } elseif ($compat) {
      $est = 'bloqueado'
      if ($hex -eq '0xC190020E') { $est = 'pospuesto' }
      Informar $est ('Verificacion de Microsoft: ' + $compat + ' (' + $hex + '). Logs en ' + $Logs) $compat
    } elseif ($codigo -eq -2) {
      Informar 'error' ('Red local: setup.exe quedo colgado y no informo resultado. Logs en ' + $Logs + ' y C:\$WINDOWS.~BT\Sources\Panther') $null
    } else {
      Informar 'error' ('Red local: setup.exe termino con el codigo ' + $hex + '. Logs en ' + $Logs) $null
    }
  }
  else {
    # ---------- Desde internet (Asistente de instalacion de Windows 11 de Microsoft) ----------
    Informar 'en_curso' 'Internet: descargando el Asistente de instalacion de Windows 11 desde Microsoft' $null
    Aviso-Inicio
    $asistente = Join-Path $Cache 'Windows11InstallationAssistant.exe'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri $UrlAsistente -OutFile $asistente -UseBasicParsing -TimeoutSec 600
    } catch {
      Informar 'pospuesto' ('Internet: no se pudo descargar el asistente de Microsoft (' + $_.Exception.Message + '): se reintenta') $null
      exit 0
    }
    if (-not (Firmado-Microsoft $asistente)) {
      Remove-Item $asistente -Force -ErrorAction SilentlyContinue
      Informar 'error' 'Internet: el asistente descargado no tiene una firma valida de Microsoft: upgrade NO lanzado' $null
      exit 1
    }

    # El asistente verifica la compatibilidad, baja Windows 11 (unos 4 GB) e instala conservando apps y datos
    $detAsis = 'Internet: el asistente de Microsoft esta descargando e instalando Windows 11 (1 a 3 horas segun la conexion)'
    Informar 'en_curso' $detAsis 'Asistente de Microsoft' 5
    $parametros = @('/QuietInstall', '/SkipEULA', '/auto upgrade', ('/copylogs "' + (Join-Path $Logs 'asistente') + '"'))
    if (-not $orden.reiniciar) { $parametros += '/NoRestartUI' }
    $p = Start-Process -FilePath $asistente -PassThru -ArgumentList $parametros
    $codigo = Esperar-Con-Avance $p 'en_curso' $detAsis 'Asistente de Microsoft' { $s = Avance-Setup; if ($null -eq $s) { return $null }; return [int](5 + 0.95 * $s) }
    $hex = '0x{0:X8}' -f $codigo
    if ($codigo -eq 0) {
      Informar 'pendiente_reinicio' 'Internet: Windows 11 instalado por el asistente, se completa cuando se reinicie el equipo' 'Asistente de Microsoft' 100
      Aviso-Fin
    } else {
      Informar 'error' ('Internet: el asistente de Microsoft termino con el codigo ' + $hex + '. Logs en ' + $Logs) 'Asistente de Microsoft'
    }
  }
}
catch {
  Informar 'error' ($_.Exception.Message) $null
  exit 1
}
`;

const AGENTE = String.raw`# Agente de inventario Accusys - reporta el estado del equipo cada pocos minutos
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysAgente'
$ArchivoClave = Join-Path $Carpeta 'equipo.key'

# Clave propia de este equipo (la entrega el servidor en el primer reporte)
$Secreto = $null
if (Test-Path $ArchivoClave) { $Secreto = (Get-Content -Path $ArchivoClave -Raw).Trim() }
$Estado = 'desconocido'

function Obtener($bloque) { try { & $bloque } catch { $null } }

# ---- Auto-update: compara el hash del script actual con el publicado en Supabase ----
try {
  $Script    = $MyInvocation.MyCommand.Path
  $hashActual = $null
  if ($Script -and (Test-Path $Script)) {
    $sha0 = [System.Security.Cryptography.SHA256]::Create()
    $hashActual = [BitConverter]::ToString($sha0.ComputeHash([System.IO.File]::ReadAllBytes($Script))) -replace '-', ''
  }
  $headersUpd = @{ 'apikey' = $AnonKey; 'Authorization' = 'Bearer ' + $AnonKey; 'Content-Type' = 'application/json' }
  $cuerpoUpd  = '{"p_token":' + ($Token | ConvertTo-Json) + ',"p_hash_actual":' + (if ($hashActual) { $hashActual | ConvertTo-Json } else { '""' }) + '}'
  $rUpd = Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/inv_agente_check_update') -Headers $headersUpd -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpoUpd)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 15
  if ($rUpd -and $rUpd.hay_update -and $rUpd.script_contenido -and $Script -and (Test-Path $Script)) {
    Set-Content -Path $Script -Value $rUpd.script_contenido -Encoding UTF8 -Force
    Set-Content -Path (Join-Path $Carpeta 'ultimo-update.txt') -Value ('UPDATE ' + (Get-Date).ToString('s') + ' v' + $rUpd.script_version)
    # Reiniciar la tarea para que corra con el nuevo script
    Stop-ScheduledTask  -TaskName 'AccusysInventarioAgente' -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName 'AccusysInventarioAgente'
    exit 0
  }
}
catch {
  # Si falla el check de update, continúa con el ciclo normal
  Set-Content -Path (Join-Path $Carpeta 'ultimo-update.txt') -Value ('ERROR-CHECK ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
}

try {
  $cs   = Get-CimInstance Win32_ComputerSystem
  $csp  = Get-CimInstance Win32_ComputerSystemProduct
  $bios = Get-CimInstance Win32_BIOS
  $os   = Get-CimInstance Win32_OperatingSystem
  $cpu  = Get-CimInstance Win32_Processor | Select-Object -First 1

  $discos = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    [ordered]@{
      unidad   = $_.DeviceID
      total_gb = [math]::Round($_.Size / 1GB, 1)
      libre_gb = [math]::Round($_.FreeSpace / 1GB, 1)
    }
  })
  $totalDisco = ($discos | ForEach-Object { $_.total_gb } | Measure-Object -Sum).Sum

  $red = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' |
         Where-Object { $_.DefaultIPGateway } | Select-Object -First 1
  $ip = $null; $mac = $null
  if ($red) {
    $ip  = $red.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
    $mac = $red.MACAddress
  }

  $versionSO = Obtener { (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').DisplayVersion }
  $bateria   = Obtener { (Get-CimInstance Win32_Battery | Select-Object -First 1).EstimatedChargeRemaining }
  $antivirus = Obtener { (Get-MpComputerStatus).AntivirusEnabled }
  $monitores = @(Obtener {
    Get-CimInstance Win32_DesktopMonitor | Where-Object { $_.ScreenWidth -and $_.ScreenWidth -gt 0 } | ForEach-Object {
      [ordered]@{
        nombre     = if ($_.Name) { ($_.Name -replace '\s+', ' ').Trim() } else { 'Monitor' }
        fabricante = if ($_.MonitorManufacturer) { $_.MonitorManufacturer.Trim() } else { $null }
        ancho_px   = [int]$_.ScreenWidth
        alto_px    = [int]$_.ScreenHeight
      }
    }
  })

  $datos = [ordered]@{
    uuid             = $csp.UUID
    hostname         = $env:COMPUTERNAME
    numero_serie     = $bios.SerialNumber
    fabricante       = $cs.Manufacturer
    modelo           = $cs.Model
    so_nombre        = $os.Caption
    so_version       = $versionSO
    so_build         = $os.BuildNumber
    so_arquitectura  = $os.OSArchitecture
    procesador       = ($cpu.Name -replace '\s+', ' ').Trim()
    nucleos          = $cpu.NumberOfCores
    ram_total_gb     = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    ram_libre_gb     = [math]::Round(($os.FreePhysicalMemory * 1KB) / 1GB, 1)
    discos           = $discos
    almacenamiento   = ('{0} GB' -f [math]::Round($totalDisco))
    ip               = $ip
    mac              = $mac
    usuario          = $cs.UserName
    dominio          = $cs.Domain
    arranque         = $os.LastBootUpTime.ToUniversalTime().ToString('o')
    bateria_pct      = $bateria
    antivirus_activo = $antivirus
    monitores        = $monitores
    agente_version   = $Version
  }

  $cuerpo = @{ p_token = $Token; p_datos = $datos; p_secreto = $Secreto } | ConvertTo-Json -Depth 6 -Compress
  $bytes  = [System.Text.Encoding]::UTF8.GetBytes($cuerpo)
  $headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $respuesta = Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/inv_reportar_dispositivo') -Headers $headers -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
  if ($respuesta.secreto) {
    Set-Content -Path $ArchivoClave -Value $respuesta.secreto -NoNewline
    $Secreto = [string]$respuesta.secreto
  }
  if ($respuesta.estado) { $Estado = [string]$respuesta.estado }

  $nota = ''
  if ($Estado -eq 'pendiente') { $nota = ' (pendiente de aprobacion en la app)' }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-reporte.txt') -Value ('OK ' + (Get-Date).ToString('s') + $nota)
}
catch {
  Set-Content -Path (Join-Path $Carpeta 'ultimo-reporte.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
  exit 1
}

# ---- Ubicacion: todas las IP del equipo (incluida la de la VPN) y el WiFi conectado ----
function Obtener-Redes {
  @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' | ForEach-Object {
    $adaptador = [string]$_.Description
    $gw = [bool]$_.DefaultIPGateway
    foreach ($dir in @($_.IPAddress)) {
      if ($dir -match '^\d+\.\d+\.\d+\.\d+$' -and $dir -notmatch '^(127\.|169\.254\.)') {
        [ordered]@{ ip = $dir; adaptador = $adaptador; gateway = $gw }
      }
    }
  })
}

function Obtener-Ssid {
  $salida = & netsh.exe wlan show interfaces 2>$null
  foreach ($linea in @($salida)) {
    if ($linea -match '^\s*SSID\s*:\s*(.+?)\s*$') { return $Matches[1] }
  }
  return $null
}

try {
  if ($Estado -eq 'aprobado') {
    $redesEquipo = @(Obtener-Redes)
    $ssid = Obtener { Obtener-Ssid }
    $cuerpoUb = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_uuid":' + (ConvertTo-Json ([string]$csp.UUID)) +
                ',"p_hostname":' + (ConvertTo-Json $env:COMPUTERNAME) + ',"p_secreto":' + (ConvertTo-Json ([string]$Secreto)) +
                ',"p_redes":' + (ConvertTo-Json -InputObject $redesEquipo -Depth 3 -Compress) +
                ',"p_ssid":' + (ConvertTo-Json ([string]$ssid)) + '}'
    Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/inv_reportar_ubicacion') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpoUb)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 30 | Out-Null
  }
}
catch {
  Set-Content -Path (Join-Path $Carpeta 'ultima-ubicacion.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
}

# ---- Aplicaciones instaladas: se envian solo si cambiaron o una vez por dia ----
function Obtener-Aplicaciones {
  $rutas = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  # Apps instaladas solo para el usuario (Teams, Zoom, etc.) de las sesiones abiertas
  $rutasUsuarios = @(Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -match '^S-1-5-21-[\d-]+$' } |
    ForEach-Object { 'Registry::HKEY_USERS\' + $_.PSChildName + '\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' })
  $rutas = $rutas + $rutasUsuarios

  $vistos = @{}
  foreach ($ruta in $rutas) {
    Get-ItemProperty -Path $ruta -ErrorAction SilentlyContinue | Where-Object {
      $_.DisplayName -and ($_.SystemComponent -ne 1) -and (-not $_.ParentKeyName) -and
      ($_.DisplayName -notmatch '^(Update for|Security Update|Hotfix)|\(KB\d+\)')
    } | ForEach-Object {
      $nombre = ($_.DisplayName -replace '\s+', ' ').Trim()
      $version = [string]$_.DisplayVersion
      $clave = $nombre + '|' + $version
      if (-not $vistos.ContainsKey($clave)) {
        $vistos[$clave] = $true
        [ordered]@{
          nombre            = $nombre
          version           = $version
          editor            = [string]$_.Publisher
          fecha_instalacion = [string]$_.InstallDate
        }
      }
    }
  }
}

try {
  $apps = @(Obtener-Aplicaciones | Sort-Object { $_.nombre })
  $jsonApps = ConvertTo-Json -InputObject $apps -Depth 3 -Compress
  if ($apps.Count -eq 0) { $jsonApps = '[]' }

  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($jsonApps))) -replace '-', ''
  $archivoHash = Join-Path $Carpeta 'apps.hash'
  $anterior = Get-Content $archivoHash -ErrorAction SilentlyContinue
  $vencido = (-not (Test-Path $archivoHash)) -or ((Get-Item $archivoHash).LastWriteTime -lt (Get-Date).AddHours(-24))

  if ((($hash -ne $anterior) -or $vencido) -and $Estado -eq 'aprobado') {
    $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_uuid":' + (ConvertTo-Json ([string]$csp.UUID)) +
              ',"p_hostname":' + (ConvertTo-Json $env:COMPUTERNAME) + ',"p_secreto":' + (ConvertTo-Json ([string]$Secreto)) + ',"p_apps":' + $jsonApps + '}'
    Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/inv_reportar_aplicaciones') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 60 | Out-Null
    Set-Content -Path $archivoHash -Value $hash
    Set-Content -Path (Join-Path $Carpeta 'ultimas-apps.txt') -Value ('OK ' + (Get-Date).ToString('s') + ' ' + $apps.Count + ' aplicaciones')
  }
}
catch {
  Set-Content -Path (Join-Path $Carpeta 'ultimas-apps.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
}

# ---- Seguridad: se envia si cambio algo o cada 6 horas ----
function Obtener-BitLocker {
  $vols = @(Get-CimInstance -Namespace 'root\cimv2\Security\MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -ErrorAction Stop)
  $detalle = @(foreach ($v in $vols) {
    if (-not $v.DriveLetter) { continue }
    $pct = $null
    try { $pct = (Invoke-CimMethod -InputObject $v -MethodName GetConversionStatus).EncryptionPercentage } catch { }
    $estado = switch ([int]$v.ConversionStatus) {
      0 { 'sin_cifrar' } 1 { 'cifrado' } 2 { 'cifrando' } 3 { 'descifrando' } 4 { 'pausado' } 5 { 'pausado' } default { 'desconocido' }
    }
    if ($estado -eq 'cifrado' -and [int]$v.ProtectionStatus -eq 0) { $estado = 'suspendido' }
    [ordered]@{ unidad = $v.DriveLetter; estado = $estado; porcentaje = $pct; proteccion = ([int]$v.ProtectionStatus -eq 1) }
  })
  $so = $detalle | Where-Object { $_.unidad -eq $env:SystemDrive } | Select-Object -First 1
  $general = 'no_disponible'
  if ($so) { $general = $so.estado }
  return @{ estado = $general; detalle = $detalle }
}

function Obtener-UltimoParche {
  $resultado = $null
  try {
    $buscador = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
    $total = $buscador.GetTotalHistoryCount()
    if ($total -gt 0) {
      $resultado = $buscador.QueryHistory(0, [math]::Min($total, 100)) |
        Where-Object { $_.Operation -eq 1 -and $_.ResultCode -eq 2 -and $_.Title -and
                       $_.Title -notmatch 'Defender|Security Intelligence|inteligencia de seguridad|Antimalware|KB2267602|KB890830|Malicious Software|software malintencionado' } |
        Sort-Object Date -Descending | Select-Object -First 1 |
        ForEach-Object { @{ fecha = $_.Date.ToUniversalTime().ToString('o'); titulo = $_.Title } }
    }
  } catch { }
  if (-not $resultado) {
    $hf = Get-HotFix -ErrorAction SilentlyContinue | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1
    if ($hf) { $resultado = @{ fecha = $hf.InstalledOn.ToUniversalTime().ToString('o'); titulo = $hf.HotFixID } }
  }
  return $resultado
}

function Obtener-ParhesPendientes {
  # Devuelve lista de actualizaciones pendientes (excluye Defender/firmas)
  # y la cantidad total. Si el COM falla devuelve null.
  try {
    $buscador = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
    $result   = $buscador.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
    $lista = @($result.Updates | Where-Object { $_.Title -and
                $_.Title -notmatch 'Defender|Security Intelligence|inteligencia de seguridad|Antimalware|KB2267602|KB890830|Malicious Software|software malintencionado' } |
      ForEach-Object {
        @{
          titulo    = $_.Title
          kb        = $(if ($_.KBArticleIDs.Count -gt 0) { 'KB' + $_.KBArticleIDs[0] } else { $null })
          categoria = $(if ($_.Categories.Count -gt 0) { $_.Categories.Item(0).Name } else { $null })
          critica   = [bool]($_.MsrcSeverity -match 'Critical|Critica|Importante|Important')
        }
      })
    return @{ cantidad = $lista.Count; actualizaciones = $lista }
  } catch { return $null }
}

function Obtener-Admins {
  $sidGrupo = 'S-1-5-32-544'
  try {
    return @(Get-LocalGroupMember -SID $sidGrupo -ErrorAction Stop | ForEach-Object {
      [ordered]@{
        nombre    = [string]$_.Name
        tipo      = [string]$_.ObjectClass
        origen    = [string]$_.PrincipalSource
        integrado = ([string]$_.SID -match '-500$')
      }
    })
  } catch {
    # Plan B (falla conocida de Get-LocalGroupMember con cuentas de Entra ID o SIDs huerfanos)
    $nombreGrupo = (New-Object System.Security.Principal.SecurityIdentifier($sidGrupo)).Translate([System.Security.Principal.NTAccount]).Value.Split('\')[1]
    $grupo = [ADSI]('WinNT://./' + $nombreGrupo + ',group')
    return @($grupo.psbase.Invoke('Members') | ForEach-Object {
      $ruta = $_.GetType().InvokeMember('ADsPath', 'GetProperty', $null, $_, $null)
      $clase = $_.GetType().InvokeMember('Class', 'GetProperty', $null, $_, $null)
      $partes = $ruta -replace '^WinNT://', '' -split '/'
      $nombre = ($partes | Select-Object -Last 2) -join '\'
      [ordered]@{ nombre = $nombre; tipo = $clase; origen = ''; integrado = $false }
    })
  }
}

function Obtener-Antivirus {
  $productos = @()
  try {
    $productos = @(Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object {
      $estado = [int]$_.productState
      [ordered]@{
        nombre      = $_.displayName
        activo      = ((($estado -shr 12) -band 0xF) -eq 1)
        actualizado = ((($estado -shr 4) -band 0xF) -eq 0)
      }
    })
  } catch { }
  $mp = Obtener { Get-MpComputerStatus }
  if ($productos.Count -eq 0) {
    # Servidores con ESET Server Security: no hay Centro de seguridad, se mira el servicio de ESET
    $ekrn = Obtener { Get-Service -Name ekrn -ErrorAction Stop }
    if ($ekrn) {
      $productos = @([ordered]@{
        nombre      = 'ESET Server Security'
        activo      = ([string]$ekrn.Status -eq 'Running')
        actualizado = $true
      })
    }
  }
  if ($productos.Count -eq 0 -and $mp) {
    # Servidores: no tienen Centro de seguridad, se usa Defender directo
    $productos = @([ordered]@{
      nombre      = 'Microsoft Defender'
      activo      = [bool]$mp.RealTimeProtectionEnabled
      actualizado = ($mp.AntivirusSignatureLastUpdated -gt (Get-Date).AddDays(-3))
    })
  }
  $firmas = $null
  if ($mp -and $mp.AntivirusSignatureLastUpdated) { $firmas = $mp.AntivirusSignatureLastUpdated.ToUniversalTime().ToString('o') }
  return @{ productos = $productos; firmas = $firmas }
}

function Obtener-Amenazas {
  $desde = (Get-Date).AddDays(-90)
  $catalogo = @{}
  Get-MpThreat -ErrorAction SilentlyContinue | ForEach-Object { $catalogo[[string]$_.ThreatID] = $_ }
  @(Get-MpThreatDetection -ErrorAction Stop |
    Where-Object { $_.InitialDetectionTime -and $_.InitialDetectionTime -gt $desde } |
    Sort-Object InitialDetectionTime -Descending | Select-Object -First 100 |
    ForEach-Object {
      $t = $catalogo[[string]$_.ThreatID]
      $cambio = $null
      if ($_.LastThreatStatusChangeTime) { $cambio = $_.LastThreatStatusChangeTime.ToUniversalTime().ToString('o') }
      [ordered]@{
        deteccion_id  = [string]$_.DetectionID
        nombre        = $(if ($t) { [string]$t.ThreatName } else { $null })
        severidad     = $(if ($t) { [int]$t.SeverityID } else { $null })
        categoria     = $(if ($t) { [int]$t.CategoryID } else { $null })
        ejecutada     = $(if ($t) { [bool]$t.DidThreatExecute } else { $null })
        estado_id     = [int]$_.ThreatStatusID
        recursos      = @($_.Resources | Select-Object -First 5 | ForEach-Object { [string]$_ })
        usuario       = [string]$_.DomainUser
        proceso       = [string]$_.ProcessName
        detectada     = $_.InitialDetectionTime.ToUniversalTime().ToString('o')
        cambio_estado = $cambio
      }
    })
}

function Fecha-Iso($f) {
  if ($f -and $f -is [datetime] -and $f.Year -gt 2000) { return $f.ToUniversalTime().ToString('o') }
  return $null
}

function Obtener-CifradoEset {
  # 1) ESET Endpoint Encryption (ex DESlock): herramienta oficial de consulta
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $candidatos = @(
    (Join-Path $env:ProgramFiles 'ESET Endpoint Encryption\DLPCmd64.exe'),
    (Join-Path $env:ProgramFiles 'ESET Endpoint Encryption\dlpcmd.exe')
  )
  if ($pf86) { $candidatos += (Join-Path $pf86 'ESET Endpoint Encryption\dlpcmd.exe') }
  $dlp = $candidatos | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($dlp) {
    $letra = $env:SystemDrive.TrimEnd(':')
    $proc = Start-Process -FilePath $dlp -ArgumentList @('query', ('-l:' + $letra)) -Wait -PassThru -WindowStyle Hidden
    $c = [int]$proc.ExitCode
    $estado = 'desconocido'
    if ($c -eq -103 -or $c -eq 100) { $estado = 'cifrado' }
    elseif ($c -eq -101) { $estado = 'sin_cifrar' }
    elseif ($c -eq -102 -or ($c -ge 0 -and $c -lt 100)) { $estado = 'cifrando' }
    $detalle = 'Codigo devuelto por DLPCmd: ' + $c
    if ($c -ge 0 -and $c -le 100) { $detalle = 'Unidad ' + $letra + ': ' + $c + '% cifrado' }
    return @{ producto = 'ESET Endpoint Encryption'; estado = $estado; detalle = $detalle }
  }

  # 2) ESET Full Disk Encryption (ESET PROTECT): estado que escribe el propio cliente
  $carpeta = Join-Path $env:ProgramData 'ESET\ESET Full Disk Encryption'
  $archivo = Join-Path $carpeta 'AIS\Logs\Status.html'
  if (Test-Path $archivo) {
    $texto = (Get-Content -Path $archivo -Raw -ErrorAction Stop) -replace '(?s)<(script|style)[^>]*>.*?</\1>', ' ' -replace '<[^>]+>', ' ' -replace '&nbsp;', ' ' -replace '&amp;', '&' -replace '\s+', ' '
    $texto = $texto.Trim()
    # Status.html es un log cronologico: las entradas antiguas estan primero y pueden decir "not encrypted"
    # aunque el equipo ya este cifrado. Se evalua solo el final del archivo (entrada mas reciente).
    $ultimo = if ($texto.Length -gt 500) { $texto.Substring($texto.Length - 500) } else { $texto }
    $t = $ultimo.ToLower()
    $estado = 'desconocido'
    if ($t -match 'not encrypted|is not encrypted|no est. cifrad|sin cifrar|unencrypted') { $estado = 'sin_cifrar' }
    elseif ($t -match 'failed|error al|fall. ') { $estado = 'error' }
    elseif ($t -match 'waiting for|pre-boot password|restart is required|safe start|must restart|reinicio|reiniciar') { $estado = 'pendiente' }
    elseif ($t -match 'encrypting|encryption in progress|in progress|cifrando|en curso|decrypting') { $estado = 'cifrando' }
    elseif ($t -match 'encrypted|cifrad') { $estado = 'cifrado' }
    # Guardar los ultimos 800 caracteres en detalle (los mas recientes, utiles para debug)
    $corto = if ($texto.Length -gt 800) { $texto.Substring($texto.Length - 800) } else { $texto }
    return @{ producto = 'ESET Full Disk Encryption'; estado = $estado; detalle = $corto }
  }
  if (Test-Path $carpeta) {
    return @{ producto = 'ESET Full Disk Encryption'; estado = 'desconocido'; detalle = 'Cliente EFDE instalado, sin archivo de estado' }
  }
  return $null
}

function Obtener-ClaveBios {
  # Dell (modelos 2018 en adelante): WMI nativo, sin instalar nada
  try {
    $p = @(Get-CimInstance -Namespace 'root\dcim\sysman\wmisecurity' -ClassName PasswordObject -ErrorAction Stop)
    if ($p.Count -gt 0) {
      $adm = $p | Where-Object { $_.NameId -eq 'Admin' } | Select-Object -First 1
      $sis = $p | Where-Object { $_.NameId -eq 'System' } | Select-Object -First 1
      return @{
        admin   = $(if ($adm) { [int]$adm.IsPasswordSet -eq 1 } else { $null })
        sistema = $(if ($sis) { [int]$sis.IsPasswordSet -eq 1 } else { $null })
        fuente  = 'Dell (WMI del BIOS)'
      }
    }
  } catch { }
  # Dell modelos anteriores: requiere Dell Command | Monitor
  try {
    $p = @(Get-CimInstance -Namespace 'root\dcim\sysman' -ClassName DCIM_BIOSPassword -ErrorAction Stop)
    if ($p.Count -gt 0) {
      $adm = $p | Where-Object { $_.AttributeName -match 'Admin|Setup' } | Select-Object -First 1
      $sis = $p | Where-Object { $_.AttributeName -match 'System' } | Select-Object -First 1
      return @{
        admin   = $(if ($adm) { [string]$adm.IsSet -match 'true|1' } else { $null })
        sistema = $(if ($sis) { [string]$sis.IsSet -match 'true|1' } else { $null })
        fuente  = 'Dell Command Monitor'
      }
    }
  } catch { }
  # Lenovo: PasswordState es una suma de bits (1 encendido, 2 supervisor)
  try {
    $l = Get-CimInstance -Namespace 'root\wmi' -ClassName Lenovo_BiosPasswordSettings -ErrorAction Stop | Select-Object -First 1
    if ($l) {
      $e = [int]$l.PasswordState
      return @{ admin = (($e -band 2) -ne 0); sistema = (($e -band 1) -ne 0); fuente = 'Lenovo (WMI del BIOS)' }
    }
  } catch { }
  # HP
  try {
    $h = @(Get-CimInstance -Namespace 'root\HP\InstrumentedBIOS' -ClassName HP_BIOSPassword -ErrorAction Stop)
    if ($h.Count -gt 0) {
      $adm = $h | Where-Object { $_.Name -match 'Setup' } | Select-Object -First 1
      $sis = $h | Where-Object { $_.Name -match 'Power-On' } | Select-Object -First 1
      return @{
        admin   = $(if ($adm) { [int]$adm.IsSet -eq 1 } else { $null })
        sistema = $(if ($sis) { [int]$sis.IsSet -eq 1 } else { $null })
        fuente  = 'HP (WMI del BIOS)'
      }
    }
  } catch { }
  return $null
}

try {
  $bl = Obtener { Obtener-BitLocker }
  $eset = Obtener { Obtener-CifradoEset }
  $bios = Obtener { Obtener-ClaveBios }
  if (-not $bl) { $bl = @{ estado = 'no_disponible'; detalle = @() } }
  $parche = Obtener-UltimoParche
  $parchesPendientes = Obtener-ParhesPendientes
  $reinicio = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or
              (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
  $admins = @(Obtener { Obtener-Admins } | Where-Object { $_ })
  $fw = [ordered]@{}
  Obtener { Get-NetFirewallProfile | ForEach-Object { $fw[[string]$_.Name] = ([string]$_.Enabled -eq 'True') } } | Out-Null
  # Si otro firewall (por ejemplo el de ESET Endpoint Security) esta activo, Windows apaga el suyo: manda ese
  $fwTerceros = @(Obtener { Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName FirewallProduct -ErrorAction Stop } |
    Where-Object { $_ -and (((([int]$_.productState) -shr 12) -band 0xF) -eq 1) })
  if ($fwTerceros.Count -gt 0) {
    $fw = [ordered]@{}
    $fwTerceros | ForEach-Object { $fw[[string]$_.displayName] = $true }
  }
  $av = Obtener-Antivirus
  $mpEstado = Obtener { Get-MpComputerStatus }
  $amenazas = Obtener { Obtener-Amenazas }
  $tpm = Obtener { Get-CimInstance -Namespace 'root\cimv2\Security\MicrosoftTpm' -ClassName Win32_Tpm }
  $secureBoot = Obtener { Confirm-SecureBootUEFI }
  if ($null -eq $secureBoot) { $secureBoot = $false }

  $seguridad = [ordered]@{
    bitlocker_estado     = $bl.estado
    bitlocker_detalle    = @($bl.detalle)
    ultimo_parche        = $(if ($parche) { $parche.fecha } else { $null })
    ultimo_parche_titulo = $(if ($parche) { $parche.titulo } else { $null })
    reinicio_pendiente   = [bool]$reinicio
    admins_locales       = $(if ($admins.Count -gt 0) { $admins } else { $null })
    firewall_perfiles    = $fw
    firewall_activo      = ($fw.Count -gt 0 -and -not ($fw.Values -contains $false))
    av_productos         = @($av.productos)
    av_firmas_fecha      = $av.firmas
    av_escaneo_rapido    = $(if ($mpEstado) { Fecha-Iso $mpEstado.QuickScanEndTime } else { $null })
    av_escaneo_completo  = $(if ($mpEstado) { Fecha-Iso $mpEstado.FullScanEndTime } else { $null })
    av_proteccion_alteraciones = $(if ($mpEstado -and $null -ne $mpEstado.IsTamperProtected) { [bool]$mpEstado.IsTamperProtected } else { $null })
    amenazas             = @($amenazas | Where-Object { $_ })
    tpm_presente         = [bool]$tpm
    tpm_version          = $(if ($tpm) { ([string]$tpm.SpecVersion).Split(',')[0].Trim() } else { $null })
    secure_boot          = [bool]$secureBoot
    cifrado_producto     = $(if ($eset) { $eset.producto } else { $null })
    cifrado_estado       = $(if ($eset) { $eset.estado } else { $null })
    cifrado_detalle      = $(if ($eset) { $eset.detalle } else { $null })
    bios_clave_admin     = $(if ($bios) { $bios.admin } else { $null })
    bios_clave_sistema   = $(if ($bios) { $bios.sistema } else { $null })
    bios_fuente          = $(if ($bios) { $bios.fuente } else { $null })
    parches_pendientes   = $parchesPendientes
  }

  $jsonSeg = ConvertTo-Json -InputObject $seguridad -Depth 5 -Compress
  $sha2 = [System.Security.Cryptography.SHA256]::Create()
  $hashSeg = [BitConverter]::ToString($sha2.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($jsonSeg))) -replace '-', ''
  $archivoSeg = Join-Path $Carpeta 'seguridad.hash'
  $anteriorSeg = Get-Content $archivoSeg -ErrorAction SilentlyContinue
  $vencidoSeg = (-not (Test-Path $archivoSeg)) -or ((Get-Item $archivoSeg).LastWriteTime -lt (Get-Date).AddHours(-1))

  if ((($hashSeg -ne $anteriorSeg) -or $vencidoSeg) -and $Estado -eq 'aprobado') {
    $cuerpoSeg = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_uuid":' + (ConvertTo-Json ([string]$csp.UUID)) +
                 ',"p_hostname":' + (ConvertTo-Json $env:COMPUTERNAME) + ',"p_secreto":' + (ConvertTo-Json ([string]$Secreto)) + ',"p_datos":' + $jsonSeg + '}'
    Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/inv_reportar_seguridad') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpoSeg)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 60 | Out-Null
    Set-Content -Path $archivoSeg -Value $hashSeg
    Set-Content -Path (Join-Path $Carpeta 'ultima-seguridad.txt') -Value ('OK ' + (Get-Date).ToString('s'))
  }
}
catch {
  Set-Content -Path (Join-Path $Carpeta 'ultima-seguridad.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
}

# ---- Accesos (solo servidores): inicios de sesion por consola y Escritorio remoto, cierres e intentos fallidos ----
try {
  if ($os -and [int]$os.ProductType -ne 1 -and $Estado -eq 'aprobado') {
    $archivoAcc = Join-Path $Carpeta 'accesos.ultimo'
    $ultimoAcc = $null
    if (Test-Path $archivoAcc) { $ultimoAcc = (Get-Content $archivoAcc -Raw).Trim() }
    if ($ultimoAcc -match '^\d+$') { $condAcc = 'EventRecordID &gt; ' + $ultimoAcc } else { $condAcc = 'TimeCreated[timediff(@SystemTime) &lt;= 604800000]' }
    $ltOk = (@('2', '10', '11') | ForEach-Object { "Data[@Name='LogonType']='" + $_ + "'" }) -join ' or '
    $ltFallo = (@('2', '3', '10') | ForEach-Object { "Data[@Name='LogonType']='" + $_ + "'" }) -join ' or '
    $xmlAcc = '<QueryList><Query Id="0" Path="Security">' +
      '<Select Path="Security">*[System[(EventID=4624 or EventID=4634) and ' + $condAcc + '] and EventData[' + $ltOk + ']]</Select>' +
      '<Select Path="Security">*[System[(EventID=4625) and ' + $condAcc + '] and EventData[' + $ltFallo + ']]</Select>' +
      '<Select Path="Security">*[System[(EventID=4647) and ' + $condAcc + ']]</Select>' +
      '</Query></QueryList>'
    $evsAcc = @()
    try { $evsAcc = @(Get-WinEvent -FilterXml ([xml]$xmlAcc) -Oldest -MaxEvents 1500) }
    catch { if ($_.FullyQualifiedErrorId -notmatch 'NoMatchingEventsFound' -and $_.Exception.Message -notmatch 'No events|No se encontraron') { throw } }
    $sistema = @('SYSTEM', 'ANONYMOUS LOGON', 'LOCAL SERVICE', 'NETWORK SERVICE', '-', '')
    $accesos = New-Object System.Collections.ArrayList
    $maxAcc = $ultimoAcc
    foreach ($e in ($evsAcc | Sort-Object RecordId)) {
      if (-not $maxAcc -or [int64]$e.RecordId -gt [int64]$maxAcc) { $maxAcc = [string]$e.RecordId }
      $d = @{}
      try { foreach ($n in ([xml]$e.ToXml()).Event.EventData.Data) { $d[[string]$n.Name] = [string]$n.'#text' } } catch { continue }
      $u = [string]$d['TargetUserName']
      if ($sistema -contains $u.ToUpper() -or $u -match '\$$' -or $u -match '^(DWM-|UMFD-)') { continue }
      $id = [int]$e.Id
      # Un administrador por RDP genera dos inicios enlazados (token completo y filtrado): se guarda uno solo
      if ($id -eq 4624 -and $d['TargetLinkedLogonId'] -and $d['TargetLinkedLogonId'] -ne '0x0' -and $d['ElevatedToken'] -eq '%%1843') { continue }
      $tipoAcc = 'fin'
      if ($id -eq 4624) { $tipoAcc = 'inicio' } elseif ($id -eq 4625) { $tipoAcc = 'fallo' }
      $ipAcc = $d['IpAddress']
      if ($ipAcc) { $ipAcc = ($ipAcc -replace '^::ffff:', ''); if ($ipAcc -in @('-', '::1', '127.0.0.1')) { $ipAcc = $null } }
      $motivoAcc = $null
      if ($id -eq 4625) { $motivoAcc = $d['SubStatus']; if (-not $motivoAcc -or $motivoAcc -eq '0x0') { $motivoAcc = $d['Status'] } }
      $lt = $null
      if ($d['LogonType'] -match '^\d+$') { $lt = [int]$d['LogonType'] }
      $origenAcc = $d['WorkstationName']
      if ($origenAcc -eq '-') { $origenAcc = $null }
      [void]$accesos.Add([ordered]@{
        record_id = [int64]$e.RecordId; fecha = $e.TimeCreated.ToUniversalTime().ToString('o'); tipo = $tipoAcc
        usuario = $u; dominio = $d['TargetDomainName']; logon_type = $lt; ip = $ipAcc; origen = $origenAcc
        logon_id = $d['TargetLogonId']; motivo = $motivoAcc
      })
    }
    if ($accesos.Count -gt 0) {
      $jsonAcc = ConvertTo-Json -InputObject ([ordered]@{ eventos = $accesos }) -Depth 4 -Compress
      $cuerpoAcc = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_uuid":' + (ConvertTo-Json ([string]$csp.UUID)) +
                   ',"p_hostname":' + (ConvertTo-Json $env:COMPUTERNAME) + ',"p_secreto":' + (ConvertTo-Json ([string]$Secreto)) + ',"p_datos":' + $jsonAcc + '}'
      Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/srv_reportar_accesos') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpoAcc)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 60 | Out-Null
    }
    if ($maxAcc) { Set-Content -Path $archivoAcc -Value $maxAcc }
    Set-Content -Path (Join-Path $Carpeta 'ultimos-accesos.txt') -Value ('OK ' + (Get-Date).ToString('s') + ' ' + $accesos.Count + ' eventos de acceso')
  }
}
catch {
  $dAcc = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $dAcc = $dAcc + ' | ' + $_.ErrorDetails.Message }
  Set-Content -Path (Join-Path $Carpeta 'ultimos-accesos.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + ($dAcc -replace '\s+', ' '))
}

# ---- Migracion a Windows 11 (solo equipos de escritorio aprobados) ----
# Informa el build y el estado del upgrade; si Accusys Cyber ordena actualizar, lanza la tarea aparte.
# El agente no ejecuta nada que venga del servidor: la unica orden posible es "actualizar".
try {
  if ($Estado -eq 'aprobado' -and $os -and [int]$os.ProductType -eq 1) {
    $DirW11 = Join-Path $Carpeta 'w11'
    $ArchEstadoW11 = Join-Path $DirW11 'estado.json'
    $TareaW11 = 'AccusysActualizacionW11'
    $datosW11 = [ordered]@{ build = [string]$os.BuildNumber }
    $pendienteW11 = $null
    if (Test-Path $ArchEstadoW11) {
      $pendienteW11 = Get-Content $ArchEstadoW11 -Raw | ConvertFrom-Json
      if (-not $pendienteW11.reportado) {
        $datosW11.estado  = [string]$pendienteW11.estado
        $datosW11.detalle = [string]$pendienteW11.detalle
        $datosW11.compat  = [string]$pendienteW11.compat
        if ($null -ne $pendienteW11.progreso) { $datosW11.progreso = [int]$pendienteW11.progreso }
      }
    }
    $cuerpoW11 = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_uuid":' + (ConvertTo-Json ([string]$csp.UUID)) +
                 ',"p_hostname":' + (ConvertTo-Json $env:COMPUTERNAME) + ',"p_secreto":' + (ConvertTo-Json ([string]$Secreto)) +
                 ',"p_datos":' + (ConvertTo-Json -InputObject $datosW11 -Compress) + '}'
    $rW11 = Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/inv_w11_agente') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpoW11)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
    if ($datosW11.Contains('estado')) {
      # Solo se marca como reportado si la tarea no escribio un estado nuevo mientras tanto (avance cada 30 s)
      $actualW11 = Obtener { Get-Content $ArchEstadoW11 -Raw | ConvertFrom-Json }
      if ($actualW11 -and [string]$actualW11.fecha -eq [string]$pendienteW11.fecha -and [string]$actualW11.estado -eq [string]$pendienteW11.estado) {
        $pendienteW11.reportado = $true
        Set-Content -Path $ArchEstadoW11 -Value ($pendienteW11 | ConvertTo-Json -Compress) -Encoding UTF8
      }
    }

    if ($rW11.orden -eq 'actualizar' -and [int]$os.BuildNumber -lt 22000) {
      $enMarcha = Obtener { (Get-ScheduledTask -TaskName $TareaW11 -ErrorAction Stop).State -eq 'Running' }
      if (-not $enMarcha) {
        New-Item -ItemType Directory -Force -Path $DirW11 | Out-Null
        $ordenW11 = [ordered]@{ origen = [string]$rW11.origen; sha256 = [string]$rW11.sha256; reiniciar = [bool]$rW11.reiniciar; internet = [bool]$rW11.internet }
        Set-Content -Path (Join-Path $DirW11 'orden.json') -Value ($ordenW11 | ConvertTo-Json -Compress) -Encoding UTF8
        $scriptW11 = Join-Path $DirW11 'actualizar.ps1'
        Set-Content -Path $scriptW11 -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__W11_SCRIPT__'))) -Encoding UTF8
        Set-Content -Path $ArchEstadoW11 -Value '{"estado":"en_curso","detalle":"Tarea de actualizacion iniciada","compat":null,"progreso":0,"reportado":false}' -Encoding UTF8
        $accW11 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptW11 + '"')
        $usrW11 = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $cfgW11 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $TareaW11 -Action $accW11 -Principal $usrW11 -Settings $cfgW11 -Force | Out-Null
        Start-ScheduledTask -TaskName $TareaW11
      }
    }
    Set-Content -Path (Join-Path $Carpeta 'ultima-w11.txt') -Value ('OK ' + (Get-Date).ToString('s') + ' orden: ' + [string]$rW11.orden)
  }
}
catch {
  Set-Content -Path (Join-Path $Carpeta 'ultima-w11.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
}

# ---- Diagnostico del disco C (agente 2.1) ----
# Envia el resultado del ultimo analisis y pregunta si hay que hacer uno nuevo. Cuando analizar lo decide
# Accusys Cyber (pedido desde la app, disco casi lleno o analisis viejo). El analisis corre en una tarea aparte y solo lee.
try {
  if ($Estado -eq 'aprobado') {
    $DirDisco = Join-Path $Carpeta 'disco'
    $ArchDisco = Join-Path $DirDisco 'disco.json'
    $TareaDisco = 'AccusysDiagnosticoDisco'
    $resDisco = $null
    $datosDisco = '{}'
    if (Test-Path $ArchDisco) {
      $resDisco = Get-Content $ArchDisco -Raw | ConvertFrom-Json
      if (-not $resDisco.reportado) { $datosDisco = '{"resultado":' + (Get-Content $ArchDisco -Raw).Trim() + '}' }
    }
    $enMarchaDisco = [bool](Obtener { (Get-ScheduledTask -TaskName $TareaDisco -ErrorAction Stop).State -eq 'Running' })
    if ($datosDisco -eq '{}' -and $enMarchaDisco) { $datosDisco = '{"en_curso":true}' }
    $cuerpoDisco = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_uuid":' + (ConvertTo-Json ([string]$csp.UUID)) +
                   ',"p_hostname":' + (ConvertTo-Json $env:COMPUTERNAME) + ',"p_secreto":' + (ConvertTo-Json ([string]$Secreto)) +
                   ',"p_datos":' + $datosDisco + '}'
    $rDisco = Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/inv_disco_agente') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpoDisco)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 60
    if ($datosDisco.StartsWith('{"resultado"')) {
      $resDisco.reportado = $true
      Set-Content -Path $ArchDisco -Value ($resDisco | ConvertTo-Json -Depth 6 -Compress) -Encoding UTF8
    }
    if ($rDisco.analizar -and -not $enMarchaDisco) {
      New-Item -ItemType Directory -Force -Path $DirDisco | Out-Null
      $scriptDisco = Join-Path $DirDisco 'analizar.ps1'
      Set-Content -Path $scriptDisco -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__DISCO_SCRIPT__'))) -Encoding UTF8
      $accDisco = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptDisco + '"')
      $usrDisco = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      $cfgDisco = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -MultipleInstances IgnoreNew -Priority 7
      Register-ScheduledTask -TaskName $TareaDisco -Action $accDisco -Principal $usrDisco -Settings $cfgDisco -Force | Out-Null
      Start-ScheduledTask -TaskName $TareaDisco
    }
    Set-Content -Path (Join-Path $Carpeta 'ultimo-disco.txt') -Value ('OK ' + (Get-Date).ToString('s') + ' analizar: ' + [string]$rDisco.analizar)
  }
}
catch {
  Set-Content -Path (Join-Path $Carpeta 'ultimo-disco.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
}

# ---- Órdenes remotas (Windows Update, etc.) ----
try {
  $cuerpoOrd = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_uuid":' + (ConvertTo-Json ([string]$csp.UUID)) +
               ',"p_hostname":' + (ConvertTo-Json $env:COMPUTERNAME) + '}'
  $ordenes = Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/inv_ordenes_pendientes') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpoOrd)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 20
  foreach ($ord in @($ordenes)) {
    if (-not $ord -or -not $ord.id) { continue }
    $ordEstado  = 'completada'
    $ordResult  = $null
    $ordDetalle = $null
    try {
      if ($ord.tipo -eq 'windows_update') {
        # Buscar actualizaciones pendientes via COM (no requiere módulos adicionales)
        $sess   = New-Object -ComObject Microsoft.Update.Session
        $buscar = $sess.CreateUpdateSearcher()
        $res    = $buscar.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
        $lista  = @($res.Updates | Where-Object { $_.Title -notmatch 'Defender|Security Intelligence|Antimalware|KB2267602|KB890830|Malicious Software' })
        if ($lista.Count -eq 0) {
          $ordResult = 'Sin actualizaciones pendientes'
        } else {
          # Descargar e instalar
          $downloader = $sess.CreateUpdateDownloader()
          $downloader.Updates = $res.Updates
          $downloader.Download() | Out-Null
          $installer = $sess.CreateUpdateInstaller()
          $installer.Updates = $res.Updates
          $installer.AllowSourcePrompts = $false
          $installer.ForceQuiet = $true
          $instRes = $installer.Install()
          $instaladas = @($lista | ForEach-Object { $_.Title })
          $ordDetalle = @{ instaladas = $instaladas; reinicio = [bool]$instRes.RebootRequired } | ConvertTo-Json -Compress
          $ordResult  = ('{0} actualización(es) instalada(s)' -f $lista.Count) + $(if ($instRes.RebootRequired) { '. Reinicio requerido.' } else { '.' })
          if ($instRes.ResultCode -notin @(2, 3)) { $ordEstado = 'error'; $ordResult = 'Error al instalar (código ' + $instRes.ResultCode + ')' }
        }
      } else {
        $ordEstado = 'error'; $ordResult = 'Tipo de orden desconocido: ' + $ord.tipo
      }
    } catch {
      $ordEstado = 'error'; $ordResult = $_.Exception.Message
    }
    $cuerpoRes = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_id":' + $ord.id +
                 ',"p_estado":' + (ConvertTo-Json $ordEstado) + ',"p_resultado":' + (ConvertTo-Json $ordResult) +
                 ',"p_detalle":' + $(if ($ordDetalle) { $ordDetalle } else { 'null' }) + '}'
    Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/inv_orden_resultado') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpoRes)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 20 | Out-Null
  }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-ordenes.txt') -Value ('OK ' + (Get-Date).ToString('s'))
}
catch {
  Set-Content -Path (Join-Path $Carpeta 'ultimo-ordenes.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
}
`;

const INSTALADOR = String.raw`# Instalador del agente de inventario Accusys
# Ejecutar como administrador:
#   powershell -ExecutionPolicy Bypass -File .\instalar-agente-accusys.ps1

$ErrorActionPreference = 'Stop'
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Ejecuta este script como administrador.' -ForegroundColor Red; exit 1 }

$Carpeta = 'C:\ProgramData\AccusysAgente'
$Script  = Join-Path $Carpeta 'agente.ps1'
$Tarea   = 'AccusysInventarioAgente'

New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
# Carpeta accesible solo para SYSTEM y Administradores: un usuario comun no puede leer el token ni la clave del equipo.
# Se protege la carpeta y los archivos que ya existan pasan a heredar esos permisos (tambien repara
# instalaciones anteriores que dejaban archivos sin permisos y daban "Acceso denegado" al reinstalar).
& icacls.exe $Carpeta /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
# Archivos que dejo una version anterior: se toma posesion (Administradores) y se les devuelven los permisos heredados
Get-ChildItem -Path $Carpeta -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
  & takeown.exe /F $_.FullName /A 2>&1 | Out-Null
  & icacls.exe $_.FullName /reset /Q 2>&1 | Out-Null
}

$agente = @'
__AGENTE__
'@
Set-Content -Path $Script -Value $agente -Encoding UTF8

$accion   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Script + '"')
$periodo  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes __INTERVALO__)
$arranque = New-ScheduledTaskTrigger -AtStartup
$usuario  = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$config   = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $Tarea -Action $accion -Trigger @($periodo, $arranque) -Principal $usuario -Settings $config -Force | Out-Null
Start-ScheduledTask -TaskName $Tarea

Start-Sleep -Seconds 15
$resultado = Get-Content (Join-Path $Carpeta 'ultimo-reporte.txt') -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Agente instalado. Resultado del primer reporte:' -ForegroundColor Green
Write-Host $resultado
`;

const DESINSTALADOR = String.raw`# Desinstala el agente de inventario Accusys (ejecutar como administrador)
Unregister-ScheduledTask -TaskName 'AccusysInventarioAgente' -Confirm:$false -ErrorAction SilentlyContinue
# Borra tambien la clave del equipo: si se vuelve a instalar, hay que restablecerla desde Monitoreo en la app
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysAgente' -ErrorAction SilentlyContinue
Write-Host 'Agente desinstalado.'
`;

export function generarInstalador(url: string, anon: string, token: string, intervalo: number) {
  // Reemplazos con función: así los "$" del código PowerShell no se interpretan como patrones de JS
  const agente = AGENTE.replace("__URL__", () => url.replace(/\/$/, ""))
    .replace("__ANON__", () => anon)
    .replace("__TOKEN__", () => token)
    .replace("__VERSION__", () => AGENTE_VERSION)
    // btoa: el script es solo ASCII y funciona igual en el navegador y en el servidor
    .replace("__W11_SCRIPT__", () => btoa(W11_ACTUALIZAR.replace(/\r?\n/g, "\r\n")))
    .replace("__DISCO_SCRIPT__", () => btoa(DISCO_ANALIZAR.replace(/\r?\n/g, "\r\n")));
  return INSTALADOR.replace("__AGENTE__", () => agente).replace("__INTERVALO__", () => String(intervalo));
}

// Lanzador .cmd: un solo archivo que se abre con doble clic. Pide permisos de administrador
// y ejecuta EN MEMORIA el script de PowerShell que lleva adentro (despues de la marca):
// no se escribe ningun archivo temporal que otro programa pueda reemplazar antes de ejecutarse.
// No depende de la politica de ejecucion de PowerShell ni de la carpeta donde se guarde.
const LANZADOR = String.raw`@echo off
rem __TITULO__ - hacer doble clic para ejecutar.
title __TITULO__
net session >nul 2>&1
if errorlevel 1 (
  echo Pidiendo permisos de administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo __TITULO__
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText('%~f0'); $i=$t.IndexOf('#==INICIO'+'_SCRIPT==#'); & ([ScriptBlock]::Create($t.Substring($i)))"
echo.
pause
exit /b
#==INICIO_SCRIPT==#
`;

export function generarInstaladorCmd(url: string, anon: string, token: string, intervalo: number) {
  return LANZADOR.replace(/__TITULO__/g, () => "Instalador del agente de Accusys Cyber") + generarInstalador(url, anon, token, intervalo);
}

// Envuelve cualquier script de PowerShell en un .cmd de doble clic (pide administrador y lo ejecuta en memoria)
export function envolverEnCmd(titulo: string, script: string) {
  return LANZADOR.replace(/__TITULO__/g, () => titulo) + script;
}

export function generarDesinstaladorCmd() {
  return LANZADOR.replace(/__TITULO__/g, () => "Desinstalador del agente de Accusys Cyber") + generarDesinstalador();
}

export function generarDesinstalador() {
  return DESINSTALADOR;
}

// Genera el script del agente listo para publicar en Supabase (auto-update).
// Usa los mismos valores de URL/token que el instalador descargado.
export function generarScriptAgente(url: string, anon: string, token: string) {
  return AGENTE
    .replace("__URL__", () => url.replace(/\/$/, ""))
    .replace("__ANON__", () => anon)
    .replace("__TOKEN__", () => token)
    .replace("__VERSION__", () => AGENTE_VERSION)
    .replace("__W11_SCRIPT__", () => btoa(W11_ACTUALIZAR.replace(/\r?\n/g, "\r\n")))
    .replace("__DISCO_SCRIPT__", () => btoa(DISCO_ANALIZAR.replace(/\r?\n/g, "\r\n")));
}

export function descargar(nombre: string, contenido: string, opciones: { linux?: boolean } = {}) {
  // Windows: CRLF. Los .ps1 llevan BOM (Windows PowerShell 5.1 los lee mejor); los .cmd NO,
  // porque la consola interpretaria el BOM como parte del primer comando.
  // Linux (.sh): saltos de linea LF y sin BOM, o bash no lo puede ejecutar.
  const linux = opciones.linux || nombre.toLowerCase().endsWith(".sh");
  const bom = linux || nombre.toLowerCase().endsWith(".cmd") ? "" : "\uFEFF";
  const texto = linux ? contenido.replace(/\r\n/g, "\n") : contenido.replace(/\r?\n/g, "\r\n");
  const blob = new Blob([bom + texto], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  a.click();
}
