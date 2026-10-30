import { convertQuantity } from './units'
import type {
  DirectCost,
  Ingredient,
  Product,
  RecipeItem,
} from '../types'

export interface ProductCostBreakdown {
  materials: number
  labor: number
  overhead: number
  total: number
  perUnit: number
}

export function calculateIngredientCost(
  quantity: number,
  quantityUnit: RecipeItem['quantityUnit'],
  ingredient: Pick<Ingredient, 'unit' | 'pricePerUnit' | 'hasPrice'>,
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
  )

  return ingredientQuantity * ingredient.pricePerUnit
}

export function calculateProductCost(
  product: Product,
  recipeItems: readonly RecipeItem[],
  ingredients: readonly Ingredient[],
  directCosts: readonly DirectCost[],
): ProductCostBreakdown {
  if (!Number.isFinite(product.outputQuantity) || product.outputQuantity <= 0) {
    throw new RangeError('Количество готовой продукции должно быть больше нуля.')
  }

  const ingredientsById = new Map(
    ingredients.map(
      (ingredient): [string, Ingredient] => [ingredient.id, ingredient],
    ),
  )
  const productRecipe = recipeItems.filter((item) => item.productId === product.id)
  const productDirectCosts = directCosts.filter(
    (directCost) => directCost.productId === product.id,
  )

  const materials = productRecipe.reduce((total, item) => {
    const ingredient = ingredientsById.get(item.ingredientId)
    if (!ingredient) {
      throw new Error(`Ингредиент рецепта не найден: ${item.ingredientId}`)
    }

    return total + calculateIngredientCost(item.quantity, item.quantityUnit, ingredient)
  }, 0)

  const labor = sumDirectCosts(productDirectCosts, 'labor')
  const overhead = sumDirectCosts(productDirectCosts, 'overhead')
  const total = materials + labor + overhead

  return {
    materials,
    labor,
    overhead,
    total,
    perUnit: total / product.outputQuantity,
  }
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
