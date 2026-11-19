import { StrictMode, useEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import Login from './ui/Login'
import { refreshSession, useSession } from './api'

const useHash = () => useSyncExternalStore((cb) => { addEventListener('hashchange', cb); return () => removeEventListener('hashchange', cb) }, () => location.hash)

/** Signed-out users see the login screen; with no server the editor runs offline (IndexedDB) as before. */
function Root() {
  const user = useSession((s) => s.user), hash = useHash()
  useEffect(() => { refreshSession() }, [])
  if (user === undefined) return null
  return user === null || hash === '#login' ? <Login /> : <App />
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
