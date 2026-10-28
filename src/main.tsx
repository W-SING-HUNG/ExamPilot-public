import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'
import './theme.css'
import { App } from './App'
import { StoreProvider } from './store/StoreContext'
import { CloudStoreProvider } from './sync/CloudStore'
import { IS_WEB_EDITION } from './lib/edition'

// Web edition: the account's synced store. Desktop edition: unchanged local store.
const Provider = IS_WEB_EDITION ? CloudStoreProvider : StoreProvider

if (!window.location.hash) window.location.hash = '/home'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider>
      <App />
    </Provider>
  </React.StrictMode>,
)
