// SPDX-FileCopyrightText: 2026 Epic Games, Inc.
// SPDX-License-Identifier: MIT
import { PackWriter } from "./immutable.js";

// Consume independently of response production so a client can send multiple
// messages before waiting for acknowledgements. The limit includes completed
// responses, giving slow readers backpressure as well as bounding payloads.
export async function* packedStream<T, R>(requests: AsyncIterable<T>, writer: PackWriter, maxPending: number, process: (request: T) => Promise<R>): AsyncGenerator<R> {
  const iterator = requests[Symbol.asyncIterator]();
  const ready: R[] = [];
  let outstanding = 0;
  let done = false;
  let stopped = false;
  let failure: unknown;
  const waiters = new Set<() => void>();
  const signal = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  const wait = () => new Promise<void>(resolve => { waiters.add(resolve); });
  const producer = (async () => {
    try {
      while (!stopped) {
        while (outstanding >= maxPending && !stopped) {
          writer.flush();
          await wait();
        }
        if (stopped) break;
        await writer.waitForCapacity();
        if (stopped) break;
        const next = await iterator.next();
        if (next.done) break;
        if (stopped) break;
        outstanding++;
        void process(next.value).then(value => { ready.push(value); signal(); }, error => { failure = error; signal(); });
      }
      writer.flush();
    } catch (error) { failure = error; }
    finally { done = true; signal(); }
  })();
  try {
    while (!done || outstanding) {
      if (failure !== undefined) throw failure;
      if (ready.length) {
        const value = ready.shift()!;
        outstanding--;
        signal();
        yield value;
      } else await wait();
    }
    if (failure !== undefined) throw failure;
    await producer;
  } finally {
    stopped = true;
    writer.cancel();
    signal();
    // A disconnected client may have a pending next(); do not wait for it.
    if (iterator.return) void iterator.return().catch(() => {});
  }
}
