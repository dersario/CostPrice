import styles from './Primitives.module.css'

interface FeedbackProps {
  error?: string | null
}

export function Feedback({ error }: FeedbackProps) {
  if (!error) return null
  return (
    <p className={styles.error} role="alert">
      {error}
    </p>
  )
}
