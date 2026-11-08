import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Feedback } from '../components/Feedback'
import { IngredientAutocomplete } from '../components/IngredientAutocomplete'
import { PageHeading } from '../components/PageHeading'
import { UnitSelect } from '../components/UnitSelect'
import {
  deleteDirectCost,
  deleteRecipeItem,
  getProduct,
  listAllDirectCosts,
  listAllRecipeItems,
  listDirectCosts,
  listIngredients,
  listProducts,
  listRecipeItems,
  saveDirectCost,
  saveProduct,
  saveRecipeItem,
  scaleProductRecipeInPlace,
  subscribeToDataChanges,
  wouldCreateProductCycle,
} from '../db/repository'
import {
  calculateIngredientCost,
  calculateProductCost,
  scaleMultiplierForPanDiameter,
  type ProductCostBreakdown,
} from '../lib/cost'
import { exportRecipeCsv, printTechCard } from '../lib/export'
import { formatCurrency, formatNumber } from '../lib/format'
import { createId } from '../lib/id'
import { getDefaultHourlyRate } from '../lib/preferences'
import {
  compatibleUnits,
  convertQuantity,
  isMeasurementUnit,
  measurementUnits,
  unitLabels,
} from '../lib/units'
import type {
  DirectCost,
  DirectCostCategory,
  Ingredient,
  MarkupType,
  MeasurementUnit,
  Product,
  RecipeItem,
  RecipeItemType,
} from '../types'
import styles from './Pages.module.css'

interface ProductDetailPageProps {
  productId: string
  onBack: () => void
  onOpenProduct?: (id: string) => void
}

interface ProductDraft {
  name: string
  description: string
  outputQuantity: string
  outputUnit: MeasurementUnit
  panDiameterCm: string
  markupType: MarkupType
  markupValue: string
}

interface RecipeDraft {
  itemType: RecipeItemType
  subProductId: string
  name: string
  quantity: string
  quantityUnit: MeasurementUnit
  pricePerUnit: string
  priceUnit: MeasurementUnit
}

interface DirectCostDraft {
  name: string
  amount: string
  category: DirectCostCategory
  hours: string
  hourlyRate: string
}

const emptyRecipeDraft: RecipeDraft = {
  itemType: 'ingredient',
  subProductId: '',
  name: '',
  quantity: '',
  quantityUnit: 'g',
  pricePerUnit: '',
  priceUnit: 'kg',
}

function createEmptyDirectCostDraft(): DirectCostDraft {
  const defaultRate = getDefaultHourlyRate()
  return {
    name: '',
    amount: '',
    category: 'labor',
    hours: '',
    hourlyRate: defaultRate > 0 ? String(defaultRate) : '',
  }
}

export function ProductDetailPage({
  productId,
  onBack,
  onOpenProduct,
}: ProductDetailPageProps) {
  const [product, setProduct] = useState<Product | null>(null)
  const [allProducts, setAllProducts] = useState<Product[]>([])
  const [allRecipeItems, setAllRecipeItems] = useState<RecipeItem[]>([])
  const [allDirectCosts, setAllDirectCosts] = useState<DirectCost[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [recipeItems, setRecipeItems] = useState<RecipeItem[]>([])
  const [directCosts, setDirectCosts] = useState<DirectCost[]>([])
  const [cost, setCost] = useState<ProductCostBreakdown | null>(null)

  const [productDraft, setProductDraft] = useState<ProductDraft | null>(null)
  const productDraftDirty = useRef(false)
  const initializedForProductId = useRef<string | null>(null)

  const [recipeDraft, setRecipeDraft] = useState<RecipeDraft>(emptyRecipeDraft)
  const [editingRecipeId, setEditingRecipeId] = useState<string | null>(null)
  const [directCostDraft, setDirectCostDraft] = useState<DirectCostDraft>(() =>
    createEmptyDirectCostDraft(),
  )
  const [editingDirectCostId, setEditingDirectCostId] = useState<string | null>(
    null,
  )

  // Scaling state
  const [scaleMode, setScaleMode] = useState<'multiplier' | 'output' | 'diameter'>(
    'multiplier',
  )
  const [scaleMultiplierInput, setScaleMultiplierInput] = useState('1')
  const [scaleTargetOutputInput, setScaleTargetOutputInput] = useState('')
  const [scaleFromDiameterInput, setScaleFromDiameterInput] = useState('18')
  const [scaleToDiameterInput, setScaleToDiameterInput] = useState('22')

  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(
    async (options?: { forceResetDraft?: boolean }): Promise<void> => {
      try {
        const [
          nextProduct,
          nextAllProducts,
          nextIngredients,
          nextRecipeItems,
          nextAllRecipeItems,
          nextDirectCosts,
          nextAllDirectCosts,
        ] = await Promise.all([
          getProduct(productId),
          listProducts(),
          listIngredients(),
          listRecipeItems(productId),
          listAllRecipeItems(),
          listDirectCosts(productId),
          listAllDirectCosts(),
        ])
        if (!nextProduct) {
          setProduct(null)
          setCost(null)
          setError('Рецепт не найден. Возможно, он был удалён.')
          return
        }

        setProduct(nextProduct)
        setAllProducts(nextAllProducts)
        setIngredients(nextIngredients)
        setRecipeItems(nextRecipeItems)
        setAllRecipeItems(nextAllRecipeItems)
        setDirectCosts(nextDirectCosts)
        setAllDirectCosts(nextAllDirectCosts)

        const shouldResetDraft =
          options?.forceResetDraft ||
          initializedForProductId.current !== productId ||
          !productDraftDirty.current

        if (shouldResetDraft) {
          setProductDraft({
            name: nextProduct.name,
            description: nextProduct.description,
            outputQuantity: String(nextProduct.outputQuantity),
            outputUnit: nextProduct.outputUnit,
            panDiameterCm:
              nextProduct.panDiameterCm !== null &&
              nextProduct.panDiameterCm !== undefined
                ? String(nextProduct.panDiameterCm)
                : '',
            markupType: nextProduct.markupType,
            markupValue: String(nextProduct.markupValue),
          })
          productDraftDirty.current = false
          if (initializedForProductId.current !== productId) {
            initializedForProductId.current = productId
            setScaleTargetOutputInput(String(nextProduct.outputQuantity))
            if (nextProduct.panDiameterCm) {
              setScaleFromDiameterInput(String(nextProduct.panDiameterCm))
            }
          }
        }

        setCost(
          calculateProductCost(
            nextProduct,
            nextAllRecipeItems,
            nextIngredients,
            nextAllDirectCosts,
            nextAllProducts,
          ),
        )
      } catch (caught) {
        setError(messageOf(caught, 'Не удалось загрузить рецепт.'))
      }
    },
    [productId],
  )

  useEffect(() => {
    void refresh({ forceResetDraft: true })
    return subscribeToDataChanges(() => {
      void refresh()
    })
  }, [refresh])

  const subrecipeCostsById = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of allProducts) {
      if (p.id === productId) continue
      try {
        const c = calculateProductCost(
          p,
          allRecipeItems,
          ingredients,
          allDirectCosts,
          allProducts,
        )
        map.set(p.id, c.perUnit)
      } catch {
        map.set(p.id, 0)
      }
    }
    return map
  }, [allProducts, allRecipeItems, ingredients, allDirectCosts, productId])

  const activeScaleMultiplier = useMemo(() => {
    if (!product) return 1
    if (scaleMode === 'multiplier') {
      const val = Number(scaleMultiplierInput)
      return Number.isFinite(val) && val > 0 ? val : 1
    }
    if (scaleMode === 'output') {
      const target = Number(scaleTargetOutputInput)
      return Number.isFinite(target) && target > 0 && product.outputQuantity > 0
        ? target / product.outputQuantity
        : 1
    }
    if (scaleMode === 'diameter') {
      const fromD = Number(scaleFromDiameterInput)
      const toD = Number(scaleToDiameterInput)
      if (
        Number.isFinite(fromD) &&
        fromD > 0 &&
        Number.isFinite(toD) &&
        toD > 0
      ) {
        return scaleMultiplierForPanDiameter(fromD, toD)
      }
      return 1
    }
    return 1
  }, [
    product,
    scaleMode,
    scaleMultiplierInput,
    scaleTargetOutputInput,
    scaleFromDiameterInput,
    scaleToDiameterInput,
  ])

  function updateProductDraft(patch: Partial<ProductDraft>): void {
    setProductDraft((prev) => {
      if (!prev) return prev
      productDraftDirty.current = true
      return { ...prev, ...patch }
    })
  }

  async function saveProductDetails(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault()
    if (!product || !productDraft) return

    const outputQuantity = Number(productDraft.outputQuantity)
    if (!Number.isFinite(outputQuantity) || outputQuantity <= 0) {
      setError('Количество на выходе должно быть больше нуля.')
      return
    }
    const markupValue = Number(productDraft.markupValue)
    if (!Number.isFinite(markupValue) || markupValue < 0) {
      setError('Значение наценки/маржи должно быть неотрицательным числом.')
      return
    }
    if (productDraft.markupType === 'margin' && markupValue >= 100) {
      setError('Целевая маржа должна быть меньше 100%.')
      return
    }
    if (
      productDraft.markupType === 'foodCost' &&
      (markupValue <= 0 || markupValue > 100)
    ) {
      setError('Целевой фудкост должен быть больше 0% и не более 100%.')
      return
    }
    const panDiameterCm =
      productDraft.panDiameterCm.trim() === ''
        ? null
        : Number(productDraft.panDiameterCm)
    if (
      panDiameterCm !== null &&
      (!Number.isFinite(panDiameterCm) || panDiameterCm <= 0)
    ) {
      setError('Диаметр формы должен быть положительным числом.')
      return
    }

    try {
      await saveProduct({
        id: product.id,
        name: productDraft.name.trim(),
        description: productDraft.description.trim(),
        outputQuantity,
        outputUnit: productDraft.outputUnit,
        panDiameterCm,
        markupType: productDraft.markupType,
        markupValue,
      })
      productDraftDirty.current = false
      setError(null)
      await refresh({ forceResetDraft: true })
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось сохранить параметры рецепта.'))
    }
  }

  async function applyScalePermanently(): Promise<void> {
    if (!product) return
    if (
      !Number.isFinite(activeScaleMultiplier) ||
      activeScaleMultiplier <= 0 ||
      Math.abs(activeScaleMultiplier - 1) < 1e-6
    ) {
      return
    }
    const nextDiam =
      scaleMode === 'diameter' && Number(scaleToDiameterInput) > 0
        ? Number(scaleToDiameterInput)
        : undefined
    try {
      await scaleProductRecipeInPlace(
        product.id,
        activeScaleMultiplier,
        nextDiam,
      )
      setScaleMultiplierInput('1')
      productDraftDirty.current = false
      await refresh({ forceResetDraft: true })
      setError(null)
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось масштабировать рецепт.'))
    }
  }

  async function saveRecipe(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!product) return
    const quantity = Number(recipeDraft.quantity)
    if (!Number.isFinite(quantity) || quantity < 0) {
      setError('Укажите корректное количество.')
      return
    }
    if (recipeDraft.itemType === 'product') {
      if (!recipeDraft.subProductId) {
        setError('Выберите полуфабрикат.')
        return
      }
    } else if (!recipeDraft.name.trim()) {
      setError('Укажите название ингредиента.')
      return
    }
    const pricePerUnit =
      recipeDraft.itemType === 'ingredient' &&
      recipeDraft.pricePerUnit.trim() !== ''
        ? Number(recipeDraft.pricePerUnit)
        : null
    if (
      pricePerUnit !== null &&
      (!Number.isFinite(pricePerUnit) || pricePerUnit < 0)
    ) {
      setError('Цена ингредиента должна быть неотрицательным числом.')
      return
    }

    try {
      await saveRecipeItem({
        id: editingRecipeId ?? createId(),
        productId: product.id,
        itemType: recipeDraft.itemType,
        subProductId:
          recipeDraft.itemType === 'product'
            ? recipeDraft.subProductId
            : undefined,
        ingredientName: recipeDraft.name.trim(),
        quantity,
        quantityUnit: recipeDraft.quantityUnit,
        pricePerUnit,
        priceUnit: recipeDraft.priceUnit,
      })
      setRecipeDraft(emptyRecipeDraft)
      setEditingRecipeId(null)
      setError(null)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось сохранить строку рецепта.'))
    }
  }

  function editRecipe(item: RecipeItem): void {
    setEditingRecipeId(item.id)
    if (item.itemType === 'product') {
      setRecipeDraft({
        itemType: 'product',
        subProductId: item.ingredientId,
        name: '',
        quantity: String(item.quantity),
        quantityUnit: item.quantityUnit,
        pricePerUnit: '',
        priceUnit: item.quantityUnit,
      })
    } else {
      const ingredient = ingredients.find(
        (entry) => entry.id === item.ingredientId,
      )
      setRecipeDraft({
        itemType: 'ingredient',
        subProductId: '',
        name: ingredient?.name ?? '',
        quantity: String(item.quantity),
        quantityUnit: item.quantityUnit,
        pricePerUnit: '',
        priceUnit: ingredient?.unit ?? item.quantityUnit,
      })
    }
    setError(null)
  }

  async function removeRecipeItem(item: RecipeItem): Promise<void> {
    const itemName =
      item.itemType === 'product'
        ? (allProducts.find((p) => p.id === item.ingredientId)?.name ??
          'полуфабрикат')
        : (ingredients.find((ingredient) => ingredient.id === item.ingredientId)
            ?.name ?? 'ингредиент')
    if (!window.confirm(`Удалить «${itemName}» из рецепта?`)) return

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
    const hours =
      directCostDraft.category === 'labor' &&
      directCostDraft.hours.trim() !== ''
        ? Number(directCostDraft.hours)
        : null
    const hourlyRate =
      directCostDraft.category === 'labor' &&
      directCostDraft.hourlyRate.trim() !== ''
        ? Number(directCostDraft.hourlyRate)
        : null

    if (hours !== null && (!Number.isFinite(hours) || hours <= 0)) {
      setError('Количество часов должно быть больше нуля.')
      return
    }
    if (
      hourlyRate !== null &&
      (!Number.isFinite(hourlyRate) || hourlyRate < 0)
    ) {
      setError('Ставка в час должна быть неотрицательным числом.')
      return
    }

    const computedLaborAmount =
      hours !== null && hourlyRate !== null ? hours * hourlyRate : null
    const amount =
      computedLaborAmount !== null
        ? computedLaborAmount
        : Number(directCostDraft.amount)

    if (!Number.isFinite(amount) || amount < 0) {
      setError('Укажите корректную сумму прямых затрат.')
      return
    }

    try {
      await saveDirectCost({
        id: editingDirectCostId ?? createId(),
        productId: product.id,
        name: directCostDraft.name.trim(),
        amount,
        category: directCostDraft.category,
        hours,
        hourlyRate,
      })
      setDirectCostDraft(createEmptyDirectCostDraft())
      setEditingDirectCostId(null)
      setError(null)
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
      hours:
        directCost.hours !== null && directCost.hours !== undefined
          ? String(directCost.hours)
          : '',
      hourlyRate:
        directCost.hourlyRate !== null && directCost.hourlyRate !== undefined
          ? String(directCost.hourlyRate)
          : '',
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

  const availableSubProducts = useMemo(
    () =>
      allProducts.filter(
        (candidate) =>
          candidate.id !== productId &&
          !wouldCreateProductCycle(productId, candidate.id, allRecipeItems),
      ),
    [allProducts, allRecipeItems, productId],
  )

  const selectedRecipeIngredient = ingredients.find(
    (ingredient) =>
      ingredient.name.trim().toLocaleLowerCase() ===
      recipeDraft.name.trim().toLocaleLowerCase(),
  )
  const selectedIngredientBridge = selectedRecipeIngredient
    ? {
        gramsPerMl: selectedRecipeIngredient.gramsPerMl,
        gramsPerPiece: selectedRecipeIngredient.gramsPerPiece,
      }
    : undefined

  const selectedSubProduct = availableSubProducts.find(
    (p) => p.id === recipeDraft.subProductId,
  )

  const recipeUnits =
    recipeDraft.itemType === 'product'
      ? selectedSubProduct
        ? compatibleUnits(selectedSubProduct.outputUnit)
        : measurementUnits
      : selectedRecipeIngredient
        ? compatibleUnits(selectedRecipeIngredient.unit, selectedIngredientBridge)
        : measurementUnits

  if (!product || !productDraft) {
    return (
      <section>
        <button className={styles.buttonSecondary} onClick={onBack} type="button">
          ← К рецептам
        </button>
        <Feedback error={error} />
      </section>
    )
  }

  return (
    <section>
      <PageHeading
        title={product.name}
        description="Состав рецепта, полуфабрикаты, масштабирование, затраты и экспорт техкарты."
      >
        <button className={styles.buttonSecondary} onClick={onBack} type="button">
          ← К рецептам
        </button>
        {cost && (
          <>
            <button
              className={styles.buttonSecondary}
              onClick={() => {
                try {
                  exportRecipeCsv(
                    product,
                    recipeItems,
                    ingredients,
                    allProducts,
                    directCosts,
                    cost,
                    activeScaleMultiplier,
                  )
                } catch (caught) {
                  setError(messageOf(caught, 'Не удалось выгрузить CSV.'))
                }
              }}
              type="button"
            >
              Экспорт CSV (Excel)
            </button>
            <button
              className={styles.buttonSecondary}
              onClick={() => {
                try {
                  printTechCard(
                    product,
                    recipeItems,
                    ingredients,
                    allProducts,
                    directCosts,
                    cost,
                    subrecipeCostsById,
                    activeScaleMultiplier,
                  )
                } catch (caught) {
                  setError(messageOf(caught, 'Не удалось открыть печать техкарты.'))
                }
              }}
              type="button"
            >
              Печать / PDF техкарты
            </button>
          </>
        )}
      </PageHeading>

      <Feedback error={error} />

      <form
        className={styles.formCard}
        onSubmit={(event) => void saveProductDetails(event)}
      >
        <div className={styles.formTitle}>
          <h2>Параметры рецепта и ценообразование</h2>
          {productDraftDirty.current && (
            <span className={styles.unsavedBadge}>Есть несохранённые изменения</span>
          )}
        </div>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>Название рецепта</span>
            <input
              onChange={(event) =>
                updateProductDraft({ name: event.currentTarget.value })
              }
              required
              value={productDraft.name}
            />
          </label>
          <label className={styles.field}>
            <span>Описание</span>
            <input
              onChange={(event) =>
                updateProductDraft({ description: event.currentTarget.value })
              }
              value={productDraft.description}
            />
          </label>
          <label className={styles.field}>
            <span>Количество на выходе</span>
            <input
              min="0"
              onChange={(event) =>
                updateProductDraft({ outputQuantity: event.currentTarget.value })
              }
              required
              step="any"
              type="number"
              value={productDraft.outputQuantity}
            />
          </label>
          <UnitSelect
            label="Единица выхода"
            onChange={(outputUnit) => updateProductDraft({ outputUnit })}
            value={productDraft.outputUnit}
          />
          <label className={styles.field}>
            <span>Диаметр формы, см (необяз.)</span>
            <input
              min="0"
              onChange={(event) =>
                updateProductDraft({ panDiameterCm: event.currentTarget.value })
              }
              placeholder="Напр. 18"
              step="any"
              type="number"
              value={productDraft.panDiameterCm}
            />
          </label>
          <label className={styles.field}>
            <span>Способ расчёта цены</span>
            <select
              onChange={(event) => {
                const nextType = event.currentTarget.value as MarkupType
                updateProductDraft({
                  markupType: nextType,
                  markupValue:
                    nextType === 'foodCost' && productDraft.markupValue === '0'
                      ? '30'
                      : productDraft.markupValue,
                })
              }}
              value={productDraft.markupType}
            >
              <option value="absolute">Фиксированная наценка (₽)</option>
              <option value="percentage">Наценка (% от себестоимости)</option>
              <option value="margin">Целевая маржа (% от цены)</option>
              <option value="foodCost">Целевой фудкост (% от цены)</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>{markupLabel(productDraft.markupType)}</span>
            <input
              min="0"
              onChange={(event) =>
                updateProductDraft({ markupValue: event.currentTarget.value })
              }
              required
              step="any"
              type="number"
              value={productDraft.markupValue}
            />
          </label>
        </div>
        <div className={styles.formActions}>
          <button className={styles.buttonPrimary} type="submit">
            Сохранить параметры
          </button>
        </div>
      </form>

      <section className={styles.sectionCard}>
        <div className={styles.sectionTitle}>
          <div>
            <h2>Масштабирование рецепта (пересчёт на вес, порции или форму)</h2>
            <p>
              Мгновенно пересчитывает граммовку всех позиций в таблице и техкарте.
              При желании новый масштаб можно сохранить в рецепт.
            </p>
          </div>
          {Math.abs(activeScaleMultiplier - 1) > 1e-4 && (
            <span className={styles.statusPill + ' ' + styles.statusConnected}>
              Масштаб ×{formatNumber(activeScaleMultiplier)} (выход:{' '}
              {formatNumber(product.outputQuantity * activeScaleMultiplier)}{' '}
              {unitLabels[product.outputUnit]})
            </span>
          )}
        </div>

        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>Режим пересчёта</span>
            <select
              onChange={(event) =>
                setScaleMode(
                  event.currentTarget.value as
                    | 'multiplier'
                    | 'output'
                    | 'diameter',
                )
              }
              value={scaleMode}
            >
              <option value="multiplier">Коэффициент (×N)</option>
              <option value="output">
                Под нужный выход ({unitLabels[product.outputUnit]})
              </option>
              <option value="diameter">Круглая форма (по диаметру, см)</option>
            </select>
          </label>

          {scaleMode === 'multiplier' && (
            <label className={styles.field}>
              <span>Коэффициент (напр. 0.5, 1.5, 2)</span>
              <input
                min="0.01"
                onChange={(event) =>
                  setScaleMultiplierInput(event.currentTarget.value)
                }
                step="any"
                type="number"
                value={scaleMultiplierInput}
              />
            </label>
          )}

          {scaleMode === 'output' && (
            <label className={styles.field}>
              <span>
                Желаемый выход ({unitLabels[product.outputUnit]}), сейчас{' '}
                {formatNumber(product.outputQuantity)}
              </span>
              <input
                min="0.01"
                onChange={(event) =>
                  setScaleTargetOutputInput(event.currentTarget.value)
                }
                step="any"
                type="number"
                value={scaleTargetOutputInput}
              />
            </label>
          )}

          {scaleMode === 'diameter' && (
            <>
              <label className={styles.field}>
                <span>Исходный диаметр формы, см</span>
                <input
                  min="1"
                  onChange={(event) =>
                    setScaleFromDiameterInput(event.currentTarget.value)
                  }
                  step="any"
                  type="number"
                  value={scaleFromDiameterInput}
                />
              </label>
              <label className={styles.field}>
                <span>Новый диаметр формы, см</span>
                <input
                  min="1"
                  onChange={(event) =>
                    setScaleToDiameterInput(event.currentTarget.value)
                  }
                  step="any"
                  type="number"
                  value={scaleToDiameterInput}
                />
              </label>
            </>
          )}
        </div>

        {Math.abs(activeScaleMultiplier - 1) > 1e-4 && (
          <div className={styles.formActions}>
            <button
              className={styles.buttonPrimary}
              onClick={() => void applyScalePermanently()}
              type="button"
            >
              Зафиксировать этот масштаб в рецепте (×
              {formatNumber(activeScaleMultiplier)})
            </button>
            <button
              className={styles.buttonSecondary}
              onClick={() => {
                setScaleMode('multiplier')
                setScaleMultiplierInput('1')
              }}
              type="button"
            >
              Сбросить к ×1
            </button>
          </div>
        )}
      </section>

      <section className={styles.sectionCard}>
        <div className={styles.sectionTitle}>
          <div>
            <h2>Состав рецепта</h2>
            <p>
              Добавляйте ингредиенты по названию или включайте полуфабрикат (другой
              рецепт). Цена пересчитывается с учётом выбранной единицы.
            </p>
          </div>
        </div>

        <form className={styles.inlineForm} onSubmit={(event) => void saveRecipe(event)}>
          <label className={styles.field}>
            <span>Тип позиции</span>
            <select
              onChange={(event) => {
                const nextType = event.currentTarget.value as RecipeItemType
                if (nextType === 'product') {
                  const first = availableSubProducts[0]
                  setRecipeDraft({
                    ...recipeDraft,
                    itemType: 'product',
                    subProductId: first?.id ?? '',
                    quantityUnit: first?.outputUnit ?? 'g',
                  })
                } else {
                  setRecipeDraft({
                    ...recipeDraft,
                    itemType: 'ingredient',
                    subProductId: '',
                  })
                }
              }}
              value={recipeDraft.itemType}
            >
              <option value="ingredient">Ингредиент</option>
              <option
                disabled={availableSubProducts.length === 0}
                value="product"
              >
                Полуфабрикат (рецепт)
              </option>
            </select>
          </label>

          {recipeDraft.itemType === 'product' ? (
            <label className={styles.field}>
              <span>Полуфабрикат</span>
              <select
                onChange={(event) => {
                  const subId = event.currentTarget.value
                  const sub = availableSubProducts.find((p) => p.id === subId)
                  setRecipeDraft({
                    ...recipeDraft,
                    subProductId: subId,
                    quantityUnit: sub ? sub.outputUnit : recipeDraft.quantityUnit,
                  })
                }}
                required
                value={recipeDraft.subProductId}
              >
                <option value="" disabled>
                  Выберите рецепт…
                </option>
                {availableSubProducts.map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    {sub.name} (выход {formatNumber(sub.outputQuantity)}{' '}
                    {unitLabels[sub.outputUnit]})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className={styles.field}>
              <span>Ингредиент</span>
              <IngredientAutocomplete
                id={`recipe-ingredient-${productId}`}
                ingredients={ingredients}
                onChange={(name) => {
                  const ingredient = ingredients.find(
                    (item) =>
                      item.name.trim().toLocaleLowerCase() ===
                      name.trim().toLocaleLowerCase(),
                  )
                  const bridge = ingredient
                    ? {
                        gramsPerMl: ingredient.gramsPerMl,
                        gramsPerPiece: ingredient.gramsPerPiece,
                      }
                    : undefined
                  const allowed = ingredient
                    ? compatibleUnits(ingredient.unit, bridge)
                    : measurementUnits
                  setRecipeDraft({
                    ...recipeDraft,
                    name,
                    quantityUnit:
                      ingredient && !allowed.includes(recipeDraft.quantityUnit)
                        ? ingredient.unit
                        : recipeDraft.quantityUnit,
                    priceUnit: ingredient
                      ? ingredient.unit
                      : recipeDraft.priceUnit,
                  })
                }}
                required
                value={recipeDraft.name}
              />
            </label>
          )}

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
                  setRecipeDraft({
                    ...recipeDraft,
                    quantityUnit: unit,
                    priceUnit: selectedRecipeIngredient
                      ? selectedRecipeIngredient.unit
                      : unit,
                  })
                }
              }}
              value={recipeDraft.quantityUnit}
            >
              {recipeUnits.map((unit) => (
                <option key={unit} value={unit}>
                  {unitLabels[unit]}
                </option>
              ))}
            </select>
          </label>

          {recipeDraft.itemType === 'ingredient' && (
            <label className={styles.field}>
              <span>
                Цена за 1 {unitLabels[recipeDraft.priceUnit]} (необяз.)
              </span>
              <div className={styles.priceWithUnitGroup}>
                <input
                  min="0"
                  onChange={(event) =>
                    setRecipeDraft({
                      ...recipeDraft,
                      pricePerUnit: event.currentTarget.value,
                    })
                  }
                  placeholder={
                    selectedRecipeIngredient?.hasPrice
                      ? `${formatNumber(selectedRecipeIngredient.pricePerUnit)} ₽/${unitLabels[selectedRecipeIngredient.unit]}`
                      : 'Не указана'
                  }
                  step="any"
                  type="number"
                  value={recipeDraft.pricePerUnit}
                />
                <select
                  aria-label="Единица цены"
                  onChange={(event) => {
                    const unit = event.currentTarget.value
                    if (isMeasurementUnit(unit)) {
                      setRecipeDraft({ ...recipeDraft, priceUnit: unit })
                    }
                  }}
                  value={recipeDraft.priceUnit}
                >
                  {recipeUnits.map((unit) => (
                    <option key={unit} value={unit}>
                      ₽/{unitLabels[unit]}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          )}

          <div className={styles.formActions}>
            <button className={styles.buttonPrimary} type="submit">
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
          <p className={styles.mutedText}>В рецепте пока нет позиций.</p>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Позиция</th>
                    <th scope="col">
                      Количество
                      {Math.abs(activeScaleMultiplier - 1) > 1e-4
                        ? ` (×${formatNumber(activeScaleMultiplier)})`
                        : ''}
                    </th>
                    <th scope="col">Цена за единицу</th>
                    <th scope="col">Сумма</th>
                    <th scope="col">
                      <span className={styles.visuallyHidden}>Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recipeItems.map((item) => {
                    const scaledQty = item.quantity * activeScaleMultiplier

                    if (item.itemType === 'product') {
                      const subProduct = allProducts.find(
                        (entry) => entry.id === item.ingredientId,
                      )
                      if (!subProduct) {
                        return (
                          <tr key={item.id}>
                            <th scope="row">⚠ Полуфабрикат удалён</th>
                            <td>
                              {formatNumber(scaledQty)}{' '}
                              {unitLabels[item.quantityUnit]}
                            </td>
                            <td>—</td>
                            <td>—</td>
                            <td className={styles.rowActions}>
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
                      }
                      const subPerUnit =
                        subrecipeCostsById.get(subProduct.id) ?? 0
                      let subLineCost = 0
                      try {
                        subLineCost =
                          convertQuantity(
                            scaledQty,
                            item.quantityUnit,
                            subProduct.outputUnit,
                          ) * subPerUnit
                      } catch {
                        subLineCost = 0
                      }
                      return (
                        <tr key={item.id}>
                          <th scope="row">
                            {onOpenProduct ? (
                              <button
                                className={styles.productLink}
                                onClick={() => onOpenProduct(subProduct.id)}
                                type="button"
                              >
                                {subProduct.name}
                              </button>
                            ) : (
                              subProduct.name
                            )}
                            <span className={styles.rowSubtitle}>
                              Полуфабрикат (выход{' '}
                              {formatNumber(subProduct.outputQuantity)}{' '}
                              {unitLabels[subProduct.outputUnit]})
                            </span>
                          </th>
                          <td>
                            {formatNumber(scaledQty)}{' '}
                            {unitLabels[item.quantityUnit]}
                          </td>
                          <td>
                            {formatCurrency(subPerUnit)}/
                            {unitLabels[subProduct.outputUnit]}
                          </td>
                          <td>{formatCurrency(subLineCost)}</td>
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
                    }

                    const ingredient = ingredients.find(
                      (entry) => entry.id === item.ingredientId,
                    )
                    if (!ingredient) {
                      return (
                        <tr key={item.id}>
                          <th scope="row">⚠ Ингредиент не найден</th>
                          <td>
                            {formatNumber(scaledQty)}{' '}
                            {unitLabels[item.quantityUnit]}
                          </td>
                          <td>—</td>
                          <td>—</td>
                          <td className={styles.rowActions}>
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
                    }

                    let lineCost = 0
                    let conversionError = false
                    try {
                      lineCost = calculateIngredientCost(
                        scaledQty,
                        item.quantityUnit,
                        ingredient,
                      )
                    } catch {
                      conversionError = true
                    }

                    return (
                      <tr key={item.id}>
                        <th scope="row">{ingredient.name}</th>
                        <td>
                          {formatNumber(scaledQty)} {unitLabels[item.quantityUnit]}
                        </td>
                        <td>
                          {ingredient.hasPrice
                            ? `${formatCurrency(ingredient.pricePerUnit)}/${unitLabels[ingredient.unit]}`
                            : 'Не указана'}
                        </td>
                        <td>
                          {conversionError
                            ? '⚠ Нужна плотность / вес шт.'
                            : formatCurrency(lineCost)}
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
            {recipeItems.some(
              (item) =>
                item.itemType !== 'product' &&
                !ingredients.find(
                  (ingredient) => ingredient.id === item.ingredientId,
                )?.hasPrice,
            ) && (
              <p className={styles.priceWarning}>
                В себестоимость не включена стоимость ингредиентов без указанной цены.
              </p>
            )}
          </>
        )}
      </section>

      <section className={styles.sectionCard}>
        <div className={styles.sectionTitle}>
          <div>
            <h2>Прямые затраты (труд, упаковка, накладные)</h2>
            <p>
              Для категории «Труд» можно указать часы и ставку в час — сумма
              рассчитается автоматически.
            </p>
          </div>
        </div>

        <form className={styles.inlineForm} onSubmit={(event) => void saveCost(event)}>
          <label className={styles.field}>
            <span>Категория</span>
            <select
              onChange={(event) => {
                const category = event.currentTarget.value as DirectCostCategory
                if (
                  category === 'labor' ||
                  category === 'packaging' ||
                  category === 'overhead'
                ) {
                  const defaultRate = getDefaultHourlyRate()
                  setDirectCostDraft({
                    ...directCostDraft,
                    category,
                    hourlyRate:
                      category === 'labor' &&
                      !directCostDraft.hourlyRate &&
                      defaultRate > 0
                        ? String(defaultRate)
                        : directCostDraft.hourlyRate,
                  })
                }
              }}
              value={directCostDraft.category}
            >
              <option value="labor">Труд</option>
              <option value="packaging">Упаковка и расходники</option>
              <option value="overhead">Накладные</option>
            </select>
          </label>

          <label className={styles.field}>
            <span>Название</span>
            <input
              onChange={(event) =>
                setDirectCostDraft({
                  ...directCostDraft,
                  name: event.currentTarget.value,
                })
              }
              placeholder={
                directCostDraft.category === 'packaging'
                  ? 'Коробка, подложка, лента'
                  : directCostDraft.category === 'labor'
                    ? 'Выпечка и сборка'
                    : 'Электроэнергия, амортизация'
              }
              required
              value={directCostDraft.name}
            />
          </label>

          {directCostDraft.category === 'labor' && (
            <>
              <label className={styles.field}>
                <span>Часы (необяз.)</span>
                <input
                  min="0"
                  onChange={(event) => {
                    const hours = event.currentTarget.value
                    const h = Number(hours)
                    const r = Number(directCostDraft.hourlyRate)
                    setDirectCostDraft({
                      ...directCostDraft,
                      hours,
                      amount:
                        hours.trim() !== '' &&
                        directCostDraft.hourlyRate.trim() !== '' &&
                        Number.isFinite(h * r)
                          ? String(Math.round(h * r * 100) / 100)
                          : directCostDraft.amount,
                    })
                  }}
                  placeholder="Напр. 2.5"
                  step="any"
                  type="number"
                  value={directCostDraft.hours}
                />
              </label>
              <label className={styles.field}>
                <span>Ставка ₽/ч (необяз.)</span>
                <input
                  min="0"
                  onChange={(event) => {
                    const hourlyRate = event.currentTarget.value
                    const h = Number(directCostDraft.hours)
                    const r = Number(hourlyRate)
                    setDirectCostDraft({
                      ...directCostDraft,
                      hourlyRate,
                      amount:
                        directCostDraft.hours.trim() !== '' &&
                        hourlyRate.trim() !== '' &&
                        Number.isFinite(h * r)
                          ? String(Math.round(h * r * 100) / 100)
                          : directCostDraft.amount,
                    })
                  }}
                  placeholder="Напр. 500"
                  step="any"
                  type="number"
                  value={directCostDraft.hourlyRate}
                />
              </label>
            </>
          )}

          <label className={styles.field}>
            <span>Итого сумма, ₽</span>
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

          <div className={styles.formActions}>
            <button className={styles.buttonPrimary} type="submit">
              {editingDirectCostId ? 'Сохранить затраты' : 'Добавить затраты'}
            </button>
            {editingDirectCostId && (
              <button
                className={styles.buttonSecondary}
                onClick={() => {
                  setEditingDirectCostId(null)
                  setDirectCostDraft(createEmptyDirectCostDraft())
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
            {directCosts.map((directCost) => {
              const catName =
                directCost.category === 'labor'
                  ? 'Труд'
                  : directCost.category === 'packaging'
                    ? 'Упаковка'
                    : 'Накладные'
              const laborDetail =
                directCost.category === 'labor' &&
                directCost.hours &&
                directCost.hourlyRate !== null &&
                directCost.hourlyRate !== undefined
                  ? ` · ${formatNumber(directCost.hours)} ч × ${formatCurrency(directCost.hourlyRate)}/ч`
                  : ''
              return (
                <div className={styles.costListRow} key={directCost.id}>
                  <div>
                    <strong>{directCost.name}</strong>
                    <span className={styles.rowSubtitle}>
                      {catName}
                      {laborDetail}
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
              )
            })}
          </div>
        )}
      </section>

      {cost && (
        <section className={styles.summaryCard}>
          <h2>
            Итоговая калькуляция
            {Math.abs(activeScaleMultiplier - 1) > 1e-4
              ? ` (масштаб ×${formatNumber(activeScaleMultiplier)})`
              : ''}
          </h2>
          <dl className={styles.summaryList}>
            <div>
              <dt>Сырьё (ингредиенты)</dt>
              <dd>{formatCurrency(cost.materials * activeScaleMultiplier)}</dd>
            </div>
            {cost.subrecipes > 0 && (
              <div>
                <dt>Полуфабрикаты</dt>
                <dd>{formatCurrency(cost.subrecipes * activeScaleMultiplier)}</dd>
              </div>
            )}
            <div>
              <dt>Труд</dt>
              <dd>{formatCurrency(cost.labor)}</dd>
            </div>
            <div>
              <dt>Упаковка и расходники</dt>
              <dd>{formatCurrency(cost.packaging * activeScaleMultiplier)}</dd>
            </div>
            <div>
              <dt>Накладные</dt>
              <dd>{formatCurrency(cost.overhead)}</dd>
            </div>
            <div className={styles.summaryTotal}>
              <dt>Полная себестоимость партии</dt>
              <dd>{formatCurrency(cost.total * activeScaleMultiplier)}</dd>
            </div>
            <div className={styles.summaryPerUnit}>
              <dt>
                Себестоимость за 1 {unitLabels[product.outputUnit]}
              </dt>
              <dd>{formatCurrency(cost.perUnit)}</dd>
            </div>
            <div>
              <dt>{summaryMarkupTitle(product)}</dt>
              <dd>+{formatCurrency(cost.markupPerUnit)} за ед.</dd>
            </div>
            <div className={styles.summaryPerUnit}>
              <dt>
                Цена продажи за 1 {unitLabels[product.outputUnit]}
              </dt>
              <dd>{formatCurrency(cost.sellingPricePerUnit)}</dd>
            </div>
            <div>
              <dt>Цена продажи всей партии</dt>
              <dd>
                {formatCurrency(
                  cost.totalSellingPrice * activeScaleMultiplier,
                )}
              </dd>
            </div>
            <div>
              <dt>Чистая прибыль (за ед. / за партию)</dt>
              <dd>
                {formatCurrency(cost.profitPerUnit)} /{' '}
                {formatCurrency(cost.totalProfit * activeScaleMultiplier)}
              </dd>
            </div>
            <div>
              <dt>Маржинальность / Фудкост</dt>
              <dd>
                Маржа {formatNumber(cost.marginPercent)}% · Фудкост{' '}
                {formatNumber(cost.foodCostPercent)}%
              </dd>
            </div>
          </dl>
        </section>
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

function summaryMarkupTitle(product: Product): string {
  switch (product.markupType) {
    case 'percentage':
      return `Наценка (${formatNumber(product.markupValue)}% от себестоимости)`
    case 'margin':
      return `Наценка (целевая маржа ${formatNumber(product.markupValue)}%)`
    case 'foodCost':
      return `Наценка (целевой фудкост ${formatNumber(product.markupValue)}%)`
    case 'absolute':
    default:
      return 'Фиксированная наценка'
  }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
