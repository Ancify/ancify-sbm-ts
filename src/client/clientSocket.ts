import { SbmSocket } from "../shared/sbmSocket";
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
    const message = new Message("_auth_", { Id: id, Key: key, Scope: scope });
    const response = await this.sendRequestAsync(message);
    const data = response.asTypeless();
    const success = Boolean(data["Success"]);

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
