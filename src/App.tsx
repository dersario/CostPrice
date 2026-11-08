import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeToDataChanges } from './db/repository'
import { IngredientsPage } from './pages/IngredientsPage'
import { ProductDetailPage } from './pages/ProductDetailPage'
import { ProductsPage } from './pages/ProductsPage'
import { SettingsPage } from './pages/SettingsPage'
import { accentColors, isColorTheme, type ColorTheme } from './lib/themes'
import { isSupabaseConfigured } from './sync/client'
import type { SyncResult } from './sync/synchronize'
import { getWorkspaceCode } from './sync/workspace'
import styles from './App.module.css'

type Page = 'products' | 'recipes' | 'detail' | 'settings'

const LAST_SYNC_KEY = 'recipe-cost.last-sync-at'
const THEME_KEY = 'recipe-cost.color-theme'
const ACCENT_KEY = 'recipe-cost.custom-accent'
const CUSTOM_ACCENT_KEY = 'recipe-cost.saved-custom-accent'
const TABLE_FONT_SIZE_KEY = 'recipe-cost.table-font-size'
const DEFAULT_TABLE_FONT_SIZE = 16
const DEFAULT_CUSTOM_ACCENT = '#16834b'
const AUTO_SYNC_DEBOUNCE_MS = 2500
const LEGACY_ACCENTS: Record<string, string> = {
  green: '#16834b',
  blue: '#1769aa',
  terracotta: '#c34b26',
  violet: '#7040c0',
  dark: '#a78bfa',
}

interface RouteState {
  page: Page
  selectedProductId: string | null
}

function parseHashRoute(hash: string): RouteState {
  const clean = hash.replace(/^#\/?/, '')
  if (clean.startsWith('recipe/')) {
    const id = decodeURIComponent(clean.slice('recipe/'.length)).trim()
    if (id) {
      return { page: 'detail', selectedProductId: id }
    }
  }
  if (clean === 'recipes') {
    return { page: 'recipes', selectedProductId: null }
  }
  if (clean === 'settings') {
    return { page: 'settings', selectedProductId: null }
  }
  return { page: 'products', selectedProductId: null }
}

function buildHashRoute(route: RouteState): string {
  if (route.page === 'detail' && route.selectedProductId) {
    return `#/recipe/${encodeURIComponent(route.selectedProductId)}`
  }
  if (route.page === 'recipes') return '#/recipes'
  if (route.page === 'settings') return '#/settings'
  return '#/ingredients'
}

function App() {
  const [route, setRoute] = useState<RouteState>(() =>
    typeof window !== 'undefined'
      ? parseHashRoute(window.location.hash)
      : { page: 'products', selectedProductId: null },
  )
  const [connected, setConnected] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)
  const [queuedCount, setQueuedCount] = useState(0)
  const [theme, setTheme] = useState<ColorTheme>('light')
  const [customAccent, setCustomAccent] = useState<string | null>(null)
  const [savedCustomAccent, setSavedCustomAccent] = useState(DEFAULT_CUSTOM_ACCENT)
  const [tableFontSize, setTableFontSize] = useState(DEFAULT_TABLE_FONT_SIZE)
  const syncInProgress = useRef(false)
  const configured = isSupabaseConfigured()

  const navigate = useCallback((nextRoute: RouteState) => {
    setRoute(nextRoute)
    const targetHash = buildHashRoute(nextRoute)
    if (typeof window !== 'undefined' && window.location.hash !== targetHash) {
      window.location.hash = targetHash
    }
  }, [])

  useEffect(() => {
    const onHashChange = () => {
      setRoute(parseHashRoute(window.location.hash))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

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
      const savedAccent = localStorage.getItem(ACCENT_KEY)
      const savedCustomAccent = localStorage.getItem(CUSTOM_ACCENT_KEY)
      const savedTableFontSize = Number(localStorage.getItem(TABLE_FONT_SIZE_KEY))
      if (isColorTheme(savedTheme)) {
        setTheme(savedTheme)
      } else if (savedTheme && savedTheme !== 'light') {
        setTheme('light')
        localStorage.setItem(THEME_KEY, 'light')
      }
      const legacyAccent = savedTheme ? LEGACY_ACCENTS[savedTheme] : undefined
      if (!savedAccent && legacyAccent) {
        localStorage.setItem(ACCENT_KEY, legacyAccent)
        setCustomAccent(legacyAccent)
      }
      if (savedAccent && /^#[\da-f]{6}$/i.test(savedAccent)) {
        setCustomAccent(savedAccent)
      }
      if (savedCustomAccent && /^#[\da-f]{6}$/i.test(savedCustomAccent)) {
        setSavedCustomAccent(savedCustomAccent)
      } else if (
        savedAccent &&
        /^#[\da-f]{6}$/i.test(savedAccent) &&
        !accentColors.some((option) => option.color === savedAccent)
      ) {
        setSavedCustomAccent(savedAccent)
      }
      if (
        Number.isInteger(savedTableFontSize) &&
        savedTableFontSize >= 12 &&
        savedTableFontSize <= 20
      ) {
        setTableFontSize(savedTableFontSize)
      }
    } catch (error) {
      setSyncError(messageOf(error, 'Не удалось прочитать настройки оформления.'))
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    const metaColorScheme = document.querySelector('meta[name="color-scheme"]')
    if (metaColorScheme) {
      metaColorScheme.setAttribute('content', theme)
    }
    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor) {
      metaThemeColor.setAttribute(
        'content',
        theme === 'dark' ? '#11151d' : '#eff8f2',
      )
    }

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

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--table-font-size',
      `${tableFontSize}px`,
    )
  }, [tableFontSize])

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

  const runSync = useCallback(
    async (options?: { forceFullPull?: boolean }) => {
      if (syncInProgress.current) return
      syncInProgress.current = true
      setSyncing(true)
      setSyncError(null)
      try {
        const { synchronizeNow } = await import('./sync/synchronize')
        onSyncSuccess(await synchronizeNow(options))
      } catch (error) {
        setSyncError(messageOf(error, 'Не удалось выполнить синхронизацию.'))
      } finally {
        syncInProgress.current = false
        setSyncing(false)
      }
    },
    [onSyncSuccess],
  )

  useEffect(() => {
    if (!connected || !configured) return
    const handleOnline = () => {
      void runSync()
    }
    window.addEventListener('online', handleOnline)
    if (navigator.onLine) void runSync()

    let debounceTimer: number | undefined
    const unsubscribeChanges = subscribeToDataChanges(() => {
      if (!navigator.onLine) return
      if (debounceTimer !== undefined) {
        window.clearTimeout(debounceTimer)
      }
      debounceTimer = window.setTimeout(() => {
        if (navigator.onLine) void runSync()
      }, AUTO_SYNC_DEBOUNCE_MS)
    })

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void runSync()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.removeEventListener('online', handleOnline)
      unsubscribeChanges()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (debounceTimer !== undefined) {
        window.clearTimeout(debounceTimer)
      }
    }
  }, [connected, configured, runSync])

  function openProduct(id: string): void {
    navigate({ page: 'detail', selectedProductId: id })
  }

  const { page, selectedProductId } = route

  return (
    <div className={styles.app}>
      <header className={styles.topbar}>
        <button
          aria-label="На главную"
          className={styles.brand}
          onClick={() => navigate({ page: 'products', selectedProductId: null })}
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
            onClick={() =>
              navigate({ page: 'products', selectedProductId: null })
            }
            type="button"
          >
            Ингредиенты
          </button>
          <button
            aria-current={page === 'recipes' || page === 'detail' ? 'page' : undefined}
            className={
              page === 'recipes' || page === 'detail'
                ? styles.navActive
                : styles.navLink
            }
            onClick={() =>
              navigate({ page: 'recipes', selectedProductId: null })
            }
            type="button"
          >
            Рецепты
          </button>
          <button
            aria-current={page === 'settings' ? 'page' : undefined}
            className={page === 'settings' ? styles.navActive : styles.navLink}
            onClick={() =>
              navigate({ page: 'settings', selectedProductId: null })
            }
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
            onBack={() =>
              navigate({ page: 'recipes', selectedProductId: null })
            }
            onOpenProduct={openProduct}
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
            savedCustomAccent={savedCustomAccent}
            onSavedCustomAccentChange={setSavedCustomAccent}
            tableFontSize={tableFontSize}
            onTableFontSizeChange={setTableFontSize}
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
