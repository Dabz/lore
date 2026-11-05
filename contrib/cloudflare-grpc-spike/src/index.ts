// SPDX-FileCopyrightText: 2026 Epic Games, Inc.
// SPDX-License-Identifier: MIT
// Unauthenticated experimental subset of the Lore service APIs.
import { DurableObject } from "cloudflare:workers";
import { Code, ConnectError, createConnectRouter } from "@connectrpc/connect";
import { universalServerRequestFromFetch, universalServerResponseToFetch } from "@connectrpc/connect/protocol";
import { EnvironmentService } from "./gen/lore/environment/v1/environment_pb.js";
import { StorageService } from "./gen/lore/storage/v1/storage_pb.js";
import { RepositoryService } from "./gen/lore/repository/v1/repository_pb.js";
import { RevisionService } from "./gen/lore/revision/v1/revision_pb.js";
import { fromHex, getFragment, getFragments, itemStatus, PackWriter, queryFragments, ReadRangeScheduler, toHex } from "./immutable.js";
import { packedStream } from "./stream.js";
import { ReadMetrics, readOptions, readStream } from "./read-stream.js";
import { ReadAheadCache } from "./read-cache.js";
import { packOptions } from "./pack-options.js";
import { branchRecord, repositoryService } from "./repository.js";
import { verifyRevision } from "./revision.js";
import { repackTree } from "./repack.js";
import type { BranchData, FragmentAddress, FragmentHeader, PackEntry, PackLocation, PackRelocation, RepositoryRequest, Scope } from "./types.js";
import type { GetResolvedRequest } from "./gen/lore/storage/v1/storage_pb.js";
export { RepositoryCatalog, PackedRepositoryCatalog } from "./repository.js";

const ZERO = "00".repeat(32);
type GetReply = { address: FragmentAddress; fragment?: FragmentHeader; payload?: Uint8Array; status: { code: number; message?: string } };
type ResolvedReply = { requestId: bigint; resolved?: Uint8Array; fragment?: FragmentHeader; payload?: Uint8Array; status: { code: number; message?: string } };
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) => Uint8Array.from(value.match(/../g)!, part => parseInt(part, 16));

function hash(value: Uint8Array, label: string) {
  if (value.length !== 32) throw new ConnectError(`${label} must be 32 bytes`, Code.InvalidArgument);
  return hex(value);
}

function keyType(value: number, write = false) {
  if (value > 7) throw new ConnectError("invalid key type", Code.InvalidArgument);
  // These types have dedicated, validated mutation APIs in the Lore server.
  if (write && (value === 1 || value === 3 || value === 4)) {
    throw new ConnectError("key type requires its dedicated API", Code.InvalidArgument);
  }
  return value;
}

function partition(headers: Headers, env: Env): Scope {
  const encoded = headers.get("lore-partition-bin") ?? headers.get("urc-repository-id-bin");
  if (!encoded) throw new ConnectError("missing repository ID", Code.InvalidArgument);
  let id;
  try {
    id = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  } catch {
    throw new ConnectError("invalid repository ID", Code.InvalidArgument);
  }
  if (id.length !== 16) throw new ConnectError("repository ID must be 16 bytes", Code.InvalidArgument);
  const name = hex(id);
  return { id: name, store: env.MUTABLE.getByName(name) };
}

// One instance per partition. Synchronous SQLite transactions make each CAS atomic,
// including the read of a missing key and a concurrent insert.
// Retain the old class export for the existing migration; the new binding has
// its own namespace and does not interpret old fragment associations as packs.
export class MutablePartition extends DurableObject<Env> {}
export class PackedMutablePartition extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS entries (type INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (type, key))");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS fragments (hash TEXT NOT NULL, context TEXT NOT NULL, PRIMARY KEY (hash, context))");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS fragment_objects (hash TEXT PRIMARY KEY, key TEXT NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL, flags INTEGER NOT NULL, content TEXT NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, name TEXT COLLATE NOCASE UNIQUE NOT NULL, record TEXT NOT NULL)");
  }

  load(type: number, key: string) {
    return this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM entries WHERE type = ? AND key = ?", type, key).toArray()[0]?.value ?? null;
  }

  loadMany(type: number, keys: string[]) {
    return keys.map(key => this.load(type, key));
  }

  store(type: number, key: string, value: string) {
    if (value === ZERO) {
      this.ctx.storage.sql.exec("DELETE FROM entries WHERE type = ? AND key = ?", type, key);
    } else {
      this.ctx.storage.sql.exec("INSERT INTO entries (type, key, value) VALUES (?, ?, ?) ON CONFLICT(type, key) DO UPDATE SET value = excluded.value", type, key, value);
    }
  }

  compareAndSwap(type: number, key: string, expected: string, value: string) {
    return this.ctx.storage.transactionSync(() => {
      const current = this.load(type, key) ?? ZERO;
      // Unlike store(zero), CAS can install an explicit zero value. Lore uses
      // this to initialize branch pointers and subsequently reads that value.
      if (current === expected) {
        this.ctx.storage.sql.exec("INSERT INTO entries (type, key, value) VALUES (?, ?, ?) ON CONFLICT(type, key) DO UPDATE SET value = excluded.value", type, key, value);
      }
      return current;
    });
  }

  associate(hash: string, context: string) {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO fragments (hash, context) VALUES (?, ?)", hash, context);
  }

  matchFragment(hash: string, context: string) {
    const matches = this.ctx.storage.sql.exec("SELECT context FROM fragments WHERE hash = ? ORDER BY context = ? DESC LIMIT 1", hash, context).toArray();
    return matches.length === 0 ? 2 : matches[0].context === context ? 0 : 1;
  }

  publishPack(entries: PackEntry[]): boolean[] {
    return this.ctx.storage.transactionSync(() => entries.map(entry => {
      const sql = this.ctx.storage.sql;
      const existing = sql.exec<PackLocation>("SELECT key, offset, length, flags, content FROM fragment_objects WHERE hash = ?", entry.hash).toArray()[0];
      if (existing && ((existing.flags & 1) !== (entry.flags & 1) || existing.content !== entry.content)) return false;
      if (!existing) sql.exec("INSERT INTO fragment_objects (hash, key, offset, length, flags, content) VALUES (?, ?, ?, ?, ?, ?)", entry.hash, entry.key, entry.offset, entry.length, entry.flags, entry.content);
      this.associate(entry.hash, entry.context);
      return true;
    }));
  }

  relocatePack(entries: PackRelocation[]): number {
    return this.ctx.storage.transactionSync(() => {
      let moved = 0;
      for (const entry of entries) {
        const old = entry.old;
        const result = this.ctx.storage.sql.exec("UPDATE fragment_objects SET key = ?, offset = ? WHERE hash = ? AND key = ? AND offset = ? AND length = ? AND flags = ? AND content = ?", entry.key, entry.offset, entry.hash, old.key, old.offset, old.length, old.flags, old.content);
        moved += result.rowsWritten;
      }
      return moved;
    });
  }

  describeFragments(addresses: { hash: string; context: string }[]) {
    return addresses.map(({ hash, context }) => {
      const location = this.ctx.storage.sql.exec<PackLocation>("SELECT key, offset, length, flags, content FROM fragment_objects WHERE hash = ?", hash).toArray()[0];
      return location ? { state: this.matchFragment(hash, context), location } : { state: 2, location: null };
    });
  }

  initializeRepository(request: RepositoryRequest, created: number, metadata: string, branchHash: string) {
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM branches WHERE id = ?", request.defaultBranchId).toArray()[0];
      const record: BranchData = {
        id: request.defaultBranchId, name: request.defaultBranchName, creator: request.creator,
        category: "", created, latest: ZERO, deleted: false, metadata: branchHash,
      };
      if (existing) {
        const prior = JSON.parse(existing.record) as BranchData;
        if (prior.id !== record.id || prior.name !== record.name || prior.creator !== record.creator || prior.created !== record.created || prior.metadata !== record.metadata) {
          throw new Error("repository initialization conflict");
        }
      }
      if (!existing) this.ctx.storage.sql.exec("INSERT INTO branches (id, name, record) VALUES (?, ?, ?)", record.id, record.name, JSON.stringify(record));
    });
  }

  getBranch(kind: "id" | "name", value: string): BranchData | null {
    const row = this.ctx.storage.sql.exec<{ record: string }>(`SELECT record FROM branches WHERE ${kind === "id" ? "id" : "name"} = ?`, value).toArray()[0];
    return row ? JSON.parse(row.record) as BranchData : null;
  }

  listBranches(creator: string | null): BranchData[] {
    return this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM branches ORDER BY name").toArray()
      .map(row => JSON.parse(row.record) as BranchData).filter(record => creator === null || record.creator === creator);
  }

  advanceBranch(id: string, expected: string, next: string, number: string): { result: "missing" } | { result: "ok" } | { result: "diverged"; latest: string } {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM branches WHERE id = ?", id).toArray()[0];
      if (!row) return { result: "missing" };
      const record = JSON.parse(row.record) as BranchData;
      if (record.latest === next) return { result: "ok" };
      if (record.latest !== expected || BigInt(record.number ?? "0") + 1n !== BigInt(number)) return { result: "diverged", latest: record.latest };
      record.latest = next;
      record.number = number;
      this.ctx.storage.sql.exec("UPDATE branches SET record = ? WHERE id = ?", JSON.stringify(record), id);
      return { result: "ok" };
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const router = createConnectRouter();
    router.service(EnvironmentService, { environmentGet: () => ({ environment: { config: { compressionMode: 1, maxQueryBatch: 5461 } } }) });
    router.service(RepositoryService, repositoryService(env));
    router.service(RevisionService, {
      async branchGet(req, context) {
        if (!req.query?.case) throw new ConnectError("branch query required", Code.InvalidArgument);
        if (req.query.case === "id" && req.query.value.length !== 16) throw new ConnectError("invalid branch id", Code.InvalidArgument);
        const value = req.query.case === "id" ? hex(req.query.value) : req.query.value;
        const record = await partition(context.requestHeader, env).store.getBranch(req.query.case, value);
        if (!record) throw new ConnectError("branch not found", Code.NotFound);
        return { branch: branchRecord(record) };
      },
      async *branchList(req, context) {
        const records = await partition(context.requestHeader, env).store.listBranches(req.creator ?? null);
        for (const record of records) if (req.includeDeleted || !record.deleted) yield { branch: branchRecord(record) };
      },
      async branchMetadataGet(req, context) {
        if (req.id.length !== 16) throw new ConnectError("invalid branch id", Code.InvalidArgument);
        const record = await partition(context.requestHeader, env).store.getBranch("id", hex(req.id));
        if (!record) throw new ConnectError("branch not found", Code.NotFound);
        return { metadata: bytes(record.metadata) };
      },
      async branchPush(req, context) {
        if (req.id.length !== 16 || req.revisionSignature.length !== 32 || req.revisionSignature.every(byte => byte === 0)) {
          throw new ConnectError("invalid branch or revision", Code.InvalidArgument);
        }
        if (req.force || req.fastForwardMerge) throw new ConnectError("forced pushes and merges are not supported yet", Code.Unimplemented);
        const scope = partition(context.requestHeader, env);
        const branchId = hex(req.id);
        const record = await scope.store.getBranch("id", branchId);
        if (!record) throw new ConnectError("branch not found", Code.NotFound);
        const verified = await verifyRevision(env, scope, req.revisionSignature);
        const result = await scope.store.advanceBranch(branchId, verified.parent, hex(req.revisionSignature), String(verified.number));
        if (result.result === "missing") throw new ConnectError("branch not found", Code.NotFound);
        if (result.result !== "ok") throw new ConnectError(`branch push is not a fast-forward; branch latest: ${result.latest}`, Code.FailedPrecondition);
        return { revisionSignature: req.revisionSignature, revisionNumber: verified.number, fastForwardMerged: false };
      },
    });
    router.service(StorageService, {
      async *put(requests, context) {
        const scope = partition(context.requestHeader, env);
        const options = packOptions(env);
        const writer = new PackWriter(env, scope, options);
        yield* packedStream(requests, writer, options.maxPending, async req => {
          if (!req.address) throw new ConnectError("put address is required", Code.InvalidArgument);
          try {
            await writer.add(req.address, req.fragment, req.payload);
            return { address: req.address, status: { code: 0 } };
          } catch (error) {
            return { address: req.address, status: itemStatus(error) };
          }
        });
      },
      async *get(requests, context) {
        const scope = partition(context.requestHeader, env);
        const options = readOptions(env);
        const metrics = new ReadMetrics("Get", options);
        const cache = options.readAheadBytes ? new ReadAheadCache(options.readAheadBytes, options.cacheBytes, metrics) : undefined;
        let scheduler: ReadRangeScheduler | undefined;
        try { yield* readStream<FragmentAddress, GetReply>(requests, options, async (batch, emit, limiter, budget) => {
          scheduler ??= new ReadRangeScheduler(env, scope, options, limiter, metrics, cache, budget);
          await getFragments(env, scope, batch, false, options, limiter, (i, result, release) => {
            metrics.result(result);
            emit("error" in result ? { address: batch[i], status: itemStatus(result.error) } : { address: batch[i], ...result, status: { code: 0 } }, release);
          }, metrics, cache, budget, scheduler);
        }, metrics); } finally { scheduler?.close(); cache?.close(); }
      },
      async *getMetadata(requests, context) {
        const scope = partition(context.requestHeader, env);
        const options = readOptions(env);
        const metrics = new ReadMetrics("GetMetadata", options);
        yield* readStream<FragmentAddress, GetReply>(requests, options, async (batch, emit, limiter) => {
          await getFragments(env, scope, batch, true, options, limiter, (i, result) => {
            metrics.result(result);
            emit("error" in result ? { address: batch[i], status: itemStatus(result.error) } : { address: batch[i], ...result, status: { code: 0 } });
          }, metrics);
        }, metrics);
      },
      async query(req, context) {
        return queryFragments(partition(context.requestHeader, env), req.addresses);
      },
      async *putResolved(requests, context) {
        const scope = partition(context.requestHeader, env);
        const options = packOptions(env);
        const writer = new PackWriter(env, scope, options);
        const chains = new Map<string, Promise<void>>();
        yield* packedStream(requests, writer, options.maxPending, async req => {
          if (req.requestId === 0n) throw new ConnectError("request id must be nonzero", Code.InvalidArgument);
          try {
            const key = hash(req.key, "key");
            if (key === ZERO || !req.address) throw new ConnectError("invalid key or missing address", Code.InvalidArgument);
            const target = hash(req.address.hash, "address hash");
            // Start the pack write immediately, but serialize mapping updates for
            // the same key in request order even across concurrent pack uploads.
            const written = target === ZERO ? Promise.resolve(null) : writer.add(req.address, req.fragment, req.payload).then(() => null, error => error);
            const previous = chains.get(key) ?? Promise.resolve();
            const update = previous.catch(() => {}).then(async () => {
              const error: unknown = await written;
              if (error !== null) throw error;
              if (target !== ZERO && req.fragment && (req.fragment.flags & 1) && req.fragment.sizeContent >= 4n * 1024n * 1024n) {
                try { await repackTree(env, scope, req.address!); }
                catch (error) { console.error({ event: "repack_failed", partition: scope.id, error: String(error) }); }
              }
              await scope.store.store(7, key, target);
            });
            chains.set(key, update);
            try { await update; } finally { if (chains.get(key) === update) chains.delete(key); }
            return { requestId: req.requestId, status: { code: 0 } };
          } catch (error) {
            return { requestId: req.requestId, status: itemStatus(error) };
          }
        });
      },
      async *getResolved(requests, context) {
        const scope = partition(context.requestHeader, env);
        const options = readOptions(env);
        const metrics = new ReadMetrics("GetResolved", options);
        const cache = options.readAheadBytes ? new ReadAheadCache(options.readAheadBytes, options.cacheBytes, metrics) : undefined;
        let scheduler: ReadRangeScheduler | undefined;
        try { yield* readStream<GetResolvedRequest, ResolvedReply>(requests, options, async (batch, emit, limiter, budget) => {
          scheduler ??= new ReadRangeScheduler(env, scope, options, limiter, metrics, cache, budget);
          if (batch.some(req => req.requestId === 0n)) throw new ConnectError("request id must be nonzero", Code.InvalidArgument);
          const valid: Array<{ req: GetResolvedRequest; key: string }> = [];
          for (const req of batch) {
            try {
              if (req.flags !== 0) throw new ConnectError("unsupported flags", Code.Unimplemented);
              if (!req.key) throw new ConnectError("key is required", Code.InvalidArgument);
              valid.push({ req, key: hash(req.key.hash, "key") });
            } catch (error) { metrics.result({ error }); emit({ requestId: req.requestId, status: itemStatus(error) }); }
          }
          let values: Array<string | null>;
          try { values = valid.length ? await scope.store.loadMany(7, valid.map(item => item.key)) : []; }
          catch (error) { for (const item of valid) { metrics.result({ error }); emit({ requestId: item.req.requestId, status: itemStatus(error) }); } return; }
          const found: Array<{ req: GetResolvedRequest; address: FragmentAddress }> = [];
          for (const [i, item] of valid.entries()) {
            const value = values[i];
            if (value === null) {
              const error = new ConnectError("mutable key not found", Code.NotFound);
              metrics.result({ error });
              emit({ requestId: item.req.requestId, status: itemStatus(error) });
            } else found.push({ req: item.req, address: { hash: fromHex(value), context: item.req.key!.context } });
          }
          await getFragments(env, scope, found.map(item => item.address), false, options, limiter, (i, result, release) => {
            const item = found[i];
            metrics.result(result);
            emit("error" in result ? { requestId: item.req.requestId, status: itemStatus(result.error) } : { requestId: item.req.requestId, resolved: item.address.hash, ...result, status: { code: 0 } }, release);
          }, metrics, cache, budget, scheduler);
        }, metrics); } finally { scheduler?.close(); cache?.close(); }
      },
      async *copy(requests, context) {
        const scope = partition(context.requestHeader, env);
        for await (const req of requests) {
          if (!req.sourceAddress) throw new ConnectError("copy source address is required", Code.InvalidArgument);
          try {
            if (req.sourceRepositoryId.length !== 16 || toHex(req.sourceRepositoryId) !== scope.id) {
              throw new ConnectError("cross-repository copy is not supported yet", Code.Unimplemented);
            }
            await getFragment(env, scope, req.sourceAddress, true);
            const targetContext = req.targetContext.length ? req.targetContext : req.sourceAddress.context;
            if (targetContext.length !== 16) throw new ConnectError("target context must be 16 bytes", Code.InvalidArgument);
            await scope.store.associate(hash(req.sourceAddress.hash, "hash"), hex(targetContext));
            yield { sourceRepositoryId: req.sourceRepositoryId, sourceAddress: req.sourceAddress, status: { code: 0 } };
          } catch (error) {
            yield { sourceRepositoryId: req.sourceRepositoryId, sourceAddress: req.sourceAddress, status: itemStatus(error) };
          }
        }
      },
      async mutableLoad(req, context) {
        const value = await partition(context.requestHeader, env).store.load(keyType(req.keyType), hash(req.key, "key"));
        if (value === null) throw new ConnectError("mutable key not found", Code.NotFound);
        return { value: bytes(value) };
      },
      async mutableStore(req, context) {
        await partition(context.requestHeader, env).store.store(keyType(req.keyType, true), hash(req.key, "key"), hash(req.value, "value"));
        return {};
      },
      async mutableCompareAndSwap(req, context) {
        const current = await partition(context.requestHeader, env).store.compareAndSwap(
          keyType(req.keyType, true), hash(req.key, "key"), hash(req.expected, "expected"), hash(req.value, "value"),
        );
        return { currentValue: bytes(current) };
      },
    });
    const handler = router.handlers.find(item => item.requestPath === new URL(request.url).pathname);
    if (!handler) return new Response("Not found", { status: 404 });
    return universalServerResponseToFetch(await handler(universalServerRequestFromFetch(request, {})));
  },
} satisfies ExportedHandler<Env>;
