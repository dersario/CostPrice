import { db } from './database'
import type {
  DirectCost,
  Ingredient,
  Product,
  RecipeItem,
  SyncEntity,
  SyncOperationType,
} from '../types'
import { createId } from '../lib/id'
import { compatibleUnits, convertQuantity } from '../lib/units'

type NewRecord<T extends { updatedAt: string }> = Omit<T, 'updatedAt'>

export interface RecipeLineInput {
  id: string
  ingredientName: string
  quantity: number
  quantityUnit: RecipeItem['quantityUnit']
  pricePerUnit: number | null
}

export async function listIngredients(): Promise<Ingredient[]> {
  return db.ingredients.orderBy('name').toArray()
}

export async function saveIngredient(
  input: NewRecord<Ingredient>,
): Promise<Ingredient> {
  assertName(input.name, 'продукта')
  const purchaseQuantity = input.hasPrice ? input.purchaseQuantity : 1
  const purchasePrice = input.hasPrice ? input.purchasePrice : 0
  if (input.hasPrice) assertPositive(purchaseQuantity, 'Количество продукта')
  assertNonNegative(purchasePrice, 'Цена продукта')
  const pricePerUnit = purchasePrice / purchaseQuantity
  assertNonNegative(pricePerUnit, 'Цена за единицу продукта')

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
            'Нельзя изменить тип единицы продукта: сначала обновите единицы в связанных рецептах.',
          )
        }
      }
      const ingredient = {
        ...input,
        purchaseQuantity,
        purchasePrice,
        pricePerUnit,
        updatedAt: nextUpdatedAt(previous?.updatedAt),
      }
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
        throw new Error('Сначала удалите продукт из всех рецептов.')
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
  validateMarkup(input.markupType, input.markupValue)

  return db.transaction('rw', db.products, db.syncQueue, async () => {
    const previous = await db.products.get(input.id)
    const product = { ...input, updatedAt: nextUpdatedAt(previous?.updatedAt) }
    await db.products.put(product)
    await enqueue('products', product.id, 'upsert', product.updatedAt)
    return product
  })
}

export async function createProductWithRecipe(
  input: NewRecord<Product>,
  recipeItems: RecipeLineInput[],
): Promise<Product> {
  assertName(input.name, 'продукта')
  assertPositive(input.outputQuantity, 'Количество готовой продукции')
  validateMarkup(input.markupType, input.markupValue)
  for (const item of recipeItems) {
    validateRecipeLine(item)
  }

  return db.transaction(
    'rw',
    db.products,
    db.ingredients,
    db.recipeItems,
    db.syncQueue,
    async () => {
      const product = { ...input, updatedAt: nextUpdatedAt() }
      await db.products.add(product)
      await enqueue('products', product.id, 'upsert', product.updatedAt)

      const ingredients = await db.ingredients.toArray()
      for (const draft of recipeItems) {
        const ingredient = await findOrCreateIngredient(
          draft.ingredientName,
          draft.quantityUnit,
          draft.pricePerUnit,
          ingredients,
        )
        const item: RecipeItem = {
          id: draft.id,
          productId: product.id,
          ingredientId: ingredient.id,
          quantity: draft.quantity,
          quantityUnit: draft.quantityUnit,
          updatedAt: now(),
        }
        await db.recipeItems.add(item)
        await enqueue('recipeItems', item.id, 'upsert', item.updatedAt)
      }

      return product
    },
  )
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
  input: RecipeLineInput & Pick<RecipeItem, 'productId'>,
): Promise<RecipeItem> {
  validateRecipeLine(input)

  return db.transaction(
    'rw',
    db.recipeItems,
    db.products,
    db.ingredients,
    db.syncQueue,
    async () => {
      const product = await db.products.get(input.productId)
      if (!product) throw new Error('Продукт рецепта не найден.')
      const previous = await db.recipeItems.get(input.id)
      if (previous && previous.productId !== input.productId) {
        throw new Error('Строка рецепта не принадлежит этому продукту.')
      }
      const ingredients = await db.ingredients.toArray()
      const ingredient = await findOrCreateIngredient(
        input.ingredientName,
        input.quantityUnit,
        input.pricePerUnit,
        ingredients,
      )
      const item: RecipeItem = {
        id: input.id,
        productId: input.productId,
        ingredientId: ingredient.id,
        quantity: input.quantity,
        quantityUnit: input.quantityUnit,
        updatedAt: nextUpdatedAt(previous?.updatedAt),
      }
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

function validateMarkup(type: Product['markupType'], value: number): void {
  if (type !== 'absolute' && type !== 'percentage') {
    throw new Error('Выберите тип наценки.')
  }
  assertNonNegative(value, 'Наценка')
}

function validateRecipeLine(input: RecipeLineInput): void {
  assertName(input.ingredientName, 'продукта в рецепте')
  assertNonNegative(input.quantity, 'Количество продукта')
  if (input.pricePerUnit !== null) {
    assertNonNegative(input.pricePerUnit, 'Цена продукта')
  }
}

async function findOrCreateIngredient(
  name: string,
  unit: Ingredient['unit'],
  pricePerUnit: number | null,
  ingredients: Ingredient[],
): Promise<Ingredient> {
  const normalizedName = name.trim().toLocaleLowerCase()
  const existing = ingredients.find(
    (ingredient) => ingredient.name.trim().toLocaleLowerCase() === normalizedName,
  )

  if (!existing) {
    const now = new Date().toISOString()
    const ingredient: Ingredient = {
      id: createId(),
      name: name.trim(),
      unit,
      purchaseQuantity: 1,
      purchasePrice: pricePerUnit ?? 0,
      pricePerUnit: pricePerUnit ?? 0,
      hasPrice: pricePerUnit !== null,
      updatedAt: now,
    }
    await db.ingredients.add(ingredient)
    await enqueue('ingredients', ingredient.id, 'upsert', ingredient.updatedAt)
    ingredients.push(ingredient)
    return ingredient
  }

  if (!compatibleUnits(existing.unit).includes(unit)) {
    throw new Error(
      `Единица «${unit}» не подходит продукту «${existing.name}». Измените единицу в строке рецепта.`,
    )
  }

  if (pricePerUnit !== null) {
    const priceInStoredUnit =
      pricePerUnit / convertQuantity(1, unit, existing.unit)
    const updated: Ingredient = {
      ...existing,
      purchaseQuantity: 1,
      purchasePrice: priceInStoredUnit,
      pricePerUnit: priceInStoredUnit,
      hasPrice: true,
      updatedAt: nextUpdatedAt(existing.updatedAt),
    }
    await db.ingredients.put(updated)
    await enqueue('ingredients', updated.id, 'upsert', updated.updatedAt)
    Object.assign(existing, updated)
    return existing
  }

  return existing
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
