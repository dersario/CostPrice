export type MeasurementUnit = 'g' | 'kg' | 'ml' | 'l' | 'pcs'

export type DirectCostCategory = 'labor' | 'overhead' | 'packaging'
export type MarkupType = 'absolute' | 'percentage' | 'margin' | 'foodCost'
export type RecipeItemType = 'ingredient' | 'product'

export interface Ingredient {
  id: string
  name: string
  unit: MeasurementUnit
  purchaseQuantity: number
  purchasePrice: number
  pricePerUnit: number
  hasPrice: boolean
  /** Mass of 1 ml in grams (e.g. 1.03 for milk, 0.92 for oil). Enables mass <-> volume conversion. */
  gramsPerMl?: number | null
  /** Mass of 1 piece in grams (e.g. 55 for an egg). Enables count <-> mass (and count <-> volume if gramsPerMl is also set) conversion. */
  gramsPerPiece?: number | null
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
  /** Optional pan diameter in cm (for circular baking pans scaling). */
  panDiameterCm?: number | null
  updatedAt: string
}

export interface RecipeItem {
  id: string
  productId: string
  /** Target ingredient ID (or sub-recipe Product ID when itemType === 'product'). */
  ingredientId: string
  /** 'ingredient' (default) or 'product' (sub-recipe / полуфабрикат). */
  itemType?: RecipeItemType
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
  /** For labor: optional hours worked. */
  hours?: number | null
  /** For labor: optional hourly rate. */
  hourlyRate?: number | null
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
