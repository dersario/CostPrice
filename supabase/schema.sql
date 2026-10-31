create table if not exists public.ingredients (
  workspace_id text not null check (workspace_id ~ '^[0-9a-f]{32}$'),
  id uuid not null,
  name text,
  unit text check (unit in ('g', 'kg', 'ml', 'l', 'pcs')),
  purchase_quantity numeric check (purchase_quantity > 0),
  purchase_price numeric check (purchase_price >= 0),
  price_per_unit numeric check (price_per_unit >= 0),
  has_price boolean not null default true,
  updated_at timestamptz(3) not null,
  is_deleted boolean not null default false,
  primary key (workspace_id, id),
  check (
    is_deleted
    or (
      name is not null
      and length(trim(name)) > 0
      and unit is not null
      and purchase_quantity is not null
      and purchase_price is not null
      and price_per_unit is not null
    )
  )
);

alter table public.ingredients
  add column if not exists purchase_quantity numeric check (purchase_quantity > 0);
alter table public.ingredients
  add column if not exists purchase_price numeric check (purchase_price >= 0);
alter table public.ingredients
  add column if not exists has_price boolean not null default true;
update public.ingredients
set purchase_quantity = 1,
    purchase_price = price_per_unit
where not is_deleted
  and (purchase_quantity is null or purchase_price is null);

create table if not exists public.products (
  workspace_id text not null check (workspace_id ~ '^[0-9a-f]{32}$'),
  id uuid not null,
  name text,
  description text,
  output_quantity numeric check (output_quantity > 0),
  output_unit text check (output_unit in ('g', 'kg', 'ml', 'l', 'pcs')),
  updated_at timestamptz(3) not null,
  is_deleted boolean not null default false,
  primary key (workspace_id, id),
  check (
    is_deleted
    or (
      name is not null
      and length(trim(name)) > 0
      and description is not null
      and output_quantity is not null
      and output_unit is not null
    )
  )
);

create table if not exists public.recipe_items (
  workspace_id text not null check (workspace_id ~ '^[0-9a-f]{32}$'),
  id uuid not null,
  product_id uuid,
  ingredient_id uuid,
  quantity numeric check (quantity >= 0),
  quantity_unit text check (quantity_unit in ('g', 'kg', 'ml', 'l', 'pcs')),
  updated_at timestamptz(3) not null,
  is_deleted boolean not null default false,
  primary key (workspace_id, id),
  check (
    is_deleted
    or (
      product_id is not null
      and ingredient_id is not null
      and quantity is not null
      and quantity_unit is not null
    )
  )
);

create table if not exists public.direct_costs (
  workspace_id text not null check (workspace_id ~ '^[0-9a-f]{32}$'),
  id uuid not null,
  product_id uuid,
  name text,
  amount numeric check (amount >= 0),
  category text check (category in ('labor', 'overhead')),
  updated_at timestamptz(3) not null,
  is_deleted boolean not null default false,
  primary key (workspace_id, id),
  check (
    is_deleted
    or (
      product_id is not null
      and name is not null
      and length(trim(name)) > 0
      and amount is not null
      and category is not null
    )
  )
);

create or replace function public.keep_newest_entity_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.updated_at <= old.updated_at then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists ingredients_lww on public.ingredients;
create trigger ingredients_lww
before update on public.ingredients
for each row execute function public.keep_newest_entity_version();

drop trigger if exists products_lww on public.products;
create trigger products_lww
before update on public.products
for each row execute function public.keep_newest_entity_version();

drop trigger if exists recipe_items_lww on public.recipe_items;
create trigger recipe_items_lww
before update on public.recipe_items
for each row execute function public.keep_newest_entity_version();

drop trigger if exists direct_costs_lww on public.direct_costs;
create trigger direct_costs_lww
before update on public.direct_costs
for each row execute function public.keep_newest_entity_version();

alter table public.ingredients disable row level security;
alter table public.products disable row level security;
alter table public.recipe_items disable row level security;
alter table public.direct_costs disable row level security;

grant usage on schema public to anon;
grant select, insert, update, delete
  on public.ingredients, public.products, public.recipe_items, public.direct_costs
  to anon;

comment on column public.ingredients.workspace_id is
  'SHA-256 workspace namespace only; it is not an authorization boundary.';
comment on column public.products.workspace_id is
  'SHA-256 workspace namespace only; it is not an authorization boundary.';
comment on column public.recipe_items.workspace_id is
  'SHA-256 workspace namespace only; it is not an authorization boundary.';
comment on column public.direct_costs.workspace_id is
  'SHA-256 workspace namespace only; it is not an authorization boundary.';
