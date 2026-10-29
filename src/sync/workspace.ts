const WORKSPACE_CODE_KEY = 'recipe-cost.workspace-code'

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

export async function getWorkspaceId(code = getWorkspaceCode()): Promise<string> {
  const normalizedCode = code.trim()
  if (!normalizedCode) {
    throw new Error('Сначала укажите код рабочей области.')
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error('Для синхронизации требуется безопасный контекст с Web Crypto.')
  }

  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalizedCode),
  )

  // A short hash is a workspace namespace, not an authentication secret.
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  )
    .join('')
    .slice(0, 32)
}
