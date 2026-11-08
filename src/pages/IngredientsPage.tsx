import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Feedback } from '../components/Feedback'
import { PageHeading } from '../components/PageHeading'
import { UnitSelect } from '../components/UnitSelect'
import {
  deleteIngredient,
  listIngredients,
  saveIngredient,
  subscribeToDataChanges,
} from '../db/repository'
import { formatCurrency, formatNumber } from '../lib/format'
import { createId } from '../lib/id'
import { unitLabels } from '../lib/units'
import type { Ingredient, MeasurementUnit } from '../types'
import styles from './Pages.module.css'

interface IngredientForm {
  name: string
  unit: MeasurementUnit
  quantity: string
  totalPrice: string
  gramsPerMl: string
  gramsPerPiece: string
}

const emptyForm: IngredientForm = {
  name: '',
  unit: 'g',
  quantity: '',
  totalPrice: '',
  gramsPerMl: '',
  gramsPerPiece: '',
}

export function IngredientsPage() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [form, setForm] = useState<IngredientForm>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setIngredients(await listIngredients())
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось загрузить ингредиенты.'))
    }
  }, [])

  useEffect(() => {
    void refresh()
    return subscribeToDataChanges(() => {
      void refresh()
    })
  }, [refresh])

  function startCreate(): void {
    setEditingId(null)
    setForm(emptyForm)
    setIsFormOpen(true)
    setError(null)
  }

  function startEdit(ingredient: Ingredient): void {
    setEditingId(ingredient.id)
    setForm({
      name: ingredient.name,
      unit: ingredient.unit,
      quantity: ingredient.hasPrice ? String(ingredient.purchaseQuantity) : '',
      totalPrice: ingredient.hasPrice ? String(ingredient.purchasePrice) : '',
      gramsPerMl:
        ingredient.gramsPerMl !== null && ingredient.gramsPerMl !== undefined
          ? String(ingredient.gramsPerMl)
          : '',
      gramsPerPiece:
        ingredient.gramsPerPiece !== null &&
        ingredient.gramsPerPiece !== undefined
          ? String(ingredient.gramsPerPiece)
          : '',
    })
    setIsFormOpen(true)
    setError(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const hasQuantity = form.quantity.trim() !== ''
    const hasTotalPrice = form.totalPrice.trim() !== ''
    if (hasQuantity !== hasTotalPrice) {
      setError('Укажите и количество, и общую цену либо оставьте оба поля пустыми.')
      return
    }
    const hasPrice = hasQuantity && hasTotalPrice
    const quantity = hasPrice ? Number(form.quantity) : 1
    const totalPrice = hasPrice ? Number(form.totalPrice) : 0
    if (hasPrice && (!Number.isFinite(quantity) || quantity <= 0)) {
      setError('Количество должно быть больше нуля.')
      return
    }
    if (hasPrice && (!Number.isFinite(totalPrice) || totalPrice < 0)) {
      setError('Укажите корректную цену, не меньше нуля.')
      return
    }
    const gramsPerMl =
      form.gramsPerMl.trim() === '' ? null : Number(form.gramsPerMl)
    if (
      gramsPerMl !== null &&
      (!Number.isFinite(gramsPerMl) || gramsPerMl <= 0)
    ) {
      setError('Плотность (г в 1 мл) должна быть положительным числом.')
      return
    }
    const gramsPerPiece =
      form.gramsPerPiece.trim() === '' ? null : Number(form.gramsPerPiece)
    if (
      gramsPerPiece !== null &&
      (!Number.isFinite(gramsPerPiece) || gramsPerPiece <= 0)
    ) {
      setError('Вес 1 шт. (г) должен быть положительным числом.')
      return
    }

    const pricePerUnit = hasPrice ? totalPrice / quantity : 0

    try {
      await saveIngredient({
        id: editingId ?? createId(),
        name: form.name.trim(),
        unit: form.unit,
        purchaseQuantity: quantity,
        purchasePrice: totalPrice,
        pricePerUnit,
        hasPrice,
        gramsPerMl,
        gramsPerPiece,
      })
      setIsFormOpen(false)
      setEditingId(null)
      setForm(emptyForm)
      setError(null)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось сохранить ингредиент.'))
    }
  }

  async function remove(ingredient: Ingredient): Promise<void> {
    if (!window.confirm(`Удалить ингредиент «${ingredient.name}»?`)) return
    try {
      await deleteIngredient(ingredient.id)
      setError(null)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось удалить ингредиент.'))
    }
  }

  return (
    <section>
      <PageHeading
        title="Ингредиенты"
        description="Справочник сырья и продуктов закупки. Цена за единицу рассчитывается автоматически."
      >
        <button className={styles.buttonPrimary} onClick={startCreate} type="button">
          Добавить ингредиент
        </button>
      </PageHeading>

      <Feedback error={error} />

      {isFormOpen && (
        <form className={styles.formCard} onSubmit={(event) => void submit(event)}>
          <div className={styles.formTitle}>
            <h2>{editingId ? 'Изменить ингредиент' : 'Новый ингредиент'}</h2>
            <button
              aria-label="Закрыть форму"
              className={styles.iconButton}
              onClick={() => setIsFormOpen(false)}
              type="button"
            >
              ×
            </button>
          </div>
          <div className={`${styles.formGrid} ${styles.productFormGrid}`}>
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
            <UnitSelect
              label="Единица закупки"
              onChange={(unit) => setForm({ ...form, unit })}
              value={form.unit}
            />
            <label className={styles.field}>
              <span>Количество ({unitLabels[form.unit]})</span>
              <input
                min="0"
                onChange={(event) =>
                  setForm({ ...form, quantity: event.currentTarget.value })
                }
                step="any"
                type="number"
                value={form.quantity}
              />
            </label>
            <label className={styles.field}>
              <span>Цена за упаковку (необязательно)</span>
              <input
                min="0"
                onChange={(event) =>
                  setForm({ ...form, totalPrice: event.currentTarget.value })
                }
                step="any"
                type="number"
                value={form.totalPrice}
              />
            </label>
            <div className={styles.calculatedPrice} aria-live="polite">
              <span>Цена за {unitLabels[form.unit]}</span>
              <strong>
                {form.quantity !== '' &&
                form.totalPrice !== '' &&
                Number(form.quantity) > 0 &&
                Number.isFinite(Number(form.totalPrice) / Number(form.quantity))
                  ? formatCurrency(Number(form.totalPrice) / Number(form.quantity))
                  : 'Не указана'}
              </strong>
            </div>
          </div>

          <div className={`${styles.formGrid} ${styles.conversionFieldsGrid}`}>
            <label className={styles.field}>
              <span>Плотность: г в 1 мл (для перевода г ↔ мл)</span>
              <input
                min="0"
                onChange={(event) =>
                  setForm({ ...form, gramsPerMl: event.currentTarget.value })
                }
                placeholder="Напр. 1.03 молоко, 0.92 масло"
                step="any"
                type="number"
                value={form.gramsPerMl}
              />
            </label>
            <label className={styles.field}>
              <span>Вес 1 шт. в граммах (для перевода шт. ↔ г)</span>
              <input
                min="0"
                onChange={(event) =>
                  setForm({ ...form, gramsPerPiece: event.currentTarget.value })
                }
                placeholder="Напр. 55 яйцо С1"
                step="any"
                type="number"
                value={form.gramsPerPiece}
              />
            </label>
          </div>

          <p className={styles.mutedText}>
            Чтобы добавить ингредиент без цены, оставьте количество и цену пустыми.
            Плотность и вес 1 шт. позволяют в рецептах переводить массу в объём или штуки.
          </p>
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

      {ingredients.length === 0 ? (
        <div className={styles.emptyState}>
          <h2>Пока нет ингредиентов</h2>
          <p>Добавьте ингредиенты здесь или прямо при составлении рецепта.</p>
        </div>
      ) : (
        <div className={styles.tableCard}>
          <table className={`${styles.table} ${styles.stickyFirstColumn}`}>
            <thead>
              <tr>
                <th scope="col">Ингредиент</th>
                <th scope="col">Упаковка</th>
                <th scope="col">Цена покупки</th>
                <th scope="col">Цена за единицу</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ingredients.map((ingredient) => {
                const bridgeNotes: string[] = []
                if (ingredient.gramsPerMl) {
                  bridgeNotes.push(`1 мл = ${formatNumber(ingredient.gramsPerMl)} г`)
                }
                if (ingredient.gramsPerPiece) {
                  bridgeNotes.push(`1 шт. = ${formatNumber(ingredient.gramsPerPiece)} г`)
                }
                return (
                  <tr key={ingredient.id}>
                    <th scope="row">
                      {ingredient.name}
                      {bridgeNotes.length > 0 && (
                        <span className={styles.rowSubtitle}>
                          {bridgeNotes.join(' · ')}
                        </span>
                      )}
                    </th>
                    <td>
                      {ingredient.hasPrice
                        ? `${formatNumber(ingredient.purchaseQuantity)} ${unitLabels[ingredient.unit]}`
                        : '—'}
                    </td>
                    <td>
                      {ingredient.hasPrice
                        ? formatCurrency(ingredient.purchasePrice)
                        : 'Не указана'}
                    </td>
                    <td>
                      {ingredient.hasPrice
                        ? `${formatCurrency(ingredient.pricePerUnit)}/${unitLabels[ingredient.unit]}`
                        : 'Не указана'}
                    </td>
                    <td className={styles.tableRowActions}>
                      <div className={styles.rowActionStack}>
                        <button
                          className={styles.tableActionButton}
                          onClick={() => startEdit(ingredient)}
                          type="button"
                        >
                          Изменить
                        </button>
                        <button
                          className={`${styles.tableActionButton} ${styles.tableActionButtonDanger}`}
                          onClick={() => void remove(ingredient)}
                          type="button"
                        >
                          Удалить
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
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
