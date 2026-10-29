import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import styles from './App.module.css'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className={styles.app}>
      <App />
    </div>
  </StrictMode>,
)
