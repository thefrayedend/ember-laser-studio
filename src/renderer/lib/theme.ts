import { useSyncExternalStore } from 'react'

export type ThemePref = 'auto' | 'light' | 'dark'
const KEY = 'ember.theme'
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null
const subs = new Set<() => void>()

export const getPref = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'auto'
  } catch {
    return 'auto'
  }
}
export const resolve = (p: ThemePref): 'light' | 'dark' => (p === 'auto' ? (mq?.matches ? 'light' : 'dark') : p)

export function applyTheme() {
  document.documentElement.dataset.theme = resolve(getPref())
  subs.forEach((f) => f())
}
export function setPref(p: ThemePref) {
  try {
    localStorage.setItem(KEY, p)
  } catch {
    /* private mode */
  }
  applyTheme()
}
export const nextPref = (p: ThemePref): ThemePref => (p === 'auto' ? 'light' : p === 'light' ? 'dark' : 'auto')
mq?.addEventListener?.('change', applyTheme)

const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f))
export const useThemePref = () => useSyncExternalStore(subscribe, getPref)
export const useTheme = () => resolve(useThemePref())
