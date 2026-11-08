create table if not exists public.ingredients (
  workspace_id text not null check (workspace_id ~ '^[0-9a-f]{32}$'),
  id uuid not null,
  name text,
  unit text check (unit in ('g', 'kg', 'ml', 'l', 'pcs')),
  purchase_quantity numeric check (purchase_quantity > 0),
  purchase_price numeric check (purchase_price >= 0),
  price_per_unit numeric check (price_per_unit >= 0),
  has_price boolean not null default true,
  grams_per_ml numeric check (grams_per_ml is null or grams_per_ml > 0),
  grams_per_piece numeric check (grams_per_piece is null or grams_per_piece > 0),
  updated_at timestamptz(3) not null,
  server_updated_at timestamptz(3) not null default now(),
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
alter table public.ingredients
  add column if not exists grams_per_ml numeric check (grams_per_ml is null or grams_per_ml > 0);
alter table public.ingredients
  add column if not exists grams_per_piece numeric check (grams_per_piece is null or grams_per_piece > 0);
alter table public.ingredients
  add column if not exists server_updated_at timestamptz(3) not null default now();

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
  markup_type text not null default 'absolute'
    check (markup_type in ('absolute', 'percentage', 'margin', 'foodCost')),
  markup_value numeric not null default 0 check (markup_value >= 0),
  pan_diameter_cm numeric check (pan_diameter_cm is null or pan_diameter_cm > 0),
  updated_at timestamptz(3) not null,
  server_updated_at timestamptz(3) not null default now(),
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

alter table public.products
  add column if not exists markup_type text not null default 'absolute';
alter table public.products
  drop constraint if exists products_markup_type_check;
alter table public.products
  add constraint products_markup_type_check
  check (markup_type in ('absolute', 'percentage', 'margin', 'foodCost'));
alter table public.products
  add column if not exists markup_value numeric not null default 0
  check (markup_value >= 0);
alter table public.products
  add column if not exists pan_diameter_cm numeric
  check (pan_diameter_cm is null or pan_diameter_cm > 0);
alter table public.products
  add column if not exists server_updated_at timestamptz(3) not null default now();

create table if not exists public.recipe_items (
  workspace_id text not null check (workspace_id ~ '^[0-9a-f]{32}$'),
  id uuid not null,
  product_id uuid,
  ingredient_id uuid,
  item_type text not null default 'ingredient'
    check (item_type in ('ingredient', 'product')),
  quantity numeric check (quantity >= 0),
  quantity_unit text check (quantity_unit in ('g', 'kg', 'ml', 'l', 'pcs')),
  updated_at timestamptz(3) not null,
  server_updated_at timestamptz(3) not null default now(),
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

alter table public.recipe_items
  add column if not exists item_type text not null default 'ingredient'
  check (item_type in ('ingredient', 'product'));
alter table public.recipe_items
  add column if not exists server_updated_at timestamptz(3) not null default now();

create table if not exists public.direct_costs (
  workspace_id text not null check (workspace_id ~ '^[0-9a-f]{32}$'),
  id uuid not null,
  product_id uuid,
  name text,
  amount numeric check (amount >= 0),
  category text check (category in ('labor', 'overhead', 'packaging')),
  hours numeric check (hours is null or hours > 0),
  hourly_rate numeric check (hourly_rate is null or hourly_rate >= 0),
  updated_at timestamptz(3) not null,
  server_updated_at timestamptz(3) not null default now(),
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

alter table public.direct_costs
  drop constraint if exists direct_costs_category_check;
alter table public.direct_costs
  add constraint direct_costs_category_check
  check (category in ('labor', 'overhead', 'packaging'));
alter table public.direct_costs
  add column if not exists hours numeric check (hours is null or hours > 0);
alter table public.direct_costs
  add column if not exists hourly_rate numeric check (hourly_rate is null or hourly_rate >= 0);
alter table public.direct_costs
  add column if not exists server_updated_at timestamptz(3) not null default now();

-- Clamp future timestamps (prevents permanent LWW poisoning) and maintain server_updated_at
create or replace function public.keep_newest_entity_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.updated_at > now() + interval '5 minutes' then
    new.updated_at := now();
  end if;
  new.server_updated_at := now();

  if tg_op = 'UPDATE' and new.updated_at <= old.updated_at then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists ingredients_lww on public.ingredients;
create trigger ingredients_lww
before insert or update on public.ingredients
for each row execute function public.keep_newest_entity_version();

drop trigger if exists products_lww on public.products;
create trigger products_lww
before insert or update on public.products
for each row execute function public.keep_newest_entity_version();

drop trigger if exists recipe_items_lww on public.recipe_items;
create trigger recipe_items_lww
before insert or update on public.recipe_items
for each row execute function public.keep_newest_entity_version();

drop trigger if exists direct_costs_lww on public.direct_costs;
create trigger direct_costs_lww
before insert or update on public.direct_costs
for each row execute function public.keep_newest_entity_version();

-- Helper to extract workspace header when sent by the client
create or replace function public.request_workspace_id()
returns text
language sql
stable
as $$
  select nullif(
    (coalesce(current_setting('request.headers', true), '{}')::json ->> 'x-workspace-id'),
    ''
  );
$$;

-- Enable Row Level Security so nobody can dump or overwrite other workspaces
alter table public.ingredients enable row level security;
alter table public.products enable row level security;
alter table public.recipe_items enable row level security;
alter table public.direct_costs enable row level security;

drop policy if exists workspace_isolation_ingredients on public.ingredients;
create policy workspace_isolation_ingredients on public.ingredients
  for all to anon
  using (workspace_id = public.request_workspace_id())
  with check (
    workspace_id ~ '^[0-9a-f]{32}$'
    and workspace_id = public.request_workspace_id()
  );

drop policy if exists workspace_isolation_products on public.products;
create policy workspace_isolation_products on public.products
  for all to anon
  using (workspace_id = public.request_workspace_id())
  with check (
    workspace_id ~ '^[0-9a-f]{32}$'
    and workspace_id = public.request_workspace_id()
  );

drop policy if exists workspace_isolation_recipe_items on public.recipe_items;
create policy workspace_isolation_recipe_items on public.recipe_items
  for all to anon
  using (workspace_id = public.request_workspace_id())
  with check (
    workspace_id ~ '^[0-9a-f]{32}$'
    and workspace_id = public.request_workspace_id()
  );

drop policy if exists workspace_isolation_direct_costs on public.direct_costs;
create policy workspace_isolation_direct_costs on public.direct_costs
  for all to anon
  using (workspace_id = public.request_workspace_id())
  with check (
    workspace_id ~ '^[0-9a-f]{32}$'
    and workspace_id = public.request_workspace_id()
  );

grant usage on schema public to anon;
revoke delete on public.ingredients, public.products, public.recipe_items, public.direct_costs from anon;
grant select, insert, update
  on public.ingredients, public.products, public.recipe_items, public.direct_costs
  to anon;

comment on column public.ingredients.workspace_id is
  'SHA-256 workspace namespace isolated via RLS and x-workspace-id header.';
comment on column public.products.workspace_id is
  'SHA-256 workspace namespace isolated via RLS and x-workspace-id header.';
comment on column public.recipe_items.workspace_id is
  'SHA-256 workspace namespace isolated via RLS and x-workspace-id header.';
comment on column public.direct_costs.workspace_id is
  'SHA-256 workspace namespace isolated via RLS and x-workspace-id header.';
