# Lectura de tickets del Helpdesk desde Accusys Cyber

Especificación para el equipo que mantiene el sistema de tickets (`helpdesk.accusys.com.ar`).

Accusys Cyber necesita **solo leer** el estado de los tickets **del área de Ciberseguridad** para mostrar un tablero: abiertos, en espera,
cerrados y cuánto tiempo lleva cada uno. No crea, modifica ni cierra tickets.

Hace falta un único endpoint `GET` de solo lectura en el helpdesk. Accusys Cyber lo consulta cada 15 minutos.
La ruta la elige el equipo del helpdesk (ejemplo: `/api/cyber/tickets`).

## Seguridad

- Solo HTTPS.
- Autenticación con un token de servicio de **solo lectura** en el encabezado `Authorization: Bearer <token>`.
- Si el token falta o es incorrecto: responder `401`.
- La consulta sale de la base de Accusys Cyber (Supabase), no de la red interna:
  el endpoint tiene que ser accesible desde internet. No hay IP de origen fija para filtrar; la protección es el token.
- Del lado de Cyber el token no se muestra en la app ni en los logs, y solo lo carga un administrador.

## El endpoint

**Pedido:** `GET <dirección>?sector=<sector>` con `Authorization: Bearer <token>` y `Accept: application/json`.

El parámetro `sector` trae el nombre del sector tal como figura en el helpdesk (por ejemplo `sector=Ciberseguridad`);
si son varios, separados por coma. El endpoint tiene que devolver **solo los tickets asignados a esos sectores**.
Si prefieren, el token puede quedar limitado a ese sector del lado del helpdesk: Cyber no necesita ver los demás.

**Respuesta:** `200 OK`, `Content-Type: application/json`.

```json
{
  "tickets": [
    {
      "id": "1024",
      "numero": "HD-1024",
      "titulo": "No conecta la VPN",
      "estado": "En curso",
      "sector": "CAU",
      "prioridad": "Alta",
      "solicitante": "Nombre Apellido",
      "asignado": "Nombre Apellido",
      "creado": "2026-10-01T12:00:00Z",
      "actualizado": "2026-10-06T10:00:00Z",
      "cerrado": null,
      "url": "https://helpdesk.accusys.com.ar/tickets/1024"
    }
  ]
}
```

| Campo | Obligatorio | Detalle |
|---|---|---|
| `id` | Sí | Identificador único y estable del ticket (texto o número). |
| `numero` | No | Número visible para el usuario, si es distinto del `id`. |
| `titulo` | Sí | Asunto del ticket. |
| `estado` | Sí | Texto del estado tal como lo muestra el helpdesk. |
| `sector` | Sí | Sector o área que lo tiene asignado. |
| `prioridad` | No | |
| `solicitante` | No | Quién lo pidió. |
| `asignado` | No | Persona que lo atiende. |
| `creado` | Sí | Fecha de creación, ISO 8601 con zona horaria (ej. `2026-10-01T12:00:00Z` o `...-03:00`). |
| `actualizado` | No | Última modificación. |
| `cerrado` | Sí en cerrados | Fecha de cierre; `null` si sigue abierto. |
| `url` | No | Enlace directo al ticket. |

**Qué tickets devolver, siempre en una sola respuesta:**

- **Todos** los tickets del sector pedido que no están cerrados, sin importar la antigüedad.
- Los tickets del sector pedido cerrados en los últimos **90 días**.

Es importante que vengan todos los abiertos: si un ticket que figuraba abierto deja de venir, Cyber lo da por eliminado.
Si la lista es muy grande (miles de tickets), avisar para acordar paginado.

**Cómo interpreta Cyber el estado** (no hace falta cambiar los nombres del helpdesk):

| Si el texto del estado contiene… | Cuenta como |
|---|---|
| cerrado, resuelto, finalizado, completado, cancelado, anulado, rechazado | Cerrado |
| espera, pendiente, pausado, detenido | En espera |
| cualquier otro (nuevo, abierto, en curso, asignado…) | Abierto |

Si el helpdesk usa estados con otros nombres, pasar la lista completa y se ajusta la regla en Cyber.

**Errores:** `401` token inválido, `5xx` falla interna. Cyber muestra el error y reintenta a los 15 minutos; no borra nada.

**No incluir** descripción completa, comentarios, adjuntos ni datos personales más allá de nombres: Cyber solo muestra tablero y tiempos.

## Cómo probar

1. `curl -H "Authorization: Bearer <token>" https://helpdesk.accusys.com.ar/<ruta>` tiene que devolver el JSON de arriba.
2. En Accusys Cyber → Gobierno → Tickets → Configurar lectura: cargar dirección y token, y tocar **Leer ahora**.
