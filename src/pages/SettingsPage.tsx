import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Feedback } from '../components/Feedback'
import { PageHeading } from '../components/PageHeading'
import { db } from '../db/database'
import {
  enqueueAllLocalRecordsForSync,
  exportDatabaseBackup,
  importDatabaseBackup,
  subscribeToDataChanges,
  type BackupPayload,
} from '../db/repository'
import { downloadTextFile } from '../lib/export'
import { formatDateTime } from '../lib/format'
import { getDefaultHourlyRate, setDefaultHourlyRate } from '../lib/preferences'
import { accentColors, colorThemes, type ColorTheme } from '../lib/themes'
import {
  clearWorkspaceCode,
  generateRandomWorkspaceCode,
  getWorkspaceCode,
  setWorkspaceCode,
} from '../sync/workspace'
import styles from './Pages.module.css'

interface SettingsPageProps {
  connected: boolean
  configured: boolean
  lastSyncAt: string | null
  syncing: boolean
  syncError: string | null
  queuedCount: number
  onConnectionChange: (connected: boolean) => void
  onSyncNow: (options?: { forceFullPull?: boolean }) => Promise<void>
  theme: ColorTheme
  onThemeChange: (theme: ColorTheme) => void
  customAccent: string | null
  onCustomAccentChange: (color: string | null) => void
  savedCustomAccent: string
  onSavedCustomAccentChange: (color: string) => void
  tableFontSize: number
  onTableFontSizeChange: (size: number) => void
}

export function SettingsPage({
  connected,
  configured,
  lastSyncAt,
  syncing,
  syncError,
  queuedCount,
  onConnectionChange,
  onSyncNow,
  theme,
  onThemeChange,
  customAccent,
  onCustomAccentChange,
  savedCustomAccent,
  onSavedCustomAccentChange,
  tableFontSize,
  onTableFontSizeChange,
}: SettingsPageProps) {
  const [workspaceCode, setCode] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [queueCount, setQueueCount] = useState(queuedCount)
  const [hourlyRateInput, setHourlyRateInput] = useState(() => {
    const r = getDefaultHourlyRate()
    return r > 0 ? String(r) : ''
  })
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [themeError, setThemeError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')

  const selectedPresetAccent = accentColors.some(
    (option) => option.color === customAccent,
  )
    ? customAccent
    : customAccent === null
      ? accentColors[0].color
      : null
  const customAccentSelected = customAccent !== null && selectedPresetAccent === null

  const refreshQueue = useCallback(async (): Promise<void> => {
    try {
      setQueueCount(await db.syncQueue.count())
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось прочитать очередь синхронизации.'))
    }
  }, [])

  useEffect(() => {
    try {
      setCode(getWorkspaceCode())
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось прочитать код рабочей области.'))
    }

    void refreshQueue()

    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    const unsubscribeData = subscribeToDataChanges(() => {
      void refreshQueue()
    })
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      unsubscribeData()
    }
  }, [refreshQueue])

  useEffect(() => {
    setQueueCount(queuedCount)
  }, [queuedCount])

  async function connect(): Promise<void> {
    if (!configured) {
      setError('Синхронизация не настроена: проверьте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY.')
      return
    }

    try {
      const previousCode = getWorkspaceCode()
      setWorkspaceCode(workspaceCode)
      const normalized = getWorkspaceCode()
      setCode(normalized)
      if (previousCode !== normalized) {
        await enqueueAllLocalRecordsForSync()
        await refreshQueue()
      }
      onConnectionChange(true)
      setError(null)
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось подключить рабочую область.'))
    }
  }

  function disconnect(): void {
    try {
      clearWorkspaceCode()
      setCode('')
      onConnectionChange(false)
      setError(null)
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось отключить рабочую область.'))
    }
  }

  async function synchronize(forceFullPull = false): Promise<void> {
    await onSyncNow({ forceFullPull })
    await refreshQueue()
  }

  function saveHourlyRate(): void {
    const val = hourlyRateInput.trim() === '' ? 0 : Number(hourlyRateInput)
    if (!Number.isFinite(val) || val < 0) {
      setError('Ставка в час должна быть неотрицательным числом.')
      return
    }
    try {
      setDefaultHourlyRate(val)
      setBackupMessage('Ставка оплаты труда по умолчанию сохранена.')
      setError(null)
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось сохранить ставку в час.'))
    }
  }

  async function handleExportJson(): Promise<void> {
    try {
      const backup = await exportDatabaseBackup()
      const dateSuffix = new Date().toISOString().slice(0, 10)
      downloadTextFile(
        `costprice-backup-${dateSuffix}.json`,
        JSON.stringify(backup, null, 2),
        'application/json;charset=utf-8',
      )
      setBackupMessage('Резервная копия JSON успешно скачана.')
      setError(null)
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось создать резервную копию.'))
    }
  }

  async function handleImportJson(
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return

    if (
      importMode === 'replace' &&
      !window.confirm(
        'Заменить все текущие данные в браузере данными из файла резервной копии?',
      )
    ) {
      return
    }

    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as BackupPayload
      const stats = await importDatabaseBackup(parsed, importMode)
      await refreshQueue()
      setBackupMessage(
        `Импорт завершён: ингредиентов — ${stats.ingredients}, рецептов — ${stats.products}.`,
      )
      setError(null)
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось импортировать резервную копию.'))
    }
  }

  function selectTheme(nextTheme: ColorTheme): void {
    try {
      localStorage.setItem('recipe-cost.color-theme', nextTheme)
      onThemeChange(nextTheme)
      setThemeError(null)
    } catch (caught) {
      setThemeError(messageOf(caught, 'Не удалось сохранить цветовую схему.'))
    }
  }

  function selectAccent(color: string): void {
    try {
      localStorage.setItem('recipe-cost.custom-accent', color)
      onCustomAccentChange(color)
      setThemeError(null)
    } catch (caught) {
      setThemeError(messageOf(caught, 'Не удалось сохранить цветовой акцент.'))
    }
  }

  function selectCustomAccent(color: string): void {
    try {
      localStorage.setItem('recipe-cost.saved-custom-accent', color)
      localStorage.setItem('recipe-cost.custom-accent', color)
      onSavedCustomAccentChange(color)
      onCustomAccentChange(color)
      setThemeError(null)
    } catch (caught) {
      setThemeError(messageOf(caught, 'Не удалось сохранить свой цвет.'))
    }
  }

  function selectTableFontSize(size: number): void {
    try {
      localStorage.setItem('recipe-cost.table-font-size', String(size))
      onTableFontSizeChange(size)
      setThemeError(null)
    } catch (caught) {
      setThemeError(messageOf(caught, 'Не удалось сохранить размер шрифта таблиц.'))
    }
  }

  return (
    <section>
      <PageHeading
        title="Настройки"
        description="Оформление, расчётные нормативы, резервные копии и синхронизация между устройствами."
      />

      <Feedback error={error ?? themeError ?? syncError} />

      {backupMessage && (
        <div className={styles.notice} role="status">
          <strong>Готово</strong>
          <span>{backupMessage}</span>
        </div>
      )}

      {!configured && (
        <div className={styles.notice}>
          <strong>Supabase не настроен.</strong>
          <span>
            Добавьте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY в .env, чтобы
            включить облачную синхронизацию. Локальные резервные копии JSON
            работают всегда.
          </span>
        </div>
      )}

      <section className={styles.settingsCard + ' ' + styles.themeCard}>
        <div className={styles.sectionTitle}>
          <div>
            <h2>Тема и цветовая палитра</h2>
            <p>
              Выберите светлое или тёмное оформление и настройте цвет акцента.
              Настройки сохраняются в этом браузере.
            </p>
          </div>
        </div>
        <div aria-label="Тема оформления" className={styles.themeChoices} role="group">
          {colorThemes.map((option) => (
            <button
              aria-pressed={theme === option.id}
              className={
                theme === option.id
                  ? `${styles.themeOption} ${styles.themeOptionActive}`
                  : styles.themeOption
              }
              key={option.id}
              onClick={() => selectTheme(option.id)}
              type="button"
            >
              <span
                aria-hidden="true"
                className={`${styles.themePreview} ${styles[`themePreview${option.id}`]}`}
              />
              <span>{option.name}</span>
            </button>
          ))}
        </div>
        <div className={styles.accentSection}>
          <strong>Готовые цвета</strong>
          <div aria-label="Цвет акцента" className={styles.accentChoices} role="group">
            {accentColors.map((option) => (
              <button
                aria-label={option.name}
                aria-pressed={selectedPresetAccent === option.color}
                className={
                  selectedPresetAccent === option.color
                    ? `${styles.accentSwatch} ${styles.accentSwatchActive}`
                    : styles.accentSwatch
                }
                key={option.color}
                onClick={() => selectAccent(option.color)}
                style={{ '--swatch-color': option.color } as React.CSSProperties}
                title={option.name}
                type="button"
              />
            ))}
          </div>
        </div>
        <div className={styles.customAccentSection}>
          <div
            className={
              customAccentSelected
                ? `${styles.customColorChoice} ${styles.customColorChoiceActive}`
                : styles.customColorChoice
            }
          >
            <button
              aria-pressed={customAccentSelected}
              className={styles.customColorApply}
              onClick={() => selectAccent(savedCustomAccent)}
              type="button"
            >
              <span className={styles.customColorLabel}>
                <strong>Свой цвет</strong>
                <small>Настроить вручную</small>
              </span>
            </button>
            <input
              aria-label="Выбрать свой цвет акцента"
              className={
                customAccentSelected
                  ? `${styles.customColorPicker} ${styles.customColorPickerActive}`
                  : styles.customColorPicker
              }
              onChange={(event) => selectCustomAccent(event.currentTarget.value)}
              type="color"
              value={savedCustomAccent}
            />
          </div>
        </div>
      </section>

      <div className={styles.settingsGrid + ' ' + styles.tableFontSettings}>
        <section className={styles.settingsCard}>
          <div className={styles.sectionTitle}>
            <div>
              <h2>Размер шрифта таблиц</h2>
              <p>Настройка применяется к таблицам ингредиентов и рецептов.</p>
            </div>
            <output htmlFor="table-font-size">{tableFontSize} px</output>
          </div>
          <label className={styles.tableFontControl}>
            <span className={styles.visuallyHidden}>Размер шрифта таблиц</span>
            <input
              id="table-font-size"
              max="20"
              min="12"
              onChange={(event) =>
                selectTableFontSize(Number(event.currentTarget.value))
              }
              step="1"
              type="range"
              value={tableFontSize}
            />
            <span className={styles.tableFontScale} aria-hidden="true">
              <span>12 px</span>
              <span>20 px</span>
            </span>
          </label>
        </section>

        <section className={styles.settingsCard}>
          <div className={styles.sectionTitle}>
            <div>
              <h2>Нормативы расчёта</h2>
              <p>Подставляются по умолчанию при добавлении затрат на труд.</p>
            </div>
          </div>
          <label className={styles.field}>
            <span>Ставка оплаты труда по умолчанию, ₽/час</span>
            <input
              min="0"
              onChange={(event) => setHourlyRateInput(event.currentTarget.value)}
              placeholder="Напр. 500"
              step="any"
              type="number"
              value={hourlyRateInput}
            />
          </label>
          <div className={styles.formActions}>
            <button
              className={styles.buttonSecondary}
              onClick={saveHourlyRate}
              type="button"
            >
              Сохранить ставку
            </button>
          </div>
        </section>
      </div>

      <section className={`${styles.settingsCard} ${styles.tableFontSettings}`}>
        <div className={styles.sectionTitle}>
          <div>
            <h2>Резервная копия данных (JSON)</h2>
            <p>
              Сохраните все ингредиенты и рецепты в файл на устройство или
              восстановите их из ранее сохранённой копии.
            </p>
          </div>
        </div>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>Режим при импорте из файла</span>
            <select
              onChange={(event) =>
                setImportMode(
                  event.currentTarget.value === 'replace' ? 'replace' : 'merge',
                )
              }
              value={importMode}
            >
              <option value="merge">Объединить с текущими данными</option>
              <option value="replace">Полностью заменить текущие данные</option>
            </select>
          </label>
        </div>
        <div className={styles.formActions}>
          <button
            className={styles.buttonPrimary}
            onClick={() => void handleExportJson()}
            type="button"
          >
            Скачать резервную копию (JSON)
          </button>
          <button
            className={styles.buttonSecondary}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            Загрузить из файла (JSON)…
          </button>
          <input
            accept="application/json,.json"
            className={styles.visuallyHidden}
            onChange={(event) => void handleImportJson(event)}
            ref={fileInputRef}
            type="file"
          />
        </div>
      </section>

      <div className={styles.settingsGrid}>
        <section className={styles.settingsCard}>
          <div className={styles.sectionTitle}>
            <div>
              <h2>Рабочая область</h2>
              <p>
                Используйте одинаковый секретный код на устройствах, которым
                нужно обмениваться данными.
              </p>
            </div>
            <span
              className={`${styles.statusPill} ${
                connected ? styles.statusConnected : styles.statusDisconnected
              }`}
            >
              {connected ? 'Подключено' : 'Не подключено'}
            </span>
          </div>

          <label className={styles.field}>
            <span>Код рабочей области</span>
            <input
              autoComplete="off"
              onChange={(event) => setCode(event.currentTarget.value)}
              spellCheck={false}
              type="text"
              value={workspaceCode}
            />
          </label>

          <div className={styles.formActions}>
            {connected ? (
              <button
                className={styles.buttonSecondary}
                disabled={syncing}
                onClick={disconnect}
                type="button"
              >
                Отключиться
              </button>
            ) : (
              <>
                <button
                  className={styles.buttonPrimary}
                  disabled={!configured}
                  onClick={() => void connect()}
                  type="button"
                >
                  Подключиться
                </button>
                <button
                  className={styles.buttonSecondary}
                  onClick={() => setCode(generateRandomWorkspaceCode())}
                  type="button"
                >
                  Сгенерировать надёжный код
                </button>
              </>
            )}
          </div>
          <p className={styles.securityNote}>
            Код хешируется (SHA-256) и передаётся в заголовке запроса для
            изоляции рабочей области (RLS). Используйте длинный случайный код.
          </p>
        </section>

        <section className={styles.settingsCard}>
          <div className={styles.sectionTitle}>
            <div>
              <h2>Состояние синхронизации</h2>
              <p>
                Изменения автоматически отправляются через несколько секунд после
                сохранения.
              </p>
            </div>
            <span
              className={`${styles.statusPill} ${
                online ? styles.statusConnected : styles.statusOffline
              }`}
            >
              {online ? 'В сети' : 'Офлайн'}
            </span>
          </div>

          <dl className={styles.settingsList}>
            <div>
              <dt>Последняя синхронизация</dt>
              <dd>{formatDateTime(lastSyncAt)}</dd>
            </div>
            <div>
              <dt>Операций в очереди</dt>
              <dd>{queueCount}</dd>
            </div>
          </dl>

          <div className={styles.formActions}>
            <button
              className={styles.buttonPrimary}
              disabled={!connected || !configured || !online || syncing}
              onClick={() => void synchronize(false)}
              type="button"
            >
              {syncing ? 'Синхронизация…' : 'Синхронизировать сейчас'}
            </button>
            <button
              className={styles.buttonSecondary}
              disabled={!connected || !configured || !online || syncing}
              onClick={() => void synchronize(true)}
              type="button"
            >
              Полная пересинхронизация
            </button>
          </div>
        </section>
      </div>
    </section>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
