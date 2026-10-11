export type Mode = 'ask' | 'warn' | 'block'

/** One refused assumption, parsed from KERNEL.md. */
export type Refusal = {
  id: string
  assumption: string
  tells: string[]
  instead: string
}

/** A place where work re-imposed a refusal. */
export type Flag = {
  id: string
  term: string
  where: string
  why: string
  at: number
}

export type KernelSummary = {
  project: string
  refusals: number
  mode: Mode
} | null

declare module 'claude-code' {
  interface PluginState {
    'deviation-kernel': { pending: Flag[]; summary: KernelSummary }
  }
}
