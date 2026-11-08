import type {
  DirectCost,
  Ingredient,
  Product,
  RecipeItem,
} from '../types'
import {
  calculateIngredientCost,
  type ProductCostBreakdown,
} from './cost'
import { formatCurrency, formatNumber } from './format'
import { convertQuantity, unitLabels } from './units'

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function exportRecipeCsv(
  product: Product,
  recipeItems: readonly RecipeItem[],
  ingredients: readonly Ingredient[],
  allProducts: readonly Product[],
  directCosts: readonly DirectCost[],
  cost: ProductCostBreakdown,
  multiplier = 1,
): void {
  const rows: string[][] = []
  const outQty = product.outputQuantity * multiplier

  rows.push(['Технологическая карта (расчёт себестоимости)', product.name])
  if (product.description) {
    rows.push(['Описание', product.description])
  }
  rows.push([
    'Выход',
    `${formatNumber(outQty)} ${unitLabels[product.outputUnit]}`,
  ])
  if (product.panDiameterCm) {
    rows.push(['Диаметр формы, см', formatNumber(product.panDiameterCm)])
  }
  rows.push([])

  rows.push(['Состав рецепта'])
  rows.push([
    'Наименование',
    'Тип',
    'Количество',
    'Ед. изм.',
    'Цена за ед.',
    'Сумма, ₽',
  ])

  for (const item of recipeItems) {
    const scaledQty = item.quantity * multiplier
    if (item.itemType === 'product') {
      const sub = allProducts.find((p) => p.id === item.ingredientId)
      if (!sub) continue
      rows.push([
        sub.name,
        'Полуфабрикат',
        formatNumber(scaledQty),
        unitLabels[item.quantityUnit],
        `выход ${formatNumber(sub.outputQuantity)} ${unitLabels[sub.outputUnit]}`,
        '',
      ])
    } else {
      const ing = ingredients.find((i) => i.id === item.ingredientId)
      if (!ing) continue
      let lineCost = 0
      try {
        lineCost = calculateIngredientCost(scaledQty, item.quantityUnit, ing)
      } catch {
        lineCost = 0
      }
      rows.push([
        ing.name,
        'Ингредиент',
        formatNumber(scaledQty),
        unitLabels[item.quantityUnit],
        ing.hasPrice
          ? `${formatNumber(ing.pricePerUnit)} ₽/${unitLabels[ing.unit]}`
          : 'Не указана',
        formatNumber(lineCost),
      ])
    }
  }

  rows.push([])
  rows.push(['Дополнительные затраты'])
  rows.push(['Наименование', 'Категория', 'Детали', 'Сумма, ₽'])
  for (const dc of directCosts) {
    const categoryLabel =
      dc.category === 'labor'
        ? 'Труд'
        : dc.category === 'packaging'
          ? 'Упаковка'
          : 'Накладные'
    const details =
      dc.category === 'labor' && dc.hours && dc.hourlyRate !== null && dc.hourlyRate !== undefined
        ? `${formatNumber(dc.hours)} ч × ${formatNumber(dc.hourlyRate)} ₽/ч`
        : ''
    const amount = dc.category === 'packaging' ? dc.amount * multiplier : dc.amount
    rows.push([dc.name, categoryLabel, details, formatNumber(amount)])
  }

  rows.push([])
  rows.push(['Итоги'])
  rows.push(['Сырьё (ингредиенты)', formatCurrency(cost.materials * multiplier)])
  if (cost.subrecipes > 0) {
    rows.push(['Полуфабрикаты', formatCurrency(cost.subrecipes * multiplier)])
  }
  rows.push(['Труд', formatCurrency(cost.labor)])
  rows.push(['Упаковка', formatCurrency(cost.packaging * multiplier)])
  rows.push(['Накладные', formatCurrency(cost.overhead)])
  rows.push(['Полная себестоимость', formatCurrency(cost.total * multiplier)])
  rows.push([
    `Себестоимость за 1 ${unitLabels[product.outputUnit]}`,
    formatCurrency(cost.perUnit),
  ])
  rows.push([
    `Цена продажи за 1 ${unitLabels[product.outputUnit]}`,
    formatCurrency(cost.sellingPricePerUnit),
  ])
  rows.push([
    `Прибыль за 1 ${unitLabels[product.outputUnit]}`,
    formatCurrency(cost.profitPerUnit),
  ])
  rows.push(['Маржинальность', `${formatNumber(cost.marginPercent)}%`])
  rows.push(['Фудкост', `${formatNumber(cost.foodCostPercent)}%`])

  // UTF-8 BOM so Excel on Windows opens Russian Cyrillic cleanly
  const csvContent =
    '\uFEFF' +
    rows
      .map((row) =>
        row
          .map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`)
          .join(';'),
      )
      .join('\r\n')

  const safeName = product.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'recipe'
  downloadTextFile(`${safeName}.csv`, csvContent, 'text/csv;charset=utf-8')
}

export function printTechCard(
  product: Product,
  recipeItems: readonly RecipeItem[],
  ingredients: readonly Ingredient[],
  allProducts: readonly Product[],
  directCosts: readonly DirectCost[],
  cost: ProductCostBreakdown,
  subrecipeCostsById: ReadonlyMap<string, number>,
  multiplier = 1,
): void {
  const outQty = product.outputQuantity * multiplier
  const itemRowsHtml = recipeItems
    .map((item) => {
      const scaledQty = item.quantity * multiplier
      if (item.itemType === 'product') {
        const sub = allProducts.find((p) => p.id === item.ingredientId)
        if (!sub) return ''
        const subPerUnit = subrecipeCostsById.get(sub.id) ?? 0
        let lineCost = 0
        try {
          lineCost =
            convertQuantity(scaledQty, item.quantityUnit, sub.outputUnit) *
            subPerUnit
        } catch {
          lineCost = 0
        }
        return `<tr>
          <td>${escapeHtml(sub.name)} <small>(полуфабрикат)</small></td>
          <td>${formatNumber(scaledQty)} ${unitLabels[item.quantityUnit]}</td>
          <td>${formatCurrency(subPerUnit)}/${unitLabels[sub.outputUnit]}</td>
          <td>${formatCurrency(lineCost)}</td>
        </tr>`
      }
      const ing = ingredients.find((i) => i.id === item.ingredientId)
      if (!ing) return ''
      let lineCost = 0
      try {
        lineCost = calculateIngredientCost(scaledQty, item.quantityUnit, ing)
      } catch {
        lineCost = 0
      }
      return `<tr>
        <td>${escapeHtml(ing.name)}</td>
        <td>${formatNumber(scaledQty)} ${unitLabels[item.quantityUnit]}</td>
        <td>${ing.hasPrice ? `${formatCurrency(ing.pricePerUnit)}/${unitLabels[ing.unit]}` : 'Не указана'}</td>
        <td>${formatCurrency(lineCost)}</td>
      </tr>`
    })
    .join('')

  const costRowsHtml = directCosts
    .map((dc) => {
      const cat =
        dc.category === 'labor'
          ? 'Труд'
          : dc.category === 'packaging'
            ? 'Упаковка'
            : 'Накладные'
      const amount = dc.category === 'packaging' ? dc.amount * multiplier : dc.amount
      return `<tr>
        <td>${escapeHtml(dc.name)}</td>
        <td>${cat}</td>
        <td>${formatCurrency(amount)}</td>
      </tr>`
    })
    .join('')

  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>Техкарта — ${escapeHtml(product.name)}</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; color: #1d2c22; margin: 24px; }
    h1 { margin: 0 0 6px; font-size: 22px; }
    p.meta { margin: 0 0 16px; color: #556; font-size: 13px; }
    h2 { margin: 20px 0 8px; font-size: 16px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 13px; }
    th, td { border: 1px solid #d0d7de; padding: 6px 8px; text-align: left; }
    th { background: #f4f7f5; }
    .summary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 16px; font-size: 13px; max-width: 520px; }
    .summary div { display: flex; justify-content: space-between; border-bottom: 1px dashed #ddd; padding: 3px 0; }
    @media print { body { margin: 10mm; } }
  </style>
</head>
<body>
  <h1>Технологическая карта: ${escapeHtml(product.name)}</h1>
  <p class="meta">
    Выход: <strong>${formatNumber(outQty)} ${unitLabels[product.outputUnit]}</strong>
    ${product.panDiameterCm ? ` · Форма Ø ${formatNumber(product.panDiameterCm)} см` : ''}
    ${multiplier !== 1 ? ` · Масштаб ×${formatNumber(multiplier)}` : ''}
  </p>
  ${product.description ? `<p>${escapeHtml(product.description)}</p>` : ''}

  <h2>Состав рецепта</h2>
  <table>
    <thead>
      <tr><th>Компонент</th><th>Количество</th><th>Цена за ед.</th><th>Сумма</th></tr>
    </thead>
    <tbody>${itemRowsHtml || '<tr><td colspan="4">Нет позиций</td></tr>'}</tbody>
  </table>

  ${
    directCosts.length > 0
      ? `<h2>Прямые затраты и упаковка</h2>
  <table>
    <thead><tr><th>Наименование</th><th>Категория</th><th>Сумма</th></tr></thead>
    <tbody>${costRowsHtml}</tbody>
  </table>`
      : ''
  }

  <h2>Калькуляция себестоимости и цены</h2>
  <div class="summary">
    <div><span>Сырьё:</span><strong>${formatCurrency(cost.materials * multiplier)}</strong></div>
    ${cost.subrecipes > 0 ? `<div><span>Полуфабрикаты:</span><strong>${formatCurrency(cost.subrecipes * multiplier)}</strong></div>` : ''}
    <div><span>Труд:</span><strong>${formatCurrency(cost.labor)}</strong></div>
    <div><span>Упаковка:</span><strong>${formatCurrency(cost.packaging * multiplier)}</strong></div>
    <div><span>Накладные:</span><strong>${formatCurrency(cost.overhead)}</strong></div>
    <div><span>Итого себестоимость:</span><strong>${formatCurrency(cost.total * multiplier)}</strong></div>
    <div><span>Себестоимость за 1 ${unitLabels[product.outputUnit]}:</span><strong>${formatCurrency(cost.perUnit)}</strong></div>
    <div><span>Цена продажи за 1 ${unitLabels[product.outputUnit]}:</span><strong>${formatCurrency(cost.sellingPricePerUnit)}</strong></div>
    <div><span>Прибыль за 1 ${unitLabels[product.outputUnit]}:</span><strong>${formatCurrency(cost.profitPerUnit)}</strong></div>
    <div><span>Маржа / Фудкост:</span><strong>${formatNumber(cost.marginPercent)}% / ${formatNumber(cost.foodCostPercent)}%</strong></div>
  </div>
  <script>window.onload = () => { window.print(); }</script>
</body>
</html>`

  const win = window.open('', '_blank', 'width=840,height=720')
  if (!win) {
    throw new Error('Разрешите всплывающие окна в браузере для печати техкарты.')
  }
  win.document.open()
  win.document.write(html)
  win.document.close()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
