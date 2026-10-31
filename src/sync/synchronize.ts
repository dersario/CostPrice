import { db } from '../db/database'
import { compatibleUnits, isMeasurementUnit } from '../lib/units'
import type {
  DirectCost,
  Ingredient,
  Product,
  RecipeItem,
  SyncEntity,
  SyncOperation,
} from '../types'
import { getSupabaseClient } from './client'
import { getWorkspaceId } from './workspace'

type SyncRecord = Ingredient | Product | RecipeItem | DirectCost
type RemoteRow = Record<string, unknown>

interface RemoteEntry {
  id: string
  updatedAt: string
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
const REMOTE_PAGE_SIZE = 500

export async function synchronizeNow(): Promise<SyncResult> {
  if (!navigator.onLine) {
    throw new Error('Нет подключения к интернету. Изменения останутся в очереди.')
  }

  const workspaceId = await getWorkspaceId()
  const client = getSupabaseClient()
  const pulled = await pullRemoteChanges(client, workspaceId)
  const pushed = await pushPendingChanges(client, workspaceId)
  await pullRemoteChanges(client, workspaceId)
  const queued = await db.syncQueue.count()

  return {
    pushed,
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
  client: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
): Promise<number> {
  let applied = 0

  for (const entity of Object.keys(remoteTables) as SyncEntity[]) {
    const rows = await fetchRemoteRows(client, entity, workspaceId)
    const pending = await db.syncQueue.toArray()
    const latestPending = getLatestOperations(pending, entity)
    for (const value of rows) {
      const remote = decodeRemoteRow(entity, value)
      const local = await getLocalRecord(entity, remote.id)
      const operation = latestPending.get(remote.id)

      if (!local && operation?.operation === 'delete') {
        if (compareTimestamps(operation.updatedAt, remote.updatedAt) > 0) {
          continue
        }
        await deletePendingOperations(entity, remote.id)
      }

      if (!local) {
        if (!remote.deleted && remote.record) {
          await putLocalRecord(entity, remote.record)
          applied += 1
        }
        continue
      }

      // The newest updatedAt wins; equal timestamps resolve consistently in favor of remote.
      if (compareTimestamps(remote.updatedAt, local.updatedAt) >= 0) {
        if (remote.deleted) {
          await deleteLocalRecord(entity, remote.id)
        } else if (remote.record) {
          await putLocalRecord(entity, remote.record)
        }
        await deletePendingOperations(entity, remote.id, remote.updatedAt)
        applied += 1
      } else {
        await ensureUpsertQueued(entity, local)
      }
    }
  }

  return applied
}

async function fetchRemoteRows(
  client: ReturnType<typeof getSupabaseClient>,
  entity: SyncEntity,
  workspaceId: string,
): Promise<RemoteRow[]> {
  const rows: RemoteRow[] = []
  let offset = 0

  while (true) {
    const { data, error } = await client
      .from(remoteTables[entity])
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('id', { ascending: true })
      .range(offset, offset + REMOTE_PAGE_SIZE - 1)
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
  client: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
): Promise<number> {
  const queuedOperations = await db.syncQueue.toArray()
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
  for (const [entity, byId] of byEntity) {
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

    const { error } = await client
      .from(remoteTables[entity])
      .upsert(rows, { onConflict: 'workspace_id,id' })
    if (error) {
      throw new Error(formatRemoteError('отправить', remoteTables[entity], error))
    }

    await db.syncQueue.bulkDelete(acknowledgedOperationIds)
    pushed += acknowledgedOperationIds.length
  }

  return pushed
}

function formatRemoteError(
  action: 'загрузить' | 'отправить',
  table: string,
  error: { code?: string; message: string },
): string {
  if (error.code === 'PGRST205') {
    return `Таблица public.${table} не найдена в Supabase или кэш схемы устарел. Выполните supabase/schema.sql в SQL Editor проекта. Если таблица уже создана, обновите кэш командой NOTIFY pgrst, 'reload schema'; затем повторите синхронизацию.`
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
      if (!isIngredient(record)) throw new Error('Неверные данные ингредиента.')
      const recipeItems = await db.recipeItems
        .where('ingredientId')
        .equals(record.id)
        .toArray()
      if (
        recipeItems.some(
          (item) => !compatibleUnits(record.unit).includes(item.quantityUnit),
        )
      ) {
        throw new Error(
          `Обновление ингредиента «${record.name}» конфликтует с единицами в рецептах.`,
        )
      }
      await db.ingredients.put(record)
      return
    }
    case 'products':
      if (!isProduct(record)) throw new Error('Неверные данные продукта.')
      await db.products.put(record)
      return
    case 'recipeItems': {
      if (!isRecipeItem(record)) throw new Error('Неверные данные строки рецепта.')
      const [product, ingredient] = await Promise.all([
        db.products.get(record.productId),
        db.ingredients.get(record.ingredientId),
      ])
      if (!product) throw new Error(`Не найден продукт для строки рецепта ${record.id}.`)
      if (!ingredient) {
        throw new Error(`Не найден ингредиент для строки рецепта ${record.id}.`)
      }
      if (!compatibleUnits(ingredient.unit).includes(record.quantityUnit)) {
        throw new Error(`В строке рецепта ${record.id} несовместимая единица количества.`)
      }
      await db.recipeItems.put(record)
      return
    }
    case 'directCosts': {
      if (!isDirectCost(record)) throw new Error('Неверные данные прямых затрат.')
      if (!(await db.products.get(record.productId))) {
        throw new Error(`Не найден продукт для прямых затрат ${record.id}.`)
      }
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
    updated_at: record.updatedAt,
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
      }
    case 'products':
      if (!isProduct(record)) throw new Error('Неверные данные продукта.')
      return {
        ...common,
        name: record.name,
        description: record.description,
        output_quantity: record.outputQuantity,
        output_unit: record.outputUnit,
        markup_type: record.markupType,
        markup_value: record.markupValue,
      }
    case 'recipeItems':
      if (!isRecipeItem(record)) throw new Error('Неверные данные строки рецепта.')
      return {
        ...common,
        product_id: record.productId,
        ingredient_id: record.ingredientId,
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
    updated_at: updatedAt,
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
      }
    case 'recipeItems':
      return {
        ...common,
        product_id: null,
        ingredient_id: null,
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
      }
    default:
      return assertNever(entity)
  }
}

function decodeRemoteRow(entity: SyncEntity, value: RemoteRow): RemoteEntry {
  const id = requireString(value.id, 'id')
  const updatedAt = requireString(value.updated_at, 'updated_at')
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new Error(`Некорректная дата updated_at у записи ${id}.`)
  }

  const deleted = value.is_deleted === true
  if (value.is_deleted !== true && value.is_deleted !== false) {
    throw new Error(`Некорректный признак удаления у записи ${id}.`)
  }
  if (deleted) return { id, updatedAt, deleted }

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
          value.markup_value === undefined
            ? 0
            : requireNumber(value.markup_value, 'markup_value'),
      }
      break
    case 'recipeItems':
      record = {
        id,
        updatedAt,
        productId: requireString(value.product_id, 'product_id'),
        ingredientId: requireString(value.ingredient_id, 'ingredient_id'),
        quantity: requireNumber(value.quantity, 'quantity'),
        quantityUnit: requireUnit(value.quantity_unit),
      }
      break
    case 'directCosts':
      if (value.category !== 'labor' && value.category !== 'overhead') {
        throw new Error(`Некорректная категория прямых затрат у записи ${id}.`)
      }
      record = {
        id,
        updatedAt,
        productId: requireString(value.product_id, 'product_id'),
        name: requireString(value.name, 'name'),
        amount: requireNumber(value.amount, 'amount'),
        category: value.category,
      }
      break
    default:
      return assertNever(entity)
  }

  if (!record) throw new Error(`Неизвестный тип синхронизируемой записи: ${entity}.`)
  return { id, updatedAt, deleted, record }
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
    throw new Error('Невозможно разрешить конфликт: некорректная дата updatedAt.')
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
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Некорректное поле ${field} в данных синхронизации.`)
  }
  return value
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
  if (value === 'absolute' || value === 'percentage') return value
  throw new Error('Некорректный тип наценки в данных синхронизации.')
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
