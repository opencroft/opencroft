import type { Setting as SettingRow } from '@opencroft/db'

export type Setting<T = Record<string, unknown>> = Omit<SettingRow, 'data'> & {
  data: T
}
