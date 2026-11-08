import { convertQuantity } from './units'
import type {
  DirectCost,
  Ingredient,
  Product,
  RecipeItem,
} from '../types'

export interface ProductCostBreakdown {
  materials: number
  subrecipes: number
  labor: number
  overhead: number
  packaging: number
  total: number
  perUnit: number
  markupPerUnit: number
  sellingPricePerUnit: number
  totalSellingPrice: number
  profitPerUnit: number
  totalProfit: number
  marginPercent: number
  foodCostPercent: number
  missingItems: string[]
}

export function calculateIngredientCost(
  quantity: number,
  quantityUnit: RecipeItem['quantityUnit'],
  ingredient: Pick<
    Ingredient,
    'unit' | 'pricePerUnit' | 'hasPrice' | 'gramsPerMl' | 'gramsPerPiece'
  >,
): number {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new RangeError('Количество ингредиента должно быть неотрицательным числом.')
  }
  if (!Number.isFinite(ingredient.pricePerUnit) || ingredient.pricePerUnit < 0) {
    throw new RangeError('Цена ингредиента должна быть неотрицательным числом.')
  }
  if (!ingredient.hasPrice) return 0

  const ingredientQuantity = convertQuantity(
    quantity,
    quantityUnit,
    ingredient.unit,
    {
      gramsPerMl: ingredient.gramsPerMl,
      gramsPerPiece: ingredient.gramsPerPiece,
    },
  )

  return ingredientQuantity * ingredient.pricePerUnit
}

export function calculateProductCost(
  product: Product,
  recipeItems: readonly RecipeItem[],
  ingredients: readonly Ingredient[],
  directCosts: readonly DirectCost[],
  allProducts: readonly Product[] = [product],
  visitedProductIds: ReadonlySet<string> = new Set(),
): ProductCostBreakdown {
  if (!Number.isFinite(product.outputQuantity) || product.outputQuantity <= 0) {
    throw new RangeError('Количество готовой продукции должно быть больше нуля.')
  }

  const ingredientsById = new Map(
    ingredients.map(
      (ingredient): [string, Ingredient] => [ingredient.id, ingredient],
    ),
  )
  const productsById = new Map(
    allProducts.map((entry): [string, Product] => [entry.id, entry]),
  )
  if (!productsById.has(product.id)) {
    productsById.set(product.id, product)
  }

  const productRecipe = recipeItems.filter((item) => item.productId === product.id)
  const productDirectCosts = directCosts.filter(
    (directCost) => directCost.productId === product.id,
  )

  let materials = 0
  let subrecipes = 0
  const missingItems: string[] = []

  const nextVisited = new Set(visitedProductIds)
  nextVisited.add(product.id)

  for (const item of productRecipe) {
    const isSubrecipe = item.itemType === 'product'
    if (isSubrecipe) {
      const subProduct = productsById.get(item.ingredientId)
      if (!subProduct) {
        missingItems.push(item.ingredientId)
        continue
      }
      if (nextVisited.has(subProduct.id)) {
        missingItems.push(`Циклическая ссылка: ${subProduct.name}`)
        continue
      }
      try {
        const subBreakdown = calculateProductCost(
          subProduct,
          recipeItems,
          ingredients,
          directCosts,
          allProducts,
          nextVisited,
        )
        const convertedQty = convertQuantity(
          item.quantity,
          item.quantityUnit,
          subProduct.outputUnit,
        )
        subrecipes += convertedQty * subBreakdown.perUnit
        if (subBreakdown.missingItems.length > 0) {
          missingItems.push(...subBreakdown.missingItems)
        }
      } catch {
        missingItems.push(subProduct.name)
      }
      continue
    }

    const ingredient = ingredientsById.get(item.ingredientId)
    if (!ingredient) {
      missingItems.push(item.ingredientId)
      continue
    }

    try {
      materials += calculateIngredientCost(
        item.quantity,
        item.quantityUnit,
        ingredient,
      )
    } catch {
      missingItems.push(ingredient.name)
    }
  }

  const labor = sumDirectCosts(productDirectCosts, 'labor')
  const overhead = sumDirectCosts(productDirectCosts, 'overhead')
  const packaging = sumDirectCosts(productDirectCosts, 'packaging')
  const total = materials + subrecipes + labor + overhead + packaging
  const perUnit = total / product.outputQuantity

  const { sellingPricePerUnit, markupPerUnit } = computeSellingPrice(
    perUnit,
    product.markupType,
    product.markupValue,
  )

  const totalSellingPrice = sellingPricePerUnit * product.outputQuantity
  const profitPerUnit = sellingPricePerUnit - perUnit
  const totalProfit = profitPerUnit * product.outputQuantity
  const marginPercent =
    sellingPricePerUnit > 0 ? (profitPerUnit / sellingPricePerUnit) * 100 : 0
  const foodCostPercent =
    sellingPricePerUnit > 0 ? (perUnit / sellingPricePerUnit) * 100 : 0

  return {
    materials,
    subrecipes,
    labor,
    overhead,
    packaging,
    total,
    perUnit,
    markupPerUnit,
    sellingPricePerUnit,
    totalSellingPrice,
    profitPerUnit,
    totalProfit,
    marginPercent,
    foodCostPercent,
    missingItems,
  }
}

function computeSellingPrice(
  perUnitCost: number,
  markupType: Product['markupType'],
  markupValue: number,
): { sellingPricePerUnit: number; markupPerUnit: number } {
  const safeVal = Number.isFinite(markupValue) && markupValue >= 0 ? markupValue : 0

  switch (markupType) {
    case 'percentage': {
      const markupPerUnit = perUnitCost * (safeVal / 100)
      return {
        markupPerUnit,
        sellingPricePerUnit: perUnitCost + markupPerUnit,
      }
    }
    case 'margin': {
      // Target margin M% (< 100): Price = Cost / (1 - M/100)
      const clampedMargin = Math.min(safeVal, 99.9)
      const sellingPricePerUnit =
        clampedMargin <= 0 ? perUnitCost : perUnitCost / (1 - clampedMargin / 100)
      return {
        sellingPricePerUnit,
        markupPerUnit: sellingPricePerUnit - perUnitCost,
      }
    }
    case 'foodCost': {
      // Target food cost FC% (> 0): Price = Cost / (FC/100)
      if (safeVal <= 0) {
        return { sellingPricePerUnit: perUnitCost, markupPerUnit: 0 }
      }
      const sellingPricePerUnit = perUnitCost / (safeVal / 100)
      return {
        sellingPricePerUnit,
        markupPerUnit: Math.max(0, sellingPricePerUnit - perUnitCost),
      }
    }
    case 'absolute':
    default: {
      return {
        markupPerUnit: safeVal,
        sellingPricePerUnit: perUnitCost + safeVal,
      }
    }
  }
}

export function scaleMultiplierForPanDiameter(
  fromDiameterCm: number,
  toDiameterCm: number,
): number {
  if (
    !Number.isFinite(fromDiameterCm) ||
    fromDiameterCm <= 0 ||
    !Number.isFinite(toDiameterCm) ||
    toDiameterCm <= 0
  ) {
    throw new RangeError('Диаметр формы должен быть положительным числом.')
  }
  return (toDiameterCm / fromDiameterCm) ** 2
}

function sumDirectCosts(
  directCosts: readonly DirectCost[],
  category: DirectCost['category'],
): number {
  return directCosts
    .filter((directCost) => directCost.category === category)
    .reduce((total, directCost) => {
      if (!Number.isFinite(directCost.amount) || directCost.amount < 0) {
        throw new RangeError('Прямые затраты должны быть неотрицательным числом.')
      }

      return total + directCost.amount
    }, 0)
}
