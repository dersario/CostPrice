import type { MeasurementUnit } from '../types'

type Dimension = 'mass' | 'volume' | 'count'

type UnitDefinition = {
  dimension: Dimension
  baseUnit: MeasurementUnit
  factorToBase: number
}

export interface CrossDimensionBridge {
  /** Mass of 1 ml in grams (density). */
  gramsPerMl?: number | null
  /** Mass of 1 piece in grams. */
  gramsPerPiece?: number | null
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

export function getUnitDimension(unit: MeasurementUnit): Dimension {
  return unitDefinitions[unit].dimension
}

function hasPositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function canConvertUnits(
  fromUnit: MeasurementUnit,
  toUnit: MeasurementUnit,
  bridge?: CrossDimensionBridge,
): boolean {
  const fromDim = unitDefinitions[fromUnit].dimension
  const toDim = unitDefinitions[toUnit].dimension
  if (fromDim === toDim) return true
  if (!bridge) return false

  const hasDensity = hasPositive(bridge.gramsPerMl)
  const hasPieceWeight = hasPositive(bridge.gramsPerPiece)

  const dims = new Set<Dimension>([fromDim, toDim])
  if (dims.has('mass') && dims.has('volume')) {
    return hasDensity
  }
  if (dims.has('mass') && dims.has('count')) {
    return hasPieceWeight
  }
  if (dims.has('volume') && dims.has('count')) {
    return hasDensity && hasPieceWeight
  }
  return false
}

export function compatibleUnits(
  unit: MeasurementUnit,
  bridge?: CrossDimensionBridge,
): MeasurementUnit[] {
  return measurementUnits.filter((candidate) =>
    canConvertUnits(candidate, unit, bridge),
  )
}

export function defaultRecipeUnit(unit: MeasurementUnit): MeasurementUnit {
  return unitDefinitions[unit].baseUnit
}

export function convertQuantity(
  quantity: number,
  fromUnit: MeasurementUnit,
  toUnit: MeasurementUnit,
  bridge?: CrossDimensionBridge,
): number {
  if (!Number.isFinite(quantity)) {
    throw new RangeError('Количество должно быть конечным числом.')
  }

  const from = unitDefinitions[fromUnit]
  const to = unitDefinitions[toUnit]

  if (from.dimension === to.dimension) {
    return (quantity * from.factorToBase) / to.factorToBase
  }

  // Convert through grams as the universal pivot when bridge parameters are provided.
  const toGrams = (valInBase: number, dim: Dimension): number => {
    if (dim === 'mass') return valInBase
    if (dim === 'volume' && hasPositive(bridge?.gramsPerMl)) {
      return valInBase * bridge.gramsPerMl
    }
    if (dim === 'count' && hasPositive(bridge?.gramsPerPiece)) {
      return valInBase * bridge.gramsPerPiece
    }
    throw new RangeError(
      `Нельзя перевести «${unitLabels[fromUnit]}» в «${unitLabels[toUnit]}» без указания плотности или веса 1 шт.`,
    )
  }

  const fromGrams = (grams: number, dim: Dimension): number => {
    if (dim === 'mass') return grams
    if (dim === 'volume' && hasPositive(bridge?.gramsPerMl)) {
      return grams / bridge.gramsPerMl
    }
    if (dim === 'count' && hasPositive(bridge?.gramsPerPiece)) {
      return grams / bridge.gramsPerPiece
    }
    throw new RangeError(
      `Нельзя перевести «${unitLabels[fromUnit]}» в «${unitLabels[toUnit]}» без указания плотности или веса 1 шт.`,
    )
  }

  const baseFrom = quantity * from.factorToBase
  const grams = toGrams(baseFrom, from.dimension)
  const baseTo = fromGrams(grams, to.dimension)
  return baseTo / to.factorToBase
}
