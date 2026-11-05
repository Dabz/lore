// SPDX-FileCopyrightText: 2026 Epic Games, Inc.
// SPDX-License-Identifier: MIT
import { Code, ConnectError } from "@connectrpc/connect";
import { describeFragments, getFragment, toHex } from "./immutable.js";
import { validMetadata } from "./core.js";
import type { Scope } from "./types.js";

const zeroContext = new Uint8Array(16);
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const hashAt = (data: Uint8Array, offset: number) => data.slice(offset, offset + 32);
const isZero = (data: Uint8Array) => data.every(byte => byte === 0);
const invalid = (message: string) => new ConnectError(message, Code.FailedPrecondition);

// Structural revision fragments still use the simple current-format subset.
// File content may be a fragment tree, verified without materializing the file.
export async function verifyRevision(env: Env, scope: Scope, signature: Uint8Array) {
  let reads = 0;
  let contentReferences = 0;
  async function read(hash: Uint8Array, context: Uint8Array = zeroContext) {
    if (isZero(hash)) return null;
    if (++reads > 4096) throw new ConnectError("revision exceeds MVP verification limit", Code.ResourceExhausted);
    let item;
    try { item = await getFragment(env, scope, { hash, context }); }
    catch (error) {
      if (error instanceof ConnectError && error.code === Code.NotFound) throw invalid(`missing fragment ${toHex(hash)}`);
      throw error;
    }
    if ((item.fragment.flags & 1) !== 0) throw new ConnectError("fragmented revisions are not supported yet", Code.Unimplemented);
    return item.payload;
  }
  async function metadata(hash: Uint8Array) {
    const data = await read(hash);
    if (!data) return;
    if (!data.length || !validMetadata(data)) throw invalid("invalid metadata");
    for (let offset = 8; offset < data.length;) {
      const key = view(data).getUint32(offset, true);
      const size = view(data).getUint32(offset + 4, true);
      const type = view(data).getUint32(offset + 8, true);
      offset += 12;
      offset += key;
      if (type === 1) {
        if (size !== 48) throw invalid("invalid metadata address");
        await read(hashAt(data, offset), data.slice(offset + 32, offset + 48));
      }
      offset += size;
    }
  }
  async function verifyFile(hash: Uint8Array, context: Uint8Array, expected: bigint) {
    if (isZero(hash)) {
      if (expected !== 0n) throw invalid("missing file content");
      return;
    }
    const [root] = await describeFragments(scope, [{ hash, context }]);
    if (!root.fragment || root.fragment.sizeContent !== expected) throw invalid("missing or invalid file content");
    if (!(root.fragment.flags & 1)) return;
    async function walk(hash: Uint8Array, size: bigint, start: bigint | null, depth: number): Promise<void> {
      if (depth > 8) throw new ConnectError("fragment tree exceeds verification depth", Code.ResourceExhausted);
      const item = await getFragment(env, scope, { hash, context });
      const data = item.payload;
      if (!(item.fragment.flags & 1) || item.fragment.sizeContent !== size || !data.length || data.length % 40) throw invalid("invalid fragment list");
      const dv = view(data);
      const base = dv.getBigUint64(32, true);
      if (start !== null && base !== start) throw invalid("fragment sublist offset mismatch");
      const end = base + size;
      if (end > (1n << 64n) - 1n) throw invalid("fragment list offset overflow");
      const count = data.length / 40;
      contentReferences += count;
      if (contentReferences > 100000) throw new ConnectError("file content exceeds verification limit", Code.ResourceExhausted);
      let tier: boolean | undefined;
      for (let first = 0; first < count; first += 512) {
        const children = [];
        for (let i = first; i < Math.min(first + 512, count); i++) {
          const offset = dv.getBigUint64(i * 40 + 32, true);
          const next = i + 1 < count ? dv.getBigUint64((i + 1) * 40 + 32, true) : end;
          const childHash = hashAt(data, i * 40);
          if (isZero(childHash) || next <= offset || next > end) throw invalid("invalid fragment coverage");
          children.push({ hash: childHash, context, offset, size: next - offset });
        }
        const descriptions = await describeFragments(scope, children);
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          const fragment = descriptions[i].fragment;
          if (!fragment || fragment.sizeContent !== child.size) throw invalid("missing or invalid file fragment");
          const fragmented = (fragment.flags & 1) !== 0;
          if (tier !== undefined && tier !== fragmented) throw invalid("mixed fragment tree tiers");
          tier = fragmented;
          if (fragmented) await walk(child.hash, child.size, child.offset, depth + 1);
          else if (child.size > 256n * 1024n) throw invalid("file fragment exceeds size limit");
        }
      }
    }
    await walk(hash, expected, null, 0);
  }
  const state = await read(signature);
  if (!state || state.length !== 320 || view(state).getUint32(0, true) !== 0xd37a208e || view(state).getUint32(4, true) !== 2) throw invalid("invalid revision state");
  const number = view(state).getBigUint64(24, true);
  const parent = hashAt(state, 32);
  if (!isZero(hashAt(state, 64)) || !isZero(hashAt(state, 160)) || !isZero(hashAt(state, 192))) {
    throw new ConnectError("merge or linked revisions are not supported yet", Code.Unimplemented);
  }
  await metadata(hashAt(state, 128));
  const tree = await read(hashAt(state, 96));
  if (!tree || tree.length !== 288 || view(tree).getUint32(0, true) !== 0x3c71bf05 || view(tree).getUint32(4, true) !== 1) throw invalid("invalid revision tree");
  const count = view(tree).getUint32(12, true);
  if (count > 1024) throw new ConnectError("tree exceeds MVP verification limit", Code.ResourceExhausted);
  if (!isZero(hashAt(tree, 96))) throw new ConnectError("legacy name tables are not supported yet", Code.Unimplemented);
  await read(hashAt(tree, 160)); // delta
  const nodes = await read(hashAt(tree, 64));
  const fileMetadata = await read(hashAt(tree, 128));
  if (!nodes || nodes.length % 32 || nodes.length / 32 > count || (fileMetadata && (fileMetadata.length % 32 || fileMetadata.length / 32 > count))) throw invalid("invalid block lists");
  // Do not acknowledge metadata blocks that the node traversal would skip.
  if (fileMetadata && fileMetadata.length > nodes.length && !isZero(fileMetadata.slice(nodes.length))) throw invalid("orphaned metadata blocks");
  for (let blockIndex = 0; blockIndex < nodes.length / 32; blockIndex++) {
    const block = await read(hashAt(nodes, blockIndex * 32));
    if (!block) {
      if (fileMetadata && blockIndex * 32 < fileMetadata.length && !isZero(hashAt(fileMetadata, blockIndex * 32))) throw invalid("orphaned metadata block");
      continue;
    }
    if (block.length !== 49280) throw new ConnectError("legacy node blocks are not supported yet", Code.Unimplemented);
    const blockView = view(block);
    const nodeCount = blockView.getUint32(4, true);
    let unusedCount = blockView.getUint32(8, true);
    let unused = blockView.getUint32(12, true);
    if (nodeCount > 512 || unusedCount > nodeCount) throw invalid("invalid node block");
    const free = new Set();
    while (unusedCount-- > 0) {
      const index = unused & 511;
      if (unused === 0xffffffff || index >= nodeCount || free.has(index)) throw invalid("invalid unused node list");
      free.add(index);
      unused = blockView.getUint32(128 + index * 96 + 16, true);
    }
    await read(hashAt(block, 32)); // name table
    const metadataBlock = fileMetadata && blockIndex * 32 < fileMetadata.length ? await read(hashAt(fileMetadata, blockIndex * 32)) : null;
    if (metadataBlock && metadataBlock.length !== 65568) throw new ConnectError("legacy metadata blocks are not supported yet", Code.Unimplemented);
    for (let i = 0; i < nodeCount; i++) {
      if (free.has(i)) continue;
      const offset = 128 + i * 96;
      const flags = blockView.getUint16(offset, true);
      if (flags & 2) throw new ConnectError("linked trees are not supported yet", Code.Unimplemented);
      if (flags & 1) {
        const fileHash = hashAt(block, offset + 48);
        const expected = blockView.getBigUint64(offset + 40, true);
        await verifyFile(fileHash, block.slice(offset + 80, offset + 96), expected);
      }
      if (metadataBlock) await metadata(hashAt(metadataBlock, 32 + i * 128));
    }
  }
  return { parent: toHex(parent), number };
}
