# Tickets del Helpdesk en Accusys Cyber

Accusys Cyber **solo lee** el estado de los tickets del área para mostrar un tablero en Gobierno → Tickets:
abiertos, en espera, cerrados, SLA y cuánto tiempo lleva cada uno. No crea, modifica ni cierra tickets.

## De dónde lee

De la **Helpdesk Dashboard API** (`workdesk.accusys.com.ar`), endpoint de bandeja por subárea:

```
GET https://workdesk.accusys.com.ar/api/dashboard/bandejas/subarea/{idSubarea}?idEmpresa=1&tipoBandeja=2
Encabezado: X-API-Key: <API Key>
```

- `tipoBandeja=2`: tickets **asignados a** la subárea (los que hay que resolver).
- `tipoBandeja=1`: tickets **generados por** la subárea.
- Para esta integración: `idSubarea=50`, `idEmpresa=1`.

La consulta sale de la base de Accusys Cyber (Supabase) cada 15 minutos.

## Configuración en Cyber

Gobierno → Tickets → Configurar lectura (solo administradores):

- **Dirección:** la URL completa de la bandeja, con sus parámetros.
- **Token:** la API Key. No se muestra en la app ni en los logs.
- **Sectores a leer:** vacío (la bandeja ya viene filtrada por subárea).

## Qué toma de cada ticket

| En Cyber | Campo de la API |
|---|---|
| Número | `idTicket` |
| Título | `titulo` |
| Estado | `estado` |
| Tipo | `tipoTicket` |
| Prioridad | `prioridad` |
| Solicitante | `autor` |
| Asignado a | personas de `asignados` (tipo 1) |
| Sector | subárea o grupo de `asignados` (tipo 2 y 3) |
| SLA | `estadoSla` |
| Creado | `fechaAlta` |
| Actualizado | `fechaUltimaModificacion` |
| Cerrado | `fechaUltimoCambioEstado`, solo si el estado es de cierre |

## Cómo se interpretan los estados

| Estado en el helpdesk | En Cyber |
|---|---|
| Pendiente, Asignado, En curso, En revisión, Devuelto, Reabierto | Abierto |
| En espera | En espera |
| Resuelto, Cerrado, Rechazado | Cerrado |

## Supuestos a confirmar con el equipo del helpdesk

- Las fechas vienen sin zona horaria (`2026-06-20T10:34:11`): Cyber las toma como **hora de Argentina**.
- La bandeja no informa fecha de cierre: se usa la fecha del último cambio de estado.
- Se asume que la bandeja devuelve también los tickets resueltos y cerrados. Si solo devuelve los pendientes,
  en Cyber no van a figurar los cerrados ni el tiempo de resolución.
