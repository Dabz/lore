// SPDX-FileCopyrightText: 2026 Epic Games, Inc.
// SPDX-License-Identifier: MIT
import { Code, ConnectError } from "@connectrpc/connect";
import { Decompress } from "fzstd";
import { loreHash, validFragmentList, validFragmentMetadata } from "./core.js";
import type { FragmentAddress, FragmentHeader, PackEntry, PackLocation, Scope } from "./types.js";
import type { PackOptions } from "./pack-options.js";

const MAX_FRAGMENT = 256 * 1024;
const STORED = 0x1c0000;
const DURABLE = 0x040000;
export const toHex = (data: Uint8Array) => Array.from(data, byte => byte.toString(16).padStart(2, "0")).join("");
export const fromHex = (value: string) => Uint8Array.from(value.match(/../g)!, part => parseInt(part, 16));

function invalid(message: string) { return new ConnectError(message, Code.InvalidArgument); }

function contextHex(context: Uint8Array) {
  if (context.length === 0) return "00".repeat(16);
  if (context.length !== 16) throw invalid("context must be 16 bytes");
  return toHex(context);
}

function addressParts(address: FragmentAddress) {
  if (!address || address.hash.length !== 32) throw invalid("address hash must be 32 bytes");
  return { hash: toHex(address.hash), context: contextHex(address.context) };
}

// Bound the Zstd frame window before passing untrusted input to the decoder.
// Accept one ordinary frame without dictionaries or checksums; reject other
// representations instead of silently accepting a partially verified payload.
function decodeZstd(payload: Uint8Array, size: number) {
  if (payload.length < 6 || payload[0] !== 0x28 || payload[1] !== 0xb5 || payload[2] !== 0x2f || payload[3] !== 0xfd) throw invalid("invalid Zstd frame");
  const descriptor = payload[4];
  if (descriptor & 0x1f) throw invalid("unsupported Zstd frame features");
  const single = (descriptor & 0x20) !== 0;
  const mode = descriptor >> 6;
  let pos = 5;
  let window = 0;
  if (!single) {
    const wd = payload[pos++];
    const base = 2 ** (10 + (wd >> 3));
    window = base + base / 8 * (wd & 7);
    if (window > MAX_FRAGMENT) throw invalid("Zstd window exceeds fragment limit");
  }
  const fieldSize = mode === 0 ? (single ? 1 : 0) : 2 ** mode;
  if (pos + fieldSize > payload.length) throw invalid("truncated Zstd header");
  let contentSize = 0n;
  for (let i = 0; i < fieldSize; i++) contentSize |= BigInt(payload[pos++]) << BigInt(i * 8);
  if (mode === 1) contentSize += 256n;
  if (fieldSize && contentSize !== BigInt(size)) throw invalid("Zstd content size mismatch");
  if (single && contentSize > BigInt(MAX_FRAGMENT)) throw invalid("Zstd window exceeds fragment limit");
  let last = false;
  while (!last) {
    if (pos + 3 > payload.length) throw invalid("truncated Zstd block");
    const header = payload[pos] | payload[pos + 1] << 8 | payload[pos + 2] << 16;
    pos += 3;
    last = (header & 1) !== 0;
    const type = (header >> 1) & 3;
    const length = header >> 3;
    if (type === 3 || length > 131072) throw invalid("invalid Zstd block");
    pos += type === 1 ? 1 : length;
    if (pos > payload.length) throw invalid("truncated Zstd block");
  }
  if (pos !== payload.length) throw invalid("extra data after Zstd frame");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const decoder = new Decompress(chunk => {
      total += chunk.length;
      if (total > size) throw invalid("Zstd output exceeds declared size");
      chunks.push(chunk);
    });
    decoder.push(payload, true);
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw invalid("invalid Zstd payload");
  }
  if (total !== size) throw invalid("Zstd output size mismatch");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function validateFragment(fragment: FragmentHeader | undefined, payload: Uint8Array | undefined, expectedHash: string): Uint8Array {
  if (!fragment || !payload) throw invalid("fragment and payload are required");
  const { flags, sizePayload, sizeContent } = fragment;
  const compressed = flags & 0xfe;
  const fragmented = (flags & 1) !== 0;
  if (!validFragmentMetadata(fragment) || payload.length !== sizePayload) {
    throw invalid("invalid fragment metadata or payload size");
  }
  if (compressed && compressed !== 8) throw new ConnectError("only Zstd compressed fragments are supported", Code.Unimplemented);
  const content = compressed ? decodeZstd(payload, Number(sizeContent)) : payload;
  if (fragmented && !validFragmentList(fragment, payload)) throw invalid("invalid fragment reference list");
  if (toHex(loreHash(content)) !== expectedHash) throw invalid("fragment content hash mismatch");
  return content;
}

type Prepared = { hash: string; context: string; flags: number; content: string; payload: Uint8Array };
function prepare(address: FragmentAddress, fragment: FragmentHeader | undefined, payload: Uint8Array | undefined): Prepared {
  const parts = addressParts(address);
  const content = validateFragment(fragment, payload, parts.hash);
  if (!fragment) throw invalid("fragment and payload are required");
  return { ...parts, flags: fragment.flags & ~STORED & ~0xfe, content: String(fragment.sizeContent), payload: content };
}

async function writePack(env: Env, scope: Scope, items: Prepared[]) {
  const key = `packs/${scope.id}/${crypto.randomUUID()}`;
  const buffer = new Uint8Array(items.reduce((size, item) => size + item.payload.length, 0));
  const entries: PackEntry[] = [];
  let offset = 0;
  for (const item of items) {
    buffer.set(item.payload, offset);
    entries.push({ hash: item.hash, context: item.context, key, offset, length: item.payload.length, flags: item.flags, content: item.content });
    offset += item.payload.length;
  }
  // A successful R2 put precedes the atomic index and association transaction.
  // Interrupted or conflicting writes may leave unreachable pack bytes.
  await env.FRAGMENTS.put(key, buffer);
  return scope.store.publishPack(entries);
}

export async function putFragment(env: Env, scope: Scope, address: FragmentAddress, fragment: FragmentHeader | undefined, payload: Uint8Array | undefined) {
  const [ok] = await writePack(env, scope, [prepare(address, fragment, payload)]);
  if (!ok) throw new ConnectError("fragment conflicts with existing representation", Code.AlreadyExists);
}

type Pending = { item: Prepared; resolve: () => void; reject: (error: unknown) => void };
// Count the original fragment bytes as well as the pack's concatenated copy:
// at most 32 MiB of validated payloads plus their R2 buffers per stream.
const BUFFER_BUDGET = 32 * 1024 * 1024;
export class PackWriter {
  private pending: Pending[] = [];
  private queued: Pending[][] = [];
  private size = 0;
  private active = 0;
  private buffered = 0;
  private capacityWaiters = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private batchTarget: number;
  constructor(private env: Env, private scope: Scope, private options: PackOptions) {
    // Reserve room for several uploads rather than allowing one large pack to
    // consume the entire budget. The configured max remains a hard upper bound.
    this.batchTarget = Math.min(options.maxBytes, Math.floor(BUFFER_BUDGET / Math.min(options.concurrency, 4)));
  }
  async waitForCapacity() {
    while (!this.closed && this.buffered >= BUFFER_BUDGET) {
      this.flush();
      await new Promise<void>(resolve => this.capacityWaiters.add(resolve));
    }
  }
  private signalCapacity() {
    for (const resolve of this.capacityWaiters) resolve();
    this.capacityWaiters.clear();
  }
  add(address: FragmentAddress, fragment: FragmentHeader | undefined, payload: Uint8Array | undefined): Promise<void> {
    if (this.closed) throw new ConnectError("stream closed", Code.Canceled);
    const item = prepare(address, fragment, payload);
    if (this.size + item.payload.length > this.batchTarget) this.flush();
    const result = new Promise<void>((resolve, reject) => this.pending.push({ item, resolve, reject }));
    this.size += item.payload.length;
    this.buffered += item.payload.length;
    if (this.size >= this.batchTarget) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.options.lingerMs);
    return result;
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.length) return;
    this.queued.push(this.pending);
    this.pending = [];
    this.size = 0;
    this.start();
  }
  private start() {
    while (!this.closed && this.active < this.options.concurrency && this.queued.length) {
      const batch = this.queued.shift()!;
      this.active++;
      void writePack(this.env, this.scope, batch.map(entry => entry.item)).then(results => {
        batch.forEach((entry, i) => results[i] ? entry.resolve() : entry.reject(new ConnectError("fragment conflicts with existing representation", Code.AlreadyExists)));
      }, error => batch.forEach(entry => entry.reject(error))).finally(() => {
        this.buffered -= batch.reduce((sum, entry) => sum + entry.item.payload.length, 0);
        this.active--;
        this.signalCapacity();
        this.start();
      });
    }
  }
  cancel() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const batch of [this.pending, ...this.queued]) for (const entry of batch) {
      this.buffered -= entry.item.payload.length;
      entry.reject(new ConnectError("stream closed", Code.Canceled));
    }
    this.pending = [];
    this.queued = [];
    this.signalCapacity();
  }
}

function fragmentFromLocation(location: PackLocation): FragmentHeader {
  return { flags: (location.flags & ~STORED) | DURABLE, sizePayload: location.length, sizeContent: BigInt(location.content) };
}

export async function describeFragments(scope: Scope, addresses: FragmentAddress[]) {
  if (addresses.length > Math.floor(MAX_FRAGMENT / 48)) throw invalid("too many addresses");
  const found = await scope.store.describeFragments(addresses.map(addressParts));
  return found.map(item => ({ state: item.state, fragment: item.location ? fragmentFromLocation(item.location) : null, location: item.location }));
}

export async function getFragment(env: Env, scope: Scope, address: FragmentAddress, metadataOnly = false) {
  const [item] = await describeFragments(scope, [address]);
  if (!item.location || !item.fragment) {
    throw new ConnectError("fragment not found", Code.NotFound);
  }
  if (metadataOnly) return { fragment: item.fragment, payload: new Uint8Array() };
  const object = await env.FRAGMENTS.get(item.location.key, { range: { offset: item.location.offset, length: item.location.length } });
  if (!object) {
    console.error(JSON.stringify({ message: "indexed fragment pack missing", partition: scope.id, key: item.location.key, offset: item.location.offset, length: item.location.length }));
    throw new ConnectError("fragment association has no payload", Code.DataLoss);
  }
  const payload = new Uint8Array(await object.arrayBuffer());
  if (payload.length !== item.location.length) throw new ConnectError("truncated fragment pack", Code.DataLoss);
  return { fragment: item.fragment, payload };
}

export async function queryFragments(scope: Scope, addresses: FragmentAddress[]) {
  return { results: (await describeFragments(scope, addresses)).map(item => item.state) };
}

export function itemStatus(error: unknown) {
  if (error instanceof ConnectError) return { code: error.code, message: error.rawMessage };
  console.error(JSON.stringify({ message: "fragment operation failed", error: String(error) }));
  return { code: Code.Internal, message: "fragment operation failed" };
}
