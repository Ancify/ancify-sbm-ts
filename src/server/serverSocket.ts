import { createServer, Server, Socket } from "net";
import { ConnectionStatus, ConnectionStatusEventArgs } from "../shared/model/networking/connectionStatus";
import { ConnectedClientSocket } from "./connectedClientSocket";
import { TcpTransport } from "../shared/transport/tcp/tcpTransport";
//import { WebsocketTransport } from "../shared/transport/ws/websocketTransport";
import { Message } from "../shared/model/networking/message";
import { EventEmitter } from "events";
import { AuthContext } from "../shared/model/authContext";

export type AuthHandler = (id: string, key: string, scope?: string) => Promise<AuthContext>;

export class ServerSocket extends EventEmitter {
  private server?: Server;
  private httpServer?: any; // Placeholder for WebSocket server
  private clients: Map<string, ConnectedClientSocket> = new Map();
  public authHandler?: AuthHandler;
  private host: string;
  private port: number;
  private sslConfig: any; // Adjust type if needed
  private useWebSocket: boolean;
  private anonymousDisallowed: boolean = false;

  constructor(host: string, port: number, sslConfig: any, useWebSocket: boolean = false, authHandler?: AuthHandler) {
    super();
    this.host = host;
    this.port = port;
    this.sslConfig = sslConfig;
    this.useWebSocket = useWebSocket;
    if (authHandler) {
      this.authHandler = authHandler;
    }
  }

  public async startAsync(): Promise<void> {
    if (this.useWebSocket) {
      await this.startWebSocketServer();
    } else {
      this.startTcpServer();
    }
  }

  private startTcpServer(): void {
    this.server = createServer((socket: Socket) => {
      const transport = new TcpTransport(socket, this.sslConfig);
      this.handleNewClient(transport);
    });

    this.server.listen(this.port, this.host, () => {
      console.log(`TCP Server listening on ${this.host}:${this.port}`);
    });

    this.server.on("error", (err) => {
      console.error("Server error:", err);
    });
  }

  private async startWebSocketServer(): Promise<void> {
    /*
    const { WebSocketServer } = await import("ws");
    this.httpServer = new WebSocketServer({ port: this.port });

    this.httpServer.on("connection", (ws: any) => {
      const transport = new WebsocketTransport(ws);
      this.handleNewClient(transport);
    });

    console.log(`WebSocket Server listening on ws://${this.host}:${this.port}`);
    */
  }

  private handleNewClient(transport: TcpTransport /* | WebsocketTransport */): void {
    const clientSocket = new ConnectedClientSocket(transport, this);
    clientSocket.clientId = crypto.randomUUID();
    clientSocket.disallowAnonymous = this.anonymousDisallowed;

    this.clients.set(clientSocket.clientId, clientSocket);
    this.emit("clientConnected", clientSocket);
  }

  public async broadcastAsync(message: Message): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.sendAsync(message)));
  }

  public async sendToClientAsync(clientId: string, message: Message): Promise<void> {
    const clientSocket = this.clients.get(clientId);
    if (!clientSocket) {
      throw new Error("Client not connected");
    }
    await clientSocket.sendAsync(message);
  }

  public removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  public disallowAnonymous(): void {
    this.anonymousDisallowed = true;
  }

  public async checkConnectionStatus(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.checkConnectionStatus();
      } catch {
        // Ignore errors from individual clients
      }
    }

    setTimeout(() => this.checkConnectionStatus(), 5000);
  }
}
