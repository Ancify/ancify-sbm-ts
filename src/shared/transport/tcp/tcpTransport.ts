import { Socket } from "net";
import * as tls from "tls";
import { Transport } from "../../../interfaces/transport";
import { Message } from "../../../shared/model/networking/message";
import {
  ConnectionStatus,
  ConnectionStatusEventArgs,
} from "../../../shared/model/networking/connectionStatus";
import { EventEmitter } from "events";
import { createCodec, decode, encode } from "msgpack-lite";

export interface SslConfig {
  sslEnabled: boolean;
  rejectUnauthorized: boolean;
  // For server-side TLS: provide key and certificate
  key?: string | Buffer;
  cert?: string | Buffer;
}

interface IMessage {
  channel: string;
  data?: any;
  replyTo?: string;
  messageId: string;
  senderId: string;
  targetId?: string;
}

function serializeMessage(message: IMessage): Buffer {
  message.senderId = '00000000-0000-0000-0000-000000000000'
  const arr = [
    message.channel,
    message.data,
    message.replyTo,
    message.messageId,
    message.senderId,
    message.targetId,
  ];
  return encode(arr);
}

export class TcpTransport extends EventEmitter implements Transport {
  private socket: Socket | tls.TLSSocket;
  private host: string;
  private port: number;
  private sslConfig: SslConfig;
  private isServer: boolean = false;
  private isSettingUpSsl: boolean = false;
  private writeLock: Promise<void> = Promise.resolve();
  private buffer: Buffer = Buffer.alloc(0);
  private disposed: boolean = false;
  private _releaseLock: () => void = () => {};

  /**
   * Use this constructor when you already have a connected socket (server-side).
   */
  constructor(
    socketOrHost: Socket | string,
    portOrSslConfig: number | SslConfig,
    sslConfigArg?: SslConfig,
  ) {
    super();
    if (typeof socketOrHost === "string") {
      // Client constructor: host and port provided.
      this.host = socketOrHost;
      this.port = portOrSslConfig as number;
      this.sslConfig = sslConfigArg!;
      this.isServer = false;
      this.socket = new Socket();
    } else {
      // Server constructor: socket is already provided.
      this.socket = socketOrHost;
      this.host = socketOrHost.remoteAddress || "";
      this.port = socketOrHost.remotePort || 0;
      this.sslConfig = portOrSslConfig as SslConfig;
      this.isServer = true;
    }
  }

  /**
   * For a server-side transport, if SSL is enabled, wrap the existing socket.
   */
  public async setupServerStream(): Promise<void> {
    if (this.sslConfig.sslEnabled) {
      this.isSettingUpSsl = true;
      if (!this.sslConfig.cert || !this.sslConfig.key) {
        throw new Error(
          "SSL is enabled but no certificate/key provided for server authentication.",
        );
      }
      const options: tls.TlsOptions = {
        cert: this.sslConfig.cert,
        key: this.sslConfig.key,
        rejectUnauthorized: this.sslConfig.rejectUnauthorized,
      };
      // Wrap the underlying socket in a TLSSocket
      this.socket = new tls.TLSSocket(this.socket, {
        isServer: true,
        ...options,
      });
      await new Promise<void>((resolve, reject) => {
        (this.socket as tls.TLSSocket).once("secureConnect", resolve);
        (this.socket as tls.TLSSocket).once("error", reject);
      });
      this.isSettingUpSsl = false;
    }
    this.emit(
      "connectionStatusChanged",
      new ConnectionStatusEventArgs(ConnectionStatus.Connected),
    );
  }

  public async connectAsync(
    maxRetries: number = 5,
    delayMilliseconds: number = 1000,
  ): Promise<void> {
    this.emit(
      "connectionStatusChanged",
      new ConnectionStatusEventArgs(ConnectionStatus.Connecting),
    );
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.socket.connect(this.port, this.host, resolve);
          this.socket.once("error", reject);
        });
        if (this.sslConfig.sslEnabled) {
          this.isSettingUpSsl = true;
          const options: tls.ConnectionOptions = {
            host: this.host,
            port: this.port,
            rejectUnauthorized: this.sslConfig.rejectUnauthorized,
          };
          this.socket = tls.connect(options, () => {
            this.isSettingUpSsl = false;
          });
          await new Promise<void>((resolve, reject) => {
            (this.socket as tls.TLSSocket).once(
              "secureConnect",
              resolve,
            );
            (this.socket as tls.TLSSocket).once("error", reject);
          });
        }
        this.emit(
          "connectionStatusChanged",
          new ConnectionStatusEventArgs(ConnectionStatus.Connected),
        );
        return;
      } catch (err) {
        attempt++;
        console.error(`Attempt ${attempt} failed:`, err);
        if (attempt >= maxRetries) {
          this.emit(
            "connectionStatusChanged",
            new ConnectionStatusEventArgs(ConnectionStatus.Failed),
          );
          throw new Error(
            `Failed to connect to ${this.host}:${this.port} after ${maxRetries} attempts.`,
          );
        }
        await new Promise((res) =>
          setTimeout(
            res,
            delayMilliseconds * Math.pow(2, attempt - 1),
          )
        );
      }
    }
  }

  public onAuthenticated(): void {
    this.emit(
      "connectionStatusChanged",
      new ConnectionStatusEventArgs(ConnectionStatus.Authenticated),
    );
  }

  public async sendAsync(message: Message): Promise<void> {
    const data = serializeMessage(message);
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32LE(data.length, 0);
    await this.acquireLock();
    try {
      await this.writeAll(lengthBuffer);
      await this.writeAll(data);
    } finally {
      this.releaseLock();
    }
  }

  private writeAll(buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(buffer, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async acquireLock(): Promise<void> {
    await this.writeLock;
    this.writeLock = new Promise<void>((resolve) => {
      this._releaseLock = resolve;
    });
  }

  private releaseLock() {
    this._releaseLock();
  }

  public async *receiveAsync(
    abortSignal?: AbortSignal,
  ): AsyncIterable<Message> {
    while (!this.disposed) {
      try {
        const lengthPrefix = await this.readExact(4, abortSignal);
        if (!lengthPrefix) break;
        const length = lengthPrefix.readUInt32LE(0);
        const dataBuffer = await this.readExact(length, abortSignal);
        if (!dataBuffer) break;
        const decoded = decode(dataBuffer);

        if (!Array.isArray(decoded) || decoded.length < 6) {
          throw new Error("Invalid message format received.");
        }

        // Convert array to Message object
        const message: Message = new Message(decoded[0], decoded[1], decoded[5]); // channel, data, targetId
        message.replyTo = decoded[2]; // replyTo
        message.messageId = decoded[3]; // messageId
        message.senderId = decoded[4]; // senderId
        yield message;
      } catch (err) {
        console.error("Error reading from socket:", err);
        break;
      }
    }
  }

  /**
   * Reads exactly n bytes from the socket, accumulating data as needed.
   */
  private async readExact(n: number, abortSignal?: AbortSignal): Promise<Buffer | null> {
    let bytesRead = 0;
    const chunks: Buffer[] = [];
  
    while (bytesRead < n) {
      if (this.buffer.length >= n - bytesRead) {
        // Extract the required portion from the buffer
        chunks.push(this.buffer.subarray(0, n - bytesRead));
        this.buffer = this.buffer.subarray(n - bytesRead);
        return Buffer.concat(chunks);
      }
  
      // If we don't have enough data, wait for more
      try {
        const chunk = await new Promise<Buffer>((resolve, reject) => {
          const onData = (data: Buffer) => {
            this.socket.off("error", onError);
            resolve(data);
          };
  
          const onError = (err: Error) => {
            this.socket.off("data", onData);
            reject(err);
          };
  
          this.socket.once("data", onData);
          this.socket.once("error", onError);
  
          if (abortSignal) {
            abortSignal.addEventListener("abort", () => {
              this.socket.off("data", onData);
              this.socket.off("error", onError);
              reject(new Error("Read operation aborted."));
            });
          }
        });
  
        this.buffer = Buffer.concat([this.buffer, chunk]);
      } catch (err) {
        console.error("Error while reading from socket:", err);
        return null;
      }
    }
  
    return null; // Should never reach this point
  }
  

  public dispose(): void {
    this.disposed = true;
    this.socket.end();
    this.socket.destroy();
    this.emit(
      "connectionStatusChanged",
      new ConnectionStatusEventArgs(ConnectionStatus.Disconnected),
    );
  }
}
