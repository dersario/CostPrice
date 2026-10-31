import { useEffect, useState, type FormEvent } from 'react'
import { Feedback } from '../components/Feedback'
import { IngredientAutocomplete } from '../components/IngredientAutocomplete'
import { PageHeading } from '../components/PageHeading'
import { UnitSelect } from '../components/UnitSelect'
import {
  createProductWithRecipe,
  deleteProduct,
  listAllDirectCosts,
  listAllRecipeItems,
  listIngredients,
  listProducts,
} from '../db/repository'
import { calculateProductCost, type ProductCostBreakdown } from '../lib/cost'
import { formatCurrency, formatNumber } from '../lib/format'
import {
  compatibleUnits,
  isMeasurementUnit,
  measurementUnits,
  unitLabels,
} from '../lib/units'
import type { Ingredient, MarkupType, MeasurementUnit, Product } from '../types'
import styles from './Pages.module.css'

interface RecipeItemDraft {
  id: string
  name: string
  quantity: string
  quantityUnit: MeasurementUnit
  pricePerUnit: string
}

interface ProductForm {
  name: string
  description: string
  outputQuantity: string
  outputUnit: MeasurementUnit
  markupType: MarkupType
  markupValue: string
  recipeItems: RecipeItemDraft[]
}

interface ProductRow {
  product: Product
  cost: ProductCostBreakdown
  unpricedCount: number
}

const emptyForm: ProductForm = {
  name: '',
  description: '',
  outputQuantity: '1',
  outputUnit: 'pcs',
  markupType: 'absolute',
  markupValue: '0',
  recipeItems: [],
}

interface ProductsPageProps {
  onOpenProduct: (id: string) => void
}

export function ProductsPage({ onOpenProduct }: ProductsPageProps) {
  const [rows, setRows] = useState<ProductRow[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [form, setForm] = useState<ProductForm>(emptyForm)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      const [products, ingredients, recipeItems, directCosts] = await Promise.all([
        listProducts(),
        listIngredients(),
        listAllRecipeItems(),
        listAllDirectCosts(),
      ])
      setIngredients(ingredients)
      setRows(
        products.map((product) => {
          const productRecipe = recipeItems.filter(
            (item) => item.productId === product.id,
          )
          return {
            product,
            cost: calculateProductCost(product, recipeItems, ingredients, directCosts),
            unpricedCount: productRecipe.filter(
              (item) =>
                !ingredients.find(
                  (ingredient) => ingredient.id === item.ingredientId,
                )?.hasPrice,
            ).length,
          }
        }),
      )
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось загрузить продукты и их себестоимость.'))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  function startCreate(): void {
    setForm({
      ...emptyForm,
      recipeItems: [newRecipeItem()],
    })
    setIsFormOpen(true)
    setError(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const outputQuantity = Number(form.outputQuantity)
    if (!Number.isFinite(outputQuantity) || outputQuantity <= 0) {
      setError('Количество на выходе должно быть больше нуля.')
      return
    }
    const markupValue = Number(form.markupValue)
    if (!Number.isFinite(markupValue) || markupValue < 0) {
      setError('Наценка должна быть неотрицательным числом.')
      return
    }
    for (const item of form.recipeItems) {
      if (!item.name.trim()) {
        setError('Укажите название продукта для каждой строки рецепта.')
        return
      }
      const quantity = Number(item.quantity)
      if (!Number.isFinite(quantity) || quantity < 0) {
        setError('Укажите корректное количество продукта в рецепте.')
        return
      }
      if (
        item.pricePerUnit.trim() !== '' &&
        (!Number.isFinite(Number(item.pricePerUnit)) ||
          Number(item.pricePerUnit) < 0)
      ) {
        setError('Цена продукта должна быть неотрицательным числом.')
        return
      }
    }

    try {
      const product = {
        id: crypto.randomUUID(),
        name: form.name.trim(),
        description: form.description.trim(),
        outputQuantity,
        outputUnit: form.outputUnit,
        markupType: form.markupType,
        markupValue,
      }
      await createProductWithRecipe(
        product,
        form.recipeItems.map((item) => ({
          id: item.id,
          ingredientName: item.name.trim(),
          quantity: Number(item.quantity),
          quantityUnit: item.quantityUnit,
          pricePerUnit:
            item.pricePerUnit.trim() === '' ? null : Number(item.pricePerUnit),
        })),
      )
      setIsFormOpen(false)
      setForm({ ...emptyForm, recipeItems: [] })
      setError(null)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось сохранить продукт.'))
    }
  }

  async function remove(product: Product): Promise<void> {
    if (!window.confirm(`Удалить продукт «${product.name}» и его рецепт?`)) return
    try {
      await deleteProduct(product.id)
      setError(null)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось удалить продукт.'))
    }
  }

  return (
    <section>
      <PageHeading
        title="Рецепты"
        description="Сохранённые рецепты и их рассчитанная себестоимость."
      >
        <button className={styles.buttonPrimary} onClick={startCreate} type="button">
          Создать рецепт
        </button>
      </PageHeading>

      <Feedback error={error} />

      {isFormOpen && (
        <form className={styles.formCard} onSubmit={(event) => void submit(event)}>
          <div className={styles.formTitle}>
            <h2>Новый рецепт</h2>
            <button
              aria-label="Закрыть форму"
              className={styles.iconButton}
              onClick={() => setIsFormOpen(false)}
              type="button"
            >
              ×
            </button>
          </div>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span>Название рецепта</span>
              <input
                autoFocus
                onChange={(event) =>
                  setForm({ ...form, name: event.currentTarget.value })
                }
                required
                value={form.name}
              />
            </label>
            <label className={styles.field}>
              <span>Описание</span>
              <input
                onChange={(event) =>
                  setForm({ ...form, description: event.currentTarget.value })
                }
                value={form.description}
              />
            </label>
            <label className={styles.field}>
              <span>Количество на выходе</span>
              <input
                min="0"
                onChange={(event) =>
                  setForm({ ...form, outputQuantity: event.currentTarget.value })
                }
                required
                step="any"
                type="number"
                value={form.outputQuantity}
              />
            </label>
            <UnitSelect
              label="Единица выхода"
              onChange={(outputUnit) => setForm({ ...form, outputUnit })}
              value={form.outputUnit}
            />
            <label className={styles.field}>
              <span>Тип наценки</span>
              <select
                onChange={(event) =>
                  setForm({
                    ...form,
                    markupType:
                      event.currentTarget.value === 'percentage'
                        ? 'percentage'
                        : 'absolute',
                  })
                }
                value={form.markupType}
              >
                <option value="absolute">Фиксированная сумма</option>
                <option value="percentage">Процент от себестоимости</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>
                Наценка {form.markupType === 'percentage' ? '(%)' : '(на единицу)'}
              </span>
              <input
                min="0"
                onChange={(event) =>
                  setForm({ ...form, markupValue: event.currentTarget.value })
                }
                required
                step="any"
                type="number"
                value={form.markupValue}
              />
            </label>
          </div>
          <div className={styles.recipeDraftSection}>
            <div className={styles.sectionTitle}>
              <div>
                <h2>Продукты и количество</h2>
                <p>Введите названия и количество. Цену можно указать сейчас или позже.</p>
              </div>
              <button
                className={styles.buttonSecondary}
                onClick={() => {
                  setForm({
                    ...form,
                    recipeItems: [...form.recipeItems, newRecipeItem()],
                  })
                }}
                type="button"
              >
                Добавить продукт
              </button>
            </div>
            {form.recipeItems.map((item, index) => {
              const ingredient = ingredients.find(
                (entry) =>
                  entry.name.trim().toLocaleLowerCase() ===
                  item.name.trim().toLocaleLowerCase(),
              )
              const units = ingredient
                ? compatibleUnits(ingredient.unit)
                : measurementUnits
              return (
                <div className={styles.recipeDraftRow} key={item.id}>
                  <label className={styles.field}>
                    <span>Продукт</span>
                    <IngredientAutocomplete
                      id={`recipe-ingredient-${item.id}`}
                      ingredients={ingredients}
                      onChange={(name) => {
                        const selected = ingredients.find(
                          (entry) =>
                            entry.name.trim().toLocaleLowerCase() ===
                            name.trim().toLocaleLowerCase(),
                        )
                        setForm({
                          ...form,
                          recipeItems: form.recipeItems.map((draft, rowIndex) =>
                            rowIndex === index
                              ? {
                                  ...draft,
                                  name,
                                  quantityUnit:
                                    selected &&
                                    !compatibleUnits(selected.unit).includes(
                                      draft.quantityUnit,
                                    )
                                      ? selected.unit
                                      : draft.quantityUnit,
                                }
                              : draft,
                          ),
                        })
                      }}
                      required
                      value={item.name}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>Количество</span>
                    <input
                      min="0"
                      onChange={(event) =>
                        setForm({
                          ...form,
                          recipeItems: form.recipeItems.map((draft, rowIndex) =>
                            rowIndex === index
                              ? { ...draft, quantity: event.currentTarget.value }
                              : draft,
                          ),
                        })
                      }
                      required
                      step="any"
                      type="number"
                      value={item.quantity}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>Цена за единицу (необязательно)</span>
                    <input
                      min="0"
                      onChange={(event) =>
                        setForm({
                          ...form,
                          recipeItems: form.recipeItems.map((draft, rowIndex) =>
                            rowIndex === index
                              ? {
                                  ...draft,
                                  pricePerUnit: event.currentTarget.value,
                                }
                              : draft,
                          ),
                        })
                      }
                      placeholder={
                        ingredient?.hasPrice
                          ? formatNumber(ingredient.pricePerUnit)
                          : 'Не указана'
                      }
                      step="any"
                      type="number"
                      value={item.pricePerUnit}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>Единица количества</span>
                    <select
                      onChange={(event) => {
                        const unit = event.currentTarget.value
                        if (!isMeasurementUnit(unit)) return
                        setForm({
                          ...form,
                          recipeItems: form.recipeItems.map((draft, rowIndex) =>
                            rowIndex === index
                              ? { ...draft, quantityUnit: unit }
                              : draft,
                          ),
                        })
                      }}
                      value={item.quantityUnit}
                    >
                      {units.map((unit) => (
                        <option key={unit} value={unit}>
                          {unitLabels[unit]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    aria-label={`Удалить продукт из рецепта: ${ingredient?.name ?? ''}`}
                    className={styles.textButtonDanger}
                    onClick={() =>
                      setForm({
                        ...form,
                        recipeItems: form.recipeItems.filter(
                          (draft) => draft.id !== item.id,
                        ),
                      })
                    }
                    type="button"
                  >
                    Удалить
                  </button>
                </div>
              )
            })}
          </div>
          <div className={styles.formActions}>
            <button className={styles.buttonPrimary} type="submit">
              Создать рецепт
            </button>
            <button
              className={styles.buttonSecondary}
              onClick={() => setIsFormOpen(false)}
              type="button"
            >
              Отмена
            </button>
          </div>
        </form>
      )}

      {rows.length === 0 ? (
        <div className={styles.emptyState}>
          <h2>Пока нет рецептов</h2>
          <p>Создайте рецепт и добавьте в него продукты с нужным количеством.</p>
        </div>
      ) : (
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.recipeNameColumn} scope="col">Рецепт</th>
                <th scope="col">Себестоимость</th>
                <th scope="col">Себестоимость за единицу</th>
                <th scope="col">Цена продажи за единицу</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ product, cost, unpricedCount }) => (
                <tr key={product.id}>
                  <th className={styles.recipeNameColumn} scope="row">
                    <button
                      className={styles.productLink}
                      onClick={() => onOpenProduct(product.id)}
                      type="button"
                    >
                      {product.name}
                    </button>
                    <span className={styles.rowSubtitle}>
                      {formatNumber(product.outputQuantity)}{' '}
                      {unitLabels[product.outputUnit]} на выходе
                    </span>
                    {unpricedCount > 0 && (
                      <span className={styles.priceWarning}>
                        Без цены: {unpricedCount}
                      </span>
                    )}
                  </th>
                  <td>{formatCurrency(cost.total)}</td>
                  <td>{formatCurrency(cost.perUnit)}</td>
                  <td>{formatCurrency(cost.sellingPricePerUnit)}</td>
                  <td className={styles.tableRowActions}>
                    <div className={styles.rowActionStack}>
                      <button
                        aria-label={`Редактировать рецепт: ${product.name}`}
                        className={styles.tableActionButton}
                        onClick={() => onOpenProduct(product.id)}
                        type="button"
                      >
                        <span aria-hidden="true">✎</span>
                        Редактировать рецепт
                      </button>
                      <button
                        className={`${styles.tableActionButton} ${styles.tableActionButtonDanger}`}
                        onClick={() => void remove(product)}
                        type="button"
                      >
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function newRecipeItem(): RecipeItemDraft {
  return {
    id: crypto.randomUUID(),
    name: '',
    quantity: '',
    quantityUnit: 'g',
    pricePerUnit: '',
  }
}
