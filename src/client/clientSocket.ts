import { SbmSocket, AuthStatus } from "../shared/sbmSocket";
import { Transport } from "../interfaces/transport";
import { Message } from "../shared/model/networking/message";
import { ConnectionStatus, ConnectionStatusEventArgs } from "../shared/model/networking/connectionStatus";

export class ClientSocket extends SbmSocket {
  constructor(transport: Transport) {
    super(transport);
    this.startReceiving();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.onHandler("__$status", async (message: Message) => Message.fromReply(message, { Success: true }));
  }

  public async connectAsync(): Promise<void> {
    await this._transport!.connectAsync();
  }

  public async authenticateAsync(id: string, key: string, scope?: string): Promise<boolean> {
    // Omit Scope when not provided so msgpack-lite doesn't encode it as
    // nil; the C# server treats a missing field as `null` and downstream
    // AuthHandlers can match `scope === undefined` instead of getting a
    // truthy-but-empty payload entry.
    const payload: { Id: string; Key: string; Scope?: string } = { Id: id, Key: key };
    if (scope !== undefined) payload.Scope = scope;
    this.authStatus = AuthStatus.Authenticating;
    const message = new Message("_auth_", payload);
    const response = await this.sendRequestAsync(message);
    const data = response.asTypeless();
    const success = Boolean(data["Success"]);

    this.authStatus = success ? AuthStatus.Authenticated : AuthStatus.Failed;
    if (success) {
      this._transport?.onAuthenticated();
    }

    return success;
  }

  public override async sendAsync(message: Message): Promise<void> {
    message.senderId = this.clientId;
    await super.sendAsync(message);
  }

  public override async sendRequestAsync(request: Message, timeout?: number): Promise<Message> {
    request.senderId = this.clientId;
    return super.sendRequestAsync(request, timeout);
  }
}
