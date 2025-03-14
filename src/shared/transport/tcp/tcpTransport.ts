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
  }

  private handleSocketErrors(): void {
    this.socket.on("error", (err) => {
      console.error("Socket error:", err);
      this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Disconnected));
      if (this.alwaysReconnect) this.reconnect();
    });

    this.socket.on("close", () => {
      console.warn("Socket closed.");
      this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Disconnected));
      if (this.alwaysReconnect) this.reconnect();
    });

    this.socket.on("end", () => {
      console.warn("Socket ended.");
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
    }

    this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Connected));
  }

  public async connectAsync(
    maxRetries: number = 5,
    delayMilliseconds: number = 1000,
    isReconnect: boolean = false
  ): Promise<void> {
    this.isConnected = false;
    if (isReconnect) {
      this.socket.destroy();
      this.socket = new Socket();
      //this.handleSocketErrors();
    }

    this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(isReconnect ? ConnectionStatus.Reconnecting : ConnectionStatus.Connecting));

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.socket.connect(this.port, this.host, resolve);
          this.socket.once("error", reject);
        });

        if (this.sslConfig.sslEnabled) {
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
        }

        this.isConnected = true

        await delay(1) // race conditions!

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
      message.senderId = '00000000-0000-0000-0000-000000000000'
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

  public async *receiveAsync(): AsyncIterable<Message> {
    while (!this.disposed) {
      try {
        if (!this.isConnected || !this.socket.readable) {
          await delay(1);
          continue;
        }

        const lengthPrefix = await this.readExact(4);
        if (!lengthPrefix) {
          if (this.alwaysReconnect) await this.reconnect();
          continue;
        }

        const length = lengthPrefix.readUInt32LE(0);
        const dataBuffer = await this.readExact(length);
        if (!dataBuffer) {
          if (this.alwaysReconnect) await this.reconnect();
          continue;
        }

        const decoded = decode(dataBuffer);
        if (!Array.isArray(decoded) || decoded.length < 6) {
          throw new Error("Invalid message format received.");
        }

        const message = new Message(decoded[0], decoded[1], decoded[5]); // channel, data, targetId
        message.replyTo = decoded[2];
        message.messageId = decoded[3];
        message.senderId = decoded[4];
        yield message;
      } catch (err) {
        console.error("Error reading from socket:", err);
        if (this.alwaysReconnect) await this.reconnect();
      }
    }
  }

  private async readExact(n: number): Promise<Buffer | null> {
    let bytesRead = 0;
    const chunks: Buffer[] = [];
  
    while (bytesRead < n) {
      // If we already have enough data in our buffer:
      if (this.buffer.length >= n - bytesRead) {
        const needed = n - bytesRead;
        chunks.push(this.buffer.subarray(0, needed));
        this.buffer = this.buffer.subarray(needed);
        bytesRead += needed;
        return Buffer.concat(chunks);
      }
  
      // Otherwise, wait for new data to arrive:
      try {
        const chunk = await new Promise<Buffer>((resolve, reject) => {
          const onData = (data: Buffer) => {
            // We got data; remove the error listener and resolve
            this.socket.removeListener("error", onError);
            resolve(data);
          };
          const onError = (err: Error) => {
            // We got an error; remove the data listener and reject
            this.socket.removeListener("data", onData);
            reject(err);
          };
  
          this.socket.once("data", onData);
          this.socket.once("error", onError);
        });
  
        // We successfully got data; append it to our buffer
        this.buffer = Buffer.concat([this.buffer, chunk]);
      } catch (err) {
        console.error("Error reading from socket:", err);
        return null;
      }
    }
  
    // If we exit the while loop, we never got enough bytes
    return null;
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
    this.socket.end();
    this.socket.destroy();
    this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Disconnected));
  }

  public close(): void {
    this.dispose();
  }
}
