import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initStore, useStore } from './store'
import './styles.css'
import { installTransport } from './lib/transport'

installTransport()
void initStore()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
Object.assign(window, { __ember: useStore })
