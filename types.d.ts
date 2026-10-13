// Only what the plugin touches. The host provides these at runtime.
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType } from 'react'
  export const StateDot: ComponentType<{ state: 'done' | 'warning' | 'error' | 'idle' | 'ongoing' }>
  export function relativeTime(at: number, now: number): { unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'; n: number }
}

interface Window {
  __ModuleLoader__: { load(spec: { id: string; factory: (require: (name: string) => any) => unknown }): void }
}
