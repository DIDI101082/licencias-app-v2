// Agente e instalador para Linux (bash). Mismas funciones del servidor que el agente de Windows.
// Reglas para este archivo: el script bash NO puede contener la secuencia signo pesos + llave
// ni comillas invertidas, porque esta plantilla es un template literal de TypeScript.

export const AGENTE_LINUX_VERSION = "1.0-linux";

const AGENTE = String.raw`#!/bin/bash
# Agente de Accusys Cyber para Linux - reporta el estado del equipo cada pocos minutos
SUPABASE_URL='__URL__'
ANON_KEY='__ANON__'
TOKEN='__TOKEN__'
VERSION='__VERSION__'
DIR='/opt/accusys-agente'
CLAVE_ARCH="$DIR/equipo.key"
export LC_ALL=C
umask 077

# ---------- utilidades JSON (sin depender de jq) ----------
je() { printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\010\013-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | tr '\n' ' ')"; }
js() { if [ -n "$1" ]; then je "$1"; else printf 'null'; fi; }
jn() { case "$1" in ''|*[!0-9.]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }
jb() { case "$1" in true) printf 'true' ;; false) printf 'false' ;; *) printf 'null' ;; esac; }
leer() { head -n1 "$1" 2>/dev/null | tr -d '\n'; }
tiene() { command -v "$1" >/dev/null 2>&1; }
iso_desde_epoch() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null; }

post() {
  curl -sS -m 60 -X POST "$SUPABASE_URL/rest/v1/rpc/$1" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
    -H 'Content-Type: application/json' --data-binary @- -w '\n%{http_code}'
}
# Devuelve 0 si la respuesta (ultima linea = codigo HTTP) es 2xx; deja el cuerpo en RESP
enviar() {
  local salida codigo
  salida=$(printf '%s' "$2" | post "$1") || { RESP="sin conexion con el servidor"; return 1; }
  codigo=$(printf '%s' "$salida" | tail -n1)
  RESP=$(printf '%s' "$salida" | sed '$d')
  case "$codigo" in 2*) return 0 ;; *) return 1 ;; esac
}
msg_error() { printf '%s' "$1" | sed -n 's/.*"message"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'; }

SECRETO=''
[ -f "$CLAVE_ARCH" ] && SECRETO=$(tr -d '\n\r ' < "$CLAVE_ARCH")

# ---------- datos del equipo ----------
HOST=$(hostname 2>/dev/null)
UUID=$(leer /sys/class/dmi/id/product_uuid)
[ -z "$UUID" ] && UUID=$(leer /etc/machine-id)
SERIE=$(leer /sys/class/dmi/id/product_serial)
FAB=$(leer /sys/class/dmi/id/sys_vendor)
MODELO=$(leer /sys/class/dmi/id/product_name)
SO=$( . /etc/os-release 2>/dev/null; printf '%s' "$PRETTY_NAME")
SO_VERSION=$( . /etc/os-release 2>/dev/null; printf '%s' "$VERSION_ID")
KERNEL=$(uname -r)
ARQ=$(uname -m)
CPU=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')
[ -z "$CPU" ] && CPU=$(grep -m1 -i 'hardware\|processor' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')
NUCLEOS=$(nproc 2>/dev/null)
RAM_T=$(awk '/^MemTotal/ {printf "%.1f", $2/1048576}' /proc/meminfo)
RAM_L=$(awk '/^MemAvailable/ {printf "%.1f", $2/1048576}' /proc/meminfo)

# Solo discos locales (-l: sin carpetas de red NFS/Samba), una vez por disco aunque este montado en varios lugares
DISCOS=$(df -lP -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | awk 'NR>1 && $2>1073741824 && !vistos[$1]++ {
  gsub(/"/, "", $6); printf "%s{\"unidad\":\"%s\",\"total_gb\":%.1f,\"libre_gb\":%.1f}", (n++ ? "," : ""), $6, $2/1073741824, $4/1073741824 }')
ALMAC=$(df -lP -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | awk 'NR>1 && $2>1073741824 && !vistos[$1]++ {t+=$2} END {printf "%d GB", t/1073741824}')

DEV=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
IP=''
MAC=''
if [ -n "$DEV" ]; then
  IP=$(ip -4 -o addr show dev "$DEV" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)
  MAC=$(leer "/sys/class/net/$DEV/address")
fi
# Sin el comando ip (instalaciones minimas): primera IP que informa hostname
[ -z "$IP" ] && IP=$(hostname -I 2>/dev/null | awk '{print $1}')
USUARIO=$(who 2>/dev/null | awk '{print $1}' | sort -u | head -n1)
DOMINIO=$(hostname -d 2>/dev/null)
ARRANQUE=$(iso_desde_epoch $(( $(date +%s) - $(cut -d. -f1 /proc/uptime) )))
BATERIA=''
for b in /sys/class/power_supply/BAT*; do [ -f "$b/capacity" ] && BATERIA=$(leer "$b/capacity") && break; done

# Antivirus: ESET para Linux (endpoint o servidor) y ClamAV
AV=''
AV_ACTIVO=false
av_agregar() { AV="$AV$( [ -n "$AV" ] && printf ',')$(printf '{"nombre":%s,"activo":%s,"actualizado":%s}' "$(je "$1")" "$2" "$3")"; }
if tiene systemctl; then
  for s in eea efs esets; do
    if systemctl list-unit-files "$s.service" >/dev/null 2>&1 && systemctl list-unit-files "$s.service" | grep -q "^$s"; then
      if systemctl is-active --quiet "$s"; then av_agregar "ESET para Linux" true true; AV_ACTIVO=true; else av_agregar "ESET para Linux" false true; fi
    fi
  done
  for s in clamav-daemon clamd@scan clamd; do
    if systemctl is-active --quiet "$s" 2>/dev/null; then av_agregar "ClamAV" true true; AV_ACTIVO=true; break; fi
  done
fi

DATOS=$(printf '{"uuid":%s,"hostname":%s,"numero_serie":%s,"fabricante":%s,"modelo":%s,"so_nombre":%s,"so_version":%s,"so_build":%s,"so_arquitectura":%s,"procesador":%s,"nucleos":%s,"ram_total_gb":%s,"ram_libre_gb":%s,"discos":[%s],"almacenamiento":%s,"ip":%s,"mac":%s,"usuario":%s,"dominio":%s,"arranque":%s,"bateria_pct":%s,"antivirus_activo":%s,"agente_version":%s}' \
  "$(js "$UUID")" "$(js "$HOST")" "$(js "$SERIE")" "$(js "$FAB")" "$(js "$MODELO")" "$(js "$SO")" "$(js "$SO_VERSION")" "$(js "$KERNEL")" "$(js "$ARQ")" \
  "$(js "$CPU")" "$(jn "$NUCLEOS")" "$(jn "$RAM_T")" "$(jn "$RAM_L")" "$DISCOS" "$(js "$ALMAC")" "$(js "$IP")" "$(js "$MAC")" "$(js "$USUARIO")" \
  "$(js "$DOMINIO")" "$(js "$ARRANQUE")" "$(jn "$BATERIA")" "$(jb "$AV_ACTIVO")" "$(je "$VERSION")")

CUERPO=$(printf '{"p_token":%s,"p_datos":%s,"p_secreto":%s}' "$(je "$TOKEN")" "$DATOS" "$(js "$SECRETO")")
if ! enviar inv_reportar_dispositivo "$CUERPO"; then
  echo "ERROR $(date -Iseconds) $(msg_error "$RESP") $RESP" | cut -c1-400 > "$DIR/ultimo-reporte.txt"
  exit 1
fi
NUEVO=$(printf '%s' "$RESP" | sed -n 's/.*"secreto"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p')
if [ -n "$NUEVO" ]; then printf '%s' "$NUEVO" > "$CLAVE_ARCH"; chmod 600 "$CLAVE_ARCH"; SECRETO="$NUEVO"; fi
ESTADO=$(printf '%s' "$RESP" | sed -n 's/.*"estado"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p')
NOTA=''
[ "$ESTADO" = "pendiente" ] && NOTA=' (pendiente de aprobacion en la app)'
echo "OK $(date -Iseconds)$NOTA" > "$DIR/ultimo-reporte.txt"
[ "$ESTADO" = "aprobado" ] || exit 0

# ---------- ubicacion: todas las IP y el WiFi ----------
if tiene ip; then
  REDES=$(ip -4 -o addr show 2>/dev/null | awk -v gw="$DEV" '$2!="lo" {split($4,a,"/"); if (a[1] !~ /^169\.254\./) printf "%s{\"ip\":\"%s\",\"adaptador\":\"%s\",\"gateway\":%s}", (n++ ? "," : ""), a[1], $2, ($2==gw ? "true" : "false") }')
else
  REDES=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^169\.254\.' | awk '{printf "%s{\"ip\":\"%s\",\"adaptador\":\"\",\"gateway\":%s}", (n++ ? "," : ""), $1, (n==1 ? "true" : "false") }')
fi
SSID=''
if tiene nmcli; then SSID=$(nmcli -t -f active,ssid dev wifi 2>/dev/null | grep '^yes:' | head -n1 | cut -d: -f2-); fi
[ -z "$SSID" ] && tiene iwgetid && SSID=$(iwgetid -r 2>/dev/null)
CUERPO=$(printf '{"p_token":%s,"p_uuid":%s,"p_hostname":%s,"p_secreto":%s,"p_redes":[%s],"p_ssid":%s}' \
  "$(je "$TOKEN")" "$(js "$UUID")" "$(js "$HOST")" "$(je "$SECRETO")" "$REDES" "$(js "$SSID")")
enviar inv_reportar_ubicacion "$CUERPO" || echo "ERROR $(date -Iseconds) $(msg_error "$RESP")" > "$DIR/ultima-ubicacion.txt"

# ---------- aplicaciones (paquetes instalados a mano; se envian si cambiaron o cada 24 h) ----------
FILTRO='^(lib|perl-|python3?-|fonts?-|gir1\.2|linux-(headers|modules|image)|kernel-)|-(dev|devel|libs?|common|data|doc)$'
PAQ=''
if tiene dpkg-query; then
  FMT='$''{Package}\t$''{Version}\t$''{Maintainer}\n'
  if tiene apt-mark; then
    apt-mark showmanual 2>/dev/null | sort > "$DIR/.manual"
    PAQ=$(dpkg-query -W -f="$FMT" 2>/dev/null | sort | awk -F'\t' 'NR==FNR {m[$1]=1; next} ($1 in m)' "$DIR/.manual" -)
    rm -f "$DIR/.manual"
  else
    PAQ=$(dpkg-query -W -f="$FMT" 2>/dev/null)
  fi
elif tiene rpm; then
  PAQ=$(rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n' 2>/dev/null)
fi
APPS=$(printf '%s\n' "$PAQ" | grep -Ev "$FILTRO" | sort -u | awk -F'\t' 'NF>=2 && $1!="" {
  n1=$1; v=$2; e=$3; sub(/ *<.*/, "", e); if (e=="(none)") e="";
  gsub(/\\/,"\\\\",n1); gsub(/"/,"\\\"",n1); gsub(/\\/,"\\\\",v); gsub(/"/,"\\\"",v); gsub(/\\/,"\\\\",e); gsub(/"/,"\\\"",e);
  printf "%s{\"nombre\":\"%s\",\"version\":\"%s\",\"editor\":\"%s\",\"fecha_instalacion\":\"\"}", (c++ ? "," : ""), n1, v, e }')
HASH_APPS=$(printf '%s' "$APPS" | sha256sum | cut -d' ' -f1)
if [ "$HASH_APPS" != "$(cat "$DIR/apps.hash" 2>/dev/null)" ] || [ -z "$(find "$DIR/apps.hash" -mmin -1440 2>/dev/null)" ]; then
  CUERPO=$(printf '{"p_token":%s,"p_uuid":%s,"p_hostname":%s,"p_secreto":%s,"p_apps":[%s]}' "$(je "$TOKEN")" "$(js "$UUID")" "$(js "$HOST")" "$(je "$SECRETO")" "$APPS")
  if enviar inv_reportar_aplicaciones "$CUERPO"; then
    printf '%s' "$HASH_APPS" > "$DIR/apps.hash"
    echo "OK $(date -Iseconds)" > "$DIR/ultimas-apps.txt"
  else
    echo "ERROR $(date -Iseconds) $(msg_error "$RESP")" > "$DIR/ultimas-apps.txt"
  fi
fi

# ---------- seguridad (se envia si cambio o cada 6 h) ----------
# Cifrado: el disco del sistema esta sobre LUKS?
RAIZ=$(findmnt -no SOURCE / 2>/dev/null)
CIFRADO='sin_cifrar'
if [ -n "$RAIZ" ] && lsblk -s -rno TYPE "$RAIZ" 2>/dev/null | grep -q '^crypt$'; then CIFRADO='cifrado'; fi
# Ultima instalacion o actualizacion de paquetes
ULT=''
TITULO=''
if [ -d /var/lib/dpkg/info ]; then
  ULT=$(iso_desde_epoch "$(stat -c %Y $(ls -t /var/lib/dpkg/info/*.list 2>/dev/null | head -n1) 2>/dev/null)")
  TITULO='Ultima instalacion o actualizacion de paquetes (apt)'
elif tiene rpm; then
  F=$(rpm -qa --last 2>/dev/null | head -n1 | sed 's/^[^ ]* *//')
  [ -n "$F" ] && ULT=$(date -u -d "$F" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
  TITULO='Ultima instalacion o actualizacion de paquetes (rpm)'
fi
REINICIO=false
[ -f /var/run/reboot-required ] && REINICIO=true
if tiene needs-restarting; then needs-restarting -r >/dev/null 2>&1 || REINICIO=true; fi
# Administradores: root + integrantes de sudo, wheel y admin
ADMINS='{"nombre":"root","tipo":"Usuario","origen":"Local","integrado":true}'
for u in $(getent group sudo wheel admin 2>/dev/null | cut -d: -f4 | tr ',' '\n' | grep -v '^$' | sort -u); do
  ADMINS="$ADMINS,$(printf '{"nombre":%s,"tipo":"Usuario","origen":"Local","integrado":false}' "$(je "$u")")"
done
# Firewall
FW=false
if tiene ufw && ufw status 2>/dev/null | grep -q 'Status: active'; then FW=true; fi
if tiene systemctl && systemctl is-active --quiet firewalld 2>/dev/null; then FW=true; fi
if [ "$FW" = false ] && tiene nft && nft list ruleset 2>/dev/null | grep -q 'hook input'; then FW=true; fi
# TPM y Secure Boot
TPM=false
TPM_V=''
if [ -e /sys/class/tpm/tpm0 ]; then TPM=true; TPM_V=$(leer /sys/class/tpm/tpm0/tpm_version_major); fi
SB=false
if tiene mokutil; then mokutil --sb-state 2>/dev/null | grep -qi 'enabled' && SB=true
else
  V=$(ls /sys/firmware/efi/efivars/SecureBoot-* 2>/dev/null | head -n1)
  [ -n "$V" ] && [ "$(od -An -t u1 "$V" 2>/dev/null | awk '{print $NF}')" = "1" ] && SB=true
fi

SEG=$(printf '{"bitlocker_estado":"no_disponible","bitlocker_detalle":[],"ultimo_parche":%s,"ultimo_parche_titulo":%s,"reinicio_pendiente":%s,"admins_locales":[%s],"firewall_perfiles":{"Firewall":%s},"firewall_activo":%s,"av_productos":[%s],"av_firmas_fecha":null,"tpm_presente":%s,"tpm_version":%s,"secure_boot":%s,"cifrado_producto":"LUKS (Linux)","cifrado_estado":"%s","cifrado_detalle":%s,"bios_clave_admin":null,"bios_clave_sistema":null,"bios_fuente":null,"amenazas":[]}' \
  "$(js "$ULT")" "$(js "$TITULO")" "$REINICIO" "$ADMINS" "$FW" "$FW" "$AV" "$TPM" "$(js "$TPM_V")" "$SB" "$CIFRADO" "$(js "Disco del sistema: $RAIZ")")
HASH_SEG=$(printf '%s' "$SEG" | sha256sum | cut -d' ' -f1)
if [ "$HASH_SEG" != "$(cat "$DIR/seguridad.hash" 2>/dev/null)" ] || [ -z "$(find "$DIR/seguridad.hash" -mmin -360 2>/dev/null)" ]; then
  CUERPO=$(printf '{"p_token":%s,"p_uuid":%s,"p_hostname":%s,"p_secreto":%s,"p_datos":%s}' "$(je "$TOKEN")" "$(js "$UUID")" "$(js "$HOST")" "$(je "$SECRETO")" "$SEG")
  if enviar inv_reportar_seguridad "$CUERPO"; then
    printf '%s' "$HASH_SEG" > "$DIR/seguridad.hash"
    echo "OK $(date -Iseconds)" > "$DIR/ultima-seguridad.txt"
  else
    echo "ERROR $(date -Iseconds) $(msg_error "$RESP")" > "$DIR/ultima-seguridad.txt"
  fi
fi
exit 0
`;

const INSTALADOR = String.raw`#!/bin/bash
# Instalador del agente de Accusys Cyber para Linux
# Uso:  sudo bash instalar-agente-accusys.sh
if [ "$(id -u)" -ne 0 ]; then
  echo 'Hay que ejecutarlo como administrador:  sudo bash instalar-agente-accusys.sh'
  exit 1
fi
for c in curl awk sed df; do
  command -v "$c" >/dev/null 2>&1 || { echo "Falta el comando '$c'. Instalalo (por ejemplo: apt install $c) y volve a ejecutar."; exit 1; }
done

DIR=/opt/accusys-agente
# Carpeta solo para root: nadie mas puede leer el codigo de instalacion ni la clave del equipo
install -d -m 700 -o root -g root "$DIR"
cat > "$DIR/agente.sh" <<'FIN_DEL_AGENTE_ACCUSYS'
__AGENTE__
FIN_DEL_AGENTE_ACCUSYS
chown root:root "$DIR/agente.sh"
chmod 700 "$DIR/agente.sh"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/accusys-agente.service <<'FIN_SERVICIO'
[Unit]
Description=Agente de inventario de Accusys Cyber
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/accusys-agente/agente.sh
TimeoutStartSec=180
FIN_SERVICIO
  cat > /etc/systemd/system/accusys-agente.timer <<'FIN_TIMER'
[Unit]
Description=Ejecuta el agente de Accusys Cyber periodicamente

[Timer]
OnBootSec=2min
OnUnitActiveSec=__INTERVALO__min
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
FIN_TIMER
  systemctl daemon-reload
  systemctl enable accusys-agente.timer >/dev/null 2>&1
  systemctl restart accusys-agente.timer
  echo 'Programado con systemd (accusys-agente.timer).'
else
  echo "*/__INTERVALO__ * * * * root /bin/bash /opt/accusys-agente/agente.sh >/dev/null 2>&1" > /etc/cron.d/accusys-agente
  chmod 644 /etc/cron.d/accusys-agente
  echo 'Programado con cron (/etc/cron.d/accusys-agente).'
fi

echo 'Enviando el primer reporte...'
/bin/bash "$DIR/agente.sh" || true
echo
echo 'Agente instalado. Resultado del primer reporte:'
cat "$DIR/ultimo-reporte.txt" 2>/dev/null
`;

const DESINSTALADOR = String.raw`#!/bin/bash
# Desinstala el agente de Accusys Cyber para Linux.  Uso:  sudo bash desinstalar-agente-accusys.sh
if [ "$(id -u)" -ne 0 ]; then echo 'Ejecutalo con sudo'; exit 1; fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now accusys-agente.timer >/dev/null 2>&1
  rm -f /etc/systemd/system/accusys-agente.timer /etc/systemd/system/accusys-agente.service
  systemctl daemon-reload >/dev/null 2>&1
fi
rm -f /etc/cron.d/accusys-agente
# Borra tambien la clave del equipo: si se vuelve a instalar, hay que restablecerla desde Monitoreo en la app
rm -rf /opt/accusys-agente
echo 'Agente desinstalado.'
`;

export function generarInstaladorLinux(url: string, anon: string, token: string, intervalo: number) {
  const agente = AGENTE.replace("__URL__", () => url.replace(/\/$/, ""))
    .replace("__ANON__", () => anon)
    .replace("__TOKEN__", () => token)
    .replace("__VERSION__", () => AGENTE_LINUX_VERSION);
  return INSTALADOR.replace("__AGENTE__", () => agente).replace(/__INTERVALO__/g, () => String(intervalo));
}

export function generarDesinstaladorLinux() {
  return DESINSTALADOR;
}
