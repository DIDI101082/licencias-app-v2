-- ==========================================================
-- Catálogo de productos por código EAN/UPC (el de la caja)
-- Ejecutar UNA VEZ en el SQL Editor.
-- ==========================================================

create table if not exists public.inv_productos (
  ean text primary key,
  titulo text,
  marca text,
  modelo text,
  categoria_id int references public.inv_categorias(id),
  descripcion text,
  imagen text,
  fuente text not null default 'upcitemdb',   -- upcitemdb | manual
  actualizado timestamptz not null default now()
);

-- Guardar en cada equipo el EAN de su producto (sirve para agrupar compras del mismo modelo)
alter table public.inv_equipos add column if not exists ean text;

alter table public.inv_productos enable row level security;

drop policy if exists inv_productos_select on public.inv_productos;
create policy inv_productos_select on public.inv_productos for select to authenticated
  using (mi_rol() is not null);

drop policy if exists inv_productos_escritura on public.inv_productos;
create policy inv_productos_escritura on public.inv_productos for all to authenticated
  using (mi_rol() in ('administrador', 'lectura_escritura'))
  with check (mi_rol() in ('administrador', 'lectura_escritura'));
