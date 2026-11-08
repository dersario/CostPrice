import { useCallback, useEffect, useState, type FormEvent } from 'react'
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
  subscribeToDataChanges,
} from '../db/repository'
import { calculateProductCost, type ProductCostBreakdown } from '../lib/cost'
import { formatCurrency, formatNumber } from '../lib/format'
import { createId } from '../lib/id'
import {
  compatibleUnits,
  isMeasurementUnit,
  measurementUnits,
  unitLabels,
} from '../lib/units'
import type {
  Ingredient,
  MarkupType,
  MeasurementUnit,
  Product,
  RecipeItemType,
} from '../types'
import styles from './Pages.module.css'

interface RecipeItemDraft {
  id: string
  itemType: RecipeItemType
  subProductId: string
  name: string
  quantity: string
  quantityUnit: MeasurementUnit
  pricePerUnit: string
  priceUnit: MeasurementUnit
}

interface ProductForm {
  name: string
  description: string
  outputQuantity: string
  outputUnit: MeasurementUnit
  panDiameterCm: string
  markupType: MarkupType
  markupValue: string
  recipeItems: RecipeItemDraft[]
}

interface ProductRow {
  product: Product
  cost: ProductCostBreakdown
  unpricedCount: number
  missingCount: number
}

const emptyForm: ProductForm = {
  name: '',
  description: '',
  outputQuantity: '1',
  outputUnit: 'pcs',
  panDiameterCm: '',
  markupType: 'absolute',
  markupValue: '0',
  recipeItems: [],
}

interface ProductsPageProps {
  onOpenProduct: (id: string) => void
}

export function ProductsPage({ onOpenProduct }: ProductsPageProps) {
  const [rows, setRows] = useState<ProductRow[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [form, setForm] = useState<ProductForm>(emptyForm)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [allProducts, allIngredients, recipeItems, directCosts] =
        await Promise.all([
          listProducts(),
          listIngredients(),
          listAllRecipeItems(),
          listAllDirectCosts(),
        ])
      setProducts(allProducts)
      setIngredients(allIngredients)
      setRows(
        allProducts.map((product) => {
          const productRecipe = recipeItems.filter(
            (item) => item.productId === product.id,
          )
          const cost = calculateProductCost(
            product,
            recipeItems,
            allIngredients,
            directCosts,
            allProducts,
          )
          const unpricedCount = productRecipe.filter((item) => {
            if (item.itemType === 'product') return false
            const ing = allIngredients.find(
              (ingredient) => ingredient.id === item.ingredientId,
            )
            return ing ? !ing.hasPrice : false
          }).length
          return {
            product,
            cost,
            unpricedCount,
            missingCount: cost.missingItems.length,
          }
        }),
      )
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось загрузить рецепты и их себестоимость.'))
    }
  }, [])

  useEffect(() => {
    void refresh()
    return subscribeToDataChanges(() => {
      void refresh()
    })
  }, [refresh])

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
      setError('Значение наценки/маржи должно быть неотрицательным числом.')
      return
    }
    if (form.markupType === 'margin' && markupValue >= 100) {
      setError('Целевая маржа должна быть меньше 100%.')
      return
    }
    if (form.markupType === 'foodCost' && (markupValue <= 0 || markupValue > 100)) {
      setError('Целевой фудкост должен быть больше 0% и не более 100%.')
      return
    }
    const panDiameterCm =
      form.panDiameterCm.trim() === '' ? null : Number(form.panDiameterCm)
    if (
      panDiameterCm !== null &&
      (!Number.isFinite(panDiameterCm) || panDiameterCm <= 0)
    ) {
      setError('Диаметр формы должен быть положительным числом.')
      return
    }

    for (const item of form.recipeItems) {
      if (item.itemType === 'product') {
        if (!item.subProductId) {
          setError('Выберите полуфабрикат в строке рецепта.')
          return
        }
      } else if (!item.name.trim()) {
        setError('Укажите название ингредиента для каждой строки рецепта.')
        return
      }
      const quantity = Number(item.quantity)
      if (!Number.isFinite(quantity) || quantity < 0) {
        setError('Укажите корректное количество в рецепте.')
        return
      }
      if (
        item.itemType === 'ingredient' &&
        item.pricePerUnit.trim() !== '' &&
        (!Number.isFinite(Number(item.pricePerUnit)) ||
          Number(item.pricePerUnit) < 0)
      ) {
        setError('Цена ингредиента должна быть неотрицательным числом.')
        return
      }
    }

    try {
      const product = {
        id: createId(),
        name: form.name.trim(),
        description: form.description.trim(),
        outputQuantity,
        outputUnit: form.outputUnit,
        panDiameterCm,
        markupType: form.markupType,
        markupValue,
      }
      await createProductWithRecipe(
        product,
        form.recipeItems.map((item) => ({
          id: item.id,
          itemType: item.itemType,
          subProductId: item.itemType === 'product' ? item.subProductId : undefined,
          ingredientName: item.name.trim(),
          quantity: Number(item.quantity),
          quantityUnit: item.quantityUnit,
          pricePerUnit:
            item.itemType === 'ingredient' && item.pricePerUnit.trim() !== ''
              ? Number(item.pricePerUnit)
              : null,
          priceUnit: item.priceUnit,
        })),
      )
      setIsFormOpen(false)
      setForm({ ...emptyForm, recipeItems: [] })
      setError(null)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось сохранить рецепт.'))
    }
  }

  async function remove(product: Product): Promise<void> {
    if (!window.confirm(`Удалить рецепт «${product.name}»?`)) return
    try {
      await deleteProduct(product.id)
      setError(null)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось удалить рецепт.'))
    }
  }

  return (
    <section>
      <PageHeading
        title="Рецепты"
        description="Сохранённые рецепты, полуфабрикаты и их рассчитанная себестоимость."
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
              <span>Диаметр формы, см (необяз.)</span>
              <input
                min="0"
                onChange={(event) =>
                  setForm({ ...form, panDiameterCm: event.currentTarget.value })
                }
                placeholder="Напр. 18"
                step="any"
                type="number"
                value={form.panDiameterCm}
              />
            </label>
            <label className={styles.field}>
              <span>Способ расчёта цены</span>
              <select
                onChange={(event) => {
                  const val = event.currentTarget.value as MarkupType
                  setForm({
                    ...form,
                    markupType: val,
                    markupValue:
                      val === 'foodCost' && form.markupValue === '0'
                        ? '30'
                        : form.markupValue,
                  })
                }}
                value={form.markupType}
              >
                <option value="absolute">Фиксированная наценка (₽)</option>
                <option value="percentage">Наценка (% от себестоимости)</option>
                <option value="margin">Целевая маржа (% от цены)</option>
                <option value="foodCost">Целевой фудкост (% от цены)</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>{markupLabel(form.markupType)}</span>
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
                <h2>Состав рецепта</h2>
                <p>
                  Добавляйте ингредиенты (справочник создаётся автоматически) или
                  готовые полуфабрикаты из ваших рецептов.
                </p>
              </div>
              <div className={styles.formActions}>
                <button
                  className={styles.buttonSecondary}
                  onClick={() => {
                    setForm({
                      ...form,
                      recipeItems: [...form.recipeItems, newRecipeItem('ingredient')],
                    })
                  }}
                  type="button"
                >
                  + Ингредиент
                </button>
                {products.length > 0 && (
                  <button
                    className={styles.buttonSecondary}
                    onClick={() => {
                      const firstSub = products[0]
                      setForm({
                        ...form,
                        recipeItems: [
                          ...form.recipeItems,
                          {
                            ...newRecipeItem('product'),
                            subProductId: firstSub.id,
                            quantityUnit: firstSub.outputUnit,
                          },
                        ],
                      })
                    }}
                    type="button"
                  >
                    + Полуфабрикат
                  </button>
                )}
              </div>
            </div>
            {form.recipeItems.map((item, index) => {
              if (item.itemType === 'product') {
                const selectedSub = products.find((p) => p.id === item.subProductId)
                const subUnits = selectedSub
                  ? compatibleUnits(selectedSub.outputUnit)
                  : measurementUnits
                return (
                  <div className={styles.recipeDraftRow} key={item.id}>
                    <label className={styles.field}>
                      <span>Полуфабрикат (рецепт)</span>
                      <select
                        onChange={(event) => {
                          const subId = event.currentTarget.value
                          const sub = products.find((p) => p.id === subId)
                          setForm({
                            ...form,
                            recipeItems: form.recipeItems.map((draft, rowIndex) =>
                              rowIndex === index
                                ? {
                                    ...draft,
                                    subProductId: subId,
                                    quantityUnit: sub
                                      ? sub.outputUnit
                                      : draft.quantityUnit,
                                  }
                                : draft,
                            ),
                          })
                        }}
                        required
                        value={item.subProductId}
                      >
                        <option value="" disabled>
                          Выберите рецепт…
                        </option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({unitLabels[p.outputUnit]})
                          </option>
                        ))}
                      </select>
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
                        {subUnits.map((unit) => (
                          <option key={unit} value={unit}>
                            {unitLabels[unit]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className={styles.field}>
                      <span>Тип</span>
                      <span className={styles.subrecipeBadge}>Полуфабрикат</span>
                    </div>
                    <button
                      aria-label="Удалить полуфабрикат из рецепта"
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
              }

              const ingredient = ingredients.find(
                (entry) =>
                  entry.name.trim().toLocaleLowerCase() ===
                  item.name.trim().toLocaleLowerCase(),
              )
              const bridge = ingredient
                ? {
                    gramsPerMl: ingredient.gramsPerMl,
                    gramsPerPiece: ingredient.gramsPerPiece,
                  }
                : undefined
              const units = ingredient
                ? compatibleUnits(ingredient.unit, bridge)
                : measurementUnits
              return (
                <div className={styles.recipeDraftRow} key={item.id}>
                  <label className={styles.field}>
                    <span>Ингредиент</span>
                    <IngredientAutocomplete
                      id={`recipe-ingredient-${item.id}`}
                      ingredients={ingredients}
                      onChange={(name) => {
                        const selected = ingredients.find(
                          (entry) =>
                            entry.name.trim().toLocaleLowerCase() ===
                            name.trim().toLocaleLowerCase(),
                        )
                        const selectedBridge = selected
                          ? {
                              gramsPerMl: selected.gramsPerMl,
                              gramsPerPiece: selected.gramsPerPiece,
                            }
                          : undefined
                        const allowed = selected
                          ? compatibleUnits(selected.unit, selectedBridge)
                          : measurementUnits
                        setForm({
                          ...form,
                          recipeItems: form.recipeItems.map((draft, rowIndex) =>
                            rowIndex === index
                              ? {
                                  ...draft,
                                  name,
                                  quantityUnit:
                                    selected && !allowed.includes(draft.quantityUnit)
                                      ? selected.unit
                                      : draft.quantityUnit,
                                  priceUnit: selected
                                    ? selected.unit
                                    : draft.priceUnit,
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
                    <span>Единица количества</span>
                    <select
                      onChange={(event) => {
                        const unit = event.currentTarget.value
                        if (!isMeasurementUnit(unit)) return
                        setForm({
                          ...form,
                          recipeItems: form.recipeItems.map((draft, rowIndex) =>
                            rowIndex === index
                              ? {
                                  ...draft,
                                  quantityUnit: unit,
                                  priceUnit: ingredient ? ingredient.unit : unit,
                                }
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
                  <label className={styles.field}>
                    <span>
                      Цена за 1 {unitLabels[item.priceUnit]} (необяз.)
                    </span>
                    <div className={styles.priceWithUnitGroup}>
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
                            ? `${formatNumber(ingredient.pricePerUnit)} ₽/${unitLabels[ingredient.unit]}`
                            : 'Не указана'
                        }
                        step="any"
                        type="number"
                        value={item.pricePerUnit}
                      />
                      <select
                        aria-label="Единица цены"
                        onChange={(event) => {
                          const unit = event.currentTarget.value
                          if (!isMeasurementUnit(unit)) return
                          setForm({
                            ...form,
                            recipeItems: form.recipeItems.map((draft, rowIndex) =>
                              rowIndex === index
                                ? { ...draft, priceUnit: unit }
                                : draft,
                            ),
                          })
                        }}
                        value={item.priceUnit}
                      >
                        {units.map((unit) => (
                          <option key={unit} value={unit}>
                            ₽/{unitLabels[unit]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </label>
                  <button
                    aria-label={`Удалить ингредиент из рецепта: ${ingredient?.name ?? ''}`}
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
          <p>Создайте рецепт и добавьте в него ингредиенты с нужным количеством.</p>
        </div>
      ) : (
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.recipeNameColumn} scope="col">Рецепт</th>
                <th scope="col">Себестоимость</th>
                <th scope="col">Себестоимость за ед.</th>
                <th scope="col">Цена за ед. (Маржа)</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ product, cost, unpricedCount, missingCount }) => (
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
                      {product.panDiameterCm
                        ? ` · Ø ${formatNumber(product.panDiameterCm)} см`
                        : ''}
                    </span>
                    {unpricedCount > 0 && (
                      <span className={styles.priceWarning}>
                        Без цены: {unpricedCount}
                      </span>
                    )}
                    {missingCount > 0 && (
                      <span className={styles.priceWarning}>
                        {' '}
                        ⚠ Не найдено позиций: {missingCount}
                      </span>
                    )}
                  </th>
                  <td>{formatCurrency(cost.total)}</td>
                  <td>{formatCurrency(cost.perUnit)}</td>
                  <td>
                    <div>{formatCurrency(cost.sellingPricePerUnit)}</div>
                    <span className={styles.rowSubtitle}>
                      Прибыль {formatCurrency(cost.profitPerUnit)} (маржа{' '}
                      {formatNumber(cost.marginPercent)}%)
                    </span>
                  </td>
                  <td className={styles.tableRowActions}>
                    <div className={styles.rowActionStack}>
                      <button
                        aria-label={`Редактировать рецепт: ${product.name}`}
                        className={styles.tableActionButton}
                        onClick={() => onOpenProduct(product.id)}
                        type="button"
                      >
                        <span aria-hidden="true">✎</span>
                        Открыть
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

function markupLabel(type: MarkupType): string {
  switch (type) {
    case 'percentage':
      return 'Наценка (%)'
    case 'margin':
      return 'Целевая маржа (%)'
    case 'foodCost':
      return 'Целевой фудкост (%)'
    case 'absolute':
    default:
      return 'Наценка на единицу (₽)'
  }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function newRecipeItem(itemType: RecipeItemType = 'ingredient'): RecipeItemDraft {
  return {
    id: createId(),
    itemType,
    subProductId: '',
    name: '',
    quantity: '',
    quantityUnit: 'g',
    pricePerUnit: '',
    priceUnit: 'kg',
  }
}
