// SPDX-FileCopyrightText: 2026 Epic Games, Inc.
// SPDX-License-Identifier: MIT

export type PackOptions = {
  maxBytes: number;
  lingerMs: number;
  concurrency: number;
  maxPending: number;
};

// Fail explicitly for invalid configuration rather than silently changing the
// configured limits. String values are used in Wrangler's environment vars.
export function packOptions(env: Pick<Env, "PACK_MAX_BYTES" | "PACK_LINGER_MS" | "PACK_CONCURRENCY" | "PACK_MAX_PENDING">): PackOptions {
  function integer(name: string, value: string, min: number, max: number) {
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return number;
  }
  return {
    maxBytes: integer("PACK_MAX_BYTES", env.PACK_MAX_BYTES, 256 * 1024, 100 * 1024 * 1024),
    lingerMs: integer("PACK_LINGER_MS", env.PACK_LINGER_MS, 0, 60000),
    concurrency: integer("PACK_CONCURRENCY", env.PACK_CONCURRENCY, 1, 1000),
    maxPending: integer("PACK_MAX_PENDING", env.PACK_MAX_PENDING, 1, 10000),
  };
}
