/**
 * YOLO_MODE — skip all MCP tool approvals when enabled.
 *
 * Controlled by:
 *   1. OPENCROFT_YOLO_MODE env var (default: false) — read at startup
 *   2. Runtime toggle via setYoloMode() — resets on process restart
 */

let runtimeOverride: boolean | null = null;

const ENV_YOLO = process.env.OPENCROFT_YOLO_MODE === 'true';

/** Check if YOLO mode is active. */
export function isYoloMode(): boolean {
  return runtimeOverride ?? ENV_YOLO;
}

/** Toggle YOLO mode at runtime (not persisted). */
export function setYoloMode(value: boolean): void {
  runtimeOverride = value;
}

/** Get the effective YOLO mode and its source. */
export function getYoloModeInfo(): { enabled: boolean; source: 'env' | 'runtime' } {
  if (runtimeOverride !== null) {
    return { enabled: runtimeOverride, source: 'runtime' };
  }
  return { enabled: ENV_YOLO, source: 'env' };
}
