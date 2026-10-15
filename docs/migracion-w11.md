# Migración a Windows 11 desde Accusys Cyber

Pantalla: **Endpoints → Migración a Windows 11** (`/inventario/migracion-w11`, solapa Seguridad).

Usa el **agente de inventario que ya tienen los equipos**. No hace falta ESET ni otra herramienta.

## Cómo funciona

1. **Aptitud (desde hoy, sin tocar las PCs):** la pantalla cruza lo que el agente ya reporta (build de Windows, TPM, Secure Boot,
   procesador, RAM, disco C: y cifrado) y muestra cada equipo con Windows 10 como *Apto*, *A verificar* o *No apto*, con el motivo.
2. **Orden:** un administrador selecciona equipos, les pone una oleada y aprieta **Actualizar a Windows 11**.
3. **Ejecución:** el agente (versión **2.0** o superior) toma la orden en su próximo reporte (cada 5 minutos) y crea una tarea
   programada aparte, `AccusysActualizacionW11`, como SYSTEM. Va aparte porque la tarea del agente tiene un límite de 3 minutos.
   Antes de arrancar, la tarea verifica que la notebook esté enchufada y tenga 25 GB libres. Si no, queda **Pospuesto** y se
   reintenta cada 30 minutos.
4. **Modo mixto:** la tarea elige el camino según dónde esté el equipo.

   | Dónde está el equipo | Camino | Qué hace |
   |---|---|---|
   | Llega a la carpeta compartida (oficina o VPN) | **Red local** | Copia el ISO extraído a `C:\W11Setup`, corre el escaneo oficial de compatibilidad de Microsoft y, si da OK, instala. Entre 30 y 90 minutos. |
   | No llega (home office sin VPN) y la descarga está permitida | **Internet** | Baja el **Asistente de instalación de Windows 11** desde Microsoft. El asistente verifica la compatibilidad, descarga Windows 11 (unos 4 GB) e instala. Entre 1 y 3 horas según la conexión. |
   | No llega y la descarga no está permitida | — | Queda *Pospuesto* hasta que vuelva a la red. |

   En los dos caminos se conservan aplicaciones y datos, y el agente exige que el instalador tenga **firma válida de Microsoft**.
   Si no la tiene, no se ejecuta nada.
5. **Cierre:** al reiniciar, el agente reporta el build de Windows 11 y el equipo queda **Migrado**.

### Equipos con disco cifrado por ESET

Se actualizan **sin descifrar**. ESET soporta Windows 11 en Endpoint Encryption y Full Disk Encryption, y para el upgrade in-place
pide que `setup.exe` cargue su driver de cifrado. La tarea lo detecta sola y agrega:

```
/ReflectDrivers C:\Windows\System32\dlpcore\Upgrade\ /ResizeRecoveryPartition Disable
```

Sin esto, el upgrade falla con `0xC1900101 - 0x20017` (fase SAFE_OS). No hace falta clonar ni reemplazar el disco.

- Solo se actualizan por el camino de **red local** (carpeta compartida, en la oficina o por VPN). El Asistente de Microsoft no
  carga el driver de cifrado, así que en home office sin VPN quedan *Pospuestos* hasta que se conecten.
- Si el equipo está cifrado pero falta la carpeta de drivers, queda *Bloqueado*: hay que actualizar el cliente de cifrado de ESET.
- Durante la instalación el equipo **se reinicia varias veces y en cada reinicio pide la clave de pre-arranque**. Con el reinicio
  manual, el usuario la ingresa. Para oleadas con reinicio automático fuera de horario, hay que suspender antes la autenticación de
  pre-arranque desde ESET; si no, el equipo queda esperando la clave.
- **No usar MBR2GPT** en equipos cifrados con ESET: no está soportado. Un equipo cifrado en modo Legacy se trata aparte.
- ESET recomienda tener backup de los datos importantes antes del upgrade.

Seguridad: la única orden que el agente acepta es "actualizar", autenticada con la clave propia de cada equipo.
Las órdenes, cancelaciones y cambios de configuración quedan en **Logs**.

## Puesta en marcha

1. **Supabase:** ejecutar `supabase/migracion-w11.sql` en el SQL Editor. Va después de `auditoria.sql` e
   `instalacion-segura.sql`, y se puede repetir.
2. **Deploy:** subir los cambios del repo. Con eso la pantalla ya muestra la aptitud de todos los equipos.
3. **Configurar** (en la pantalla). Por defecto está permitida la descarga desde internet, así que se puede arrancar sin carpeta.
   Para la oficina se recomienda sumar la carpeta:
   - Crear un recurso compartido, por ejemplo `\\SERVIDOR\W11$`, con **lectura para Equipos del dominio**.
   - Extraer el ISO de Windows 11 (26H2 o 25H2, mismo idioma y edición que los equipos) en `\\SERVIDOR\W11$\26H2`.
   - Opcional: calcular la huella con `(Get-FileHash \\SERVIDOR\W11$\26H2\sources\install.wim).Hash`.
4. **Agente 2.0:** reinstalar el agente en los equipos que se van a migrar, con el mismo instalador de siempre (Monitoreo →
   Instalar agente). La reinstalación conserva la clave del equipo. La pantalla avisa cuántos equipos tienen un agente anterior.

## Cómo operar

1. Revisar los **No aptos** (candidatos a recambio) y los **A verificar**.
2. Primera oleada **Piloto** con 3 a 5 equipos del área. Incluir al menos uno con cifrado ESET y **al menos uno en home office**
   para probar el camino por internet.
3. Validar en el piloto que FortiClient, ESET, la VPN y las aplicaciones de negocio funcionan en Windows 11.
4. Seguir por oleadas (piso, sede, home office). Si en la oficina se actualiza por internet (sin carpeta), conviene armar oleadas
   chicas: cada equipo baja unos 4 GB por los enlaces.

Por defecto el equipo **no se reinicia solo**: el upgrade queda preparado (**Falta reiniciar**) y se completa cuando el usuario
reinicia. La opción *Reiniciar automáticamente* (en Configurar) es para oleadas fuera de horario.

## Estados

| Estado | Qué significa |
|---|---|
| Ordenado | Esperando el próximo reporte del agente |
| Orden recibida / En curso | Descarga, copia o instalación en marcha (el detalle dice si va por red local o por internet) |
| Falta reiniciar | Windows 11 preparado; se completa al reiniciar |
| Pospuesto | A batería, sin espacio, sin acceso a la carpeta o sin poder descargar; se reintenta solo |
| Bloqueado | El escaneo de Microsoft encontró un impedimento (app incompatible, etc.) |
| Error | Ver el detalle; logs en el equipo en `C:\ProgramData\AccusysAgente\w11\logs` |
| Revisar | Más de 24 h en curso sin pasar a Windows 11 |
| Migrado | Ya reporta Windows 11 |

## Para validar en el piloto

- **Asistente de Microsoft (camino por internet):** los parámetros silenciosos (`/QuietInstall /SkipEULA /auto upgrade
  /NoRestartUI`) son los que usan las herramientas de gestión, pero Microsoft no los documenta oficialmente. Hay que confirmar en el
  piloto que no reinicia el equipo por su cuenta cuando *Reiniciar automáticamente* está apagado, y qué código de salida devuelve.
- **ESET:** probar en el piloto al menos un equipo cifrado, con el cliente de cifrado actualizado a la última versión.
- **Código de salida de setup.exe:** si un equipo figura con *Error* pero al reiniciar pasa a Windows 11, igual queda *Migrado*;
  conviene revisar el código que muestra el detalle para ajustar la interpretación.
- **Vuelta atrás:** Windows conserva 10 días para volver a Windows 10 (Configuración → Sistema → Recuperación).
