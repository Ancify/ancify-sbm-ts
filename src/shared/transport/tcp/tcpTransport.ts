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
      this.host = socketOrHost.remoteAddress || "";
      this.port = socketOrHost.remotePort || 0;
      this.sslConfig = portOrSslConfig as SslConfig;
      this.isServer = true;
    }
    this.attachReadListeners();
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

  private handleSocketErrors(): void {
    this.socket.on("error", (err) => {
      console.error("Socket error:", err);
      this.isConnected = false;
      this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Disconnected));
      if (this.alwaysReconnect) this.reconnect();
    });

    this.socket.on("close", () => {
      console.warn("Socket closed.");
      this.isConnected = false;
      this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Disconnected));
      if (this.alwaysReconnect) this.reconnect();
    });

    this.socket.on("end", () => {
      console.warn("Socket ended.");
      this.isConnected = false;
      this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Disconnected));
      if (this.alwaysReconnect) this.reconnect();
    });
  }

  public async setupServerStream(): Promise<void> {
    if (this.sslConfig.sslEnabled) {
      this.isSettingUpSsl = true;
      if (!this.sslConfig.cert || !this.sslConfig.key) {
        throw new Error("SSL enabled but no certificate/key provided.");
      }

      this.socket = new tls.TLSSocket(this.socket, {
        isServer: true,
        key: this.sslConfig.key,
        cert: this.sslConfig.cert,
        rejectUnauthorized: this.sslConfig.rejectUnauthorized,
      });

      await new Promise<void>((resolve, reject) => {
        (this.socket as tls.TLSSocket).once("secureConnect", resolve);
        (this.socket as tls.TLSSocket).once("error", reject);
      });

      this.isSettingUpSsl = false;
      // TLS wrap replaced this.socket; reattach read listeners to the new
      // socket and discard any buffered bytes from the raw TCP read path
      // (handshake bytes already consumed by TLSSocket).
      this.buffer = Buffer.alloc(0);
      this.attachReadListeners();
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
      this.socket.destroy();
      this.socket = new Socket();
      this.buffer = Buffer.alloc(0);
      this.attachReadListeners();
    }

    this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(isReconnect ? ConnectionStatus.Reconnecting : ConnectionStatus.Connecting));

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.socket.connect(this.port, this.host, resolve);
          this.socket.once("error", reject);
        });

        if (this.sslConfig.sslEnabled) {
          this.detachReadListeners();
          this.socket = tls.connect(
            {
              host: this.host,
              port: this.port,
              rejectUnauthorized: this.sslConfig.rejectUnauthorized,
            },
            () => (this.isSettingUpSsl = false)
          );

          await new Promise<void>((resolve, reject) => {
            (this.socket as tls.TLSSocket).once("secureConnect", resolve);
            (this.socket as tls.TLSSocket).once("error", reject);
          });
          this.buffer = Buffer.alloc(0);
          this.attachReadListeners();
        } else {
          // Plain TCP socket; the constructor's listeners are still attached
          // to this.socket. attachReadListeners is idempotent on the same
          // socket, but call it to guarantee state after socket replacement.
          this.attachReadListeners();
        }

        this.isConnected = true;

        this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(isReconnect ? ConnectionStatus.Reconnected : ConnectionStatus.Connected));
        return;
      } catch (err) {
        console.error(`Attempt ${attempt + 1} failed:`, err);
        if (attempt + 1 >= maxRetries) {
          this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Failed));
          return;
        }
        await new Promise((res) => setTimeout(res, Math.min(delayMilliseconds * Math.pow(2, attempt), this.maxConnectWaitTime)));
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

  public async reconnect(): Promise<void> {
    console.log('attempting to reconnect')
    if (this.alwaysReconnect) {
      await this.connectAsync(Number.MAX_SAFE_INTEGER, 100, true);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.isConnected = false;
    this.readEnded = true;
    this.fireReadWaiterError(new Error("Transport disposed"));
    this.detachReadListeners();
    this.socket.end();
    this.socket.destroy();
    this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Disconnected));
  }

  public close(): void {
    this.dispose();
  }
}
