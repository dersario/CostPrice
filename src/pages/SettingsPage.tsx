import { useEffect, useState } from 'react'
import { Feedback } from '../components/Feedback'
import { PageHeading } from '../components/PageHeading'
import { db } from '../db/database'
import { formatDateTime } from '../lib/format'
import {
  clearWorkspaceCode,
  getWorkspaceCode,
  setWorkspaceCode,
} from '../sync/workspace'
import { colorThemes, type ColorTheme } from '../lib/themes'
import styles from './Pages.module.css'

interface SettingsPageProps {
  connected: boolean
  configured: boolean
  lastSyncAt: string | null
  syncing: boolean
  syncError: string | null
  queuedCount: number
  onConnectionChange: (connected: boolean) => void
  onSyncNow: () => Promise<void>
  theme: ColorTheme
  onThemeChange: (theme: ColorTheme) => void
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
}: SettingsPageProps) {
  const [workspaceCode, setCode] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [queueCount, setQueueCount] = useState(queuedCount)
  const [error, setError] = useState<string | null>(null)
  const [themeError, setThemeError] = useState<string | null>(null)

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
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  useEffect(() => {
    setQueueCount(queuedCount)
  }, [queuedCount])

  async function refreshQueue(): Promise<void> {
    try {
      setQueueCount(await db.syncQueue.count())
    } catch (caught) {
      setError(messageOf(caught, 'Не удалось прочитать очередь синхронизации.'))
    }
  }

  function connect(): void {
    if (!configured) {
      setError('Синхронизация не настроена: проверьте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY.')
      return
    }

    try {
      setWorkspaceCode(workspaceCode)
      setCode(getWorkspaceCode())
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

  async function synchronize(): Promise<void> {
    await onSyncNow()
    await refreshQueue()
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

  return (
    <section>
      <PageHeading
        title="Настройки"
        description="Синхронизация между устройствами — по желанию."
      />

      <Feedback error={error ?? themeError ?? syncError} />

      {!configured && (
        <div className={styles.notice}>
          <strong>Supabase не настроен.</strong>
          <span>
            Добавьте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY в .env, чтобы
            включить синхронизацию.
          </span>
        </div>
      )}

      <section className={styles.settingsCard + ' ' + styles.themeCard}>
        <div className={styles.sectionTitle}>
          <div>
            <h2>Цветовая схема</h2>
            <p>Выберите оформление приложения. Выбор сохранится в этом браузере.</p>
          </div>
        </div>
        <div aria-label="Цветовая схема" className={styles.themeChoices} role="group">
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
                className={styles.themeSwatch}
                style={{ backgroundColor: option.primary }}
              />
              <span>{option.name}</span>
            </button>
          ))}
        </div>
      </section>

      <div className={styles.settingsGrid}>
        <section className={styles.settingsCard}>
          <div className={styles.sectionTitle}>
            <div>
              <h2>Рабочая область</h2>
              <p>
                Используйте одинаковый код на устройствах, которым нужно обмениваться
                данными.
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
              <button
                className={styles.buttonPrimary}
                disabled={!configured}
                onClick={connect}
                type="button"
              >
                Подключиться
              </button>
            )}
          </div>
          <p className={styles.securityNote}>
            Код хранится только в этом браузере и служит общим ключом пространства,
            а не логином. Не используйте его как защиту секретных данных.
          </p>
        </section>

        <section className={styles.settingsCard}>
          <div className={styles.sectionTitle}>
            <div>
              <h2>Состояние синхронизации</h2>
              <p>Локальные данные доступны и без подключения к сети.</p>
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

          <button
            className={styles.buttonPrimary}
            disabled={!connected || !configured || !online || syncing}
            onClick={() => void synchronize()}
            type="button"
          >
            {syncing ? 'Синхронизация…' : 'Синхронизировать сейчас'}
          </button>
        </section>
      </div>
    </section>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
