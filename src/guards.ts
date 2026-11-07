import type { ModelRef } from "./model-rpc.ts"

// Shared tolerant-input guards. Host rows, stored records, and plugin options all
// arrive as untrusted shapes; every reader assumes only what it can check.

/** A plain, non-array object. */
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

/** A finite positive number, else the fallback. */
export const positive = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback

/** A usable model reference (provider and model id), else undefined. */
export const modelRef = (value: unknown): ModelRef | undefined => object(value) && typeof value.providerID === "string" && typeof value.id === "string"
  ? { providerID: value.providerID, id: value.id } : undefined
