import { createServer, Server, Socket } from "net";
import { ConnectionStatus, ConnectionStatusEventArgs } from "../shared/model/networking/connectionStatus";
import { ConnectedClientSocket } from "./connectedClientSocket";
import { Transport } from "../interfaces/transport";
import { TcpTransport } from "../shared/transport/tcp/tcpTransport";
import { Message } from "../shared/model/networking/message";
import { EventEmitter } from "events";

export type AuthHandler = (id: string, key: string) => Promise<boolean>;

export class ServerSocket extends EventEmitter {
  private server: Server;
  private clients: Map<string, ConnectedClientSocket> = new Map();
  public authHandler?: AuthHandler;
  private host: string;
  private port: number;
  private sslConfig: any; // Adjust type if needed

  constructor(host: string, port: number, sslConfig: any, authHandler?: AuthHandler) {
    super();
    this.host = host;
    this.port = port;
    this.sslConfig = sslConfig;
    if (authHandler) {
      this.authHandler = authHandler;
    }
    this.server = createServer((socket: Socket) => {
      // Create a transport from the accepted socket.
      const transport: Transport = new TcpTransport(socket, sslConfig);
      transport.connectAsync().catch((err) => {
        console.error("Transport connection error:", err);
      });
      const clientSocket = new ConnectedClientSocket(transport, this);
      clientSocket.clientId = crypto.randomUUID();
      this.clients.set(clientSocket.clientId, clientSocket);
      this.emit("clientConnected", clientSocket);
    });
  }

  public startAsync(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        console.log(`Server listening on ${this.host}:${this.port}`);
        resolve();
      });
      this.server.on("error", (err) => {
        reject(err);
      });
    });
  }

  public broadcastAsync(message: Message): Promise<void> {
    const promises = Array.from(this.clients.values()).map((client) => client.sendAsync(message));
    return Promise.all(promises).then(() => {});
  }

  public sendToClientAsync(clientId: string, message: Message): Promise<void> {
    const clientSocket = this.clients.get(clientId);
    if (clientSocket) {
      return clientSocket.sendAsync(message);
    } else {
      return Promise.reject(new Error("Client not connected"));
    }
  }

  public removeClient(clientId: string) {
    this.clients.delete(clientId);
  }
}
