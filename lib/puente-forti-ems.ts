// Generador del puente FortiClient EMS Cloud → Supabase
// EMS Cloud es accesible desde internet: corre en cualquier Windows con salida a internet.
// Recomendado: mismo servidor PRTG que ya corre el puente de FortiGate.
//
// Autenticación: Access Key de la API EMS Cloud + email de la cuenta master.
// Se hace login en /fct/api/public/v1/ems_api_cloud/login/ y se obtiene un session_id.
// Los endpoints de datos usan /fct/api/public/v1/ems_api/<path>.

import { envolverEnCmd } from "@/lib/agente";

export type ConfigPuenteEMS = {
  url: string;          // URL pública de Supabase
  anon: string;         // Anon key de Supabase
  token: string;        // Token en texto plano (el hash queda en Supabase)
  emsUrl: string;       // https://forticlient.forticloud.com
  emsEmail: string;     // Email de la cuenta master de FortiCloud
  emsAccessKey: string; // Access Key generado en EMS Cloud → Access Key → EMS API Access
  intervalo: number;    // Minutos entre ejecuciones
};

export function generarPuenteFortiEMS(cfg: ConfigPuenteEMS): string {
  const ps = `
#Requires -Version 5.1
<#
  Puente FortiClient EMS Cloud → Accusys Cyber
  Versión: 3.0
  Instalado: $(Get-Date -Format 'yyyy-MM-dd HH:mm')

  Consulta la API REST de FortiClient EMS Cloud y empuja los datos a Supabase.
  No escribe nada en el EMS; solo lectura.
  Las credenciales solo existen en este archivo, en la carpeta protegida del servicio.

  Prerrequisitos:
    - Access Key generado en el portal EMS Cloud (menú inferior derecho → Access Key → EMS API Access).
    - Email de la cuenta master de FortiCloud.
    - Acceso a internet desde este servidor (HTTPS saliente a forticloud.com y supabase.co).
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$VERSION        = '3.0'
$SUPABASE_URL   = '${cfg.url}'
$SUPABASE_ANON  = '${cfg.anon}'
$TOKEN          = '${cfg.token}'
$EMS_BASE       = '${cfg.emsUrl}'.TrimEnd('/')
$EMS_EMAIL      = '${cfg.emsEmail}'
$EMS_ACCESS_KEY = '${cfg.emsAccessKey}'
$INTERVALO_MIN  = ${cfg.intervalo}

# Base URL de la API pública del EMS Cloud
$EMS_API_BASE   = "$EMS_BASE/fct/api/public/v1/ems_api"
$EMS_LOGIN_URL  = "$EMS_BASE/fct/api/public/v1/ems_api_cloud/login/"
$EMS_LOGOUT_URL = "$EMS_BASE/fct/api/public/v1/ems_api_cloud/logout/"

# Forzar TLS 1.2+
[System.Net.ServicePointManager]::SecurityProtocol =
  [System.Net.SecurityProtocolType]::Tls13 -bor
  [System.Net.SecurityProtocolType]::Tls12

# ── Sesión EMS: login y renovación ───────────────────────────
$script:ems_session_id = $null
$script:ems_expira     = [datetime]::MinValue

function Get-EMSToken {
  $body = @{
    access_key    = $EMS_ACCESS_KEY
    account_email = $EMS_EMAIL
  } | ConvertTo-Json
  $hdrs = @{ 'Content-Type' = 'application/json' }
  try {
    $r = Invoke-RestMethod \`
      -Uri $EMS_LOGIN_URL \`
      -Method POST -Headers $hdrs -Body $body
    $script:ems_session_id = $r.session_id
    $script:ems_expira     = (Get-Date).AddMinutes(25)
    Write-Host "$(Get-Date) Sesión EMS Cloud iniciada (session_id obtenido)"
  } catch {
    throw "Login EMS Cloud fallido: $($_.Exception.Message)"
  }
}

function Assert-EMSToken {
  if (-not $script:ems_session_id -or [datetime]::Now -ge $script:ems_expira) {
    Get-EMSToken
  }
}

# ── Llamadas a EMS Cloud ──────────────────────────────────────
function Invoke-EMS {
  param([string]$Path, [string]$Method = 'GET', $Body)
  Assert-EMSToken
  $hdrs = @{
    'Authorization'              = $script:ems_session_id
    'Ems-Api-Header-Content-Type' = 'application/json'
    'Content-Type'               = 'application/json'
  }
  $uri = "$EMS_API_BASE$Path"
  try {
    if ($Body) {
      Invoke-RestMethod -Uri $uri -Method $Method -Headers $hdrs \`
        -Body ($Body | ConvertTo-Json -Depth 10)
    } else {
      Invoke-RestMethod -Uri $uri -Method $Method -Headers $hdrs
    }
  } catch {
    # Si 401/403, forzar re-login y reintentar
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401 -or $code -eq 403) {
      $script:ems_session_id = $null
      Assert-EMSToken
      $hdrs['Authorization'] = $script:ems_session_id
      if ($Body) {
        Invoke-RestMethod -Uri $uri -Method $Method -Headers $hdrs \`
          -Body ($Body | ConvertTo-Json -Depth 10)
      } else {
        Invoke-RestMethod -Uri $uri -Method $Method -Headers $hdrs
      }
    } else { throw }
  }
}

function Invoke-Supabase {
  param([string]$Fn, $Body)
  $hdrs = @{
    'apikey'        = $SUPABASE_ANON
    'Authorization' = "Bearer $SUPABASE_ANON"
    'Content-Type'  = 'application/json'
  }
  Invoke-RestMethod \`
    -Uri "$SUPABASE_URL/rest/v1/rpc/$Fn" \`
    -Method POST -Headers $hdrs \`
    -Body ($Body | ConvertTo-Json -Depth 20)
}

function Get-PaisCodigo {
  param([string]$Ip)
  if (-not $Ip -or $Ip -match '^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.)') {
    return @{ codigo = ''; pais = 'Red interna'; ciudad = ''; isp = '' }
  }
  try {
    $r = Invoke-RestMethod \`
      "https://ip-api.com/json/$($Ip)?fields=countryCode,country,city,isp" \`
      -TimeoutSec 5
    return @{ codigo = $r.countryCode; pais = $r.country; ciudad = $r.city; isp = $r.isp }
  } catch {
    return @{ codigo = ''; pais = ''; ciudad = ''; isp = '' }
  }
}

# ── Recolección de datos ──────────────────────────────────────
function Get-Endpoints {
  # EMS Cloud usa /api/v1/endpoints/index (no /host/list que es on-premise)
  $r    = Invoke-EMS '/api/v1/endpoints/index?count=5000'
  $list = @()
  $items = if ($r.data) { $r.data } elseif ($r.result) { $r.result } else { @() }
  foreach ($h in $items) {
    # EMS Cloud puede devolver los campos con distintos nombres según la versión
    $uid      = if ($h.id)        { [string]$h.id        } elseif ($h.device_id) { [string]$h.device_id } else { '' }
    $host     = if ($h.name)      { $h.name      } elseif ($h.hostname)  { $h.hostname  } else { '' }
    $user     = if ($h.last_user) { $h.last_user } elseif ($h.username)  { $h.username  } else { '' }
    $ip       = if ($h.ip)        { $h.ip        } elseif ($h.ip_addr)   { $h.ip_addr   } else { '' }
    $ver      = if ($h.version)   { $h.version   } elseif ($h.client_version) { $h.client_version } else { '' }
    $os       = if ($h.os_type)   { $h.os_type   } elseif ($h.os)        { $h.os        } else { '' }
    $osver    = if ($h.os_version){ $h.os_version } elseif ($h.os_ver)   { $h.os_ver    } else { '' }
    $online   = if ($h.status -eq 1 -or $h.online -eq $true -or $h.status -eq 'online') { 'online' } else { 'offline' }
    $score    = if ($null -ne $h.compliance_score) { [int]$h.compliance_score } elseif ($null -ne $h.posture_score) { [int]$h.posture_score } else { $null }
    $lastSeen = $null
    if ($h.last_seen) {
      try { $lastSeen = [datetime]::UnixEpoch.AddSeconds($h.last_seen).ToString('o') } catch {}
    } elseif ($h.last_seen_time) {
      try { $lastSeen = [datetime]::UnixEpoch.AddSeconds($h.last_seen_time).ToString('o') } catch {}
    }
    if (-not $uid) { continue }
    $list += @{
      uid             = $uid
      hostname        = $host
      usuario         = $user
      ip              = $ip
      version_cliente = $ver
      estado          = $online
      os              = $os
      so_version      = $osver
      dominio         = if ($h.domain)      { $h.domain      } else { '' }
      sitio           = if ($h.site_name)   { $h.site_name   } else { '' }
      grupo           = if ($h.group_name)  { $h.group_name  } else { '' }
      politica        = if ($h.profile_name){ $h.profile_name } elseif ($h.policy_name) { $h.policy_name } else { '' }
      score_postura   = $score
      ultimo_visto    = $lastSeen
    }
  }
  return $list
}

function Get-Cumplimiento {
  param($Endpoints)
  $list = @()
  foreach ($ep in $Endpoints) {
    try {
      $r = Invoke-EMS "/api/v1/endpoints/$($ep.uid)/compliance"
      foreach ($item in $r.data) {
        $list += @{
          endpoint_uid = $ep.uid
          regla        = $item.rule_name
          estado       = switch ($item.status) {
            'pass'    { 'pass' } 'fail' { 'fail' } 'warning' { 'warning' } default { 'fail' }
          }
          severidad    = switch ($item.severity) {
            'critical' { 'critical' } 'high' { 'high' } 'medium' { 'medium' }
            'low'      { 'low'      } default { 'info' }
          }
          detalle      = $item.message
        }
      }
    } catch { <# endpoint sin datos de cumplimiento #> }
  }
  return $list
}

function Get-VPN {
  param($Endpoints)
  $activas   = @()
  $historial = @()
  try {
    $r = Invoke-EMS '/api/v1/vpn/index?count=1000'
    foreach ($s in $r.data) {
      $geo = Get-PaisCodigo $s.public_ip
      $ep  = $Endpoints | Where-Object { $_.hostname -eq $s.hostname } | Select-Object -First 1
      $activas += @{
        endpoint_uid = if ($ep) { $ep.uid } else { $null }
        usuario      = $s.user_name
        ip_publica   = $s.public_ip
        ip_tunel     = $s.tunnel_ip
        desde        = if ($s.connect_time) {
                         [datetime]::UnixEpoch.AddSeconds($s.connect_time).ToString('o')
                       } else { $null }
        pais_codigo  = $geo.codigo
        pais         = $geo.pais
        ciudad       = $geo.ciudad
        isp          = $geo.isp
      }
    }
  } catch {}

  try {
    $desde = [int][double]::Parse(
      (Get-Date).AddDays(-7).ToUniversalTime().Subtract([datetime]::UnixEpoch).TotalSeconds
    )
    $rh = Invoke-EMS "/api/v1/events/vpn?from=$desde&count=2000"
    foreach ($ev in $rh.data) {
      $geo = Get-PaisCodigo $ev.public_ip
      $ep  = $Endpoints | Where-Object { $_.hostname -eq $ev.hostname } | Select-Object -First 1
      $historial += @{
        fecha        = if ($ev.timestamp) {
                         [datetime]::UnixEpoch.AddSeconds($ev.timestamp).ToString('o')
                       } else { $null }
        usuario      = $ev.user_name
        endpoint_uid = if ($ep) { $ep.uid } else { $null }
        hostname     = $ev.hostname
        ip_publica   = $ev.public_ip
        accion       = if ($ev.action -eq 'tunnel-up') { 'connect' } else { 'disconnect' }
        duracion_seg = $ev.duration
        pais_codigo  = $geo.codigo
        pais         = $geo.pais
      }
    }
  } catch {}

  return @{ activas = $activas; historial = $historial }
}

function Get-Vulnerabilidades {
  param($Endpoints)
  $list = @()
  try {
    $r = Invoke-EMS '/api/v1/vulnerability/index?count=5000'
    foreach ($v in $r.data) {
      $ep = $Endpoints | Where-Object { $_.hostname -eq $v.hostname } | Select-Object -First 1
      $list += @{
        endpoint_uid = if ($ep) { $ep.uid } else { $null }
        cve_id       = $v.cve_id
        severidad    = switch ($v.severity) {
          'Critical' { 'critical' } 'High' { 'high' } 'Medium' { 'medium' }
          'Low'      { 'low'      } default { 'medium' }
        }
        producto     = $v.application_name
        version      = $v.application_version
        descripcion  = $v.description
      }
    }
  } catch {}
  return $list
}

function Get-Accesos {
  $list = @()
  try {
    $desde = [int][double]::Parse(
      (Get-Date).AddDays(-7).ToUniversalTime().Subtract([datetime]::UnixEpoch).TotalSeconds
    )
    $r = Invoke-EMS "/api/v1/events/admin?from=$desde&count=2000"
    foreach ($ev in $r.data) {
      $list += @{
        fecha     = if ($ev.timestamp) {
                      [datetime]::UnixEpoch.AddSeconds($ev.timestamp).ToString('o')
                    } else { $null }
        usuario   = $ev.user_name
        ip        = $ev.client_ip
        accion    = switch ($ev.action) {
          'login'        { 'login'  }
          'logout'       { 'logout' }
          'login-failed' { 'failed' }
          default        { $ev.action }
        }
        resultado = if ($ev.status) { $ev.status } else { 'ok' }
        detalle   = $ev.description
      }
    }
  } catch {}
  return $list
}

function Get-Licencias {
  $list = @()
  try {
    $r = Invoke-EMS '/api/v1/license/index'
    foreach ($lic in $r.data) {
      $vence = $null
      if ($lic.expire_time) {
        $vence = [datetime]::UnixEpoch.AddSeconds($lic.expire_time).ToString('yyyy-MM-dd')
      }
      $estado = 'ok'
      if ($vence) {
        $dr = ([datetime]$vence - (Get-Date)).TotalDays
        if ($dr -lt 0)       { $estado = 'vencida'    }
        elseif ($dr -lt 30)  { $estado = 'por_vencer' }
      }
      $list += @{
        tipo        = $lic.product_name
        total       = $lic.total
        usadas      = $lic.used
        disponibles = $lic.total - $lic.used
        vence       = $vence
        estado      = $estado
      }
    }
  } catch {}
  return $list
}

function Get-Politicas {
  $list = @()
  try {
    $r = Invoke-EMS '/api/v1/ztna/policy/index?count=500'
    foreach ($p in $r.data) {
      $list += @{
        nombre              = $p.name
        tipo                = 'ZTNA'
        endpoints_asignados = if ($p.assigned) { [int]$p.assigned } else { 0 }
        endpoints_activos   = if ($p.active)   { [int]$p.active   } else { 0 }
      }
    }
  } catch {}
  try {
    $r2 = Invoke-EMS '/api/v1/endpointprofile/index?count=500'
    foreach ($p in $r2.data) {
      $list += @{
        nombre              = $p.name
        tipo                = 'Endpoint Profile'
        endpoints_asignados = if ($p.assigned) { [int]$p.assigned } else { 0 }
        endpoints_activos   = if ($p.active)   { [int]$p.active   } else { 0 }
      }
    }
  } catch {}
  return $list
}

# ── Loop principal ────────────────────────────────────────────
Write-Host "$(Get-Date) Puente FortiClient EMS Cloud iniciado (v$VERSION)"

while ($true) {
  try {
    Assert-EMSToken

    Write-Host "$(Get-Date) Recolectando endpoints..."
    $endpoints = Get-Endpoints

    Write-Host "$(Get-Date) Recolectando cumplimiento ($($endpoints.Count) endpoints)..."
    $cumplimiento = Get-Cumplimiento -Endpoints $endpoints

    Write-Host "$(Get-Date) Recolectando VPN..."
    $vpnData = Get-VPN -Endpoints $endpoints

    Write-Host "$(Get-Date) Recolectando vulnerabilidades..."
    $vulns = Get-Vulnerabilidades -Endpoints $endpoints

    Write-Host "$(Get-Date) Recolectando accesos a consola..."
    $accesos = Get-Accesos

    Write-Host "$(Get-Date) Recolectando licencias..."
    $licencias = Get-Licencias

    Write-Host "$(Get-Date) Recolectando políticas..."
    $politicas = Get-Politicas

    $datos = @{
      version          = $VERSION
      endpoints        = $endpoints
      cumplimiento     = $cumplimiento
      vpn              = $vpnData.activas
      vpn_historial    = $vpnData.historial
      vulnerabilidades = $vulns
      accesos          = $accesos
      licencias        = $licencias
      politicas        = $politicas
    }

    Write-Host "$(Get-Date) Enviando a Supabase..."
    $r = Invoke-Supabase -Fn 'ems_reportar' -Body @{
      p_token = $TOKEN
      p_datos = $datos
    }
    Write-Host "$(Get-Date) OK — $($endpoints.Count) endpoints, $($vulns.Count) vulns, $($vpnData.activas.Count) VPN activas"

  } catch {
    Write-Warning "$(Get-Date) Error: $($_.Exception.Message)"
  }

  Write-Host "$(Get-Date) Durmiendo $INTERVALO_MIN minutos..."
  Start-Sleep -Seconds ($INTERVALO_MIN * 60)
}
`;

  return envolverEnCmd("Puente FortiClient EMS Cloud Accusys Cyber", ps.trimStart());
}

export function generarDesinstaladorPuenteFortiEMS(): string {
  const ps = `
#Requires -Version 5.1
$name = 'PuenteFortiClientEMS'
Write-Host "Desinstalando tarea '$name'..."
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Host 'Tarea eliminada.'
} else {
  Write-Host 'No se encontró la tarea. Ya fue desinstalada o nunca se instaló.'
}
$dir = "$env:ProgramData\\AccusysCyber\\FortiClientEMS"
if (Test-Path $dir) {
  Remove-Item $dir -Recurse -Force
  Write-Host "Carpeta de datos eliminada: $dir"
}
Write-Host 'Desinstalación completada.'
`;
  return envolverEnCmd("Desinstalar Puente FortiClient EMS Cloud Accusys Cyber", ps.trimStart());
}
