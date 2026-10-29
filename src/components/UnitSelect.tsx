import type { MeasurementUnit } from '../types'
import { isMeasurementUnit, measurementUnits, unitLabels } from '../lib/units'
import styles from './Primitives.module.css'

interface UnitSelectProps {
  value: MeasurementUnit
  onChange: (value: MeasurementUnit) => void
  label: string
}

export function UnitSelect({ value, onChange, label }: UnitSelectProps) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => {
          const unit = event.currentTarget.value
          if (isMeasurementUnit(unit)) onChange(unit)
        }}
      >
        {measurementUnits.map((unit) => (
          <option value={unit} key={unit}>
            {unitLabels[unit]}
          </option>
        ))}
      </select>
    </label>
  )
}
