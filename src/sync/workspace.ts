const WORKSPACE_CODE_KEY = 'recipe-cost.workspace-code'
const LAST_SYNC_CURSOR_PREFIX = 'recipe-cost.sync-cursor.'

export function getWorkspaceCode(): string {
  return localStorage.getItem(WORKSPACE_CODE_KEY) ?? ''
}

export function setWorkspaceCode(code: string): void {
  const normalizedCode = code.trim()
  if (!normalizedCode) {
    throw new Error('Введите код рабочей области.')
  }

  localStorage.setItem(WORKSPACE_CODE_KEY, normalizedCode)
}

export function clearWorkspaceCode(): void {
  localStorage.removeItem(WORKSPACE_CODE_KEY)
}

export function generateRandomWorkspaceCode(): string {
  const bytes = new Uint8Array(12)
  const webCrypto = typeof crypto === 'undefined' ? undefined : crypto
  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 6)}-${hex.slice(6, 12)}-${hex.slice(12, 18)}-${hex.slice(18, 24)}`
}

export function getSyncCursor(workspaceId: string): string | null {
  try {
    return localStorage.getItem(`${LAST_SYNC_CURSOR_PREFIX}${workspaceId}`)
  } catch {
    return null
  }
}

export function setSyncCursor(workspaceId: string, cursor: string): void {
  try {
    localStorage.setItem(`${LAST_SYNC_CURSOR_PREFIX}${workspaceId}`, cursor)
  } catch {
    // Ignore storage quota errors for optional incremental cursor.
  }
}

export function clearSyncCursor(workspaceId: string): void {
  try {
    localStorage.removeItem(`${LAST_SYNC_CURSOR_PREFIX}${workspaceId}`)
  } catch {
    // Ignore
  }
}

export async function getWorkspaceId(code = getWorkspaceCode()): Promise<string> {
  const normalizedCode = code.trim()
  if (!normalizedCode) {
    throw new Error('Сначала укажите код рабочей области.')
  }
  const webCrypto = typeof crypto === 'undefined' ? undefined : crypto
  if (!webCrypto?.subtle) {
    throw new Error('Для синхронизации требуется безопасный контекст с Web Crypto.')
  }

  const digest = await webCrypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalizedCode),
  )

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  )
    .join('')
    .slice(0, 32)
}
