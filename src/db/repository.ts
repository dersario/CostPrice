import { db } from './database'
import type {
  DirectCost,
  Ingredient,
  MeasurementUnit,
  Product,
  RecipeItem,
  RecipeItemType,
  SyncEntity,
  SyncOperationType,
} from '../types'
import { createId } from '../lib/id'
import { compatibleUnits, convertQuantity, unitLabels } from '../lib/units'

type NewRecord<T extends { updatedAt: string }> = Omit<T, 'updatedAt'>

export interface RecipeLineInput {
  id: string
  itemType?: RecipeItemType
  /** For itemType === 'product', the target sub-recipe Product ID. */
  subProductId?: string
  /** For itemType === 'ingredient', the ingredient name. */
  ingredientName: string
  quantity: number
  quantityUnit: RecipeItem['quantityUnit']
  pricePerUnit: number | null
  priceUnit?: MeasurementUnit
}

type ChangeListener = () => void
const changeListeners = new Set<ChangeListener>()

export function subscribeToDataChanges(listener: ChangeListener): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function notifyDataChanged(): void {
  for (const listener of changeListeners) {
    try {
      listener()
    } catch {
      // Ignore listener errors so other subscribers still run.
    }
  }
}

export async function listIngredients(): Promise<Ingredient[]> {
  return db.ingredients.orderBy('name').toArray()
}

export async function saveIngredient(
  input: NewRecord<Ingredient>,
): Promise<Ingredient> {
  assertName(input.name, 'ингредиента')
  const purchaseQuantity = input.hasPrice ? input.purchaseQuantity : 1
  const purchasePrice = input.hasPrice ? input.purchasePrice : 0
  if (input.hasPrice) assertPositive(purchaseQuantity, 'Количество ингредиента')
  assertNonNegative(purchasePrice, 'Цена ингредиента')
  const pricePerUnit = purchasePrice / purchaseQuantity
  assertNonNegative(pricePerUnit, 'Цена за единицу ингредиента')

  const gramsPerMl = normalizeOptionalPositive(
    input.gramsPerMl,
    'Плотность (г в 1 мл)',
  )
  const gramsPerPiece = normalizeOptionalPositive(
    input.gramsPerPiece,
    'Вес 1 шт. (г)',
  )

  const saved = await db.transaction(
    'rw',
    db.ingredients,
    db.recipeItems,
    db.syncQueue,
    async () => {
      const normalizedName = input.name.trim().toLocaleLowerCase()
      const allIngredients = await db.ingredients.toArray()
      const duplicate = allIngredients.find(
        (entry) =>
          entry.id !== input.id &&
          entry.name.trim().toLocaleLowerCase() === normalizedName,
      )
      if (duplicate) {
        throw new Error(
          `Ингредиент с названием «${duplicate.name}» уже существует.`,
        )
      }

      const previous = await db.ingredients.get(input.id)
      const bridge = { gramsPerMl, gramsPerPiece }
      const acceptedUnits = compatibleUnits(input.unit, bridge)

      if (previous) {
        const recipeItems = await db.recipeItems
          .where('ingredientId')
          .equals(input.id)
          .toArray()
        if (
          recipeItems.some(
            (item) =>
              (item.itemType ?? 'ingredient') === 'ingredient' &&
              !acceptedUnits.includes(item.quantityUnit),
          )
        ) {
          throw new Error(
            'Нельзя изменить единицу или параметры перевода ингредиента: сначала обновите единицы в связанных рецептах или укажите плотность/вес 1 шт.',
          )
        }
      }
      const ingredient: Ingredient = {
        ...input,
        name: input.name.trim(),
        purchaseQuantity,
        purchasePrice,
        pricePerUnit,
        gramsPerMl,
        gramsPerPiece,
        updatedAt: nextUpdatedAt(previous?.updatedAt),
      }
      await db.ingredients.put(ingredient)
      await enqueue('ingredients', ingredient.id, 'upsert', ingredient.updatedAt)
      return ingredient
    },
  )

  notifyDataChanged()
  return saved
}

export async function deleteIngredient(id: string): Promise<void> {
  await db.transaction(
    'rw',
    db.ingredients,
    db.recipeItems,
    db.syncQueue,
    async () => {
      const linked = await db.recipeItems
        .where('ingredientId')
        .equals(id)
        .toArray()
      const usageCount = linked.filter(
        (item) => (item.itemType ?? 'ingredient') === 'ingredient',
      ).length
      if (usageCount > 0) {
        throw new Error('Сначала удалите ингредиент из всех рецептов.')
      }

      const previous = await db.ingredients.get(id)
      await db.ingredients.delete(id)
      await enqueue('ingredients', id, 'delete', nextUpdatedAt(previous?.updatedAt))
    },
  )
  notifyDataChanged()
}

export async function listProducts(): Promise<Product[]> {
  return db.products.orderBy('name').toArray()
}

export async function getProduct(id: string): Promise<Product | undefined> {
  return db.products.get(id)
}

export async function saveProduct(input: NewRecord<Product>): Promise<Product> {
  assertName(input.name, 'рецепта')
  assertPositive(input.outputQuantity, 'Количество готовой продукции')
  validateMarkup(input.markupType, input.markupValue)
  const panDiameterCm = normalizeOptionalPositive(
    input.panDiameterCm,
    'Диаметр формы (см)',
  )

  const saved = await db.transaction(
    'rw',
    db.products,
    db.recipeItems,
    db.syncQueue,
    async () => {
      const previous = await db.products.get(input.id)
      if (previous && previous.outputUnit !== input.outputUnit) {
        const parentRecipeLinks = await db.recipeItems
          .where('ingredientId')
          .equals(input.id)
          .toArray()
        const acceptedUnits = compatibleUnits(input.outputUnit)
        if (
          parentRecipeLinks.some(
            (item) =>
              item.itemType === 'product' &&
              !acceptedUnits.includes(item.quantityUnit),
          )
        ) {
          throw new Error(
            'Нельзя изменить тип единицы выхода рецепта: этот полуфабрикат используется в других рецептах с другой размерностью.',
          )
        }
      }
      const product: Product = {
        ...input,
        name: input.name.trim(),
        description: input.description.trim(),
        panDiameterCm,
        updatedAt: nextUpdatedAt(previous?.updatedAt),
      }
      await db.products.put(product)
      await enqueue('products', product.id, 'upsert', product.updatedAt)
      return product
    },
  )

  notifyDataChanged()
  return saved
}

export async function createProductWithRecipe(
  input: NewRecord<Product>,
  recipeItems: RecipeLineInput[],
): Promise<Product> {
  assertName(input.name, 'рецепта')
  assertPositive(input.outputQuantity, 'Количество готовой продукции')
  validateMarkup(input.markupType, input.markupValue)
  const panDiameterCm = normalizeOptionalPositive(
    input.panDiameterCm,
    'Диаметр формы (см)',
  )
  for (const item of recipeItems) {
    validateRecipeLine(item)
  }

  const created = await db.transaction(
    'rw',
    db.products,
    db.ingredients,
    db.recipeItems,
    db.syncQueue,
    async () => {
      const product: Product = {
        ...input,
        name: input.name.trim(),
        description: input.description.trim(),
        panDiameterCm,
        updatedAt: nextUpdatedAt(),
      }
      await db.products.add(product)
      await enqueue('products', product.id, 'upsert', product.updatedAt)

      const ingredients = await db.ingredients.toArray()
      const allProducts = await db.products.toArray()
      const allRecipeItems = await db.recipeItems.toArray()

      for (const draft of recipeItems) {
        const itemType: RecipeItemType = draft.itemType ?? 'ingredient'
        if (itemType === 'product') {
          const subProduct = allProducts.find(
            (entry) => entry.id === draft.subProductId,
          )
          if (!subProduct) {
            throw new Error('Выбранный полуфабрикат не найден.')
          }
          if (subProduct.id === product.id) {
            throw new Error('Рецепт не может включать сам себя.')
          }
          if (
            wouldCreateProductCycle(
              product.id,
              subProduct.id,
              allRecipeItems,
            )
          ) {
            throw new Error(
              `Нельзя добавить «${subProduct.name}»: возникнет циклическая ссылка рецептов.`,
            )
          }
          if (!compatibleUnits(subProduct.outputUnit).includes(draft.quantityUnit)) {
            throw new Error(
              `Единица «${unitLabels[draft.quantityUnit]}» не подходит полуфабрикату «${subProduct.name}» (${unitLabels[subProduct.outputUnit]}).`,
            )
          }
          const item: RecipeItem = {
            id: draft.id,
            productId: product.id,
            ingredientId: subProduct.id,
            itemType: 'product',
            quantity: draft.quantity,
            quantityUnit: draft.quantityUnit,
            updatedAt: now(),
          }
          await db.recipeItems.add(item)
          await enqueue('recipeItems', item.id, 'upsert', item.updatedAt)
          allRecipeItems.push(item)
        } else {
          const ingredient = await findOrCreateIngredient(
            draft.ingredientName,
            draft.quantityUnit,
            draft.pricePerUnit,
            draft.priceUnit ?? draft.quantityUnit,
            ingredients,
          )
          const item: RecipeItem = {
            id: draft.id,
            productId: product.id,
            ingredientId: ingredient.id,
            itemType: 'ingredient',
            quantity: draft.quantity,
            quantityUnit: draft.quantityUnit,
            updatedAt: now(),
          }
          await db.recipeItems.add(item)
          await enqueue('recipeItems', item.id, 'upsert', item.updatedAt)
          allRecipeItems.push(item)
        }
      }

      return product
    },
  )

  notifyDataChanged()
  return created
}

export async function deleteProduct(id: string): Promise<void> {
  await db.transaction(
    'rw',
    db.products,
    db.recipeItems,
    db.directCosts,
    db.syncQueue,
    async () => {
      const usedAsSubrecipe = await db.recipeItems
        .where('ingredientId')
        .equals(id)
        .toArray()
      if (usedAsSubrecipe.some((item) => item.itemType === 'product')) {
        throw new Error(
          'Сначала удалите этот рецепт (полуфабрикат) из других рецептов, где он используется.',
        )
      }

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

  notifyDataChanged()
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

  const saved = await db.transaction(
    'rw',
    db.recipeItems,
    db.products,
    db.ingredients,
    db.syncQueue,
    async () => {
      const product = await db.products.get(input.productId)
      if (!product) throw new Error('Рецепт не найден.')
      const previous = await db.recipeItems.get(input.id)
      if (previous && previous.productId !== input.productId) {
        throw new Error('Строка рецепта не принадлежит этому рецепту.')
      }

      const itemType: RecipeItemType = input.itemType ?? 'ingredient'
      if (itemType === 'product') {
        if (!input.subProductId) {
          throw new Error('Выберите полуфабрикат.')
        }
        const subProduct = await db.products.get(input.subProductId)
        if (!subProduct) {
          throw new Error('Выбранный полуфабрикат не найден.')
        }
        if (subProduct.id === input.productId) {
          throw new Error('Рецепт не может включать сам себя.')
        }
        const allRecipeItems = (await db.recipeItems.toArray()).filter(
          (entry) => entry.id !== input.id,
        )
        if (
          wouldCreateProductCycle(
            input.productId,
            subProduct.id,
            allRecipeItems,
          )
        ) {
          throw new Error(
            `Нельзя добавить «${subProduct.name}»: возникнет циклическая ссылка рецептов.`,
          )
        }
        if (!compatibleUnits(subProduct.outputUnit).includes(input.quantityUnit)) {
          throw new Error(
            `Единица «${unitLabels[input.quantityUnit]}» не подходит полуфабрикату «${subProduct.name}» (${unitLabels[subProduct.outputUnit]}).`,
          )
        }
        const item: RecipeItem = {
          id: input.id,
          productId: input.productId,
          ingredientId: subProduct.id,
          itemType: 'product',
          quantity: input.quantity,
          quantityUnit: input.quantityUnit,
          updatedAt: nextUpdatedAt(previous?.updatedAt),
        }
        await db.recipeItems.put(item)
        await enqueue('recipeItems', item.id, 'upsert', item.updatedAt)
        return item
      }

      const ingredients = await db.ingredients.toArray()
      const ingredient = await findOrCreateIngredient(
        input.ingredientName,
        input.quantityUnit,
        input.pricePerUnit,
        input.priceUnit ?? input.quantityUnit,
        ingredients,
      )
      const item: RecipeItem = {
        id: input.id,
        productId: input.productId,
        ingredientId: ingredient.id,
        itemType: 'ingredient',
        quantity: input.quantity,
        quantityUnit: input.quantityUnit,
        updatedAt: nextUpdatedAt(previous?.updatedAt),
      }
      await db.recipeItems.put(item)
      await enqueue('recipeItems', item.id, 'upsert', item.updatedAt)
      return item
    },
  )

  notifyDataChanged()
  return saved
}

export async function deleteRecipeItem(id: string): Promise<void> {
  await db.transaction('rw', db.recipeItems, db.syncQueue, async () => {
    const previous = await db.recipeItems.get(id)
    await db.recipeItems.delete(id)
    await enqueue('recipeItems', id, 'delete', nextUpdatedAt(previous?.updatedAt))
  })
  notifyDataChanged()
}

export async function scaleProductRecipeInPlace(
  productId: string,
  multiplier: number,
  nextPanDiameterCm?: number | null,
): Promise<void> {
  assertPositive(multiplier, 'Коэффициент масштабирования')

  await db.transaction(
    'rw',
    db.products,
    db.recipeItems,
    db.directCosts,
    db.syncQueue,
    async () => {
      const product = await db.products.get(productId)
      if (!product) throw new Error('Рецепт не найден.')

      const items = await db.recipeItems
        .where('productId')
        .equals(productId)
        .toArray()
      const costs = await db.directCosts
        .where('productId')
        .equals(productId)
        .toArray()

      const updatedProduct: Product = {
        ...product,
        outputQuantity: roundQuantity(product.outputQuantity * multiplier),
        panDiameterCm:
          nextPanDiameterCm !== undefined
            ? nextPanDiameterCm
            : product.panDiameterCm,
        updatedAt: nextUpdatedAt(product.updatedAt),
      }
      await db.products.put(updatedProduct)
      await enqueue('products', updatedProduct.id, 'upsert', updatedProduct.updatedAt)

      for (const item of items) {
        const updatedItem: RecipeItem = {
          ...item,
          quantity: roundQuantity(item.quantity * multiplier),
          updatedAt: nextUpdatedAt(item.updatedAt),
        }
        await db.recipeItems.put(updatedItem)
        await enqueue('recipeItems', updatedItem.id, 'upsert', updatedItem.updatedAt)
      }

      for (const cost of costs) {
        if (cost.category === 'packaging') {
          const updatedCost: DirectCost = {
            ...cost,
            amount: roundQuantity(cost.amount * multiplier),
            updatedAt: nextUpdatedAt(cost.updatedAt),
          }
          await db.directCosts.put(updatedCost)
          await enqueue('directCosts', updatedCost.id, 'upsert', updatedCost.updatedAt)
        }
      }
    },
  )

  notifyDataChanged()
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
  const hours = normalizeOptionalPositive(input.hours, 'Часы работы')
  const hourlyRate = normalizeOptionalNonNegative(
    input.hourlyRate,
    'Ставка в час',
  )

  const saved = await db.transaction(
    'rw',
    db.directCosts,
    db.products,
    db.syncQueue,
    async () => {
      if (!(await db.products.get(input.productId))) {
        throw new Error('Рецепт для прямых затрат не найден.')
      }

      const previous = await db.directCosts.get(input.id)
      const directCost: DirectCost = {
        ...input,
        name: input.name.trim(),
        hours,
        hourlyRate,
        updatedAt: nextUpdatedAt(previous?.updatedAt),
      }
      await db.directCosts.put(directCost)
      await enqueue('directCosts', directCost.id, 'upsert', directCost.updatedAt)
      return directCost
    },
  )

  notifyDataChanged()
  return saved
}

export async function deleteDirectCost(id: string): Promise<void> {
  await db.transaction('rw', db.directCosts, db.syncQueue, async () => {
    const previous = await db.directCosts.get(id)
    await db.directCosts.delete(id)
    await enqueue('directCosts', id, 'delete', nextUpdatedAt(previous?.updatedAt))
  })
  notifyDataChanged()
}

export async function enqueueAllLocalRecordsForSync(): Promise<void> {
  await db.transaction(
    'rw',
    db.ingredients,
    db.products,
    db.recipeItems,
    db.directCosts,
    db.syncQueue,
    async () => {
      const [ingredients, products, recipeItems, directCosts] = await Promise.all([
        db.ingredients.toArray(),
        db.products.toArray(),
        db.recipeItems.toArray(),
        db.directCosts.toArray(),
      ])
      for (const item of ingredients) {
        await enqueue('ingredients', item.id, 'upsert', item.updatedAt)
      }
      for (const item of products) {
        await enqueue('products', item.id, 'upsert', item.updatedAt)
      }
      for (const item of recipeItems) {
        await enqueue('recipeItems', item.id, 'upsert', item.updatedAt)
      }
      for (const item of directCosts) {
        await enqueue('directCosts', item.id, 'upsert', item.updatedAt)
      }
    },
  )
}

export interface BackupPayload {
  version: 1
  exportedAt: string
  ingredients: Ingredient[]
  products: Product[]
  recipeItems: RecipeItem[]
  directCosts: DirectCost[]
}

export async function exportDatabaseBackup(): Promise<BackupPayload> {
  const [ingredients, products, recipeItems, directCosts] = await Promise.all([
    db.ingredients.toArray(),
    db.products.toArray(),
    db.recipeItems.toArray(),
    db.directCosts.toArray(),
  ])
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    ingredients,
    products,
    recipeItems,
    directCosts,
  }
}

export async function importDatabaseBackup(
  payload: BackupPayload,
  mode: 'merge' | 'replace' = 'merge',
): Promise<{ ingredients: number; products: number }> {
  if (
    !payload ||
    !Array.isArray(payload.ingredients) ||
    !Array.isArray(payload.products) ||
    !Array.isArray(payload.recipeItems) ||
    !Array.isArray(payload.directCosts)
  ) {
    throw new Error('Некорректный формат файла резервной копии.')
  }

  await db.transaction(
    'rw',
    db.ingredients,
    db.products,
    db.recipeItems,
    db.directCosts,
    db.syncQueue,
    async () => {
      if (mode === 'replace') {
        await Promise.all([
          db.directCosts.clear(),
          db.recipeItems.clear(),
          db.products.clear(),
          db.ingredients.clear(),
          db.syncQueue.clear(),
        ])
      }

      for (const ingredient of payload.ingredients) {
        if (!ingredient?.id || !ingredient?.name) continue
        const normalized: Ingredient = {
          id: String(ingredient.id),
          name: String(ingredient.name).trim(),
          unit: ingredient.unit,
          purchaseQuantity: Number(ingredient.purchaseQuantity) || 1,
          purchasePrice: Number(ingredient.purchasePrice) || 0,
          pricePerUnit: Number(ingredient.pricePerUnit) || 0,
          hasPrice: Boolean(ingredient.hasPrice),
          gramsPerMl: ingredient.gramsPerMl ?? null,
          gramsPerPiece: ingredient.gramsPerPiece ?? null,
          updatedAt: ingredient.updatedAt || now(),
        }
        await db.ingredients.put(normalized)
        await enqueue('ingredients', normalized.id, 'upsert', normalized.updatedAt)
      }

      for (const product of payload.products) {
        if (!product?.id || !product?.name) continue
        const normalized: Product = {
          id: String(product.id),
          name: String(product.name).trim(),
          description: String(product.description ?? ''),
          outputQuantity: Number(product.outputQuantity) || 1,
          outputUnit: product.outputUnit,
          markupType: product.markupType ?? 'absolute',
          markupValue: Number(product.markupValue) || 0,
          panDiameterCm: product.panDiameterCm ?? null,
          updatedAt: product.updatedAt || now(),
        }
        await db.products.put(normalized)
        await enqueue('products', normalized.id, 'upsert', normalized.updatedAt)
      }

      for (const item of payload.recipeItems) {
        if (!item?.id || !item?.productId || !item?.ingredientId) continue
        const normalized: RecipeItem = {
          id: String(item.id),
          productId: String(item.productId),
          ingredientId: String(item.ingredientId),
          itemType: item.itemType ?? 'ingredient',
          quantity: Number(item.quantity) || 0,
          quantityUnit: item.quantityUnit,
          updatedAt: item.updatedAt || now(),
        }
        await db.recipeItems.put(normalized)
        await enqueue('recipeItems', normalized.id, 'upsert', normalized.updatedAt)
      }

      for (const cost of payload.directCosts) {
        if (!cost?.id || !cost?.productId || !cost?.name) continue
        const normalized: DirectCost = {
          id: String(cost.id),
          productId: String(cost.productId),
          name: String(cost.name).trim(),
          amount: Number(cost.amount) || 0,
          category: cost.category,
          hours: cost.hours ?? null,
          hourlyRate: cost.hourlyRate ?? null,
          updatedAt: cost.updatedAt || now(),
        }
        await db.directCosts.put(normalized)
        await enqueue('directCosts', normalized.id, 'upsert', normalized.updatedAt)
      }
    },
  )

  notifyDataChanged()
  return {
    ingredients: payload.ingredients.length,
    products: payload.products.length,
  }
}

export function wouldCreateProductCycle(
  parentProductId: string,
  candidateSubProductId: string,
  allRecipeItems: readonly RecipeItem[],
): boolean {
  if (parentProductId === candidateSubProductId) return true
  const visited = new Set<string>()
  const stack: string[] = [candidateSubProductId]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === parentProductId) return true
    if (visited.has(current)) continue
    visited.add(current)

    for (const item of allRecipeItems) {
      if (item.productId === current && item.itemType === 'product') {
        stack.push(item.ingredientId)
      }
    }
  }
  return false
}

async function enqueue(
  entity: SyncEntity,
  entityId: string,
  operation: SyncOperationType,
  updatedAt: string,
): Promise<void> {
  // Compact previous queue entries for the same entity + entityId so syncQueue never grows unbounded.
  const existing = await db.syncQueue
    .where('[entity+entityId]')
    .equals([entity, entityId])
    .primaryKeys()
  if (existing.length > 0) {
    await db.syncQueue.bulkDelete(existing)
  }

  await db.syncQueue.add({
    entity,
    entityId,
    operation,
    updatedAt,
    queuedAt: now(),
  })
}

function assertName(value: string, label: string): void {
  if (!value.trim()) throw new Error(`Укажите название ${label}.`)
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

function normalizeOptionalPositive(
  value: number | null | undefined,
  label: string,
): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} должно быть положительным числом.`)
  }
  return value
}

function normalizeOptionalNonNegative(
  value: number | null | undefined,
  label: string,
): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} должно быть неотрицательным числом.`)
  }
  return value
}

function validateMarkup(type: Product['markupType'], value: number): void {
  if (
    type !== 'absolute' &&
    type !== 'percentage' &&
    type !== 'margin' &&
    type !== 'foodCost'
  ) {
    throw new Error('Выберите корректный тип расчёта цены.')
  }
  assertNonNegative(value, 'Значение наценки/маржи')
  if (type === 'margin' && value >= 100) {
    throw new RangeError('Целевая маржа должна быть меньше 100%.')
  }
  if (type === 'foodCost' && (value <= 0 || value > 100)) {
    throw new RangeError('Целевой фудкост должен быть больше 0% и не более 100%.')
  }
}

function validateRecipeLine(input: RecipeLineInput): void {
  if ((input.itemType ?? 'ingredient') === 'product') {
    if (!input.subProductId) {
      throw new Error('Выберите полуфабрикат для строки рецепта.')
    }
  } else {
    assertName(input.ingredientName, 'ингредиента в рецепте')
  }
  assertNonNegative(input.quantity, 'Количество в рецепте')
  if (input.pricePerUnit !== null) {
    assertNonNegative(input.pricePerUnit, 'Цена ингредиента')
  }
}

async function findOrCreateIngredient(
  name: string,
  unit: Ingredient['unit'],
  pricePerUnit: number | null,
  priceUnit: MeasurementUnit,
  ingredients: Ingredient[],
): Promise<Ingredient> {
  const normalizedName = name.trim().toLocaleLowerCase()
  const existing = ingredients.find(
    (ingredient) => ingredient.name.trim().toLocaleLowerCase() === normalizedName,
  )

  if (!existing) {
    const createdAt = new Date().toISOString()
    const storedUnit = pricePerUnit !== null ? priceUnit : unit
    const ingredient: Ingredient = {
      id: createId(),
      name: name.trim(),
      unit: storedUnit,
      purchaseQuantity: 1,
      purchasePrice: pricePerUnit ?? 0,
      pricePerUnit: pricePerUnit ?? 0,
      hasPrice: pricePerUnit !== null,
      gramsPerMl: null,
      gramsPerPiece: null,
      updatedAt: createdAt,
    }
    if (!compatibleUnits(ingredient.unit).includes(unit)) {
      throw new Error(
        `Единица количества «${unitLabels[unit]}» не совместима с единицей цены «${unitLabels[storedUnit]}».`,
      )
    }
    await db.ingredients.add(ingredient)
    await enqueue('ingredients', ingredient.id, 'upsert', ingredient.updatedAt)
    ingredients.push(ingredient)
    return ingredient
  }

  const bridge = {
    gramsPerMl: existing.gramsPerMl,
    gramsPerPiece: existing.gramsPerPiece,
  }
  const allowedUnits = compatibleUnits(existing.unit, bridge)

  if (!allowedUnits.includes(unit)) {
    throw new Error(
      `Единица «${unitLabels[unit]}» не подходит ингредиенту «${existing.name}» (${unitLabels[existing.unit]}). Измените единицу в строке рецепта или укажите плотность/вес 1 шт. в карточке ингредиента.`,
    )
  }

  if (pricePerUnit !== null) {
    if (!allowedUnits.includes(priceUnit)) {
      throw new Error(
        `Единица цены «${unitLabels[priceUnit]}» не подходит ингредиенту «${existing.name}» (${unitLabels[existing.unit]}).`,
      )
    }
    const priceInStoredUnit =
      pricePerUnit / convertQuantity(1, priceUnit, existing.unit, bridge)
    // Preserve original package quantity if already set (> 0), scaling purchasePrice proportionally.
    const preservedPurchaseQuantity =
      existing.hasPrice && existing.purchaseQuantity > 0
        ? existing.purchaseQuantity
        : 1
    const updated: Ingredient = {
      ...existing,
      purchaseQuantity: preservedPurchaseQuantity,
      purchasePrice: priceInStoredUnit * preservedPurchaseQuantity,
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

function roundQuantity(value: number): number {
  return Math.round(value * 1000) / 1000
}

function nextUpdatedAt(previous?: string): string {
  const previousTime = previous ? Date.parse(previous) : 0
  if (previous && !Number.isFinite(previousTime)) {
    return new Date().toISOString()
  }

  return new Date(Math.max(Date.now(), previousTime + 1)).toISOString()
}

function now(): string {
  return new Date().toISOString()
}
