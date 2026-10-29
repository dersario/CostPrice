import type { ReactNode } from 'react'
import styles from './Primitives.module.css'

interface PageHeadingProps {
  title: string
  description: string
  children?: ReactNode
}

export function PageHeading({
  title,
  description,
  children,
}: PageHeadingProps) {
  return (
    <div className={styles.pageHeading}>
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className={styles.headingAction}>{children}</div>}
    </div>
  )
}
