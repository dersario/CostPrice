import { useCallback, useEffect, useRef, useState } from 'react'
import { IngredientsPage } from './pages/IngredientsPage'
import { ProductDetailPage } from './pages/ProductDetailPage'
import { ProductsPage } from './pages/ProductsPage'
import { SettingsPage } from './pages/SettingsPage'
import { isSupabaseConfigured } from './sync/client'
import { registerOnlineSync, synchronizeNow, type SyncResult } from './sync/synchronize'
import { getWorkspaceCode } from './sync/workspace'
import styles from './App.module.css'

type Page = 'ingredients' | 'products' | 'detail' | 'settings'

const LAST_SYNC_KEY = 'recipe-cost.last-sync-at'

function App() {
  const [page, setPage] = useState<Page>('products')
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)
  const [queuedCount, setQueuedCount] = useState(0)
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
            aria-current={page === 'ingredients' ? 'page' : undefined}
            className={page === 'ingredients' ? styles.navActive : styles.navLink}
            onClick={() => setPage('ingredients')}
            type="button"
          >
            Ингредиенты
          </button>
          <button
            aria-current={page === 'products' || page === 'detail' ? 'page' : undefined}
            className={
              page === 'products' || page === 'detail'
                ? styles.navActive
                : styles.navLink
            }
            onClick={() => setPage('products')}
            type="button"
          >
            Продукты
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
        {page === 'ingredients' && <IngredientsPage />}
        {page === 'products' && <ProductsPage onOpenProduct={openProduct} />}
        {page === 'detail' && selectedProductId && (
          <ProductDetailPage
            key={selectedProductId}
            onBack={() => setPage('products')}
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
          />
        )}
      </main>
    </div>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export default App
