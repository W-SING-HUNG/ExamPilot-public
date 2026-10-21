import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { StoreProvider } from './store/StoreContext'

if (!window.location.hash) window.location.hash = '/home'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </React.StrictMode>,
)
