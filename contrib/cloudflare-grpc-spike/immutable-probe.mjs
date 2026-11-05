// SPDX-FileCopyrightText: 2026 Epic Games, Inc.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zstdCompressSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { blake3 } from "@noble/hashes/blake3.js";
import { AddressSchema } from "./src/gen/lore/model/v1/model_pb.js";
import {
  GetResponseSchema, PutRequestSchema, PutResponseSchema, QueryRequestSchema, QueryResponseSchema,
  GetResolvedRequestSchema, GetResolvedResponseSchema, PutResolvedRequestSchema, PutResolvedResponseSchema,
  CopyRequestSchema, CopyResponseSchema,
} from "./src/gen/lore/storage/v1/storage_pb.js";
import {
  RepositoryCreateRequestSchema, RepositoryCreateResponseSchema, RepositoryGetRequestSchema, RepositoryGetResponseSchema,
  RepositoryListRequestSchema, RepositoryListResponseSchema,
} from "./src/gen/lore/repository/v1/repository_pb.js";
import { BranchGetRequestSchema, BranchGetResponseSchema, BranchListRequestSchema, BranchListResponseSchema, BranchPushRequestSchema, BranchPushResponseSchema } from "./src/gen/lore/revision/v1/revision_pb.js";

const origin = "http://127.0.0.1:8797";
const state = await mkdtemp(join(tmpdir(), "lore-immutable-"));
const partitionBytes = new Uint8Array(16).fill(1);
const partition = Buffer.from(partitionBytes).toString("base64");
const otherPartition = Buffer.alloc(16, 2).toString("base64");
const ctx = new Uint8Array(16).fill(3);
const sibling = new Uint8Array(16).fill(4);
const payload = new TextEncoder().encode("abc");
const address = { hash: blake3(payload), context: ctx };
const fragment = { flags: 0, sizePayload: 3, sizeContent: 3n };
let worker;

async function start() {
  worker = spawn(process.execPath, ["./node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--config", "wrangler.jsonc", "--persist-to", state, "--ip", "127.0.0.1", "--port", "8797"], { stdio: "inherit" });
  for (let i = 0; i < 150; i++) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited ${worker.exitCode}`);
    try { await fetch(origin); return; } catch { await delay(100); }
  }
  throw new Error("Wrangler startup timed out");
}
async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const exited = new Promise(resolve => worker.once("exit", resolve));
  worker.kill("SIGTERM");
  await exited;
}
function frame(body) {
  const result = Buffer.alloc(5 + body.length);
  result.writeUInt32BE(body.length, 1);
  result.set(body, 5);
  return result;
}

function stream(method, inputSchema, outputSchema, repo = partition) {
  const request = http.request(`${origin}/lore.storage.v1.StorageService/${method}`, {
    method: "POST", headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1", "lore-partition-bin": repo },
  });
  let pending = Buffer.alloc(0);
  const frames = [];
  let failure;
  request.on("error", error => { failure = error; });
  request.on("response", response => {
    if (response.statusCode !== 200) failure = new Error(`HTTP ${response.statusCode}`);
    response.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
        const size = pending.readUInt32BE(1);
        frames.push(pending.subarray(0, 5 + size));
        pending = pending.subarray(5 + size);
      }
    });
    response.on("error", error => { failure = error; });
  });
  async function next() {
    for (let i = 0; i < 200; i++) {
      if (failure) throw failure;
      if (frames.length) return frames.shift();
      await delay(50);
    }
    throw new Error(`timed out waiting for ${method}`);
  }
  return {
    async send(value) {
      request.write(frame(toBinary(inputSchema, create(inputSchema, value))));
      const result = await next();
      assert.equal(result[0], 0);
      return fromBinary(outputSchema, Uint8Array.from(result.subarray(5)));
    },
    async sendMany(values) {
      for (const value of values) request.write(frame(toBinary(inputSchema, create(inputSchema, value))));
      const results = [];
      for (const _ of values) {
        const result = await next();
        assert.equal(result[0], 0);
        results.push(fromBinary(outputSchema, Uint8Array.from(result.subarray(5))));
      }
      return results;
    },
    async close() {
      request.end();
      const trailer = await next();
      assert.equal(trailer[0], 0x80);
      assert.match(trailer.subarray(5).toString(), /grpc-status:\s*0\b/i);
    },
  };
}
async function query(addresses, repo = partition) {
  const response = await fetch(`${origin}/lore.storage.v1.StorageService/Query`, {
    method: "POST", headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1", "lore-partition-bin": repo },
    body: frame(toBinary(QueryRequestSchema, create(QueryRequestSchema, { addresses }))),
  });
  const wire = Buffer.from(await response.arrayBuffer());
  assert.equal(wire[0], 0);
  return fromBinary(QueryResponseSchema, Uint8Array.from(wire.subarray(5, 5 + wire.readUInt32BE(1)))).results;
}
async function packObjects() {
  const response = await fetch(`${origin}/cdn-cgi/local/explorer/api/r2/buckets/lore-worker-mvp-local/objects`);
  const data = await response.json();
  assert.equal(data.success, true);
  return data.result;
}
async function call(service, method, inputSchema, outputSchema, value, repo = partition) {
  const response = await fetch(`${origin}/lore.${service}.v1.${service === "repository" ? "Repository" : "Revision"}Service/${method}`, {
    method: "POST", headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1", "lore-partition-bin": repo },
    body: frame(toBinary(inputSchema, create(inputSchema, value))),
  });
  const wire = Buffer.from(await response.arrayBuffer());
  const messages = [];
  let trailer = "";
  for (let offset = 0; offset < wire.length;) {
    const size = wire.readUInt32BE(offset + 1);
    const data = wire.subarray(offset + 5, offset + 5 + size);
    if (wire[offset] === 0x80) trailer = data.toString();
    else messages.push(fromBinary(outputSchema, Uint8Array.from(data)));
    offset += 5 + size;
  }
  return { messages, trailer };
}

try {
  await start();
  const branchId = new Uint8Array(16).fill(12);
  const createRequest = { id: partitionBytes, name: "demo/repository", description: "example", defaultBranchId: branchId, defaultBranchName: "main", creator: "tester" };
  const createRepo = () => call("repository", "RepositoryCreate", RepositoryCreateRequestSchema, RepositoryCreateResponseSchema, createRequest);
  const created = await createRepo();
  assert.match(created.trailer, /grpc-status:\s*0\b/i);
  const repository = created.messages[0].repository;
  assert.equal(repository.name, createRequest.name);
  assert.equal(repository.metadata.length, 32);
  assert.deepEqual((await createRepo()).messages[0].repository, repository);
  const conflict = await call("repository", "RepositoryCreate", RepositoryCreateRequestSchema, RepositoryCreateResponseSchema, { ...createRequest, description: "different" });
  assert.match(conflict.trailer, /grpc-status:\s*6\b/i);
  const lookup = await call("repository", "RepositoryGet", RepositoryGetRequestSchema, RepositoryGetResponseSchema, { query: { case: "name", value: createRequest.name } });
  assert.deepEqual(lookup.messages[0].repository, repository);
  const listing = await call("repository", "RepositoryList", RepositoryListRequestSchema, RepositoryListResponseSchema, {});
  assert.deepEqual(listing.messages.map(message => message.repository.name), [createRequest.name]);
  const branch = await call("revision", "BranchGet", BranchGetRequestSchema, BranchGetResponseSchema, { query: { case: "name", value: "main" } });
  assert.deepEqual(branch.messages[0].branch.id, branchId);
  assert.equal(branch.messages[0].branch.metadata.length, 32);
  assert.deepEqual(branch.messages[0].branch.latest, new Uint8Array(32));
  const branches = await call("revision", "BranchList", BranchListRequestSchema, BranchListResponseSchema, {});
  assert.equal(branches.messages.length, 1);
  const blobGet = stream("Get", AddressSchema, GetResponseSchema);
  for (const hash of [repository.metadata, branch.messages[0].branch.metadata]) {
    const blob = await blobGet.send({ hash, context: new Uint8Array(16) });
    assert.equal(blob.status.code, 0);
    assert.equal(new DataView(blob.payload.buffer, blob.payload.byteOffset).getUint32(0, true), 0x6d657461);
    assert.deepEqual(blake3(blob.payload), hash);
  }
  await blobGet.close();
  assert.deepEqual(await query([address]), [2]);
  const put = stream("Put", PutRequestSchema, PutResponseSchema);
  assert.equal((await put.send({ address, fragment, payload: new Uint8Array([1, 2, 3]) })).status.code, 3);
  assert.deepEqual(await query([address]), [2]);
  assert.equal((await put.send({ address, fragment, payload })).status.code, 0);
  assert.equal((await put.send({ address, fragment, payload })).status.code, 0);
  assert.equal((await put.send({ address, fragment: { ...fragment, flags: 8 }, payload })).status.code, 3);
  const plain = new TextEncoder().encode("a compressible test fragment ".repeat(200));
  const compressed = zstdCompressSync(plain);
  const compressedAddress = { hash: blake3(plain), context: ctx };
  const compressedFragment = { flags: 8, sizePayload: compressed.length, sizeContent: BigInt(plain.length) };
  assert.equal((await put.send({ address: compressedAddress, fragment: compressedFragment, payload: compressed })).status.code, 0);
  assert.equal((await put.send({ address: { hash: new Uint8Array(32).fill(6), context: ctx }, fragment: compressedFragment, payload: compressed })).status.code, 3);
  assert.equal((await put.send({ address: compressedAddress, fragment: { ...compressedFragment, sizeContent: BigInt(plain.length + 1) }, payload: compressed })).status.code, 3);
  const references = new Uint8Array(80);
  references.set(new Uint8Array(32).fill(7), 0);
  references.set(new Uint8Array(32).fill(8), 40);
  new DataView(references.buffer).setBigUint64(72, 200n, true);
  const root = { hash: blake3(references), context: ctx };
  const rootFragment = { flags: 1, sizePayload: 80, sizeContent: 400n };
  assert.equal((await put.send({ address: root, fragment: rootFragment, payload: references })).status.code, 0);
  assert.equal((await put.send({ address: root, fragment: { flags: 0, sizePayload: 80, sizeContent: 80n }, payload: references })).status.code, 6);
  const badRefs = references.slice();
  new DataView(badRefs.buffer).setBigUint64(72, 0n, true);
  assert.equal((await put.send({ address: { hash: blake3(badRefs), context: ctx }, fragment: rootFragment, payload: badRefs })).status.code, 3);
  await put.close();
  // Send more than two full packs without waiting per item. A malformed item
  // must fail independently, and all published ranges must remain readable.
  const packed = Array.from({ length: 130 }, (_, i) => {
    const data = new Uint8Array(65536).fill(i);
    new DataView(data.buffer).setUint32(0, i, true);
    return { address: { hash: blake3(data), context: ctx }, fragment: { flags: 0, sizePayload: data.length, sizeContent: BigInt(data.length) }, payload: data };
  });
  const beforePacks = new Set((await packObjects()).map(object => object.key));
  const bulk = stream("Put", PutRequestSchema, PutResponseSchema);
  const results = await bulk.sendMany([...packed, { ...packed[0], payload: new Uint8Array(1) }]);
  assert.equal(results.filter(result => result.status.code === 0).length, packed.length);
  assert.equal(results.filter(result => result.status.code === 3).length, 1);
  await bulk.close();
  const newPacks = (await packObjects()).filter(object => !beforePacks.has(object.key));
  assert.ok(newPacks.length >= 2 && newPacks.length < packed.length);
  assert.equal(newPacks.reduce((sum, object) => sum + object.size, 0), packed.length * 65536);
  assert.ok(newPacks.some(object => object.size > 65536));
  assert.deepEqual(await query(packed.map(item => item.address)), packed.map(() => 0));
  const packedGet = stream("Get", AddressSchema, GetResponseSchema);
  for (const i of [0, 1, 63, 64, 129]) assert.deepEqual((await packedGet.send(packed[i].address)).payload, packed[i].payload);
  await packedGet.close();
  // Concurrent representations of the same hash must elect exactly one and
  // must not publish the losing context.
  const raceData = new Uint8Array(80);
  raceData.set(packed[3].address.hash, 0);
  raceData.set(packed[4].address.hash, 40);
  new DataView(raceData.buffer).setBigUint64(72, 200n, true);
  const raceHash = blake3(raceData);
  const raceA = stream("Put", PutRequestSchema, PutResponseSchema);
  const raceB = stream("Put", PutRequestSchema, PutResponseSchema);
  const race = await Promise.all([
    raceA.send({ address: { hash: raceHash, context: ctx }, fragment: { flags: 1, sizePayload: 80, sizeContent: 400n }, payload: raceData }),
    raceB.send({ address: { hash: raceHash, context: sibling }, fragment: { flags: 0, sizePayload: 80, sizeContent: 80n }, payload: raceData }),
  ]);
  assert.deepEqual(race.map(result => result.status.code).sort(), [0, 6]);
  assert.deepEqual(await query([{ hash: raceHash, context: ctx }, { hash: raceHash, context: sibling }]), race.map(result => result.status.code === 0 ? 0 : 1));
  await Promise.all([raceA.close(), raceB.close()]);
  const otherContext = { ...address, context: sibling };
  assert.deepEqual(await query([address, otherContext, root]), [0, 1, 0]);
  assert.deepEqual(await query([address], otherPartition), [2]);
  const get = stream("Get", AddressSchema, GetResponseSchema);
  const decoded = await get.send(compressedAddress);
  assert.equal(decoded.status.code, 0);
  assert.deepEqual(decoded.payload, plain);
  assert.equal(decoded.fragment.flags & 0xfe, 0);
  assert.equal((await get.send({ hash: new Uint8Array(32).fill(9), context: ctx })).status.code, 5);
  const found = await get.send(otherContext);
  assert.equal(found.status.code, 0);
  assert.deepEqual(found.payload, payload);
  assert.equal(found.fragment.flags, 0x40000);
  await get.close();
  const metadata = stream("GetMetadata", AddressSchema, GetResponseSchema);
  assert.equal((await metadata.send(address)).payload.length, 0);
  await metadata.close();
  const copy = stream("Copy", CopyRequestSchema, CopyResponseSchema);
  assert.equal((await copy.send({ sourceRepositoryId: partitionBytes, sourceAddress: address, targetContext: sibling })).status.code, 0);
  await copy.close();
  assert.deepEqual(await query([otherContext]), [0]);
  const key = new Uint8Array(32).fill(42);
  const publish = stream("PutResolved", PutResolvedRequestSchema, PutResolvedResponseSchema);
  assert.equal((await publish.send({ requestId: 1n, key, address, fragment, payload })).status.code, 0);
  await publish.close();
  const resolve = stream("GetResolved", GetResolvedRequestSchema, GetResolvedResponseSchema);
  const resolved = await resolve.send({ requestId: 2n, key: { hash: key, context: ctx } });
  assert.equal(resolved.status.code, 0);
  assert.deepEqual(resolved.resolved, address.hash);
  assert.deepEqual(resolved.payload, payload);
  await resolve.close();
  const ordered = stream("PutResolved", PutResolvedRequestSchema, PutResolvedResponseSchema);
  const writes = [packed[0], packed[1], packed[2]].map((item, i) => ({ ...item, key, requestId: BigInt(i + 10) }));
  assert.ok((await ordered.sendMany(writes)).every(result => result.status.code === 0));
  await ordered.close();
  const resolvedLast = stream("GetResolved", GetResolvedRequestSchema, GetResolvedResponseSchema);
  assert.deepEqual((await resolvedLast.send({ requestId: 20n, key: { hash: key, context: ctx } })).resolved, packed[2].address.hash);
  await resolvedLast.close();

  // A missing referenced tree must not advance the branch. Two independently
  // verified revision-1 pushes racing from the same tip must have one winner.
  const upload = stream("Put", PutRequestSchema, PutResponseSchema);
  async function putPlain(data) {
    const hash = blake3(data);
    assert.equal((await upload.send({ address: { hash, context: new Uint8Array(16) }, fragment: { flags: 0, sizePayload: data.length, sizeContent: BigInt(data.length) }, payload: data })).status.code, 0);
    return hash;
  }
  const push = signature => call("revision", "BranchPush", BranchPushRequestSchema, BranchPushResponseSchema, { id: branchId, revisionSignature: signature });
  function state(treeHash, metadataHash) {
    const data = new Uint8Array(320);
    const v = new DataView(data.buffer);
    v.setUint32(0, 0xd37a208e, true);
    v.setUint32(4, 2, true);
    v.setBigUint64(24, 1n, true);
    data.set(treeHash, 96);
    data.set(metadataHash, 128);
    return data;
  }
  const missing = await putPlain(state(new Uint8Array(32).fill(99), repository.metadata));
  assert.match((await push(missing)).trailer, /grpc-status:\s*9\b/i);
  // A 5,000-leaf file exceeds the old 4,096-read limit. Reusing the same
  // 64-KiB leaf exercises a 312-MiB logical file without allocating it.
  const fileRefs = new Uint8Array(5000 * 40);
  const refView = new DataView(fileRefs.buffer);
  for (let i = 0; i < 5000; i++) {
    fileRefs.set(packed[0].address.hash, i * 40);
    refView.setBigUint64(i * 40 + 32, BigInt(i * 65536), true);
  }
  const fileRoot = { hash: blake3(fileRefs), context: ctx };
  const fileFragment = { flags: 1, sizePayload: fileRefs.length, sizeContent: 5000n * 65536n };
  assert.equal((await upload.send({ address: fileRoot, fragment: fileFragment, payload: fileRefs })).status.code, 0);
  const badFileRefs = fileRefs.slice();
  badFileRefs.set(new Uint8Array(32).fill(91), 4999 * 40);
  const badFileRoot = { hash: blake3(badFileRefs), context: ctx };
  assert.equal((await upload.send({ address: badFileRoot, fragment: fileFragment, payload: badFileRefs })).status.code, 0);
  const block = new Uint8Array(49280);
  new DataView(block.buffer).setUint32(4, 1, true);
  const bv = new DataView(block.buffer);
  bv.setUint16(128, 1, true);
  bv.setBigUint64(128 + 40, fileFragment.sizeContent, true);
  block.set(fileRoot.hash, 128 + 48);
  block.set(ctx, 128 + 80);
  const badBlock = block.slice();
  badBlock.set(badFileRoot.hash, 128 + 48);
  const badBlockHash = await putPlain(badBlock);
  const badNodesHash = await putPlain(badBlockHash);
  const badTree = new Uint8Array(288);
  const badTreeView = new DataView(badTree.buffer);
  badTreeView.setUint32(0, 0x3c71bf05, true);
  badTreeView.setUint32(4, 1, true);
  badTreeView.setUint32(12, 1, true);
  badTree.set(badNodesHash, 64);
  const badRevision = await putPlain(state(await putPlain(badTree), repository.metadata));
  assert.match((await push(badRevision)).trailer, /grpc-status:\s*9\b/i);
  const blockHash = await putPlain(block);
  const nodesHash = await putPlain(blockHash);
  const tree = new Uint8Array(288);
  const tv = new DataView(tree.buffer);
  tv.setUint32(0, 0x3c71bf05, true);
  tv.setUint32(4, 1, true);
  tv.setUint32(12, 1, true);
  tree.set(nodesHash, 64);
  const treeHash = await putPlain(tree);
  const candidates = [await putPlain(state(treeHash, repository.metadata)), await putPlain(state(treeHash, branch.messages[0].branch.metadata))];
  await upload.close();
  const outcomes = await Promise.all(candidates.map(push));
  assert.equal(outcomes.filter(result => /grpc-status:\s*0\b/i.test(result.trailer)).length, 1);
  assert.equal(outcomes.filter(result => /grpc-status:\s*9\b/i.test(result.trailer)).length, 1);
  const winner = outcomes.findIndex(result => /grpc-status:\s*0\b/i.test(result.trailer));
  await stop();
  await start();
  assert.deepEqual((await createRepo()).messages[0].repository, repository);
  const branchAfter = await call("revision", "BranchGet", BranchGetRequestSchema, BranchGetResponseSchema, { query: { case: "id", value: branchId } });
  assert.equal(branchAfter.messages[0].branch.name, "main");
  assert.deepEqual(branchAfter.messages[0].branch.latest, candidates[winner]);
  assert.deepEqual(await query([address, otherContext, root]), [0, 0, 0]);
  const afterRestart = stream("Get", AddressSchema, GetResponseSchema);
  assert.deepEqual((await afterRestart.send(address)).payload, payload);
  assert.deepEqual((await afterRestart.send(packed[64].address)).payload, packed[64].payload);
  await afterRestart.close();
  console.log("Immutable gRPC-web: packed writes/ranges, 5000-leaf verification, concurrent push, copy, resolved ordering and restart persistence passed");
} finally {
  await stop();
  await rm(state, { recursive: true, force: true });
}
