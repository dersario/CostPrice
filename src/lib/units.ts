import type { MeasurementUnit } from '../types'

type UnitDefinition = {
  dimension: 'mass' | 'volume' | 'count'
  baseUnit: MeasurementUnit
  factorToBase: number
}

export const unitLabels: Record<MeasurementUnit, string> = {
  g: 'г',
  kg: 'кг',
  ml: 'мл',
  l: 'л',
  pcs: 'шт.',
}

export const measurementUnits = ['g', 'kg', 'ml', 'l', 'pcs'] as const

const unitDefinitions: Record<MeasurementUnit, UnitDefinition> = {
  g: { dimension: 'mass', baseUnit: 'g', factorToBase: 1 },
  kg: { dimension: 'mass', baseUnit: 'g', factorToBase: 1000 },
  ml: { dimension: 'volume', baseUnit: 'ml', factorToBase: 1 },
  l: { dimension: 'volume', baseUnit: 'ml', factorToBase: 1000 },
  pcs: { dimension: 'count', baseUnit: 'pcs', factorToBase: 1 },
}

export function isMeasurementUnit(value: unknown): value is MeasurementUnit {
  return (
    value === 'g' ||
    value === 'kg' ||
    value === 'ml' ||
    value === 'l' ||
    value === 'pcs'
  )
}

export function compatibleUnits(unit: MeasurementUnit): MeasurementUnit[] {
  const dimension = unitDefinitions[unit].dimension
  return measurementUnits.filter(
    (candidate) => unitDefinitions[candidate].dimension === dimension,
  )
}

export function defaultRecipeUnit(unit: MeasurementUnit): MeasurementUnit {
  return unitDefinitions[unit].baseUnit
}

export function convertQuantity(
  quantity: number,
  fromUnit: MeasurementUnit,
  toUnit: MeasurementUnit,
): number {
  if (!Number.isFinite(quantity)) {
    throw new RangeError('Количество должно быть конечным числом.')
  }

  const from = unitDefinitions[fromUnit]
  const to = unitDefinitions[toUnit]

  if (from.dimension !== to.dimension) {
    throw new RangeError(`Нельзя преобразовать ${fromUnit} в ${toUnit}.`)
  }

  // Convert through a shared base unit so mass and volume scale consistently.
  return (quantity * from.factorToBase) / to.factorToBase
}
