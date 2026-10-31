import { useId, useState, type KeyboardEvent } from 'react'
import type { Ingredient } from '../types'
import styles from './IngredientAutocomplete.module.css'

interface IngredientAutocompleteProps {
  id: string
  ingredients: Ingredient[]
  onChange: (value: string) => void
  required?: boolean
  value: string
}

export function IngredientAutocomplete({
  id,
  ingredients,
  onChange,
  required = false,
  value,
}: IngredientAutocompleteProps) {
  const generatedId = useId()
  const listId = `${id}-${generatedId}-suggestions`
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const query = value.trim().toLocaleLowerCase()
  const suggestions =
    query.length === 0
      ? []
      : ingredients
          .filter((ingredient) => {
            const name = ingredient.name.trim().toLocaleLowerCase()
            return name.includes(query) && name !== query
          })
          .slice(0, 6)

  function choose(name: string): void {
    onChange(name)
    setIsOpen(false)
    setActiveIndex(-1)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      setIsOpen(false)
      setActiveIndex(-1)
    } else if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault()
      setIsOpen(true)
      setActiveIndex((index) => (index + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault()
      setIsOpen(true)
      setActiveIndex((index) =>
        index <= 0 ? suggestions.length - 1 : index - 1,
      )
    } else if (
      event.key === 'Enter' &&
      isOpen &&
      activeIndex >= 0 &&
      suggestions[activeIndex]
    ) {
      event.preventDefault()
      choose(suggestions[activeIndex].name)
    }
  }

  return (
    <div className={styles.autocomplete}>
      <input
        aria-activedescendant={
          isOpen && activeIndex >= 0
            ? `${listId}-option-${activeIndex}`
            : undefined
        }
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={isOpen && suggestions.length > 0}
        autoComplete="off"
        className={styles.input}
        id={id}
        onBlur={() => {
          setIsOpen(false)
          setActiveIndex(-1)
        }}
        onChange={(event) => {
          onChange(event.currentTarget.value)
          setIsOpen(true)
          setActiveIndex(-1)
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        required={required}
        role="combobox"
        value={value}
      />
      {isOpen && suggestions.length > 0 && (
        <ul className={styles.suggestions} id={listId} role="listbox">
          {suggestions.map((ingredient, index) => (
            <li
              aria-selected={index === activeIndex}
              className={
                index === activeIndex ? styles.suggestionActive : undefined
              }
              id={`${listId}-option-${index}`}
              key={ingredient.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(ingredient.name)}
              role="option"
            >
              {ingredient.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
