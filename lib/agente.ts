// Plantillas del agente de Windows. Se completan con la URL de Supabase,
// la clave pública y el token al momento de descargar el instalador.
// Nota: el código PowerShell es solo ASCII (sin tildes) para que Windows
// PowerShell 5.1 lo lea bien en cualquier configuración regional.

export const AGENTE_VERSION = "1.5";

const AGENTE = String.raw`# Agente de inventario Accusys - reporta el estado del equipo cada pocos minutos
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysAgente'

function Obtener($bloque) { try { & $bloque } catch { $null } }

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
    agente_version   = $Version
  }

  $cuerpo = @{ p_token = $Token; p_datos = $datos } | ConvertTo-Json -Depth 6 -Compress
  $bytes  = [System.Text.Encoding]::UTF8.GetBytes($cuerpo)
  $headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/inv_reportar_dispositivo') -Headers $headers -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 30 | Out-Null

  Set-Content -Path (Join-Path $Carpeta 'ultimo-reporte.txt') -Value ('OK ' + (Get-Date).ToString('s'))
}
catch {
  Set-Content -Path (Join-Path $Carpeta 'ultimo-reporte.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
  exit 1
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

  if (($hash -ne $anterior) -or $vencido) {
    $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_uuid":' + (ConvertTo-Json ([string]$csp.UUID)) +
              ',"p_hostname":' + (ConvertTo-Json $env:COMPUTERNAME) + ',"p_apps":' + $jsonApps + '}'
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
    $t = $texto.ToLower()
    $estado = 'desconocido'
    if ($t -match 'not encrypted|is not encrypted|no est. cifrad|sin cifrar|unencrypted') { $estado = 'sin_cifrar' }
    elseif ($t -match 'failed|error al|fall. ') { $estado = 'error' }
    elseif ($t -match 'waiting for|pre-boot password|restart is required|safe start|must restart|reinicio|reiniciar') { $estado = 'pendiente' }
    elseif ($t -match 'encrypting|encryption in progress|in progress|cifrando|en curso|decrypting') { $estado = 'cifrando' }
    elseif ($t -match 'encrypted|cifrad') { $estado = 'cifrado' }
    $corto = $texto
    if ($corto.Length -gt 800) { $corto = $corto.Substring(0, 800) }
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
  $reinicio = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or
              (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
  $admins = @(Obtener { Obtener-Admins } | Where-Object { $_ })
  $fw = [ordered]@{}
  Obtener { Get-NetFirewallProfile | ForEach-Object { $fw[[string]$_.Name] = ([string]$_.Enabled -eq 'True') } } | Out-Null
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
  }

  $jsonSeg = ConvertTo-Json -InputObject $seguridad -Depth 5 -Compress
  $sha2 = [System.Security.Cryptography.SHA256]::Create()
  $hashSeg = [BitConverter]::ToString($sha2.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($jsonSeg))) -replace '-', ''
  $archivoSeg = Join-Path $Carpeta 'seguridad.hash'
  $anteriorSeg = Get-Content $archivoSeg -ErrorAction SilentlyContinue
  $vencidoSeg = (-not (Test-Path $archivoSeg)) -or ((Get-Item $archivoSeg).LastWriteTime -lt (Get-Date).AddHours(-6))

  if (($hashSeg -ne $anteriorSeg) -or $vencidoSeg) {
    $cuerpoSeg = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_uuid":' + (ConvertTo-Json ([string]$csp.UUID)) +
                 ',"p_hostname":' + (ConvertTo-Json $env:COMPUTERNAME) + ',"p_datos":' + $jsonSeg + '}'
    Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/inv_reportar_seguridad') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpoSeg)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 60 | Out-Null
    Set-Content -Path $archivoSeg -Value $hashSeg
    Set-Content -Path (Join-Path $Carpeta 'ultima-seguridad.txt') -Value ('OK ' + (Get-Date).ToString('s'))
  }
}
catch {
  Set-Content -Path (Join-Path $Carpeta 'ultima-seguridad.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + $_.Exception.Message)
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
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysAgente' -ErrorAction SilentlyContinue
Write-Host 'Agente desinstalado.'
`;

export function generarInstalador(url: string, anon: string, token: string, intervalo: number) {
  // Reemplazos con función: así los "$" del código PowerShell no se interpretan como patrones de JS
  const agente = AGENTE.replace("__URL__", () => url.replace(/\/$/, ""))
    .replace("__ANON__", () => anon)
    .replace("__TOKEN__", () => token)
    .replace("__VERSION__", () => AGENTE_VERSION);
  return INSTALADOR.replace("__AGENTE__", () => agente).replace("__INTERVALO__", () => String(intervalo));
}

export function generarDesinstalador() {
  return DESINSTALADOR;
}

export function descargar(nombre: string, contenido: string) {
  // BOM + CRLF: formato que Windows PowerShell 5.1 lee sin problemas
  const blob = new Blob(["\uFEFF" + contenido.replace(/\r?\n/g, "\r\n")], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  a.click();
}
