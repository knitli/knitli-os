import { useSyncExternalStore } from 'react'

// A stand-in for the router in AdminPage tests: the page's tab lives in the URL's `tab` search
// parameter, so `navigate` has to feed `useSearch` back into the page. The tab resets once the page
// unmounts, which keeps one test's tab from leaking into the next.
let tab: string | undefined
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) tab = undefined
  }
}

// One function for every render, as the real router's is: components key effects on it.
const navigate = (options: { search: { tab: string } }) => {
  tab = options.search.tab
  listeners.forEach((listener) => listener())
  return Promise.resolve()
}

export const fakeAdminRouter = {
  useNavigate: () => navigate,
  useSearch: () => ({ tab: useSyncExternalStore(subscribe, () => tab) }),
}
