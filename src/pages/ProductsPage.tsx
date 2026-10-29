import { useEffect, useState, type FormEvent } from 'react'
import { Feedback } from '../components/Feedback'
import { PageHeading } from '../components/PageHeading'
import { UnitSelect } from '../components/UnitSelect'
import {
  deleteProduct,
  listAllDirectCosts,
  listAllRecipeItems,
  listIngredients,
  listProducts,
  saveProduct,
} from '../db/repository'
import { calculateProductCost, type ProductCostBreakdown } from '../lib/cost'
import { formatCurrency, formatNumber } from '../lib/format'
import { unitLabels } from '../lib/units'
import type { MeasurementUnit, Product } from '../types'
import styles from './Pages.module.css'

interface ProductForm {
  name: string
  description: string
  outputQuantity: string
  outputUnit: MeasurementUnit
}

interface ProductRow {
  product: Product
  cost: ProductCostBreakdown
}

const emptyForm: ProductForm = {
  name: '',
  description: '',
  outputQuantity: '1',
  outputUnit: 'pcs',
}

interface ProductsPageProps {
  onOpenProduct: (id: string) => void
}

export function ProductsPage({ onOpenProduct }: ProductsPageProps) {
  const [rows, setRows] = useState<ProductRow[]>([])
  const [form, setForm] = useState<ProductForm>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
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
      setRows(
        products.map((product) => ({
          product,
          cost: calculateProductCost(product, recipeItems, ingredients, directCosts),
        })),
      )
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось загрузить продукты и их себестоимость.'))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  function startCreate(): void {
    setEditingId(null)
    setForm(emptyForm)
    setIsFormOpen(true)
    setError(null)
  }

  function startEdit(product: Product): void {
    setEditingId(product.id)
    setForm({
      name: product.name,
      description: product.description,
      outputQuantity: String(product.outputQuantity),
      outputUnit: product.outputUnit,
    })
    setIsFormOpen(true)
    setError(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const outputQuantity = Number(form.outputQuantity)
    if (!Number.isFinite(outputQuantity) || outputQuantity <= 0) {
      setError('Количество готовой продукции должно быть больше нуля.')
      return
    }

    try {
      await saveProduct({
        id: editingId ?? crypto.randomUUID(),
        name: form.name.trim(),
        description: form.description.trim(),
        outputQuantity,
        outputUnit: form.outputUnit,
      })
      setIsFormOpen(false)
      setEditingId(null)
      setForm(emptyForm)
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
        title="Продукты"
        description="Блюда и готовые позиции с рассчитанной себестоимостью."
      >
        <button className={styles.buttonPrimary} onClick={startCreate} type="button">
          Добавить продукт
        </button>
      </PageHeading>

      <Feedback error={error} />

      {isFormOpen && (
        <form className={styles.formCard} onSubmit={(event) => void submit(event)}>
          <div className={styles.formTitle}>
            <h2>{editingId ? 'Изменить продукт' : 'Новый продукт'}</h2>
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
              <span>Название</span>
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
              <span>Выход продукции</span>
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
          </div>
          <div className={styles.formActions}>
            <button className={styles.buttonPrimary} type="submit">
              Сохранить
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
          <h2>Пока нет продуктов</h2>
          <p>Создайте продукт, затем добавьте к нему рецепт и затраты.</p>
        </div>
      ) : (
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Продукт</th>
                <th scope="col">Себестоимость</th>
                <th scope="col">На единицу</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ product, cost }) => (
                <tr key={product.id}>
                  <th scope="row">
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
                  </th>
                  <td>{formatCurrency(cost.total)}</td>
                  <td>{formatCurrency(cost.perUnit)}</td>
                  <td className={styles.rowActions}>
                    <button
                      className={styles.textButton}
                      onClick={() => startEdit(product)}
                      type="button"
                    >
                      Изменить
                    </button>
                    <button
                      className={styles.textButtonDanger}
                      onClick={() => void remove(product)}
                      type="button"
                    >
                      Удалить
                    </button>
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
