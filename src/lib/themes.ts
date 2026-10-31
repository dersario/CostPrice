export const colorThemes = [
  { id: 'light', name: 'Светлая' },
  { id: 'dark', name: 'Тёмная' },
] as const

export const accentColors = [
  { name: 'Зелёный', color: '#16834b' },
  { name: 'Синий', color: '#1769aa' },
  { name: 'Коралловый', color: '#c34b26' },
  { name: 'Фиолетовый', color: '#7040c0' },
  { name: 'Бирюзовый', color: '#087f8c' },
  { name: 'Розовый', color: '#c23870' },
  { name: 'Оранжевый', color: '#df6e13' },
  { name: 'Золотой', color: '#a47700' },
] as const

export type ColorTheme = (typeof colorThemes)[number]['id']

export function isColorTheme(value: string | null): value is ColorTheme {
  return colorThemes.some((theme) => theme.id === value)
}
