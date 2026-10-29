import { useEffect, useState, type FormEvent } from 'react'
import { Feedback } from '../components/Feedback'
import { PageHeading } from '../components/PageHeading'
import { UnitSelect } from '../components/UnitSelect'
import { deleteIngredient, listIngredients, saveIngredient } from '../db/repository'
import { formatCurrency } from '../lib/format'
import { unitLabels } from '../lib/units'
import type { Ingredient, MeasurementUnit } from '../types'
import styles from './Pages.module.css'

interface IngredientForm {
  name: string
  unit: MeasurementUnit
  pricePerUnit: string
}

const emptyForm: IngredientForm = {
  name: '',
  unit: 'g',
  pricePerUnit: '',
}

export function IngredientsPage() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [form, setForm] = useState<IngredientForm>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      setIngredients(await listIngredients())
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось загрузить ингредиенты.'))
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

  function startEdit(ingredient: Ingredient): void {
    setEditingId(ingredient.id)
    setForm({
      name: ingredient.name,
      unit: ingredient.unit,
      pricePerUnit: String(ingredient.pricePerUnit),
    })
    setIsFormOpen(true)
    setError(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const pricePerUnit = Number(form.pricePerUnit)
    if (!Number.isFinite(pricePerUnit) || pricePerUnit < 0) {
      setError('Укажите корректную цену, не меньше нуля.')
      return
    }

    try {
      await saveIngredient({
        id: editingId ?? crypto.randomUUID(),
        name: form.name.trim(),
        unit: form.unit,
        pricePerUnit,
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
        description="Справочник закупочных позиций и цен."
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
            <UnitSelect
              label="Единица цены"
              onChange={(unit) => setForm({ ...form, unit })}
              value={form.unit}
            />
            <label className={styles.field}>
              <span>Цена за {unitLabels[form.unit]}</span>
              <input
                min="0"
                onChange={(event) =>
                  setForm({ ...form, pricePerUnit: event.currentTarget.value })
                }
                required
                step="any"
                type="number"
                value={form.pricePerUnit}
              />
            </label>
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

      {ingredients.length === 0 ? (
        <div className={styles.emptyState}>
          <h2>Пока нет ингредиентов</h2>
          <p>Добавьте закупочные позиции — они появятся в рецептах.</p>
        </div>
      ) : (
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Название</th>
                <th scope="col">Единица</th>
                <th scope="col">Цена</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ingredients.map((ingredient) => (
                <tr key={ingredient.id}>
                  <th scope="row">{ingredient.name}</th>
                  <td>{unitLabels[ingredient.unit]}</td>
                  <td>{formatCurrency(ingredient.pricePerUnit)}</td>
                  <td className={styles.rowActions}>
                    <button
                      className={styles.textButton}
                      onClick={() => startEdit(ingredient)}
                      type="button"
                    >
                      Изменить
                    </button>
                    <button
                      className={styles.textButtonDanger}
                      onClick={() => void remove(ingredient)}
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
