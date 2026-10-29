import { useEffect, useState, type FormEvent } from 'react'
import { Feedback } from '../components/Feedback'
import { PageHeading } from '../components/PageHeading'
import { UnitSelect } from '../components/UnitSelect'
import {
  deleteDirectCost,
  deleteRecipeItem,
  getProduct,
  listDirectCosts,
  listIngredients,
  listRecipeItems,
  saveDirectCost,
  saveProduct,
  saveRecipeItem,
} from '../db/repository'
import {
  calculateIngredientCost,
  calculateProductCost,
  type ProductCostBreakdown,
} from '../lib/cost'
import { formatCurrency, formatNumber } from '../lib/format'
import {
  compatibleUnits,
  defaultRecipeUnit,
  isMeasurementUnit,
  unitLabels,
} from '../lib/units'
import type {
  DirectCost,
  DirectCostCategory,
  Ingredient,
  MeasurementUnit,
  Product,
  RecipeItem,
} from '../types'
import styles from './Pages.module.css'

interface ProductDetailPageProps {
  productId: string
  onBack: () => void
}

interface ProductDraft {
  name: string
  description: string
  outputQuantity: string
  outputUnit: MeasurementUnit
}

interface RecipeDraft {
  ingredientId: string
  quantity: string
  quantityUnit: MeasurementUnit
}

interface DirectCostDraft {
  name: string
  amount: string
  category: DirectCostCategory
}

const emptyRecipeDraft: RecipeDraft = {
  ingredientId: '',
  quantity: '',
  quantityUnit: 'g',
}

const emptyDirectCostDraft: DirectCostDraft = {
  name: '',
  amount: '',
  category: 'labor',
}

export function ProductDetailPage({
  productId,
  onBack,
}: ProductDetailPageProps) {
  const [product, setProduct] = useState<Product | null>(null)
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [recipeItems, setRecipeItems] = useState<RecipeItem[]>([])
  const [directCosts, setDirectCosts] = useState<DirectCost[]>([])
  const [cost, setCost] = useState<ProductCostBreakdown | null>(null)
  const [productDraft, setProductDraft] = useState<ProductDraft | null>(null)
  const [recipeDraft, setRecipeDraft] = useState<RecipeDraft>(emptyRecipeDraft)
  const [editingRecipeId, setEditingRecipeId] = useState<string | null>(null)
  const [directCostDraft, setDirectCostDraft] =
    useState<DirectCostDraft>(emptyDirectCostDraft)
  const [editingDirectCostId, setEditingDirectCostId] = useState<string | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      const [nextProduct, nextIngredients, nextRecipeItems, nextDirectCosts] =
        await Promise.all([
          getProduct(productId),
          listIngredients(),
          listRecipeItems(productId),
          listDirectCosts(productId),
        ])
      if (!nextProduct) {
        setProduct(null)
        setCost(null)
        setError('Продукт не найден. Возможно, он был удалён.')
        return
      }

      setProduct(nextProduct)
      setIngredients(nextIngredients)
      setRecipeItems(nextRecipeItems)
      setDirectCosts(nextDirectCosts)
      setProductDraft({
        name: nextProduct.name,
        description: nextProduct.description,
        outputQuantity: String(nextProduct.outputQuantity),
        outputUnit: nextProduct.outputUnit,
      })
      setCost(
        calculateProductCost(
          nextProduct,
          nextRecipeItems,
          nextIngredients,
          nextDirectCosts,
        ),
      )
      setError(null)
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось загрузить продукт.'))
    }
  }

  useEffect(() => {
    void refresh()
  }, [productId])

  async function saveProductDetails(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault()
    if (!product || !productDraft) return

    const outputQuantity = Number(productDraft.outputQuantity)
    if (!Number.isFinite(outputQuantity) || outputQuantity <= 0) {
      setError('Количество готовой продукции должно быть больше нуля.')
      return
    }

    try {
      await saveProduct({
        id: product.id,
        name: productDraft.name.trim(),
        description: productDraft.description.trim(),
        outputQuantity,
        outputUnit: productDraft.outputUnit,
      })
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось сохранить продукт.'))
    }
  }

  async function saveRecipe(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!product) return
    const quantity = Number(recipeDraft.quantity)
    if (!Number.isFinite(quantity) || quantity < 0) {
      setError('Укажите корректное количество ингредиента.')
      return
    }

    try {
      await saveRecipeItem({
        id: editingRecipeId ?? crypto.randomUUID(),
        productId: product.id,
        ingredientId: recipeDraft.ingredientId,
        quantity,
        quantityUnit: recipeDraft.quantityUnit,
      })
      setRecipeDraft(emptyRecipeDraft)
      setEditingRecipeId(null)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось сохранить строку рецепта.'))
    }
  }

  function editRecipe(item: RecipeItem): void {
    setEditingRecipeId(item.id)
    setRecipeDraft({
      ingredientId: item.ingredientId,
      quantity: String(item.quantity),
      quantityUnit: item.quantityUnit,
    })
    setError(null)
  }

  async function removeRecipeItem(item: RecipeItem): Promise<void> {
    const ingredientName =
      ingredients.find((ingredient) => ingredient.id === item.ingredientId)?.name ??
      'ингредиент'
    if (!window.confirm(`Удалить «${ingredientName}» из рецепта?`)) return

    try {
      await deleteRecipeItem(item.id)
      setError(null)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось удалить строку рецепта.'))
    }
  }

  async function saveCost(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!product) return
    const amount = Number(directCostDraft.amount)
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Укажите корректную сумму прямых затрат.')
      return
    }

    try {
      await saveDirectCost({
        id: editingDirectCostId ?? crypto.randomUUID(),
        productId: product.id,
        name: directCostDraft.name.trim(),
        amount,
        category: directCostDraft.category,
      })
      setDirectCostDraft(emptyDirectCostDraft)
      setEditingDirectCostId(null)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось сохранить прямые затраты.'))
    }
  }

  function editCost(directCost: DirectCost): void {
    setEditingDirectCostId(directCost.id)
    setDirectCostDraft({
      name: directCost.name,
      amount: String(directCost.amount),
      category: directCost.category,
    })
    setError(null)
  }

  async function removeCost(directCost: DirectCost): Promise<void> {
    if (!window.confirm(`Удалить затраты «${directCost.name}»?`)) return
    try {
      await deleteDirectCost(directCost.id)
      setError(null)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось удалить прямые затраты.'))
    }
  }

  if (!product || !productDraft) {
    return (
      <section>
        <button className={styles.buttonSecondary} onClick={onBack} type="button">
          ← К продуктам
        </button>
        <Feedback error={error} />
      </section>
    )
  }

  return (
    <section>
      <PageHeading
        title={product.name}
        description="Рецепт, прямые затраты и итоговая себестоимость."
      >
        <button className={styles.buttonSecondary} onClick={onBack} type="button">
          ← К продуктам
        </button>
      </PageHeading>

      <Feedback error={error} />

      <form
        className={styles.formCard}
        onSubmit={(event) => void saveProductDetails(event)}
      >
        <div className={styles.formTitle}>
          <h2>Параметры продукта</h2>
        </div>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>Название</span>
            <input
              onChange={(event) =>
                setProductDraft({ ...productDraft, name: event.currentTarget.value })
              }
              required
              value={productDraft.name}
            />
          </label>
          <label className={styles.field}>
            <span>Описание</span>
            <input
              onChange={(event) =>
                setProductDraft({
                  ...productDraft,
                  description: event.currentTarget.value,
                })
              }
              value={productDraft.description}
            />
          </label>
          <label className={styles.field}>
            <span>Количество на выходе</span>
            <input
              min="0"
              onChange={(event) =>
                setProductDraft({
                  ...productDraft,
                  outputQuantity: event.currentTarget.value,
                })
              }
              required
              step="any"
              type="number"
              value={productDraft.outputQuantity}
            />
          </label>
          <UnitSelect
            label="Единица выхода"
            onChange={(outputUnit) => setProductDraft({ ...productDraft, outputUnit })}
            value={productDraft.outputUnit}
          />
        </div>
        <div className={styles.formActions}>
          <button className={styles.buttonSecondary} type="submit">
            Сохранить параметры
          </button>
        </div>
      </form>

      <section className={styles.sectionCard}>
        <div className={styles.sectionTitle}>
          <div>
            <h2>Рецепт</h2>
            <p>Количество и единицу можно задать отдельно для каждой строки.</p>
          </div>
        </div>

        <form className={styles.inlineForm} onSubmit={(event) => void saveRecipe(event)}>
          <label className={styles.field}>
            <span>Ингредиент</span>
            <select
              onChange={(event) => {
                const ingredientId = event.currentTarget.value
                const ingredient = ingredients.find((item) => item.id === ingredientId)
                setRecipeDraft({
                  ...recipeDraft,
                  ingredientId,
                  quantityUnit: ingredient
                    ? defaultRecipeUnit(ingredient.unit)
                    : recipeDraft.quantityUnit,
                })
              }}
              required
              value={recipeDraft.ingredientId}
            >
              <option value="" disabled>
                Выберите ингредиент
              </option>
              {ingredients.map((ingredient) => (
                <option key={ingredient.id} value={ingredient.id}>
                  {ingredient.name} · {formatCurrency(ingredient.pricePerUnit)}/
                  {unitLabels[ingredient.unit]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Количество</span>
            <input
              min="0"
              onChange={(event) =>
                setRecipeDraft({
                  ...recipeDraft,
                  quantity: event.currentTarget.value,
                })
              }
              required
              step="any"
              type="number"
              value={recipeDraft.quantity}
            />
          </label>
          <label className={styles.field}>
            <span>Единица количества</span>
            <select
              onChange={(event) => {
                const unit = event.currentTarget.value
                if (isMeasurementUnit(unit)) {
                  setRecipeDraft({ ...recipeDraft, quantityUnit: unit })
                }
              }}
              value={recipeDraft.quantityUnit}
            >
              {compatibleUnits(
                ingredients.find(
                  (ingredient) => ingredient.id === recipeDraft.ingredientId,
                )?.unit ?? recipeDraft.quantityUnit,
              ).map((unit) => (
                <option key={unit} value={unit}>
                  {unitLabels[unit]}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.formActions}>
            <button
              className={styles.buttonPrimary}
              disabled={ingredients.length === 0}
              type="submit"
            >
              {editingRecipeId ? 'Сохранить строку' : 'Добавить в рецепт'}
            </button>
            {editingRecipeId && (
              <button
                className={styles.buttonSecondary}
                onClick={() => {
                  setEditingRecipeId(null)
                  setRecipeDraft(emptyRecipeDraft)
                }}
                type="button"
              >
                Отмена
              </button>
            )}
          </div>
        </form>

        {recipeItems.length === 0 ? (
          <p className={styles.mutedText}>В рецепте пока нет ингредиентов.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Ингредиент</th>
                  <th scope="col">Количество</th>
                  <th scope="col">Цена за единицу закупки</th>
                  <th scope="col">Сумма</th>
                  <th scope="col">
                    <span className={styles.visuallyHidden}>Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {recipeItems.map((item) => {
                  const ingredient = ingredients.find(
                    (entry) => entry.id === item.ingredientId,
                  )
                  if (!ingredient) return null
                  return (
                    <tr key={item.id}>
                      <th scope="row">{ingredient.name}</th>
                      <td>
                        {formatNumber(item.quantity)} {unitLabels[item.quantityUnit]}
                      </td>
                      <td>
                        {formatCurrency(ingredient.pricePerUnit)}/
                        {unitLabels[ingredient.unit]}
                      </td>
                      <td>
                        {formatCurrency(
                          calculateIngredientCost(
                            item.quantity,
                            item.quantityUnit,
                            ingredient,
                          ),
                        )}
                      </td>
                      <td className={styles.rowActions}>
                        <button
                          className={styles.textButton}
                          onClick={() => editRecipe(item)}
                          type="button"
                        >
                          Изменить
                        </button>
                        <button
                          className={styles.textButtonDanger}
                          onClick={() => void removeRecipeItem(item)}
                          type="button"
                        >
                          Удалить
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.sectionCard}>
        <div className={styles.sectionTitle}>
          <div>
            <h2>Прямые затраты</h2>
            <p>Добавьте трудозатраты и накладные расходы.</p>
          </div>
        </div>

        <form className={styles.inlineForm} onSubmit={(event) => void saveCost(event)}>
          <label className={styles.field}>
            <span>Название</span>
            <input
              onChange={(event) =>
                setDirectCostDraft({
                  ...directCostDraft,
                  name: event.currentTarget.value,
                })
              }
              required
              value={directCostDraft.name}
            />
          </label>
          <label className={styles.field}>
            <span>Сумма, ₽</span>
            <input
              min="0"
              onChange={(event) =>
                setDirectCostDraft({
                  ...directCostDraft,
                  amount: event.currentTarget.value,
                })
              }
              required
              step="any"
              type="number"
              value={directCostDraft.amount}
            />
          </label>
          <label className={styles.field}>
            <span>Категория</span>
            <select
              onChange={(event) => {
                const category = event.currentTarget.value
                if (category === 'labor' || category === 'overhead') {
                  setDirectCostDraft({ ...directCostDraft, category })
                }
              }}
              value={directCostDraft.category}
            >
              <option value="labor">Труд</option>
              <option value="overhead">Накладные</option>
            </select>
          </label>
          <div className={styles.formActions}>
            <button className={styles.buttonPrimary} type="submit">
              {editingDirectCostId ? 'Сохранить затраты' : 'Добавить затраты'}
            </button>
            {editingDirectCostId && (
              <button
                className={styles.buttonSecondary}
                onClick={() => {
                  setEditingDirectCostId(null)
                  setDirectCostDraft(emptyDirectCostDraft)
                }}
                type="button"
              >
                Отмена
              </button>
            )}
          </div>
        </form>

        {directCosts.length === 0 ? (
          <p className={styles.mutedText}>Прямые затраты пока не добавлены.</p>
        ) : (
          <div className={styles.costList}>
            {directCosts.map((directCost) => (
              <div className={styles.costListRow} key={directCost.id}>
                <div>
                  <strong>{directCost.name}</strong>
                  <span className={styles.rowSubtitle}>
                    {directCost.category === 'labor' ? 'Труд' : 'Накладные'}
                  </span>
                </div>
                <strong>{formatCurrency(directCost.amount)}</strong>
                <div className={styles.rowActions}>
                  <button
                    className={styles.textButton}
                    onClick={() => editCost(directCost)}
                    type="button"
                  >
                    Изменить
                  </button>
                  <button
                    className={styles.textButtonDanger}
                    onClick={() => void removeCost(directCost)}
                    type="button"
                  >
                    Удалить
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {cost && (
        <section className={styles.summaryCard}>
          <h2>Себестоимость</h2>
          <dl className={styles.summaryList}>
            <div>
              <dt>Материалы</dt>
              <dd>{formatCurrency(cost.materials)}</dd>
            </div>
            <div>
              <dt>Труд</dt>
              <dd>{formatCurrency(cost.labor)}</dd>
            </div>
            <div>
              <dt>Накладные</dt>
              <dd>{formatCurrency(cost.overhead)}</dd>
            </div>
            <div className={styles.summaryTotal}>
              <dt>Итого</dt>
              <dd>{formatCurrency(cost.total)}</dd>
            </div>
            <div className={styles.summaryPerUnit}>
              <dt>
                На единицу ({unitLabels[product.outputUnit]})
              </dt>
              <dd>{formatCurrency(cost.perUnit)}</dd>
            </div>
          </dl>
        </section>
      )}
    </section>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
