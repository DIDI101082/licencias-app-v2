// Puente de switches -> Accusys Cyber. Se instala en un servidor de la red que llegue a los switches,
// los consulta por SNMP v2c (solo lectura) y envía el estado a la app. La lista de switches se toma de la app
// en cada ejecución; la community queda solo en este servidor.
// El cliente SNMP está escrito en C# y va dentro del script (no se descarga nada).
// Reglas: el PowerShell es solo ASCII, sin la secuencia signo pesos + llave, sin comillas invertidas
// y sin here-strings (va dentro del here-string del instalador).
import { envolverEnCmd } from "./agente";

export const PUENTE_SWITCHES_VERSION = "1.1";

// Cliente SNMP v2c mínimo (GET y GETBULK). Compatible con Windows PowerShell 5.1.
export const CLIENTE_SNMP = String.raw`using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;

public static class SnmpAccusys {
  public static int Timeout = 2500;
  public static int Reintentos = 2;
  static int idPedido = new Random().Next(1, 1000000);

  public class Vb { public string Oid; public int Tipo; public byte[] Valor; }

  static byte[] Largo(int n) {
    if (n < 128) return new byte[] { (byte)n };
    List<byte> b = new List<byte>();
    while (n > 0) { b.Insert(0, (byte)(n & 0xFF)); n >>= 8; }
    b.Insert(0, (byte)(0x80 | b.Count));
    return b.ToArray();
  }
  static byte[] Tlv(byte tag, byte[] v) {
    List<byte> r = new List<byte>();
    r.Add(tag); r.AddRange(Largo(v.Length)); r.AddRange(v);
    return r.ToArray();
  }
  static byte[] Entero(long v) {
    List<byte> b = new List<byte>();
    while (true) {
      b.Insert(0, (byte)(v & 0xFF));
      v >>= 8;
      if (v == 0 && (b[0] & 0x80) == 0) break;
      if (v == -1 && (b[0] & 0x80) != 0) break;
    }
    return Tlv(0x02, b.ToArray());
  }
  static byte[] OidBytes(string oid) {
    string[] p = oid.Trim('.').Split('.');
    List<byte> b = new List<byte>();
    b.Add((byte)(int.Parse(p[0]) * 40 + int.Parse(p[1])));
    for (int i = 2; i < p.Length; i++) {
      long n = long.Parse(p[i]);
      List<byte> t = new List<byte>();
      t.Insert(0, (byte)(n & 0x7F));
      n >>= 7;
      while (n > 0) { t.Insert(0, (byte)((n & 0x7F) + 0x80)); n >>= 7; }
      b.AddRange(t);
    }
    return Tlv(0x06, b.ToArray());
  }
  static string OidTexto(byte[] d, int o, int l) {
    if (l == 0) return "";
    StringBuilder sb = new StringBuilder();
    int f = d[o];
    if (f < 40) sb.Append("0.").Append(f);
    else if (f < 80) sb.Append("1.").Append(f - 40);
    else sb.Append("2.").Append(f - 80);
    long n = 0;
    for (int i = o + 1; i < o + l; i++) {
      n = n * 128 + (d[i] & 0x7F);
      if ((d[i] & 0x80) == 0) { sb.Append('.').Append(n); n = 0; }
    }
    return sb.ToString();
  }
  static byte[] Paquete(string com, byte tag, int id, int a, int b, string[] oids) {
    List<byte> vbs = new List<byte>();
    foreach (string o in oids) {
      List<byte> vb = new List<byte>();
      vb.AddRange(OidBytes(o)); vb.Add(0x05); vb.Add(0x00);
      vbs.AddRange(Tlv(0x30, vb.ToArray()));
    }
    List<byte> pdu = new List<byte>();
    pdu.AddRange(Entero(id)); pdu.AddRange(Entero(a)); pdu.AddRange(Entero(b)); pdu.AddRange(Tlv(0x30, vbs.ToArray()));
    List<byte> msg = new List<byte>();
    msg.AddRange(Entero(1)); msg.AddRange(Tlv(0x04, Encoding.ASCII.GetBytes(com))); msg.AddRange(Tlv(tag, pdu.ToArray()));
    return Tlv(0x30, msg.ToArray());
  }
  static void Cabecera(byte[] d, ref int p, out byte tag, out int len) {
    tag = d[p++];
    int l = d[p++];
    if ((l & 0x80) != 0) {
      int n = l & 0x7F; l = 0;
      for (int i = 0; i < n; i++) l = l * 256 + d[p++];
    }
    len = l;
  }
  static long LeerEntero(byte[] d, int o, int l) {
    long v = (l > 0 && (d[o] & 0x80) != 0) ? -1 : 0;
    for (int i = 0; i < l; i++) v = v * 256 + d[o + i];
    return v;
  }
  static List<Vb> Decodificar(byte[] d, int id) {
    int p = 0; byte tag; int len;
    Cabecera(d, ref p, out tag, out len);           // mensaje
    Cabecera(d, ref p, out tag, out len); p += len;   // version
    Cabecera(d, ref p, out tag, out len); p += len;   // community
    Cabecera(d, ref p, out tag, out len);           // PDU
    if (tag != 0xA2) return null;
    Cabecera(d, ref p, out tag, out len);
    long rid = LeerEntero(d, p, len); p += len;
    if (rid != id) return null;
    Cabecera(d, ref p, out tag, out len);
    long err = LeerEntero(d, p, len); p += len;
    Cabecera(d, ref p, out tag, out len); p += len;
    if (err != 0) throw new Exception("El equipo respondio con error SNMP " + err);
    Cabecera(d, ref p, out tag, out len);           // lista de variables
    int fin = p + len;
    List<Vb> r = new List<Vb>();
    while (p < fin) {
      Cabecera(d, ref p, out tag, out len);
      Cabecera(d, ref p, out tag, out len);
      string oid = OidTexto(d, p, len); p += len;
      Cabecera(d, ref p, out tag, out len);
      byte[] v = new byte[len];
      Array.Copy(d, p, v, 0, len); p += len;
      Vb x = new Vb(); x.Oid = oid; x.Tipo = tag; x.Valor = v;
      r.Add(x);
    }
    return r;
  }
  static IPAddress Resolver(string host) {
    IPAddress ip;
    if (IPAddress.TryParse(host, out ip)) return ip;
    foreach (IPAddress a in Dns.GetHostAddresses(host)) if (a.AddressFamily == AddressFamily.InterNetwork) return a;
    throw new Exception("No se pudo resolver " + host);
  }
  static List<Vb> Pedir(string host, int puerto, string com, byte tag, int a, int b, string[] oids) {
    int id = ++idPedido;
    byte[] pkt = Paquete(com, tag, id, a, b, oids);
    IPEndPoint ep = new IPEndPoint(Resolver(host), puerto);
    using (UdpClient u = new UdpClient(ep.AddressFamily)) {
      u.Client.ReceiveTimeout = Timeout;
      for (int intento = 0; intento <= Reintentos; intento++) {
        u.Send(pkt, pkt.Length, ep);
        try {
          while (true) {
            IPEndPoint de = new IPEndPoint(IPAddress.Any, 0);
            byte[] r = u.Receive(ref de);
            List<Vb> res = Decodificar(r, id);
            if (res != null) return res;
          }
        } catch (SocketException) { }
      }
    }
    throw new Exception("Sin respuesta SNMP (revisar IP, community y que el switch permita consultas desde este servidor)");
  }

  public static List<Vb> Get(string host, int puerto, string com, string[] oids) {
    return Pedir(host, puerto, com, 0xA0, 0, 0, oids);
  }
  public static List<Vb> Walk(string host, int puerto, string com, string raiz, int limite) {
    List<Vb> r = new List<Vb>();
    string sig = raiz;
    string pref = raiz + ".";
    while (r.Count < limite) {
      List<Vb> res = Pedir(host, puerto, com, 0xA5, 0, 25, new string[] { sig });
      if (res.Count == 0) break;
      bool seguir = true;
      foreach (Vb v in res) {
        if (v.Tipo == 0x82 || !v.Oid.StartsWith(pref)) { seguir = false; break; }
        if (v.Tipo == 0x80 || v.Tipo == 0x81) continue;
        r.Add(v);
      }
      if (!seguir) break;
      string ult = res[res.Count - 1].Oid;
      if (ult == sig) break;
      sig = ult;
    }
    return r;
  }
  // Valores
  public static string Texto(Vb v) {
    switch (v.Tipo) {
      case 0x02: return LeerEntero(v.Valor, 0, v.Valor.Length).ToString();
      case 0x41: case 0x42: case 0x43: case 0x46: return Sin(v.Valor).ToString();
      case 0x40: return v.Valor.Length == 4 ? (v.Valor[0] + "." + v.Valor[1] + "." + v.Valor[2] + "." + v.Valor[3]) : Hex(v);
      case 0x06: return OidTexto(v.Valor, 0, v.Valor.Length);
      case 0x04:
        foreach (byte c in v.Valor) if ((c < 32 && c != 9 && c != 10 && c != 13) || c > 126) { if (c != 0) return Hex(v); }
        return Encoding.ASCII.GetString(v.Valor).TrimEnd('\0').Trim();
      default: return "";
    }
  }
  public static string Hex(Vb v) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < v.Valor.Length; i++) { if (i > 0) sb.Append(':'); sb.Append(v.Valor[i].ToString("x2")); }
    return sb.ToString();
  }
  static ulong Sin(byte[] b) { ulong v = 0; foreach (byte c in b) v = v * 256 + c; return v; }
  public static string Sufijo(Vb v, string raiz) { return v.Oid.Length > raiz.Length + 1 ? v.Oid.Substring(raiz.Length + 1) : ""; }
}
`;

const COLECTOR = String.raw`# Colector SNMP (parte del puente de switches). Requiere que la clase SnmpAccusys ya este cargada.
# Devuelve un objeto con los datos de un switch, o con ok = false y el error.
function Consultar-Switch($obj, $Community) {
  $hostSw = [string]$obj.ip
  $puertoSnmp = 161
  if ($hostSw -match '^(.+):(\d+)$') { $hostSw = $Matches[1]; $puertoSnmp = [int]$Matches[2] }
  $r = [ordered]@{ id = $obj.id; ok = $false }
  try {
    $sys = [SnmpAccusys]::Get($hostSw, $puertoSnmp, $Community, [string[]]@('1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.1.5.0'))
    $descr = ''; $uptime = $null; $nombre = ''
    foreach ($v in $sys) {
      if ($v.Oid -eq '1.3.6.1.2.1.1.1.0') { $descr = [SnmpAccusys]::Texto($v) }
      elseif ($v.Oid -eq '1.3.6.1.2.1.1.3.0') { $uptime = [SnmpAccusys]::Texto($v) }
      elseif ($v.Oid -eq '1.3.6.1.2.1.1.5.0') { $nombre = [SnmpAccusys]::Texto($v) }
    }
    $r.sys_descr = $descr; $r.sys_nombre = $nombre; $r.uptime = $uptime

    # Columnas de interfaces: ifIndex -> valor
    function Col($raiz, $hex) {
      $m = @{}
      try {
        foreach ($v in [SnmpAccusys]::Walk($hostSw, $puertoSnmp, $Community, $raiz, 5000)) {
          $k = [SnmpAccusys]::Sufijo($v, $raiz)
          if ($hex) { $m[$k] = [SnmpAccusys]::Hex($v) } else { $m[$k] = [SnmpAccusys]::Texto($v) }
        }
      } catch {}
      return $m
    }
    $tipo   = Col '1.3.6.1.2.1.2.2.1.3' $false
    $ifd    = Col '1.3.6.1.2.1.2.2.1.2' $false
    $admin  = Col '1.3.6.1.2.1.2.2.1.7' $false
    $oper   = Col '1.3.6.1.2.1.2.2.1.8' $false
    $cambio = Col '1.3.6.1.2.1.2.2.1.9' $false
    $descin = Col '1.3.6.1.2.1.2.2.1.13' $false
    $errin  = Col '1.3.6.1.2.1.2.2.1.14' $false
    $errout = Col '1.3.6.1.2.1.2.2.1.20' $false
    $ifn    = Col '1.3.6.1.2.1.31.1.1.1.1' $false
    $alias  = Col '1.3.6.1.2.1.31.1.1.1.18' $false
    $vel    = Col '1.3.6.1.2.1.31.1.1.1.15' $false
    $inO    = Col '1.3.6.1.2.1.31.1.1.1.6' $false
    $outO   = Col '1.3.6.1.2.1.31.1.1.1.10' $false
    $bits   = 64
    if ($inO.Count -eq 0) { $inO = Col '1.3.6.1.2.1.2.2.1.10' $false; $outO = Col '1.3.6.1.2.1.2.2.1.16' $false; $bits = 32 }
    $vel32 = @{}
    if ($vel.Count -eq 0) { $vel32 = Col '1.3.6.1.2.1.2.2.1.5' $false }

    # Solo puertos fisicos y agregados (ethernet, fibra, LAG); se descartan VLAN, loopback, bridge, etc.
    $tiposFisicos = @('6', '62', '69', '117', '161')
    $puertos = New-Object System.Collections.ArrayList
    foreach ($k in $tipo.Keys) {
      if ($tiposFisicos -notcontains $tipo[$k]) { continue }
      $velocidad = $null
      if ($vel.ContainsKey($k) -and [double]$vel[$k] -gt 0) { $velocidad = [double]$vel[$k] }
      elseif ($vel32.ContainsKey($k) -and [double]$vel32[$k] -gt 0) { $velocidad = [math]::Round([double]$vel32[$k] / 1000000) }
      $nom = $ifn[$k]; if (-not $nom) { $nom = $ifd[$k] }
      [void]$puertos.Add([ordered]@{
        ifindex = [int]$k; nombre = $nom; descr = $ifd[$k]; alias = $alias[$k]; tipo = [int]$tipo[$k]
        admin = $admin[$k]; oper = $oper[$k]; velocidad = $velocidad; in = $inO[$k]; out = $outO[$k]; bits = $bits
        err_in = $errin[$k]; err_out = $errout[$k]; desc_in = $descin[$k]; cambio = $cambio[$k]
      })
    }
    $r.puertos = $puertos

    # Tabla de direcciones MAC: puerto de bridge -> ifIndex
    $macs = New-Object System.Collections.ArrayList
    function Fdb($com, $vlanFija) {
      $bp = @{}
      try { foreach ($v in [SnmpAccusys]::Walk($hostSw, $puertoSnmp, $com, '1.3.6.1.2.1.17.1.4.1.2', 2000)) { $bp[[SnmpAccusys]::Sufijo($v, '1.3.6.1.2.1.17.1.4.1.2')] = [SnmpAccusys]::Texto($v) } } catch {}
      $lista = New-Object System.Collections.ArrayList
      $q = @()
      if (-not $vlanFija) { try { $q = @([SnmpAccusys]::Walk($hostSw, $puertoSnmp, $com, '1.3.6.1.2.1.17.7.1.2.2.1.2', 8000)) } catch {} }
      foreach ($v in $q) {
        $s = ([SnmpAccusys]::Sufijo($v, '1.3.6.1.2.1.17.7.1.2.2.1.2')).Split('.')
        if ($s.Count -ne 7) { continue }
        $mac = (($s[1..6] | ForEach-Object { ([int]$_).ToString('x2') }) -join ':')
        $puente = [SnmpAccusys]::Texto($v)
        $ifx = $bp[$puente]; if (-not $ifx) { $ifx = $puente }
        if ($puente -ne '0') { [void]$lista.Add([ordered]@{ mac = $mac; ifindex = [int]$ifx; vlan = [int]$s[0] }) }
      }
      if ($lista.Count -eq 0) {
        $d = @()
        try { $d = @([SnmpAccusys]::Walk($hostSw, $puertoSnmp, $com, '1.3.6.1.2.1.17.4.3.1.2', 8000)) } catch {}
        foreach ($v in $d) {
          $s = ([SnmpAccusys]::Sufijo($v, '1.3.6.1.2.1.17.4.3.1.2')).Split('.')
          if ($s.Count -ne 6) { continue }
          $mac = (($s | ForEach-Object { ([int]$_).ToString('x2') }) -join ':')
          $puente = [SnmpAccusys]::Texto($v)
          $ifx = $bp[$puente]
          if ($ifx -and $puente -ne '0') { [void]$lista.Add([ordered]@{ mac = $mac; ifindex = [int]$ifx; vlan = $vlanFija }) }
        }
      }
      return ,$lista
    }
    $base = Fdb $Community $null
    foreach ($m in $base) { [void]$macs.Add($m) }
    # Cisco: la tabla MAC se consulta por VLAN (community@vlan)
    if ($macs.Count -eq 0 -and $descr -match 'Cisco') {
      $vlans = @()
      try { $vlans = @([SnmpAccusys]::Walk($hostSw, $puertoSnmp, $Community, '1.3.6.1.4.1.9.9.46.1.3.1.1.2', 1000) | ForEach-Object { [int](([SnmpAccusys]::Sufijo($_, '1.3.6.1.4.1.9.9.46.1.3.1.1.2')).Split('.')[-1]) }) } catch {}
      foreach ($vl in ($vlans | Where-Object { $_ -lt 1002 -or $_ -gt 1005 } | Select-Object -First 64)) {
        foreach ($m in (Fdb ($Community + '@' + $vl) $vl)) { [void]$macs.Add($m) }
      }
    }
    $r.macs = @($macs | Select-Object -First 5000)

    # Vecinos: LLDP (todas las marcas) y CDP (Cisco)
    $vecinos = New-Object System.Collections.ArrayList
    $locId = Col '1.0.8802.1.1.2.1.3.7.1.3' $false
    $locDesc = Col '1.0.8802.1.1.2.1.3.7.1.4' $false
    $remNom = Col '1.0.8802.1.1.2.1.4.1.1.9' $false
    $remPto = Col '1.0.8802.1.1.2.1.4.1.1.7' $false
    $remPdesc = Col '1.0.8802.1.1.2.1.4.1.1.8' $false
    foreach ($k in $remNom.Keys) {
      $s = $k.Split('.')
      if ($s.Count -lt 3) { continue }
      $lp = $s[1]
      $ifx = $null
      foreach ($pp in $puertos) {
        if (($locDesc[$lp] -and ($pp.nombre -eq $locDesc[$lp] -or $pp.descr -eq $locDesc[$lp])) -or ($locId[$lp] -and ($pp.nombre -eq $locId[$lp] -or $pp.descr -eq $locId[$lp]))) { $ifx = $pp.ifindex; break }
      }
      if (-not $ifx -and $tipo.ContainsKey($lp)) { $ifx = [int]$lp }
      $pto = $remPdesc[$k]; if (-not $pto) { $pto = $remPto[$k] }
      if ($ifx) { [void]$vecinos.Add([ordered]@{ ifindex = $ifx; nombre = $remNom[$k]; puerto = $pto; protocolo = 'LLDP' }) }
    }
    if ($descr -match 'Cisco') {
      $cdpNom = Col '1.3.6.1.4.1.9.9.23.1.2.1.1.6' $false
      $cdpPto = Col '1.3.6.1.4.1.9.9.23.1.2.1.1.7' $false
      foreach ($k in $cdpNom.Keys) {
        $ifx = [int]($k.Split('.')[0])
        if (-not ($vecinos | Where-Object { $_.ifindex -eq $ifx })) { [void]$vecinos.Add([ordered]@{ ifindex = $ifx; nombre = $cdpNom[$k]; puerto = $cdpPto[$k]; protocolo = 'CDP' }) }
      }
    }
    $r.vecinos = $vecinos

    # PoE (si el equipo lo informa)
    $poeT = Col '1.3.6.1.2.1.105.1.3.1.1.2' $false
    $poeU = Col '1.3.6.1.2.1.105.1.3.1.1.4' $false
    if ($poeT.Count) {
      $r.poe_total = ($poeT.Values | ForEach-Object { [double]$_ } | Measure-Object -Sum).Sum
      $r.poe_uso = ($poeU.Values | ForEach-Object { [double]$_ } | Measure-Object -Sum).Sum
    }
    $r.ok = $true
  } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    $r.error = $e.Message
  }
  return $r
}
`;

const PUENTE = String.raw`# Puente de switches -> Accusys Cyber: consulta los switches por SNMP y envia el estado a la app
$ErrorActionPreference = 'Stop'
$SupabaseUrl = '__URL__'
$AnonKey     = '__ANON__'
$Token       = '__TOKEN__'
$Community   = '__COMMUNITY__'
$Version     = '__VERSION__'
$Carpeta     = 'C:\ProgramData\AccusysPuenteSwitches'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not ('SnmpAccusys' -as [type])) {
  try { Add-Type -TypeDefinition ([Text.Encoding]::ASCII.GetString([Convert]::FromBase64String('__CLIENTE__'))) -IgnoreWarnings }
  catch { Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' [cliente SNMP] ' + $_.Exception.Message); exit 1 }
}

__COLECTOR__

$headers = @{ apikey = $AnonKey; Authorization = ('Bearer ' + $AnonKey) }
try {
  $objetivos = Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/sw_objetivos') -Headers $headers -Body ('{"p_token":' + (ConvertTo-Json $Token) + '}') -ContentType 'application/json; charset=utf-8' -TimeoutSec 60
  $resultados = New-Object System.Collections.ArrayList
  foreach ($o in @($objetivos)) { if ($o) { [void]$resultados.Add((Consultar-Switch $o $Community)) } }
  $datos = [ordered]@{ version = $Version; switches = $resultados }
  $cuerpo = '{"p_token":' + (ConvertTo-Json $Token) + ',"p_datos":' + (ConvertTo-Json -InputObject $datos -Depth 6 -Compress) + '}'
  Invoke-RestMethod -Method Post -Uri ($SupabaseUrl + '/rest/v1/rpc/sw_reportar') -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 120 | Out-Null
  $ok = @($resultados | Where-Object { $_.ok }).Count
  $linea = 'OK ' + (Get-Date).ToString('s') + ' ' + $ok + ' de ' + $resultados.Count + ' switches respondieron'
  $fallas = @($resultados | Where-Object { -not $_.ok } | ForEach-Object { [string]$_.id + ': ' + $_.error })
  if ($fallas.Count) { $linea = $linea + ' | sin respuesta: ' + ($fallas -join '; ') }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value $linea
}
catch {
  $d = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $d = $d + ' | ' + $_.ErrorDetails.Message }
  Set-Content -Path (Join-Path $Carpeta 'ultimo-envio.txt') -Value ('ERROR ' + (Get-Date).ToString('s') + ' ' + ($d -replace '\s+', ' '))
  exit 1
}
`;

const INSTALADOR = String.raw`# Instalador del puente de switches -> Accusys Cyber (ejecutar como administrador en un servidor de la red)
$ErrorActionPreference = 'Stop'
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Ejecuta este instalador como administrador.' -ForegroundColor Red; exit 1 }

$Carpeta = 'C:\ProgramData\AccusysPuenteSwitches'
$Script  = Join-Path $Carpeta 'puente.ps1'
$Tarea   = 'AccusysPuenteSwitches'

New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
# Carpeta solo para SYSTEM y Administradores: la community y el token no los puede leer un usuario comun
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

Write-Host 'Consultando los switches y enviando el primer estado (puede tardar hasta un minuto)...'
$espera = 0
while ($espera -lt 90) {
  Start-Sleep -Seconds 5; $espera += 5
  if ((Get-ScheduledTask -TaskName $Tarea).State -ne 'Running') { break }
}
Write-Host ''
Write-Host 'Puente instalado. Resultado del primer envio:' -ForegroundColor Green
Get-Content (Join-Path $Carpeta 'ultimo-envio.txt') -ErrorAction SilentlyContinue
`;

const DESINSTALADOR = String.raw`# Desinstala el puente de switches -> Accusys Cyber
Unregister-ScheduledTask -TaskName 'AccusysPuenteSwitches' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'C:\ProgramData\AccusysPuenteSwitches' -ErrorAction SilentlyContinue
Write-Host 'Puente de switches desinstalado.'
`;

// Los valores van entre comillas simples en PowerShell: se duplican las comillas simples
const ps = (v: string) => v.replace(/'/g, "''");
// El cliente SNMP viaja en base64 (así no choca con las comillas del script)
const base64 = (t: string) => (typeof btoa === "function" ? btoa(t) : Buffer.from(t, "latin1").toString("base64"));

export function generarPuenteSwitches(o: { url: string; anon: string; token: string; community: string; intervalo: number }) {
  const puente = PUENTE.replace("__URL__", () => ps(o.url.replace(/\/$/, "")))
    .replace("__ANON__", () => ps(o.anon))
    .replace("__TOKEN__", () => ps(o.token))
    .replace("__COMMUNITY__", () => ps(o.community))
    .replace("__VERSION__", () => PUENTE_SWITCHES_VERSION)
    .replace("__CLIENTE__", () => base64(CLIENTE_SNMP))
    .replace("__COLECTOR__", () => COLECTOR);
  const instalador = INSTALADOR.replace("__PUENTE__", () => puente).replace("__INTERVALO__", () => String(o.intervalo));
  return envolverEnCmd("Instalador del puente de switches de Accusys Cyber", instalador);
}

export function generarDesinstaladorPuenteSwitches() {
  return envolverEnCmd("Desinstalador del puente de switches de Accusys Cyber", DESINSTALADOR);
}

