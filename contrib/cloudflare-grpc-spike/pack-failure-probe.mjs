// SPDX-FileCopyrightText: 2026 Epic Games, Inc.
// SPDX-License-Identifier: MIT
// Exercise pack publication failures and cancellation without modifying a real bucket.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { setTimeout as delay } from "node:timers/promises";

const bundle = await build({
  entryPoints: ["src/immutable.ts"], bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "test-core", setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: "core", namespace: "test-core" }));
    build.onLoad({ filter: /.*/, namespace: "test-core" }, () => ({ contents: `
      export const loreHash = () => new Uint8Array(32);
      export const validFragmentMetadata = () => true;
      export const validFragmentList = () => true;
    ` }));
  } }],
});
const { PackWriter } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
const { packOptions } = await import(`data:text/javascript;base64,${Buffer.from((await build({ entryPoints: ["src/pack-options.ts"], bundle: true, write: false, format: "esm", platform: "node" })).outputFiles[0].contents).toString("base64")}`);
const { packedStream } = await import(`data:text/javascript;base64,${Buffer.from((await build({ entryPoints: ["src/stream.ts"], bundle: true, write: false, format: "esm", platform: "node" })).outputFiles[0].contents).toString("base64")}`);
const defaults = { PACK_MAX_BYTES: "104857600", PACK_LINGER_MS: "1000", PACK_CONCURRENCY: "50", PACK_MAX_PENDING: "1000" };
const options = packOptions(defaults);
assert.deepEqual(options, { maxBytes: 100 * 1024 * 1024, lingerMs: 1000, concurrency: 50, maxPending: 1000 });
assert.throws(() => packOptions({ ...defaults, PACK_CONCURRENCY: "0" }), /PACK_CONCURRENCY/);
assert.throws(() => packOptions({ ...defaults, PACK_LINGER_MS: "1.5" }), /PACK_LINGER_MS/);
const address = { hash: new Uint8Array(32), context: new Uint8Array(16) };
const payload = new Uint8Array([1, 2, 3]);
const fragment = { flags: 0, sizePayload: 3, sizeContent: 3n };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const until = async condition => {
  for (let i = 0; i < 100 && !condition(); i++) await delay(5);
  assert.ok(condition(), "operation did not progress");
};

// No index publication or acknowledgement before R2 finishes.
let published = 0;
const gate = deferred();
const writer = new PackWriter({ FRAGMENTS: { put: () => gate.promise } }, { id: "test", store: { publishPack: entries => { published++; return entries.map(() => true); } } }, options);
let acknowledged = false;
const stored = writer.add(address, fragment, payload).then(() => { acknowledged = true; });
writer.flush();
await delay(10);
assert.equal(published, 0);
assert.equal(acknowledged, false);
gate.resolve({});
await stored;
assert.equal(published, 1);

let calls = 0;
const failedR2 = new PackWriter({ FRAGMENTS: { put: async () => { throw new Error("R2 failed"); } } }, { id: "test", store: { publishPack: () => { calls++; } } }, options);
const r2Result = failedR2.add(address, fragment, payload);
failedR2.flush();
await assert.rejects(r2Result, /R2 failed/);
assert.equal(calls, 0);

const failedIndex = new PackWriter({ FRAGMENTS: { put: async () => ({}) } }, { id: "test", store: { publishPack: () => { throw new Error("index failed"); } } }, options);
const indexResult = failedIndex.add(address, fragment, payload);
failedIndex.flush();
await assert.rejects(indexResult, /index failed/);

const canceled = new PackWriter({ FRAGMENTS: { put: () => { calls++; } } }, { id: "test", store: {} }, options);
const cancelResult = canceled.add(address, fragment, payload);
canceled.cancel();
await assert.rejects(cancelResult, /stream closed/);
assert.equal(calls, 0);

// Fifty-one packs requested at once must never start more than 50 R2 writes.
const gates = [];
const limited = new PackWriter({ FRAGMENTS: { put: () => { const item = deferred(); gates.push(item); return item.promise; } } }, { id: "test", store: { publishPack: entries => entries.map(() => true) } }, options);
const items = [];
for (let i = 0; i < 51; i++) { items.push(limited.add(address, fragment, payload)); limited.flush(); }
assert.equal(gates.length, 50);
gates[0].resolve({});
await until(() => gates.length === 51);
for (const item of gates.slice(1)) item.resolve({});
await Promise.all(items);

// A full byte-size batch starts immediately; a partial one waits for linger.
const sizes = [];
const configured = new PackWriter({ FRAGMENTS: { put: async (_key, body) => { sizes.push(body.length); } } }, { id: "test", store: { publishPack: entries => entries.map(() => true) } }, { ...options, maxBytes: 6, lingerMs: 30 });
const first = configured.add(address, fragment, payload);
assert.deepEqual(sizes, []);
const second = configured.add(address, fragment, payload);
assert.deepEqual(sizes, [6]);
await Promise.all([first, second]);
const partial = configured.add(address, fragment, payload);
assert.deepEqual(sizes, [6]);
await partial;
assert.deepEqual(sizes, [6, 3]);

// An isolated stream stops accepting more payloads while its bounded memory is
// held by in-flight pack writes, then resumes when a write completes.
const pressureGates = [];
const pressure = new PackWriter({ FRAGMENTS: { put: () => { const item = deferred(); pressureGates.push(item); return item.promise; } } }, { id: "test", store: { publishPack: entries => entries.map(() => true) } }, options);
const largePayload = new Uint8Array(256 * 1024);
const largeFragment = { flags: 0, sizePayload: largePayload.length, sizeContent: BigInt(largePayload.length) };
const largeItems = [];
for (let i = 0; i < 128; i++) largeItems.push(pressure.add(address, largeFragment, largePayload));
assert.equal(pressureGates.length, 4);
let resumed = false;
const capacity = pressure.waitForCapacity().then(() => { resumed = true; });
await delay(10);
assert.equal(resumed, false);
pressureGates[0].resolve({});
await capacity;
assert.equal(resumed, true);
for (const item of pressureGates.slice(1)) item.resolve({});
await Promise.all(largeItems);

// The outstanding-item limit must flush a partial batch rather than waiting
// for a response that cannot arrive until the linger timer fires.
const pending = [];
const batchLengths = [];
const mockWriter = {
  async waitForCapacity() {},
  flush() { if (pending.length) { batchLengths.push(pending.length); for (const resolve of pending.splice(0)) resolve(); } },
  cancel() {},
};
async function* input() { yield 1; yield 2; yield 3; }
const responses = [];
for await (const value of packedStream(input(), mockWriter, 2, value => new Promise(resolve => pending.push(() => resolve(value))))) responses.push(value);
assert.deepEqual(responses, [1, 2, 3]);
assert.deepEqual(batchLengths, [2, 1]);
console.log("Pack settings, size/linger flush, memory backpressure, failures and concurrency passed");
