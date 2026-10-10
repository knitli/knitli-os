import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { WebPushSync } from './features/notifications/webPush/WebPushSync'
import { hasSignOutWorkerHandoff, releaseOnSignOut } from './features/notifications/webPush/browserSubscription'

interface AuthContextType {
  authenticatedApi: RpcStub<AuthenticatedApi>
  logout: () => void
  /** Current user info, fetched once on mount. Null while loading. */
  currentUser: AiChatAuthorInfo | null
  /** Whether the current user is a deployment admin. False while loading / for non-admins. */
  isAdmin: boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

interface AuthProviderProps {
  children: ReactNode
  authenticatedApi: RpcStub<AuthenticatedApi>
  onLogout: () => void
}

type ApiScoped<T> = {
  authenticatedApi: RpcStub<AuthenticatedApi>
  value: T
}

export function AuthProvider({ children, authenticatedApi, onLogout }: AuthProviderProps) {
  const [currentUserResult, setCurrentUserResult] = useState<ApiScoped<AiChatAuthorInfo> | null>(null)
  const [isAdminResult, setIsAdminResult] = useState<ApiScoped<boolean> | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.whoami().then((info) => {
      if (!cancelled) setCurrentUserResult({ authenticatedApi, value: info })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  useEffect(() => {
    let cancelled = false
    authenticatedApi.amIAdmin().then((admin) => {
      if (!cancelled) setIsAdminResult({ authenticatedApi, value: admin })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  const currentUser = currentUserResult?.authenticatedApi === authenticatedApi ? currentUserResult.value : null
  const isAdmin = isAdminResult?.authenticatedApi === authenticatedApi ? isAdminResult.value : false

  return (
    <AuthContext.Provider value={{ authenticatedApi, logout: () => {
      // Sign out first, as push cleanup is best effort and must not hold the session open if the page
      // goes: a service worker finishes it. Without one the page has to (bounded), or the redirect
      // could cut it off.
      const cleanup = releaseOnSignOut(authenticatedApi)
      if (hasSignOutWorkerHandoff()) onLogout()
      else void cleanup.finally(onLogout)
    }, currentUser, isAdmin }}>
      <WebPushSync />
      {children}
    </AuthContext.Provider>
  )
}

export function useAuthenticatedApi() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuthenticatedApi must be used within an AuthProvider')
  }
  return context
}

/** Returns the auth context when inside an AuthProvider, or null on public pages. */
export function useOptionalAuthenticatedApi(): AuthContextType | null {
  return useContext(AuthContext)
}
