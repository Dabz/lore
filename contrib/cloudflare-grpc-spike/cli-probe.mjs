// SPDX-FileCopyrightText: 2026 Epic Games, Inc.
// SPDX-License-Identifier: MIT
// Local mode bridges gRPC to gRPC-web. Remote mode forwards native gRPC over
// TLS using Node, allowing tests where Lore's TLS rejects an intercepting CA.
import { spawn } from "node:child_process";
import http from "node:http";
import http2 from "node:http2";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const target = process.argv[2] ? new URL(process.argv[2]) : null;
const cloneOnly = process.argv[3];
if ((target && (target.protocol !== "https:" || target.pathname !== "/" || target.search || target.hash)) || (cloneOnly && !target) || process.argv.length > 4) throw new Error("usage: node cli-probe.mjs [https://HOST [REPOSITORY_TO_CLONE]]");
const temp = await mkdtemp(join(tmpdir(), "lore-cli-worker-"));
const work = join(temp, "work");
await mkdir(work);
const worker = target ? null : spawn(process.execPath, ["./node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--config", "wrangler.jsonc", "--persist-to", join(temp, "state"), "--ip", "127.0.0.1", "--port", "8796"], { stdio: "inherit" });
const bridgeWindow = process.env.LORE_BRIDGE_WINDOW ? Number(process.env.LORE_BRIDGE_WINDOW) : 65535;
if (!Number.isSafeInteger(bridgeWindow) || bridgeWindow < 65535 || bridgeWindow > 0x7fffffff) throw new Error("LORE_BRIDGE_WINDOW must be an integer between 65535 and 2147483647");
const bridge = http2.createServer({ settings: { initialWindowSize: bridgeWindow } });
const remote = target ? http2.connect(target.origin, { settings: { initialWindowSize: bridgeWindow } }) : null;
if (remote) remote.on("connect", () => remote.setLocalWindowSize(bridgeWindow));
bridge.on("session", session => session.setLocalWindowSize(bridgeWindow));
if (remote) remote.on("error", error => console.error(`upstream: ${error.message}`));
if (remote) bridge.on("stream", (client, headers) => {
  const outgoing = remote.request({ ...headers, ":scheme": "https", ":authority": target.host });
  let trailers;
  let ready = false;
  client.on("wantTrailers", () => { ready = true; client.sendTrailers(trailers ?? {}); });
  outgoing.on("response", response => client.respond(response, { waitForTrailers: true }));
  outgoing.on("trailers", value => { trailers = value; });
  outgoing.on("error", error => { console.error(`upstream stream: ${error.message}`); client.close(); });
  client.on("error", () => outgoing.close());
  client.on("close", () => { if (!ready) outgoing.close(); });
  client.pipe(outgoing);
  outgoing.pipe(client);
});
else bridge.on("stream", (client, headers) => {
  const incoming = Object.fromEntries(Object.entries(headers).filter(([key]) => !key.startsWith(":")));
  incoming["content-type"] = "application/grpc-web+proto";
  incoming["x-grpc-web"] = "1";
  delete incoming.te;
  const upstream = http.request({ hostname: "127.0.0.1", port: 8796, path: headers[":path"], method: "POST", headers: incoming });
  let trailers = { "grpc-status": "13", "grpc-message": "missing grpc-web trailer" };
  client.on("wantTrailers", () => client.sendTrailers(trailers));
  upstream.on("response", response => {
    client.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    let data = Buffer.alloc(0);
    response.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 5 && data.length >= 5 + data.readUInt32BE(1)) {
        const size = data.readUInt32BE(1);
        const message = data.subarray(0, size + 5);
        data = data.subarray(size + 5);
        if (message[0] & 0x80) {
          trailers = Object.fromEntries(message.subarray(5).toString().split("\r\n").filter(Boolean).map(line => {
            const colon = line.indexOf(":");
            return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
          }));
        } else client.write(message);
      }
    });
    response.on("end", () => client.end());
    response.on("error", () => client.close());
  });
  upstream.on("error", error => { console.error(error); client.close(); });
  client.on("error", () => upstream.destroy());
  client.pipe(upstream);
});
const binary = process.env.LORE_BINARY ? resolve(process.env.LORE_BINARY) : resolve("../../target/debug/lore");
const timeoutMs = process.env.LORE_TIMEOUT_MS ? Number(process.env.LORE_TIMEOUT_MS) : 0;
const maxConnections = process.env.LORE_MAX_CONNECTIONS ? Number(process.env.LORE_MAX_CONNECTIONS) : 0;
const probeFile = process.env.LORE_PROBE_FILE ? resolve(process.env.LORE_PROBE_FILE) : null;
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("LORE_TIMEOUT_MS must be a nonnegative integer");
if (!Number.isSafeInteger(maxConnections) || maxConnections < 0) throw new Error("LORE_MAX_CONNECTIONS must be a nonnegative integer");
const token = [Buffer.from('{"alg":"none"}').toString("base64url"), Buffer.from('{"sub":"tester","iss":"local","aud":"local","exp":4102444800}').toString("base64url"), "x"].join(".");
async function lore(args, cwd = work, globalPath = join(temp, "writer-global")) {
  console.log(`\n$ lore ${args.join(" ")}`);
  const child = spawn(binary, ["--identity", "tester", ...(maxConnections ? ["--max-connections", String(maxConnections)] : []), ...args], { cwd, stdio: "inherit", env: { ...process.env, LORE_ACCESS_TOKEN: token, LORE_GLOBAL_PATH: globalPath } });
  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs) : undefined;
  let code;
  try { code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); }); }
  finally { if (timer) clearTimeout(timer); }
  if (timedOut) throw new Error(`lore timed out after ${timeoutMs} ms`);
  if (code !== 0) throw new Error(`lore exited with status ${code}`);
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function cloneAndVerify(url, name) {
  const start = performance.now();
  await lore(["clone", `${url}/${name}`, join(temp, "clone")], temp, join(temp, "clone-global"));
  const seconds = (performance.now() - start) / 1000;
  if (probeFile) {
    const target = join(temp, "clone", basename(probeFile));
    assert.equal((await stat(target)).size, (await stat(probeFile)).size);
    assert.equal(await digest(target), await digest(probeFile));
    console.log(`Verified clone: ${seconds.toFixed(2)} s, ${((await stat(probeFile)).size / 1048576 / seconds).toFixed(2)} MiB/s`);
  }
}
try {
  for (let i = 0; worker && i < 150; i++) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited ${worker.exitCode}`);
    try { await fetch("http://127.0.0.1:8796"); break; } catch { await delay(100); }
  }
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
  const url = `grpc://127.0.0.1:${bridge.address().port}`;
  if (cloneOnly) {
    await cloneAndVerify(url, cloneOnly);
    console.log("Clean-data clone passed");
  } else {
    const name = target ? `probe-${randomUUID()}` : "demo";
    await lore(["repository", "create", `${url}/${name}`]);
    await lore(["repository", "list", url]);
    await writeFile(join(work, "example.txt"), "Hello from Lore on Workers.\n");
    const large = probeFile ? null : randomBytes(8 * 1024 * 1024);
    const largeName = probeFile ? basename(probeFile) : "large.bin";
    if (probeFile) await copyFile(probeFile, join(work, largeName), constants.COPYFILE_FICLONE);
    else await writeFile(join(work, largeName), large);
    await lore(["stage", "example.txt"]);
    await lore(["stage", largeName]);
    await lore(["commit", "initial commit"]);
    await lore(["push"]);
    await writeFile(join(work, "example.txt"), "A second revision on Workers.\n");
    await lore(["stage", "example.txt"]);
    await lore(["commit", "second commit"]);
    await lore(["push"]);
    // A separate global directory prevents a shared client store from masking
    // missing remote fragments during the clone.
    await cloneAndVerify(url, name);
    assert.equal(await readFile(join(temp, "clone", "example.txt"), "utf8"), "A second revision on Workers.\n");
    if (large) assert.deepEqual(await readFile(join(temp, "clone", largeName)), large);
    console.log("CLI create, list, stage, commit, push and clone (including 8 MiB fragmented file) passed");
  }
} finally {
  bridge.close();
  if (remote) remote.destroy();
  if (worker && worker.exitCode === null) {
    const exited = new Promise(resolve => worker.once("exit", resolve));
    worker.kill("SIGTERM");
    await exited;
  }
  await rm(temp, { recursive: true, force: true });
}
