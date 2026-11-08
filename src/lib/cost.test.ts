import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  calculateIngredientCost,
  calculateProductCost,
  scaleMultiplierForPanDiameter,
} from './cost'
import {
  canConvertUnits,
  compatibleUnits,
  convertQuantity,
} from './units'
import type {
  DirectCost,
  Ingredient,
  Product,
  RecipeItem,
} from '../types'

test('convertQuantity within same dimension', () => {
  assert.equal(convertQuantity(1.5, 'kg', 'g'), 1500)
  assert.equal(convertQuantity(500, 'g', 'kg'), 0.5)
  assert.equal(convertQuantity(2, 'l', 'ml'), 2000)
  assert.equal(convertQuantity(250, 'ml', 'l'), 0.25)
  assert.equal(convertQuantity(3, 'pcs', 'pcs'), 3)
})

test('convertQuantity across mass, volume, and count with bridge parameters', () => {
  // Milk: 1 ml = 1.03 g
  const milkBridge = { gramsPerMl: 1.03 }
  assert.equal(canConvertUnits('l', 'g', milkBridge), true)
  assert.equal(canConvertUnits('l', 'pcs', milkBridge), false)
  assert.ok(Math.abs(convertQuantity(1, 'l', 'g', milkBridge) - 1030) < 1e-6)
  assert.ok(Math.abs(convertQuantity(515, 'g', 'ml', milkBridge) - 500) < 1e-6)

  // Egg: 1 pc = 55 g
  const eggBridge = { gramsPerPiece: 55 }
  assert.equal(canConvertUnits('pcs', 'g', eggBridge), true)
  assert.equal(convertQuantity(2, 'pcs', 'g', eggBridge), 110)
  assert.equal(convertQuantity(0.11, 'kg', 'pcs', eggBridge), 2)

  // Both density and piece weight: pcs <-> ml
  const fullBridge = { gramsPerMl: 1.1, gramsPerPiece: 55 }
  assert.equal(canConvertUnits('pcs', 'ml', fullBridge), true)
  assert.ok(Math.abs(convertQuantity(1, 'pcs', 'ml', fullBridge) - 50) < 1e-6)
  assert.equal(compatibleUnits('pcs', fullBridge).length, 5)
})

test('calculateProductCost supports sub-recipes, packaging, margin, and foodCost', () => {
  const ingredients: Ingredient[] = [
    {
      id: 'ing-butter',
      name: 'Сливочное масло',
      unit: 'kg',
      purchaseQuantity: 1,
      purchasePrice: 1000,
      pricePerUnit: 1000,
      hasPrice: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'ing-eggs',
      name: 'Яйцо',
      unit: 'pcs',
      purchaseQuantity: 10,
      purchasePrice: 150,
      pricePerUnit: 15,
      hasPrice: true,
      gramsPerPiece: 50,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]

  // Sub-recipe: Cream (output 500 g, uses 250 g butter = 250 RUB) -> perUnit = 0.5 RUB/g
  const creamProduct: Product = {
    id: 'prod-cream',
    name: 'Крем',
    description: '',
    outputQuantity: 500,
    outputUnit: 'g',
    markupType: 'absolute',
    markupValue: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  // Main recipe: Cake (uses 200 g Cream = 100 RUB, plus 100 g Eggs = 2 pcs = 30 RUB)
  // Plus Labor = 200 RUB, Packaging = 70 RUB -> Total = 400 RUB for 2 kg -> perUnit = 200 RUB/kg
  // Target margin 50% -> sellingPricePerUnit = 400 RUB/kg, profit = 200 RUB/kg
  const cakeProduct: Product = {
    id: 'prod-cake',
    name: 'Торт',
    description: '',
    outputQuantity: 2,
    outputUnit: 'kg',
    markupType: 'margin',
    markupValue: 50,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  const recipeItems: RecipeItem[] = [
    {
      id: 'ri-1',
      productId: 'prod-cream',
      ingredientId: 'ing-butter',
      itemType: 'ingredient',
      quantity: 250,
      quantityUnit: 'g',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'ri-2',
      productId: 'prod-cake',
      ingredientId: 'prod-cream',
      itemType: 'product',
      quantity: 200,
      quantityUnit: 'g',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'ri-3',
      productId: 'prod-cake',
      ingredientId: 'ing-eggs',
      itemType: 'ingredient',
      quantity: 100, // 100 g of eggs @ 50g/pc = 2 pcs = 30 RUB
      quantityUnit: 'g',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]

  const directCosts: DirectCost[] = [
    {
      id: 'dc-1',
      productId: 'prod-cake',
      name: 'Сборка',
      amount: 200,
      category: 'labor',
      hours: 0.5,
      hourlyRate: 400,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'dc-2',
      productId: 'prod-cake',
      name: 'Коробка',
      amount: 70,
      category: 'packaging',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]

  const breakdown = calculateProductCost(
    cakeProduct,
    recipeItems,
    ingredients,
    directCosts,
    [creamProduct, cakeProduct],
  )

  assert.equal(breakdown.materials, 30)
  assert.equal(breakdown.subrecipes, 100)
  assert.equal(breakdown.labor, 200)
  assert.equal(breakdown.packaging, 70)
  assert.equal(breakdown.total, 400)
  assert.equal(breakdown.perUnit, 200)
  assert.equal(breakdown.sellingPricePerUnit, 400)
  assert.equal(breakdown.profitPerUnit, 200)
  assert.equal(breakdown.marginPercent, 50)
  assert.equal(breakdown.foodCostPercent, 50)
  assert.equal(breakdown.missingItems.length, 0)
})

test('calculateProductCost does not throw on missing ingredient', () => {
  const product: Product = {
    id: 'p1',
    name: 'Тест',
    description: '',
    outputQuantity: 1,
    outputUnit: 'pcs',
    markupType: 'foodCost',
    markupValue: 25,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const items: RecipeItem[] = [
    {
      id: 'r1',
      productId: 'p1',
      ingredientId: 'missing-id',
      quantity: 100,
      quantityUnit: 'g',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]
  const res = calculateProductCost(product, items, [], [])
  assert.equal(res.total, 0)
  assert.deepEqual(res.missingItems, ['missing-id'])
})

test('scaleMultiplierForPanDiameter scales by square of diameter ratio', () => {
  const mult = scaleMultiplierForPanDiameter(16, 24)
  assert.equal(mult, 2.25)
  assert.equal(
    calculateIngredientCost(100, 'g', {
      unit: 'kg',
      pricePerUnit: 500,
      hasPrice: true,
    }),
    50,
  )
})
