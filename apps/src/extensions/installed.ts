// Trusted build-time allowlist. Keep prior major versions while declarations use them.
import {telemetry} from './telemetry/schema.ts'
import {extensionApis} from './registry.ts'
export const installedExtensions=[telemetry] as const
export const installedApis=extensionApis(installedExtensions)
