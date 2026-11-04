/**
 * A minimal Chrome DevTools Protocol client over Chrome's
 * `--remote-debugging-pipe` (file descriptors 3 and 4, messages separated by
 * a NUL byte). A pipe is used instead of a debugging port so no other program
 * on the computer can attach to the browser window, which may hold the
 * person's Alibaba.com sign-in.
 *
 * Only the handful of commands the supervised browser assistant needs are
 * sent (see chrome-driver.ts). Cookie, storage and network commands are never
 * used.
 */

export interface CdpConnection {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>;
  readonly closed: boolean;
  close(): void;
}

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PipeStreams {
  write(chunk: string): void;
  onData(listener: (chunk: Buffer | string) => void): void;
  onClose(listener: () => void): void;
  end(): void;
}

/** Splits a NUL-delimited stream into messages, across arbitrary chunk boundaries. */
export class NulFramer {
  private buffer = "";
  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parts = this.buffer.split("\0");
    this.buffer = parts.pop() ?? "";
    return parts.filter((p) => p.length > 0);
  }
}

export function pipeConnection(streams: PipeStreams, defaultTimeoutMs = 15_000): CdpConnection {
  let nextId = 0;
  let closed = false;
  const pending = new Map<number, Pending>();
  const framer = new NulFramer();

  const failAll = (message: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new CdpError(message));
      pending.delete(id);
    }
  };

  streams.onData((chunk) => {
    for (const text of framer.push(chunk)) {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof msg.id !== "number") continue; // events are not used
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(msg.error.message ?? "The browser refused the command"));
      else p.resolve(msg.result ?? {});
    }
  });
  streams.onClose(() => {
    closed = true;
    failAll("The browser window was closed");
  });

  return {
    get closed() {
      return closed;
    },
    send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = defaultTimeoutMs): Promise<T> {
      if (closed) return Promise.reject(new CdpError("The browser window was closed"));
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CdpError(`The browser did not answer ${method} in time`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        streams.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      failAll("The connection to the browser was closed");
      streams.end();
    },
  };
}
