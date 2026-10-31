import { useCallback, useEffect, useRef, useState } from 'react'
import { IngredientsPage } from './pages/IngredientsPage'
import { ProductDetailPage } from './pages/ProductDetailPage'
import { ProductsPage } from './pages/ProductsPage'
import { SettingsPage } from './pages/SettingsPage'
import { isColorTheme, type ColorTheme } from './lib/themes'
import { isSupabaseConfigured } from './sync/client'
import { registerOnlineSync, synchronizeNow, type SyncResult } from './sync/synchronize'
import { getWorkspaceCode } from './sync/workspace'
import styles from './App.module.css'

type Page = 'products' | 'recipes' | 'detail' | 'settings'

const LAST_SYNC_KEY = 'recipe-cost.last-sync-at'
const THEME_KEY = 'recipe-cost.color-theme'
const ACCENT_KEY = 'recipe-cost.custom-accent'

function App() {
  const [page, setPage] = useState<Page>('products')
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)
  const [queuedCount, setQueuedCount] = useState(0)
  const [theme, setTheme] = useState<ColorTheme>('green')
  const [customAccent, setCustomAccent] = useState<string | null>(null)
  const syncInProgress = useRef(false)
  const configured = isSupabaseConfigured()

  useEffect(() => {
    try {
      setConnected(Boolean(getWorkspaceCode()))
    } catch (error) {
      setSyncError(messageOf(error, 'Не удалось прочитать код рабочей области.'))
    }

    try {
      setLastSyncAt(localStorage.getItem(LAST_SYNC_KEY))
    } catch (error) {
      setSyncError(messageOf(error, 'Не удалось прочитать время последней синхронизации.'))
    }
  }, [])

  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem(THEME_KEY)
      if (isColorTheme(savedTheme)) setTheme(savedTheme)
      const savedAccent = localStorage.getItem(ACCENT_KEY)
      if (savedAccent && /^#[\da-f]{6}$/i.test(savedAccent)) {
        setCustomAccent(savedAccent)
      }
    } catch (error) {
      setSyncError(messageOf(error, 'Не удалось прочитать настройки оформления.'))
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    if (customAccent) {
      root.style.setProperty('--primary', customAccent)
      root.style.setProperty('--primary-contrast', getContrastColor(customAccent))
      root.style.setProperty(
        '--primary-hover',
        `color-mix(in srgb, ${customAccent} 82%, #000)`,
      )
      root.style.setProperty(
        '--primary-soft',
        `color-mix(in srgb, ${customAccent} 16%, var(--surface))`,
      )
      root.style.setProperty(
        '--accent-soft',
        `color-mix(in srgb, ${customAccent} 20%, var(--surface))`,
      )
    } else {
      for (const property of [
        '--primary',
        '--primary-contrast',
        '--primary-hover',
        '--primary-soft',
        '--accent-soft',
      ]) {
        root.style.removeProperty(property)
      }
    }
  }, [theme, customAccent])

  function changeTheme(nextTheme: ColorTheme): void {
    setTheme(nextTheme)
  }

  const onSyncSuccess = useCallback((result: SyncResult) => {
    setLastSyncAt(result.synchronizedAt)
    setQueuedCount(result.queued)
    setSyncError(null)
    try {
      localStorage.setItem(LAST_SYNC_KEY, result.synchronizedAt)
    } catch (error) {
      setSyncError(
        messageOf(error, 'Синхронизация завершена, но время не удалось сохранить.'),
      )
    }
  }, [])

  const runSync = useCallback(async () => {
    if (syncInProgress.current) return
    syncInProgress.current = true
    setSyncing(true)
    setSyncError(null)
    try {
      onSyncSuccess(await synchronizeNow())
    } catch (error) {
      setSyncError(messageOf(error, 'Не удалось выполнить синхронизацию.'))
    } finally {
      syncInProgress.current = false
      setSyncing(false)
    }
  }, [onSyncSuccess])

  useEffect(() => {
    if (!connected || !configured) return
    const unregister = registerOnlineSync(runSync)
    if (navigator.onLine) void runSync()
    return unregister
  }, [connected, configured, runSync])

  function openProduct(id: string): void {
    setSelectedProductId(id)
    setPage('detail')
  }

  return (
    <div className={styles.app}>
      <header className={styles.topbar}>
        <button
          aria-label="На главную"
          className={styles.brand}
          onClick={() => setPage('products')}
          type="button"
        >
          <span className={styles.brandMark} aria-hidden="true">
            с
          </span>
          <span>Себестоимость</span>
        </button>
        <nav aria-label="Основная навигация" className={styles.nav}>
          <button
            aria-current={page === 'products' ? 'page' : undefined}
            className={page === 'products' ? styles.navActive : styles.navLink}
            onClick={() => setPage('products')}
            type="button"
          >
            Продукты
          </button>
          <button
            aria-current={page === 'recipes' || page === 'detail' ? 'page' : undefined}
            className={
              page === 'recipes' || page === 'detail'
                ? styles.navActive
                : styles.navLink
            }
            onClick={() => setPage('recipes')}
            type="button"
          >
            Рецепты
          </button>
          <button
            aria-current={page === 'settings' ? 'page' : undefined}
            className={page === 'settings' ? styles.navActive : styles.navLink}
            onClick={() => setPage('settings')}
            type="button"
          >
            Настройки
          </button>
        </nav>
      </header>

      {syncError && (
        <div className={styles.globalError} role="alert">
          <span>{syncError}</span>
          <button onClick={() => setSyncError(null)} type="button">
            Скрыть
          </button>
        </div>
      )}

      <main className={styles.main}>
        {page === 'products' && <IngredientsPage />}
        {page === 'recipes' && <ProductsPage onOpenProduct={openProduct} />}
        {page === 'detail' && selectedProductId && (
          <ProductDetailPage
            key={selectedProductId}
            onBack={() => setPage('recipes')}
            productId={selectedProductId}
          />
        )}
        {page === 'detail' && !selectedProductId && (
          <ProductsPage onOpenProduct={openProduct} />
        )}
        {page === 'settings' && (
          <SettingsPage
            connected={connected && configured}
            configured={configured}
            lastSyncAt={lastSyncAt}
            onConnectionChange={setConnected}
            onSyncNow={runSync}
            queuedCount={queuedCount}
            syncError={syncError}
            syncing={syncing}
            theme={theme}
            onThemeChange={changeTheme}
            customAccent={customAccent}
            onCustomAccentChange={setCustomAccent}
          />
        )}
      </main>
    </div>
  )
}

function getContrastColor(hex: string): string {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    )
  if (!channels) return '#fff'
  const luminance =
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  return luminance > 0.42 ? '#17211a' : '#fff'
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export default App
