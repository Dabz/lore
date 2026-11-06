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
  lore_fragment_windows(ptr: number, length: number, content: bigint, output: number): number;
  lore_hash(ptr: number, length: number, output: number): void;
  lore_metadata_valid(ptr: number, length: number): number;
  lore_metadata_addresses(ptr: number, length: number, output: number): number;
  lore_revision_block_pairs(nodes: number, nodeLength: number, metadata: number, metadataLength: number, count: number, output: number): number;
  lore_revision_node_block(ptr: number, length: number, output: number): number;
  lore_revision_file_metadata(ptr: number, length: number, output: number): number;
  lore_revision_state(ptr: number, length: number, output: number): number;
  lore_revision_tree(ptr: number, length: number, output: number): number;
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

export function fragmentWindows(payload: Uint8Array, size: bigint) {
  if (!payload.length || payload.length % 40) return null;
  const data = decodeRevision(payload, payload.length / 40 * 48,
    (ptr, length, output) => core.lore_fragment_windows(ptr, length, size, output));
  if (!data) return null;
  const view = new DataView(data.buffer);
  return Array.from({ length: data.length / 48 }, (_, i) => ({
    hash: data.slice(i * 48, i * 48 + 32),
    offset: view.getBigUint64(i * 48 + 32, true),
    size: view.getBigUint64(i * 48 + 40, true),
  }));
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

export function metadataAddresses(bytes: Uint8Array) {
  if (!bytes.length) return null;
  return withBytes(bytes, ptr => {
    const output = core.lore_alloc(bytes.length);
    try {
      const result = core.lore_metadata_addresses(ptr, bytes.length, output);
      if (!result) return null;
      const data = new Uint8Array(core.memory.buffer, output, (result - 1) * 48).slice();
      return Array.from({ length: result - 1 }, (_, i) => ({ hash: data.slice(i * 48, i * 48 + 32), context: data.slice(i * 48 + 32, i * 48 + 48) }));
    } finally { core.lore_free(output, bytes.length); }
  });
}

export function revisionBlockPairs(nodes: Uint8Array, metadata: Uint8Array | null, count: number) {
  const meta = metadata ?? new Uint8Array();
  return withBytes(nodes, nodePtr => withBytes(meta, metadataPtr => {
    const length = nodes.length * 2;
    const output = core.lore_alloc(length);
    try {
      const result = core.lore_revision_block_pairs(nodePtr, nodes.length, metadataPtr, meta.length, count, output);
      if (!result) return null;
      const data = new Uint8Array(core.memory.buffer, output, (result - 1) * 64).slice();
      return Array.from({ length: result - 1 }, (_, i) => ({ node: data.slice(i * 64, i * 64 + 32), metadata: data.slice(i * 64 + 32, i * 64 + 64) }));
    } finally { core.lore_free(output, length); }
  }));
}

export function revisionNodeBlock(bytes: Uint8Array) {
  return withBytes(bytes, ptr => {
    const length = 36 + 512 * 64;
    const output = core.lore_alloc(length);
    try {
      const status = core.lore_revision_node_block(ptr, bytes.length, output);
      if (status !== 1) return { ok: false, status } as const;
      const data = new Uint8Array(core.memory.buffer, output, length).slice();
      const view = new DataView(data.buffer);
      const nodes = Array.from({ length: view.getUint32(32, true) }, (_, i) => {
        const at = 36 + i * 64;
        return { index: view.getUint32(at, true), kind: view.getUint32(at + 4, true), hash: data.slice(at + 8, at + 40), context: data.slice(at + 40, at + 56), size: view.getBigUint64(at + 56, true) };
      });
      return { ok: true, nameTable: data.slice(0, 32), nodes } as const;
    } finally { core.lore_free(output, length); }
  });
}

export function revisionFileMetadata(bytes: Uint8Array) {
  const data = decodeRevision(bytes, 512 * 32, core.lore_revision_file_metadata);
  if (!data) return null;
  return Array.from({ length: 512 }, (_, i) => data.slice(i * 32, i * 32 + 32));
}

function decodeRevision(bytes: Uint8Array, size: number, decode: (ptr: number, length: number, output: number) => number) {
  return withBytes(bytes, ptr => {
    const output = core.lore_alloc(size);
    try {
      if (!decode(ptr, bytes.length, output)) return null;
      return new Uint8Array(core.memory.buffer, output, size).slice();
    } finally {
      core.lore_free(output, size);
    }
  });
}

export function decodeRevisionState(bytes: Uint8Array) {
  const data = decodeRevision(bytes, 200, core.lore_revision_state);
  if (!data) return null;
  const hash = (index: number) => data.slice(8 + index * 32, 40 + index * 32);
  return { number: new DataView(data.buffer).getBigUint64(0, true), parent: hash(0), otherParent: hash(1), tree: hash(2), metadata: hash(3), link: hash(4), linkMerge: hash(5) };
}

export function decodeRevisionTree(bytes: Uint8Array) {
  const data = decodeRevision(bytes, 132, core.lore_revision_tree);
  if (!data) return null;
  const hash = (index: number) => data.slice(4 + index * 32, 36 + index * 32);
  return { count: new DataView(data.buffer).getUint32(0, true), nodes: hash(0), legacyNames: hash(1), metadata: hash(2), delta: hash(3) };
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
