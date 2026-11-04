// SPDX-FileCopyrightText: 2026 Epic Games, Inc.
// SPDX-License-Identifier: MIT
// The Wasm instance is used only by synchronous functions. No allocation or
// request-specific pointer is retained across an await or between calls.
import module from "../core/target/wasm32-unknown-unknown/release/lore_worker_core.wasm";
import type { FragmentHeader } from "./types.js";

// Mirrors the synchronous C ABI in core/src/lib.rs. Pointers and handles are wasm32 integers.
interface CoreExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  lore_alloc(length: number): number;
  lore_free(ptr: number, length: number): void;
  lore_fragment_metadata_valid(flags: number, payload: number, content: bigint): number;
  lore_fragment_list_valid(ptr: number, length: number, content: bigint): number;
  lore_hash(ptr: number, length: number, output: number): void;
  lore_metadata_valid(ptr: number, length: number): number;
  lore_metadata_new(): number;
  lore_metadata_set(handle: number, key: number, keyLength: number, value: number, valueLength: number, tag: number): number;
  lore_metadata_data(handle: number): number;
  lore_metadata_len(handle: number): number;
  lore_metadata_free(handle: number): void;
}
const core = (await WebAssembly.instantiate(module, {})).exports as CoreExports;

function withBytes<T>(bytes: Uint8Array, work: (ptr: number) => T): T {
  const ptr = core.lore_alloc(bytes.length);
  try {
    new Uint8Array(core.memory.buffer, ptr, bytes.length).set(bytes);
    return work(ptr);
  } finally {
    core.lore_free(ptr, bytes.length);
  }
}

export function validFragmentMetadata(fragment: FragmentHeader) {
  return core.lore_fragment_metadata_valid(fragment.flags, fragment.sizePayload, fragment.sizeContent) === 1;
}

export function validFragmentList(fragment: FragmentHeader, payload: Uint8Array) {
  return withBytes(payload, ptr => core.lore_fragment_list_valid(ptr, payload.length, fragment.sizeContent) === 1);
}

export function loreHash(payload: Uint8Array) {
  return withBytes(payload, ptr => {
    const output = core.lore_alloc(32);
    try {
      core.lore_hash(ptr, payload.length, output);
      return new Uint8Array(core.memory.buffer, output, 32).slice();
    } finally {
      core.lore_free(output, 32);
    }
  });
}

export function validMetadata(bytes: Uint8Array) {
  return withBytes(bytes, ptr => core.lore_metadata_valid(ptr, bytes.length) === 1);
}

export function encodeMetadata(entries: Array<[Uint8Array, number, Uint8Array]>) {
  const handle = core.lore_metadata_new();
  try {
    for (const [key, type, value] of entries) {
      const ok = withBytes(key, keyPtr => withBytes(value, valuePtr =>
        core.lore_metadata_set(handle, keyPtr, key.length, valuePtr, value.length, type)));
      if (!ok) throw new Error("invalid metadata entry");
    }
    return new Uint8Array(core.memory.buffer, core.lore_metadata_data(handle), core.lore_metadata_len(handle)).slice();
  } finally {
    core.lore_metadata_free(handle);
  }
}
