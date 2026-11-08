import type { SupabaseClient } from '@supabase/supabase-js'
import { db } from '../db/database'
import { notifyDataChanged } from '../db/repository'
import { isMeasurementUnit } from '../lib/units'
import type {
  DirectCost,
  Ingredient,
  Product,
  RecipeItem,
  SyncEntity,
  SyncOperation,
} from '../types'
import { getSupabaseClient } from './client'
import { getSyncCursor, getWorkspaceId, setSyncCursor } from './workspace'

type SyncRecord = Ingredient | Product | RecipeItem | DirectCost
type RemoteRow = Record<string, unknown>

interface RemoteEntry {
  id: string
  updatedAt: string
  serverUpdatedAt?: string
  deleted: boolean
  record?: SyncRecord
}

export interface SyncResult {
  pushed: number
  pulled: number
  queued: number
  synchronizedAt: string
}

const remoteTables: Record<SyncEntity, string> = {
  ingredients: 'ingredients',
  products: 'products',
  recipeItems: 'recipe_items',
  directCosts: 'direct_costs',
}

// Order for upserting (parents before children)
const UPSERT_ENTITY_ORDER: readonly SyncEntity[] = [
  'ingredients',
  'products',
  'recipeItems',
  'directCosts',
]

// Order for deleting (children before parents)
const DELETE_ENTITY_ORDER: readonly SyncEntity[] = [
  'directCosts',
  'recipeItems',
  'products',
  'ingredients',
]

const REMOTE_PAGE_SIZE = 500

export async function synchronizeNow(options?: {
  forceFullPull?: boolean
}): Promise<SyncResult> {
  if (!navigator.onLine) {
    throw new Error('Нет подключения к интернету. Изменения останутся в очереди.')
  }

  const workspaceId = await getWorkspaceId()
  const client = await getSupabaseClient(workspaceId)

  // Step 1: Push pending local changes first so local deletes/updates reach remote before pull resolution
  const pushed = await pushPendingChanges(client, workspaceId)

  // Step 2: Pull remote changes (incremental if cursor available, unless forceFullPull)
  const sinceCursor = options?.forceFullPull
    ? null
    : getSyncCursor(workspaceId)
  const { applied: pulled, maxServerTimestamp } = await pullRemoteChanges(
    client,
    workspaceId,
    sinceCursor,
  )

  // Step 3: Push any local records that won conflict resolution during pull
  const pushedAfterPull = await pushPendingChanges(client, workspaceId)

  if (maxServerTimestamp) {
    setSyncCursor(workspaceId, maxServerTimestamp)
  }

  const queued = await db.syncQueue.count()
  if (pulled > 0) {
    notifyDataChanged()
  }

  return {
    pushed: pushed + pushedAfterPull,
    pulled,
    queued,
    synchronizedAt: new Date().toISOString(),
  }
}

export function registerOnlineSync(
  onSync: () => Promise<void>,
): () => void {
  const handleOnline = () => {
    void onSync()
  }

  window.addEventListener('online', handleOnline)
  return () => window.removeEventListener('online', handleOnline)
}

async function pullRemoteChanges(
  client: SupabaseClient,
  workspaceId: string,
  sinceCursor: string | null,
): Promise<{ applied: number; maxServerTimestamp: string | null }> {
  const fetchedByEntity = new Map<SyncEntity, RemoteEntry[]>()
  let maxServerTimestamp: string | null = sinceCursor

  for (const entity of UPSERT_ENTITY_ORDER) {
    const rows = await fetchRemoteRows(
      client,
      entity,
      workspaceId,
      sinceCursor,
    )
    const decoded: RemoteEntry[] = []
    for (const row of rows) {
      try {
        const entry = decodeRemoteRow(entity, row)
        decoded.push(entry)
        if (
          entry.serverUpdatedAt &&
          (!maxServerTimestamp ||
            compareTimestamps(entry.serverUpdatedAt, maxServerTimestamp) > 0)
        ) {
          maxServerTimestamp = entry.serverUpdatedAt
        }
      } catch {
        // Skip malformed remote rows rather than locking the entire sync pipeline
      }
    }
    fetchedByEntity.set(entity, decoded)
  }

  let applied = 0

  await db.transaction(
    'rw',
    db.ingredients,
    db.products,
    db.recipeItems,
    db.directCosts,
    db.syncQueue,
    async () => {
      const pending = await db.syncQueue.toArray()

      // Pass 1: Process tombstones (deletes) in child-first order
      for (const entity of DELETE_ENTITY_ORDER) {
        const entries = fetchedByEntity.get(entity) ?? []
        const latestPending = getLatestOperations(pending, entity)

        for (const remote of entries) {
          if (!remote.deleted) continue
          const local = await getLocalRecord(entity, remote.id)
          const operation = latestPending.get(remote.id)

          if (!local) {
            if (
              operation &&
              compareTimestamps(operation.updatedAt, remote.updatedAt) <= 0
            ) {
              await deletePendingOperations(entity, remote.id, remote.updatedAt)
            }
            continue
          }

          if (compareTimestamps(remote.updatedAt, local.updatedAt) >= 0) {
            await deleteLocalRecord(entity, remote.id)
            await deletePendingOperations(entity, remote.id, remote.updatedAt)
            applied += 1
          } else {
            await ensureUpsertQueued(entity, local)
          }
        }
      }

      // Pass 2: Process non-deleted records (upserts) in parent-first order
      for (const entity of UPSERT_ENTITY_ORDER) {
        const entries = fetchedByEntity.get(entity) ?? []
        const latestPending = getLatestOperations(pending, entity)

        for (const remote of entries) {
          if (remote.deleted || !remote.record) continue
          const local = await getLocalRecord(entity, remote.id)
          const operation = latestPending.get(remote.id)

          if (!local && operation?.operation === 'delete') {
            if (compareTimestamps(operation.updatedAt, remote.updatedAt) > 0) {
              continue
            }
            await deletePendingOperations(entity, remote.id)
          }

          if (!local) {
            await putLocalRecord(entity, remote.record)
            applied += 1
            continue
          }

          // Newest updatedAt wins; equal timestamps resolve in favor of remote
          if (compareTimestamps(remote.updatedAt, local.updatedAt) >= 0) {
            await putLocalRecord(entity, remote.record)
            await deletePendingOperations(entity, remote.id, remote.updatedAt)
            applied += 1
          } else {
            await ensureUpsertQueued(entity, local)
          }
        }
      }
    },
  )

  return { applied, maxServerTimestamp }
}

async function fetchRemoteRows(
  client: SupabaseClient,
  entity: SyncEntity,
  workspaceId: string,
  sinceCursor: string | null,
): Promise<RemoteRow[]> {
  const rows: RemoteRow[] = []
  let offset = 0

  while (true) {
    let query = client
      .from(remoteTables[entity])
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('id', { ascending: true })
      .range(offset, offset + REMOTE_PAGE_SIZE - 1)

    if (sinceCursor) {
      query = query.gte('updated_at', sinceCursor)
    }

    const { data, error } = await query
    if (error) {
      throw new Error(formatRemoteError('загрузить', remoteTables[entity], error))
    }

    const page = (data ?? []) as RemoteRow[]
    rows.push(...page)
    if (page.length < REMOTE_PAGE_SIZE) break
    offset += REMOTE_PAGE_SIZE
  }

  return rows
}

async function pushPendingChanges(
  client: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const queuedOperations = await db.syncQueue.toArray()
  if (queuedOperations.length === 0) return 0

  const byEntity = new Map<SyncEntity, Map<string, SyncOperation[]>>()

  for (const operation of queuedOperations) {
    let byId = byEntity.get(operation.entity)
    if (!byId) {
      byId = new Map()
      byEntity.set(operation.entity, byId)
    }

    const operations = byId.get(operation.entityId) ?? []
    operations.push(operation)
    byId.set(operation.entityId, operations)
  }

  let pushed = 0
  for (const entity of UPSERT_ENTITY_ORDER) {
    const byId = byEntity.get(entity)
    if (!byId || byId.size === 0) continue

    const rows: RemoteRow[] = []
    const acknowledgedOperationIds: number[] = []

    for (const [entityId, operations] of byId) {
      const latestOperation = operations[operations.length - 1]
      const local = await getLocalRecord(entity, entityId)
      const shouldDelete =
        !local ||
        (latestOperation.operation === 'delete' &&
          compareTimestamps(latestOperation.updatedAt, local.updatedAt) > 0)

      rows.push(
        shouldDelete
          ? serializeTombstone(
              entity,
              entityId,
              workspaceId,
              latestOperation.updatedAt,
            )
          : serializeRecord(entity, local, workspaceId),
      )
      acknowledgedOperationIds.push(
        ...operations.flatMap((operation) =>
          operation.id === undefined ? [] : [operation.id],
        ),
      )
    }

    let { error } = await client
      .from(remoteTables[entity])
      .upsert(rows, { onConflict: 'workspace_id,id' })

    // Backward compatibility fallback: if remote schema doesn't have the new optional columns yet, strip them and retry
    if (error && (error.code === 'PGRST204' || error.code === '42703')) {
      const fallbackRows = rows.map((row) => stripExtendedColumns(entity, row))
      const retry = await client
        .from(remoteTables[entity])
        .upsert(fallbackRows, { onConflict: 'workspace_id,id' })
      error = retry.error
    }

    if (error) {
      throw new Error(formatRemoteError('отправить', remoteTables[entity], error))
    }

    await db.syncQueue.bulkDelete(acknowledgedOperationIds)
    pushed += acknowledgedOperationIds.length
  }

  return pushed
}

function stripExtendedColumns(
  entity: SyncEntity,
  row: RemoteRow,
): RemoteRow {
  const copy: RemoteRow = { ...row }
  if (entity === 'ingredients') {
    delete copy.grams_per_ml
    delete copy.grams_per_piece
  } else if (entity === 'products') {
    delete copy.pan_diameter_cm
    if (copy.markup_type !== 'absolute' && copy.markup_type !== 'percentage') {
      copy.markup_type = 'absolute'
    }
  } else if (entity === 'recipeItems') {
    delete copy.item_type
  } else if (entity === 'directCosts') {
    delete copy.hours
    delete copy.hourly_rate
    if (copy.category === 'packaging') {
      copy.category = 'overhead'
    }
  }
  return copy
}

function formatRemoteError(
  action: 'загрузить' | 'отправить',
  table: string,
  error: { code?: string; message: string },
): string {
  if (error.code === 'PGRST205') {
    return `Таблица public.${table} не найдена в Supabase или кэш схемы устарел. Выполните supabase/schema.sql в SQL Editor проекта. Если таблица уже создана, обновите кэш командой NOTIFY pgrst, 'reload schema'; затем повторите синхронизацию.`
  }

  if (error.code === 'PGRST204' || error.code === '42703') {
    return `В таблице public.${table} не хватает столбцов для текущей версии приложения. Выполните актуальный supabase/schema.sql в SQL Editor проекта и повторите синхронизацию.`
  }

  return `Не удалось ${action} ${table}: ${error.message}`
}

function getLatestOperations(
  operations: SyncOperation[],
  entity: SyncEntity,
): Map<string, SyncOperation> {
  const latest = new Map<string, SyncOperation>()
  for (const operation of operations) {
    if (
      operation.entity === entity &&
      (!latest.has(operation.entityId) ||
        (latest.get(operation.entityId)?.id ?? 0) < (operation.id ?? 0))
    ) {
      latest.set(operation.entityId, operation)
    }
  }
  return latest
}

async function getLocalRecord(
  entity: SyncEntity,
  id: string,
): Promise<SyncRecord | undefined> {
  switch (entity) {
    case 'ingredients':
      return db.ingredients.get(id)
    case 'products':
      return db.products.get(id)
    case 'recipeItems':
      return db.recipeItems.get(id)
    case 'directCosts':
      return db.directCosts.get(id)
    default:
      return assertNever(entity)
  }
}

async function putLocalRecord(entity: SyncEntity, record: SyncRecord): Promise<void> {
  switch (entity) {
    case 'ingredients': {
      if (!isIngredient(record)) return
      await db.ingredients.put(record)
      return
    }
    case 'products': {
      if (!isProduct(record)) return
      await db.products.put(record)
      return
    }
    case 'recipeItems': {
      if (!isRecipeItem(record)) return
      await db.recipeItems.put(record)
      return
    }
    case 'directCosts': {
      if (!isDirectCost(record)) return
      await db.directCosts.put(record)
      return
    }
    default:
      return assertNever(entity)
  }
}

async function deleteLocalRecord(entity: SyncEntity, id: string): Promise<void> {
  switch (entity) {
    case 'ingredients':
      await db.ingredients.delete(id)
      return
    case 'products':
      await db.products.delete(id)
      return
    case 'recipeItems':
      await db.recipeItems.delete(id)
      return
    case 'directCosts':
      await db.directCosts.delete(id)
      return
    default:
      return assertNever(entity)
  }
}

function serializeRecord(
  entity: SyncEntity,
  record: SyncRecord | undefined,
  workspaceId: string,
): RemoteRow {
  if (!record) throw new Error('Не удалось прочитать локальную запись для синхронизации.')

  const common = {
    id: record.id,
    workspace_id: workspaceId,
    updated_at: clampTimestampForRemote(record.updatedAt),
    is_deleted: false,
  }

  switch (entity) {
    case 'ingredients':
      if (!isIngredient(record)) throw new Error('Неверные данные ингредиента.')
      return {
        ...common,
        name: record.name,
        unit: record.unit,
        purchase_quantity: record.purchaseQuantity,
        purchase_price: record.purchasePrice,
        price_per_unit: record.pricePerUnit,
        has_price: record.hasPrice,
        grams_per_ml: record.gramsPerMl ?? null,
        grams_per_piece: record.gramsPerPiece ?? null,
      }
    case 'products':
      if (!isProduct(record)) throw new Error('Неверные данные рецепта.')
      return {
        ...common,
        name: record.name,
        description: record.description,
        output_quantity: record.outputQuantity,
        output_unit: record.outputUnit,
        markup_type: record.markupType,
        markup_value: record.markupValue,
        pan_diameter_cm: record.panDiameterCm ?? null,
      }
    case 'recipeItems':
      if (!isRecipeItem(record)) throw new Error('Неверные данные строки рецепта.')
      return {
        ...common,
        product_id: record.productId,
        ingredient_id: record.ingredientId,
        item_type: record.itemType ?? 'ingredient',
        quantity: record.quantity,
        quantity_unit: record.quantityUnit,
      }
    case 'directCosts':
      if (!isDirectCost(record)) throw new Error('Неверные данные прямых затрат.')
      return {
        ...common,
        product_id: record.productId,
        name: record.name,
        amount: record.amount,
        category: record.category,
        hours: record.hours ?? null,
        hourly_rate: record.hourlyRate ?? null,
      }
    default:
      return assertNever(entity)
  }
}

function serializeTombstone(
  entity: SyncEntity,
  id: string,
  workspaceId: string,
  updatedAt: string,
): RemoteRow {
  const common = {
    id,
    workspace_id: workspaceId,
    updated_at: clampTimestampForRemote(updatedAt),
    is_deleted: true,
  }

  switch (entity) {
    case 'ingredients':
      return {
        ...common,
        name: null,
        unit: null,
        purchase_quantity: null,
        purchase_price: null,
        price_per_unit: null,
        has_price: true,
        grams_per_ml: null,
        grams_per_piece: null,
      }
    case 'products':
      return {
        ...common,
        name: null,
        description: null,
        output_quantity: null,
        output_unit: null,
        markup_type: 'absolute',
        markup_value: 0,
        pan_diameter_cm: null,
      }
    case 'recipeItems':
      return {
        ...common,
        product_id: null,
        ingredient_id: null,
        item_type: 'ingredient',
        quantity: null,
        quantity_unit: null,
      }
    case 'directCosts':
      return {
        ...common,
        product_id: null,
        name: null,
        amount: null,
        category: null,
        hours: null,
        hourly_rate: null,
      }
    default:
      return assertNever(entity)
  }
}

function clampTimestampForRemote(timestamp: string): string {
  const parsed = Date.parse(timestamp)
  const nowMs = Date.now()
  if (!Number.isFinite(parsed) || parsed > nowMs + 60_000) {
    return new Date(nowMs).toISOString()
  }
  return timestamp
}

function decodeRemoteRow(entity: SyncEntity, value: RemoteRow): RemoteEntry {
  const id = requireString(value.id, 'id')
  const updatedAt = requireString(value.updated_at, 'updated_at')
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new Error(`Некорректная дата updated_at у записи ${id}.`)
  }
  const serverUpdatedAt =
    typeof value.server_updated_at === 'string' &&
    Number.isFinite(Date.parse(value.server_updated_at))
      ? value.server_updated_at
      : updatedAt

  const deleted = value.is_deleted === true
  if (value.is_deleted !== true && value.is_deleted !== false) {
    throw new Error(`Некорректный признак удаления у записи ${id}.`)
  }
  if (deleted) return { id, updatedAt, serverUpdatedAt, deleted }

  let record: SyncRecord | undefined
  switch (entity) {
    case 'ingredients':
      record = {
        id,
        updatedAt,
        name: requireString(value.name, 'name'),
        unit: requireUnit(value.unit),
        purchaseQuantity: requireNumber(value.purchase_quantity, 'purchase_quantity'),
        purchasePrice: requireNumber(value.purchase_price, 'purchase_price'),
        pricePerUnit: requireNumber(value.price_per_unit, 'price_per_unit'),
        hasPrice: requireBoolean(value.has_price, 'has_price'),
        gramsPerMl: optionalPositiveNumber(value.grams_per_ml),
        gramsPerPiece: optionalPositiveNumber(value.grams_per_piece),
      }
      break
    case 'products':
      record = {
        id,
        updatedAt,
        name: requireString(value.name, 'name'),
        description: requireString(value.description, 'description'),
        outputQuantity: requireNumber(value.output_quantity, 'output_quantity'),
        outputUnit: requireUnit(value.output_unit),
        markupType: requireMarkupType(value.markup_type),
        markupValue:
          value.markup_value === undefined || value.markup_value === null
            ? 0
            : requireNumber(value.markup_value, 'markup_value'),
        panDiameterCm: optionalPositiveNumber(value.pan_diameter_cm),
      }
      break
    case 'recipeItems':
      record = {
        id,
        updatedAt,
        productId: requireString(value.product_id, 'product_id'),
        ingredientId: requireString(value.ingredient_id, 'ingredient_id'),
        itemType: value.item_type === 'product' ? 'product' : 'ingredient',
        quantity: requireNumber(value.quantity, 'quantity'),
        quantityUnit: requireUnit(value.quantity_unit),
      }
      break
    case 'directCosts':
      if (
        value.category !== 'labor' &&
        value.category !== 'overhead' &&
        value.category !== 'packaging'
      ) {
        throw new Error(`Некорректная категория прямых затрат у записи ${id}.`)
      }
      record = {
        id,
        updatedAt,
        productId: requireString(value.product_id, 'product_id'),
        name: requireString(value.name, 'name'),
        amount: requireNumber(value.amount, 'amount'),
        category: value.category,
        hours: optionalPositiveNumber(value.hours),
        hourlyRate: optionalNonNegativeNumber(value.hourly_rate),
      }
      break
    default:
      return assertNever(entity)
  }

  if (!record) throw new Error(`Неизвестный тип синхронизируемой записи: ${entity}.`)
  return { id, updatedAt, serverUpdatedAt, deleted, record }
}

async function ensureUpsertQueued(
  entity: SyncEntity,
  record: SyncRecord,
): Promise<void> {
  const pending = await db.syncQueue
    .where('[entity+entityId]')
    .equals([entity, record.id])
    .toArray()
  if (
    pending.some(
      (operation) =>
        operation.operation === 'upsert' &&
        operation.updatedAt === record.updatedAt,
    )
  ) {
    return
  }

  await db.syncQueue.add({
    entity,
    entityId: record.id,
    operation: 'upsert',
    updatedAt: record.updatedAt,
    queuedAt: new Date().toISOString(),
  })
}

async function deletePendingOperations(
  entity: SyncEntity,
  entityId: string,
  updatedAt?: string,
): Promise<void> {
  const pending = await db.syncQueue
    .where('[entity+entityId]')
    .equals([entity, entityId])
    .toArray()
  const staleIds = pending.flatMap((operation) =>
    operation.id !== undefined &&
    (updatedAt === undefined ||
      compareTimestamps(operation.updatedAt, updatedAt) <= 0)
      ? [operation.id]
      : [],
  )
  await db.syncQueue.bulkDelete(staleIds)
}

function compareTimestamps(left: string, right: string): number {
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return 0
  }
  return leftTime - rightTime
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Некорректное поле ${field} в данных синхронизации.`)
  }
  return value
}

function requireNumber(value: unknown, field: string): number {
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    throw new Error(`Некорректное поле ${field} в данных синхронизации.`)
  }
  return num
}

function optionalPositiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num === 'number' && Number.isFinite(num) && num > 0) return num
  return null
}

function optionalNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num === 'number' && Number.isFinite(num) && num >= 0) return num
  return null
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Некорректное поле ${field} в данных синхронизации.`)
  }
  return value
}

function requireUnit(value: unknown): Ingredient['unit'] {
  if (isMeasurementUnit(value)) return value
  throw new Error('Некорректная единица измерения в данных синхронизации.')
}

function requireMarkupType(value: unknown): Product['markupType'] {
  if (value === undefined || value === null) return 'absolute'
  if (
    value === 'absolute' ||
    value === 'percentage' ||
    value === 'margin' ||
    value === 'foodCost'
  ) {
    return value
  }
  return 'absolute'
}

function isIngredient(record: SyncRecord): record is Ingredient {
  return 'pricePerUnit' in record
}

function isProduct(record: SyncRecord): record is Product {
  return 'outputQuantity' in record
}

function isRecipeItem(record: SyncRecord): record is RecipeItem {
  return 'ingredientId' in record
}

function isDirectCost(record: SyncRecord): record is DirectCost {
  return 'category' in record
}

function assertNever(value: never): never {
  throw new Error(`Неизвестная сущность синхронизации: ${String(value)}.`)
}
