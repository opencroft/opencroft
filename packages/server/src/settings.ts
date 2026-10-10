/** `@opencroft/server/settings` — the host's settings rows, by id. */

export interface HostSetting {
  id: string
  data: Record<string, unknown>
}

export interface HostSettingsApi {
  /** The setting row `data` names; null when there is none. */
  get(opts: { data: string }): Promise<HostSetting | null>
  /** Writes the whole row, replacing its data. */
  set(opts: { data: HostSetting }): Promise<HostSetting>
}

export declare const settings: HostSettingsApi
