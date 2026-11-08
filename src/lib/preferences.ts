const DEFAULT_HOURLY_RATE_KEY = 'recipe-cost.default-hourly-rate'

export function getDefaultHourlyRate(): number {
  try {
    const raw = localStorage.getItem(DEFAULT_HOURLY_RATE_KEY)
    if (!raw) return 0
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  } catch {
    return 0
  }
}

export function setDefaultHourlyRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new RangeError('Ставка в час должна быть неотрицательным числом.')
  }
  localStorage.setItem(DEFAULT_HOURLY_RATE_KEY, String(rate))
}
