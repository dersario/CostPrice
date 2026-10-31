export type MeasurementUnit = 'g' | 'kg' | 'ml' | 'l' | 'pcs'

export type DirectCostCategory = 'labor' | 'overhead'
export type MarkupType = 'absolute' | 'percentage'

export interface Ingredient {
  id: string
  name: string
  unit: MeasurementUnit
  purchaseQuantity: number
  purchasePrice: number
  pricePerUnit: number
  hasPrice: boolean
  updatedAt: string
}

export interface Product {
  id: string
  name: string
  description: string
  outputQuantity: number
  outputUnit: MeasurementUnit
  markupType: MarkupType
  markupValue: number
  updatedAt: string
}

export interface RecipeItem {
  id: string
  productId: string
  ingredientId: string
  quantity: number
  quantityUnit: MeasurementUnit
  updatedAt: string
}

export interface DirectCost {
  id: string
  productId: string
  name: string
  amount: number
  category: DirectCostCategory
  updatedAt: string
}

export type SyncEntity =
  | 'ingredients'
  | 'products'
  | 'recipeItems'
  | 'directCosts'

export type SyncOperationType = 'upsert' | 'delete'

export interface SyncOperation {
  id?: number
  entity: SyncEntity
  entityId: string
  operation: SyncOperationType
  updatedAt: string
  queuedAt: string
}
