import { Socket } from "net";
import * as tls from "tls";
import { Transport } from "../../../interfaces/transport";
import { Message } from "../../../shared/model/networking/message";
import {
  ConnectionStatus,
  ConnectionStatusEventArgs,
} from "../../../shared/model/networking/connectionStatus";
import { EventEmitter } from "events";
import { decode, encode } from "msgpack-lite";

export interface SslConfig {
  sslEnabled: boolean;
  rejectUnauthorized: boolean;
  key?: string | Buffer;
  cert?: string | Buffer;
}

function delay(ms: number) {
  return new Promise( resolve => setTimeout(resolve, ms) );
}

// Hard cap on the wire-supplied length-prefix. A malicious or corrupted
// frame could otherwise allocate up to 4 GiB. Matches the C# side's
// MaxFrameBytes for cross-implementation parity. Frames larger than this
// abort the receive loop and trigger a reconnect (client) or socket close
// (server) so we don't get stuck mid-stream on a poisoned frame.
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class Mutex {
  private mutex = Promise.resolve();

  lock(): Promise<() => void> {
      return new Promise((resolve) => {
          this.mutex = this.mutex.then(() => new Promise(resolve));
      });
  }
}

export class TcpTransport extends EventEmitter implements Transport {
  private socket: Socket | tls.TLSSocket;
  // Server-side: the raw TCP socket from createServer() before any TLS
  // wrap. We track it so dispose() can force-destroy it directly —
  // destroying the TLSSocket wrapper alone does not synchronously close
  // the underlying TCP socket that net.Server tracks for close-completion,
  // which makes server.close() hang on TLS-wrapped connections.
  private rawAcceptSocket: Socket | null = null;
  private host: string;
  private port: number;
  private sslConfig: SslConfig;
  private isServer: boolean = false;
  private isSettingUpSsl: boolean = false;
  private disposed: boolean = false;
  private buffer: Buffer = Buffer.alloc(0);
  private mutex: Mutex = new Mutex();
  private isConnected: boolean = false;

  // Notifier for the buffered reader. resolve() = "buffer/state changed,
  // re-check"; reject(err) = "socket failed, abort the in-flight read".
  // Recreated after every fire so readers always await a fresh promise.
  private readWaiter: { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } | null = null;
  private readEnded: boolean = false;
  private readEndError: Error | null = null;
  // Tracks the socket that owns the currently-attached read listeners so
  // we can detach cleanly when the socket is replaced (reconnect / TLS
  // upgrade) without leaking listeners on the old instance.
  private readListenersSocket: Socket | tls.TLSSocket | null = null;
  private onDataListener: ((chunk: Buffer) => void) | null = null;
  private onCloseListener: (() => void) | null = null;
  private onEndListener: (() => void) | null = null;
  private onReadErrorListener: ((err: Error) => void) | null = null;

  public alwaysReconnect: boolean = false;
  public maxConnectWaitTime: number = 60000; // Default: 60 seconds

  constructor(
    socketOrHost: Socket | string,
    portOrSslConfig: number | SslConfig,
    sslConfigArg?: SslConfig
  ) {
    super();
    if (typeof socketOrHost === "string") {
      this.host = socketOrHost;
      this.port = portOrSslConfig as number;
      this.sslConfig = sslConfigArg!;
      this.socket = new Socket();
      this.isServer = false;
    } else {
      this.socket = socketOrHost;
      this.rawAcceptSocket = socketOrHost;
      this.host = socketOrHost.remoteAddress || "";
      this.port = socketOrHost.remotePort || 0;
      this.sslConfig = portOrSslConfig as SslConfig;
      this.isServer = true;
    }
    this.attachReadListeners();
    if (this.isServer) {
      // Server-accepted socket is already connected. Wire lifecycle
      // listeners immediately so error/close/end propagate to consumers.
      // Client-side sockets defer this until connectAsync resolves, so
      // a connect-time failure goes only to the in-scope reject() rather
      // than fanning out to Disconnected + reconnect().
      this.handleSocketErrors();
    }
  }

  private attachReadListeners(): void {
    if (this.readListenersSocket === this.socket) return;
    this.detachReadListeners();
    const sock = this.socket;
    this.readEnded = false;
    this.readEndError = null;

    const onData = (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.fireReadWaiter();
    };
    const onClose = () => {
      this.readEnded = true;
      this.fireReadWaiterError(new Error("Socket closed"));
    };
    const onEnd = () => {
      this.readEnded = true;
      this.fireReadWaiterError(new Error("Socket ended"));
    };
    const onError = (err: Error) => {
      this.readEnded = true;
      this.fireReadWaiterError(err);
    };

    sock.on("data", onData);
    sock.on("close", onClose);
    sock.on("end", onEnd);
    sock.on("error", onError);

    this.readListenersSocket = sock;
    this.onDataListener = onData;
    this.onCloseListener = onClose;
    this.onEndListener = onEnd;
    this.onReadErrorListener = onError;
  }

  private detachReadListeners(): void {
    const sock = this.readListenersSocket;
    if (!sock) return;
    if (this.onDataListener) sock.removeListener("data", this.onDataListener);
    if (this.onCloseListener) sock.removeListener("close", this.onCloseListener);
    if (this.onEndListener) sock.removeListener("end", this.onEndListener);
    if (this.onReadErrorListener) sock.removeListener("error", this.onReadErrorListener);
    this.readListenersSocket = null;
    this.onDataListener = null;
    this.onCloseListener = null;
    this.onEndListener = null;
    this.onReadErrorListener = null;
  }

  private fireReadWaiter(): void {
    if (!this.readWaiter) return;
    const w = this.readWaiter;
    this.readWaiter = null;
    w.resolve();
  }

  private fireReadWaiterError(err: Error): void {
    this.readEndError = err;
    if (!this.readWaiter) return;
    const w = this.readWaiter;
    this.readWaiter = null;
    w.reject(err);
  }

  // One-shot wait for a socket event with paired error handling. Both
  // listeners are removed on either outcome so a failed connect doesn't
  // leak listeners onto a long-lived socket, and a late error after a
  // successful connect doesn't end up rejecting a dead promise.
  private awaitSocketEvent(
    sock: Socket | tls.TLSSocket,
    successEvent: "connect" | "secureConnect" | "secure",
    trigger?: () => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onSuccess = () => {
        sock.removeListener("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        sock.removeListener(successEvent, onSuccess);
        reject(err);
      };
      sock.once(successEvent, onSuccess);
      sock.once("error", onError);
      if (trigger) trigger();
    });
  }

  private waitForReadEvent(): Promise<void> {
    if (this.readWaiter) return this.readWaiter.promise;
    let resolveFn!: () => void;
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    this.readWaiter = { promise, resolve: resolveFn, reject: rejectFn };
    return promise;
  }

  // High-level lifecycle listeners (emits Disconnected, triggers reconnect).
  // Tracked per-socket so we can detach cleanly across socket replacement.
  private lifecycleListenersSocket: Socket | tls.TLSSocket | null = null;
  private onLifecycleErrorListener: ((err: Error) => void) | null = null;
  private onLifecycleCloseListener: (() => void) | null = null;
  private onLifecycleEndListener: (() => void) | null = null;
  // Fires exactly once per socket disconnect, regardless of which of
  // error/close/end arrives first.
  private disconnectedSignaled: boolean = false;
  // In-flight reconnect chain; concurrent callers share this promise so
  // we don't start two ConnectAsync loops in parallel on the same instance.
  private reconnectInFlight: Promise<void> | null = null;

  private handleSocketErrors(): void {
    if (this.lifecycleListenersSocket === this.socket) return;
    this.detachLifecycleListeners();
    const sock = this.socket;
    this.disconnectedSignaled = false;

    const signalDisconnected = (reason: string, err?: Error) => {
      if (this.disconnectedSignaled) return;
      this.disconnectedSignaled = true;
      if (err) console.error(`Socket ${reason}:`, err);
      else console.warn(`Socket ${reason}.`);
      this.isConnected = false;
      this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Disconnected));
      if (this.alwaysReconnect && !this.disposed) {
        // Fire-and-forget; reconnect() coalesces concurrent callers.
        this.reconnect().catch((e) => console.error("Reconnect failed:", e));
      }
    };

    const onError = (err: Error) => signalDisconnected("error", err);
    const onClose = () => signalDisconnected("closed");
    const onEnd = () => signalDisconnected("ended");

    sock.on("error", onError);
    sock.on("close", onClose);
    sock.on("end", onEnd);

    this.lifecycleListenersSocket = sock;
    this.onLifecycleErrorListener = onError;
    this.onLifecycleCloseListener = onClose;
    this.onLifecycleEndListener = onEnd;
  }

  private detachLifecycleListeners(): void {
    const sock = this.lifecycleListenersSocket;
    if (!sock) return;
    if (this.onLifecycleErrorListener) sock.removeListener("error", this.onLifecycleErrorListener);
    if (this.onLifecycleCloseListener) sock.removeListener("close", this.onLifecycleCloseListener);
    if (this.onLifecycleEndListener) sock.removeListener("end", this.onLifecycleEndListener);
    this.lifecycleListenersSocket = null;
    this.onLifecycleErrorListener = null;
    this.onLifecycleCloseListener = null;
    this.onLifecycleEndListener = null;
  }

  public async setupServerStream(): Promise<void> {
    if (this.sslConfig.sslEnabled) {
      this.isSettingUpSsl = true;
      if (!this.sslConfig.cert || !this.sslConfig.key) {
        throw new Error("SSL enabled but no certificate/key provided.");
      }

      // Server-side TLS wrap: detach lifecycle listeners from the raw TCP
      // socket since we're about to replace it. Read listeners are
      // detached implicitly by attachReadListeners() after the wrap.
      this.detachLifecycleListeners();
      this.socket = new tls.TLSSocket(this.socket, {
        isServer: true,
        key: this.sslConfig.key,
        cert: this.sslConfig.cert,
        rejectUnauthorized: this.sslConfig.rejectUnauthorized,
      });

      // tls.TLSSocket with isServer:true signals handshake completion via
      // 'secure', not 'secureConnect' (which is a tls.connect()-only event).
      await this.awaitSocketEvent(this.socket as tls.TLSSocket, "secure");

      this.isSettingUpSsl = false;
      // TLS wrap replaced this.socket; reattach read + lifecycle listeners
      // to the new socket. Buffered bytes from the raw TCP read path were
      // already consumed by TLSSocket during the handshake.
      this.buffer = Buffer.alloc(0);
      this.attachReadListeners();
      this.handleSocketErrors();
    }

    this.isConnected = true;
    this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Connected));
  }

  public async connectAsync(
    maxRetries: number = 5,
    delayMilliseconds: number = 1000,
    isReconnect: boolean = false
  ): Promise<void> {
    this.isConnected = false;
    if (isReconnect) {
      this.detachReadListeners();
      this.detachLifecycleListeners();
      this.socket.destroy();
      this.socket = new Socket();
      this.buffer = Buffer.alloc(0);
      this.attachReadListeners();
      // Lifecycle listeners are wired below, once connect succeeds.
    }

    this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(isReconnect ? ConnectionStatus.Reconnecting : ConnectionStatus.Connecting));

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (this.disposed) return;
      try {
        if (attempt > 0) {
          // A Node Socket whose connect attempt errored cannot be reused;
          // it stays in an error state. Replace it on every retry past
          // the first so the next awaitSocketEvent operates on a fresh
          // socket. (Same applies to the initial isReconnect=true branch
          // above, which already replaced once.)
          this.detachReadListeners();
          this.detachLifecycleListeners();
          this.socket.destroy();
          this.socket = new Socket();
          this.buffer = Buffer.alloc(0);
          this.attachReadListeners();
        }
        await this.awaitSocketEvent(this.socket, "connect", () => {
          this.socket.connect(this.port, this.host);
        });

        if (this.sslConfig.sslEnabled) {
          this.detachReadListeners();
          this.detachLifecycleListeners();
          this.socket = tls.connect({
            host: this.host,
            port: this.port,
            rejectUnauthorized: this.sslConfig.rejectUnauthorized,
          });
          this.isSettingUpSsl = true;

          await this.awaitSocketEvent(this.socket as tls.TLSSocket, "secureConnect");
          this.isSettingUpSsl = false;

          this.buffer = Buffer.alloc(0);
          this.attachReadListeners();
        }

        // Connect succeeded; wire lifecycle listeners on the (possibly
        // TLS-upgraded) socket.
        this.handleSocketErrors();

        this.isConnected = true;

        this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(isReconnect ? ConnectionStatus.Reconnected : ConnectionStatus.Connected));
        return;
      } catch (err) {
        console.error(`Attempt ${attempt + 1} failed:`, err);
        if (attempt + 1 >= maxRetries) {
          this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Failed));
          return;
        }
        if (this.disposed) return;
        await new Promise((res) => setTimeout(res, Math.min(delayMilliseconds * Math.pow(2, attempt), this.maxConnectWaitTime)));
        if (this.disposed) return;
      }
    }
  }

  public async sendAsync(message: Message): Promise<void> {
    try {
      const data = encode([
        message.channel,
        message.data,
        message.replyTo,
        message.messageId,
        message.senderId,
        message.targetId,
      ]);

      if (data.length > MAX_FRAME_BYTES) {
        throw new Error(
          `Outgoing frame size ${data.length} exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES}); refusing to send.`,
        );
      }

      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeUInt32LE(data.length, 0);

      const unlock = await this.mutex.lock();

      try {
        await this.writeAll(lengthBuffer);
        await this.writeAll(data);
      } finally {
        unlock();
      }
    } catch (ex) {
      console.log(ex)
    }
  }

  private async writeAll(buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(buffer, (err) => (err ? reject(err) : resolve()));
    });
  }

  public async *receiveAsync(abortSignal?: AbortSignal): AsyncIterable<Message> {
    while (!this.disposed) {
      if (abortSignal?.aborted) return;

      const lengthPrefix = await this.readExact(4, abortSignal);
      if (!lengthPrefix) {
        // null means the read was aborted or the socket ended. If we're
        // disposed/aborted we're done; otherwise wait for the reconnect
        // path to attach a fresh socket and try again.
        if (this.disposed || abortSignal?.aborted) return;
        if (this.alwaysReconnect && !this.isServer) {
          await this.waitForReconnect(abortSignal);
          continue;
        }
        return;
      }

      const length = lengthPrefix.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        console.error(
          `Incoming frame size ${length} is invalid (max ${MAX_FRAME_BYTES}); dropping connection.`,
        );
        // Stream is poisoned — we can't sync to the next frame boundary
        // without a real framing escape. Force a clean disconnect; the
        // reconnect path will create a fresh socket with a fresh buffer.
        this.socket.destroy(new Error(`Oversize/empty frame: ${length} bytes`));
        if (this.alwaysReconnect && !this.isServer) {
          await this.waitForReconnect(abortSignal);
          continue;
        }
        return;
      }
      const dataBuffer = await this.readExact(length, abortSignal);
      if (!dataBuffer) {
        if (this.disposed || abortSignal?.aborted) return;
        if (this.alwaysReconnect && !this.isServer) {
          await this.waitForReconnect(abortSignal);
          continue;
        }
        return;
      }

      let message: Message;
      try {
        const decoded = decode(dataBuffer);
        if (!Array.isArray(decoded) || decoded.length < 6) {
          throw new Error("Invalid message format received.");
        }
        message = new Message(decoded[0], decoded[1], decoded[5]); // channel, data, targetId
        message.replyTo = decoded[2];
        message.messageId = decoded[3];
        message.senderId = decoded[4];
      } catch (err) {
        console.error("Error decoding frame:", err);
        // Bad frame implies we've lost stream sync; bail so the caller can
        // recycle the socket. Reconnect path will create a fresh one.
        if (this.alwaysReconnect && !this.isServer) {
          await this.reconnect();
          continue;
        }
        return;
      }

      yield message;
    }
  }

  // Wait until the current socket reports it's connected again, so the next
  // readExact has somewhere to draw bytes from. Returns immediately if
  // already connected, disposed, or aborted.
  private async waitForReconnect(abortSignal?: AbortSignal): Promise<void> {
    while (!this.disposed && !abortSignal?.aborted && !this.isConnected) {
      await delay(10);
    }
  }

  private async readExact(n: number, abortSignal?: AbortSignal): Promise<Buffer | null> {
    if (n <= 0) {
      return Buffer.alloc(0);
    }
    while (true) {
      if (this.disposed || abortSignal?.aborted) return null;

      if (this.buffer.length >= n) {
        const out = this.buffer.subarray(0, n);
        this.buffer = this.buffer.subarray(n);
        // subarray shares memory with the underlying buffer; copy so the
        // returned slice isn't invalidated by future buffer mutations.
        return Buffer.from(out);
      }

      if (this.readEnded) {
        // Connection went away mid-frame. Caller will decide whether to
        // reconnect; we just stop reading.
        return null;
      }

      try {
        await this.raceWithAbort(this.waitForReadEvent(), abortSignal);
      } catch (err) {
        if (abortSignal?.aborted || this.disposed) return null;
        // readEnded path: fall through; next iteration checks readEnded.
        if (!this.readEnded) {
          console.error("Error reading from socket:", err);
        }
        return null;
      }
    }
  }

  private raceWithAbort<T>(promise: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
    if (!abortSignal) return promise;
    if (abortSignal.aborted) return Promise.reject(new Error("Aborted"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(new Error("Aborted"));
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (v) => {
          abortSignal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          abortSignal.removeEventListener("abort", onAbort);
          reject(e);
        }
      );
    });
  }


  public onAuthenticated(): void {
    this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Authenticated));
  }

  /**
   * Re-establish the underlying TCP (and optionally TLS) connection.
   * Re-entrant: concurrent callers share a single in-flight reconnect
   * chain, so each disconnect signal does not spawn a new attempt loop.
   *
   * This is a *transport-level* reconnect only. It does NOT re-run
   * authentication; the application owns that. Subscribe to
   * `connectionStatusChanged` for `Reconnected` and call
   * `ClientSocket.authenticateAsync` again from there. This matches
   * the C# library's behavior.
   */
  public reconnect(): Promise<void> {
    if (this.reconnectInFlight) return this.reconnectInFlight;
    if (this.disposed || this.isServer) return Promise.resolve();
    console.log("attempting to reconnect");
    const p = (async () => {
      try {
        if (this.alwaysReconnect) {
          await this.connectAsync(Number.MAX_SAFE_INTEGER, 100, true);
        }
      } finally {
        this.reconnectInFlight = null;
      }
    })();
    this.reconnectInFlight = p;
    return p;
  }

  public dispose(): void {
    this.disposed = true;
    this.isConnected = false;
    this.readEnded = true;
    this.fireReadWaiterError(new Error("Transport disposed"));
    this.detachReadListeners();
    this.detachLifecycleListeners();
    this.socket.end();
    this.socket.destroy();
    // On the server-accept path, this.socket may be a TLSSocket wrapping
    // the original raw TCP socket. Destroying the wrapper does not always
    // synchronously close the underlying socket (net.Server's close()
    // callback then hangs because it thinks the connection is still open).
    // Force-destroy the raw socket too if it's different from this.socket.
    if (this.rawAcceptSocket && this.rawAcceptSocket !== this.socket) {
      try { this.rawAcceptSocket.destroy(); } catch { /* ignore */ }
    }
    this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Disconnected));
  }

  public close(): void {
    this.dispose();
  }
}
