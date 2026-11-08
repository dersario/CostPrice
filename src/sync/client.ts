import type { SupabaseClient } from '@supabase/supabase-js'

const clientsByWorkspace = new Map<string, SupabaseClient>()

export function isSupabaseConfigured(): boolean {
  return Boolean(
    import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
  )
}

export async function getSupabaseClient(
  workspaceId: string,
): Promise<SupabaseClient> {
  const cached = clientsByWorkspace.get(workspaceId)
  if (cached) return cached

  const url = import.meta.env.VITE_SUPABASE_URL
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error(
      'Синхронизация не настроена: задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY.',
    )
  }

  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        'x-workspace-id': workspaceId,
      },
    },
  })
  clientsByWorkspace.set(workspaceId, client)
  return client
}
