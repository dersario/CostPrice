export const colorThemes = [
  { id: 'light', name: 'Светлая', primary: '#16834b', surface: '#eff8f2' },
  { id: 'green', name: 'Зелёная', primary: '#16834b', surface: '#eff8f2' },
  { id: 'blue', name: 'Синяя', primary: '#1769aa', surface: '#edf5fc' },
  { id: 'terracotta', name: 'Коралловая', primary: '#c34b26', surface: '#fff2ec' },
  { id: 'violet', name: 'Фиолетовая', primary: '#7040c0', surface: '#f5f0fc' },
  { id: 'dark', name: 'Тёмная', primary: '#a78bfa', surface: '#11151d' },
] as const

export type ColorTheme = (typeof colorThemes)[number]['id']

export function isColorTheme(value: string | null): value is ColorTheme {
  return colorThemes.some((theme) => theme.id === value)
}
