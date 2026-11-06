// SPDX-FileCopyrightText: 2026 Epic Games, Inc.
// SPDX-License-Identifier: MIT
import { Code, ConnectError } from "@connectrpc/connect";
import { describeFragments, getFragment, toHex } from "./immutable.js";
import { decodeRevisionState, decodeRevisionTree, fragmentWindows, metadataAddresses, revisionBlockPairs, revisionFileMetadata, revisionNodeBlock } from "./core.js";
import type { FragmentAddress, Scope } from "./types.js";

const zeroContext = new Uint8Array(16);
const isZero = (data: Uint8Array) => data.every(byte => byte === 0);
const invalid = (message: string) => new ConnectError(message, Code.FailedPrecondition);

// Structural revision fragments still use the simple current-format subset.
// File content may be a fragment tree, verified without materializing the file.
export async function verifyRevision(env: Env, scope: Scope, signature: Uint8Array) {
  let reads = 0;
  let contentReferences = 0;
  const repack = new Map<string, FragmentAddress>();
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
    const addresses = metadataAddresses(data);
    if (!addresses) throw invalid("invalid metadata");
    for (const address of addresses) await read(address.hash, address.context);
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
      if (!(item.fragment.flags & 1) || item.fragment.sizeContent !== size) throw invalid("invalid fragment list");
      const windows = fragmentWindows(data, size);
      if (!windows) throw invalid("invalid fragment coverage");
      if (start !== null && windows[0].offset !== start) throw invalid("fragment sublist offset mismatch");
      const count = windows.length;
      contentReferences += count;
      if (contentReferences > 100000) throw new ConnectError("file content exceeds verification limit", Code.ResourceExhausted);
      let tier: boolean | undefined;
      for (let first = 0; first < count; first += 512) {
        const children = windows.slice(first, first + 512).map(window => ({ ...window, context }));
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
    if (expected >= 4n * 1024n * 1024n) {
      repack.set(`${toHex(hash)}:${toHex(context)}`, { hash, context });
    }
  }
  const stateBytes = await read(signature);
  const state = stateBytes && decodeRevisionState(stateBytes);
  if (!state) throw invalid("invalid revision state");
  if (!isZero(state.otherParent) || !isZero(state.link) || !isZero(state.linkMerge)) {
    throw new ConnectError("merge or linked revisions are not supported yet", Code.Unimplemented);
  }
  await metadata(state.metadata);
  const treeBytes = await read(state.tree);
  const tree = treeBytes && decodeRevisionTree(treeBytes);
  if (!tree) throw invalid("invalid revision tree");
  const count = tree.count;
  if (count > 1024) throw new ConnectError("tree exceeds MVP verification limit", Code.ResourceExhausted);
  if (!isZero(tree.legacyNames)) throw new ConnectError("legacy name tables are not supported yet", Code.Unimplemented);
  await read(tree.delta);
  const nodes = await read(tree.nodes);
  const fileMetadata = await read(tree.metadata);
  if (!nodes) throw invalid("invalid block lists");
  const pairs = revisionBlockPairs(nodes, fileMetadata, count);
  if (!pairs) throw invalid("invalid or orphaned block lists");
  for (const pair of pairs) {
    const block = await read(pair.node);
    if (!block) continue;
    const scanned = revisionNodeBlock(block);
    if (!scanned.ok) {
      if (scanned.status === 2) throw new ConnectError("legacy node blocks are not supported yet", Code.Unimplemented);
      throw invalid(scanned.status === 4 ? "invalid unused node list" : "invalid node block");
    }
    await read(scanned.nameTable);
    const metadataBlock = await read(pair.metadata);
    const metadataHashes = metadataBlock && revisionFileMetadata(metadataBlock);
    if (metadataBlock && !metadataHashes) throw new ConnectError("legacy metadata blocks are not supported yet", Code.Unimplemented);
    for (const node of scanned.nodes) {
      if (node.kind === 2) throw new ConnectError("linked trees are not supported yet", Code.Unimplemented);
      if (node.kind === 1) await verifyFile(node.hash, node.context, node.size);
      if (metadataHashes) await metadata(metadataHashes[node.index]);
    }
  }
  return { parent: toHex(state.parent), number: state.number, repack: [...repack.values()] };
}
