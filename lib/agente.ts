// Plantillas del agente de Windows. Se completan con la URL de Supabase,
// la clave pública y el token al momento de descargar el instalador.
// Nota: el código PowerShell es solo ASCII (sin tildes) para que Windows
// PowerShell 5.1 lo lea bien en cualquier configuración regional.

export const AGENTE_VERSION = "1.0";

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
