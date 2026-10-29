import { db } from './database'
import type {
  DirectCost,
  Ingredient,
  Product,
  RecipeItem,
  SyncEntity,
  SyncOperationType,
} from '../types'
import { compatibleUnits } from '../lib/units'

type NewRecord<T extends { updatedAt: string }> = Omit<T, 'updatedAt'>

export async function listIngredients(): Promise<Ingredient[]> {
  return db.ingredients.orderBy('name').toArray()
}

export async function saveIngredient(
  input: NewRecord<Ingredient>,
): Promise<Ingredient> {
  assertName(input.name, 'ингредиента')
  assertNonNegative(input.pricePerUnit, 'Цена ингредиента')

  return db.transaction(
    'rw',
    db.ingredients,
    db.recipeItems,
    db.syncQueue,
    async () => {
      const previous = await db.ingredients.get(input.id)
      if (previous && previous.unit !== input.unit) {
        const recipeItems = await db.recipeItems
          .where('ingredientId')
          .equals(input.id)
          .toArray()
        const acceptedUnits = compatibleUnits(input.unit)
        if (recipeItems.some((item) => !acceptedUnits.includes(item.quantityUnit))) {
          throw new Error(
            'Нельзя изменить тип единицы: сначала обновите единицы в связанных рецептах.',
          )
        }
      }
      const ingredient = { ...input, updatedAt: nextUpdatedAt(previous?.updatedAt) }
      await db.ingredients.put(ingredient)
      await enqueue('ingredients', ingredient.id, 'upsert', ingredient.updatedAt)
      return ingredient
    },
  )
}

export async function deleteIngredient(id: string): Promise<void> {
  await db.transaction(
    'rw',
    db.ingredients,
    db.recipeItems,
    db.syncQueue,
    async () => {
      const usageCount = await db.recipeItems
        .where('ingredientId')
        .equals(id)
        .count()
      if (usageCount > 0) {
        throw new Error('Сначала удалите ингредиент из всех рецептов.')
      }

      const previous = await db.ingredients.get(id)
      await db.ingredients.delete(id)
      await enqueue('ingredients', id, 'delete', nextUpdatedAt(previous?.updatedAt))
    },
  )
}

export async function listProducts(): Promise<Product[]> {
  return db.products.orderBy('name').toArray()
}

export async function getProduct(id: string): Promise<Product | undefined> {
  return db.products.get(id)
}

export async function saveProduct(input: NewRecord<Product>): Promise<Product> {
  assertName(input.name, 'продукта')
  assertPositive(input.outputQuantity, 'Количество готовой продукции')

  return db.transaction('rw', db.products, db.syncQueue, async () => {
    const previous = await db.products.get(input.id)
    const product = { ...input, updatedAt: nextUpdatedAt(previous?.updatedAt) }
    await db.products.put(product)
    await enqueue('products', product.id, 'upsert', product.updatedAt)
    return product
  })
}

export async function deleteProduct(id: string): Promise<void> {
  await db.transaction(
    'rw',
    db.products,
    db.recipeItems,
    db.directCosts,
    db.syncQueue,
    async () => {
      const recipeItems = await db.recipeItems
        .where('productId')
        .equals(id)
        .toArray()
      const directCosts = await db.directCosts
        .where('productId')
        .equals(id)
        .toArray()
      const previousProduct = await db.products.get(id)

      for (const item of recipeItems) {
        await db.recipeItems.delete(item.id)
        await enqueue(
          'recipeItems',
          item.id,
          'delete',
          nextUpdatedAt(item.updatedAt),
        )
      }
      for (const directCost of directCosts) {
        await db.directCosts.delete(directCost.id)
        await enqueue(
          'directCosts',
          directCost.id,
          'delete',
          nextUpdatedAt(directCost.updatedAt),
        )
      }

      await db.products.delete(id)
      await enqueue('products', id, 'delete', nextUpdatedAt(previousProduct?.updatedAt))
    },
  )
}

export async function listRecipeItems(productId: string): Promise<RecipeItem[]> {
  return db.recipeItems.where('productId').equals(productId).toArray()
}

export async function listAllRecipeItems(): Promise<RecipeItem[]> {
  return db.recipeItems.toArray()
}

export async function saveRecipeItem(
  input: NewRecord<RecipeItem>,
): Promise<RecipeItem> {
  assertNonNegative(input.quantity, 'Количество ингредиента')

  return db.transaction(
    'rw',
    db.recipeItems,
    db.products,
    db.ingredients,
    db.syncQueue,
    async () => {
      const [product, ingredient] = await Promise.all([
        db.products.get(input.productId),
        db.ingredients.get(input.ingredientId),
      ])
      if (!product) throw new Error('Продукт рецепта не найден.')
      if (!ingredient) throw new Error('Ингредиент рецепта не найден.')
      if (!compatibleUnits(ingredient.unit).includes(input.quantityUnit)) {
        throw new Error('Единица количества должна совпадать с типом единицы ингредиента.')
      }

      const previous = await db.recipeItems.get(input.id)
      const item = { ...input, updatedAt: nextUpdatedAt(previous?.updatedAt) }
      await db.recipeItems.put(item)
      await enqueue('recipeItems', item.id, 'upsert', item.updatedAt)
      return item
    },
  )
}

export async function deleteRecipeItem(id: string): Promise<void> {
  await db.transaction('rw', db.recipeItems, db.syncQueue, async () => {
    const previous = await db.recipeItems.get(id)
    await db.recipeItems.delete(id)
    await enqueue('recipeItems', id, 'delete', nextUpdatedAt(previous?.updatedAt))
  })
}

export async function listDirectCosts(productId: string): Promise<DirectCost[]> {
  return db.directCosts.where('productId').equals(productId).toArray()
}

export async function listAllDirectCosts(): Promise<DirectCost[]> {
  return db.directCosts.toArray()
}

export async function saveDirectCost(
  input: NewRecord<DirectCost>,
): Promise<DirectCost> {
  assertName(input.name, 'затраты')
  assertNonNegative(input.amount, 'Сумма прямых затрат')

  return db.transaction(
    'rw',
    db.directCosts,
    db.products,
    db.syncQueue,
    async () => {
      if (!(await db.products.get(input.productId))) {
        throw new Error('Продукт для прямых затрат не найден.')
      }

      const previous = await db.directCosts.get(input.id)
      const directCost = { ...input, updatedAt: nextUpdatedAt(previous?.updatedAt) }
      await db.directCosts.put(directCost)
      await enqueue('directCosts', directCost.id, 'upsert', directCost.updatedAt)
      return directCost
    },
  )
}

export async function deleteDirectCost(id: string): Promise<void> {
  await db.transaction('rw', db.directCosts, db.syncQueue, async () => {
    const previous = await db.directCosts.get(id)
    await db.directCosts.delete(id)
    await enqueue('directCosts', id, 'delete', nextUpdatedAt(previous?.updatedAt))
  })
}

async function enqueue(
  entity: SyncEntity,
  entityId: string,
  operation: SyncOperationType,
  updatedAt: string,
): Promise<void> {
  await db.syncQueue.add({
    entity,
    entityId,
    operation,
    updatedAt,
    queuedAt: now(),
  })
}

function assertName(value: string, label: string): void {
  if (!value.trim()) throw new Error(`Укажите название: ${label}.`)
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} должно быть неотрицательным числом.`)
  }
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} должно быть больше нуля.`)
  }
}

function nextUpdatedAt(previous?: string): string {
  const previousTime = previous ? Date.parse(previous) : 0
  if (previous && !Number.isFinite(previousTime)) {
    throw new Error('У записи некорректная дата updatedAt.')
  }

  return new Date(Math.max(Date.now(), previousTime + 1)).toISOString()
}

function now(): string {
  return new Date().toISOString()
}
