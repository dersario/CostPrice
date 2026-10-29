import Dexie, { type Table } from 'dexie'
import type {
  DirectCost,
  Ingredient,
  Product,
  RecipeItem,
  SyncOperation,
} from '../types'

export class AppDatabase extends Dexie {
  ingredients!: Table<Ingredient, string>
  products!: Table<Product, string>
  recipeItems!: Table<RecipeItem, string>
  directCosts!: Table<DirectCost, string>
  syncQueue!: Table<SyncOperation, number>

  constructor() {
    super('recipe-cost-calculator')

    this.version(1).stores({
      ingredients: '&id, name, updatedAt',
      products: '&id, name, updatedAt',
      recipeItems: '&id, productId, ingredientId, updatedAt',
      directCosts: '&id, productId, category, updatedAt',
      syncQueue: '++id, queuedAt, [entity+entityId]',
    })
  }
}

export const db = new AppDatabase()
