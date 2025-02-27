import { Transport } from "../interfaces/transport";
import { Message } from "./model/networking/message";
import { ConnectionStatus, ConnectionStatusEventArgs } from "./model/networking/connectionStatus";
import { EventEmitter } from "events";

export enum AuthStatus {
  None = "None",
  Anonymous = "Anonymous",
  Authenticating = "Authenticating",
  Authenticated = "Authenticated",
  Failed = "Failed"
}

/**
 * Base socket class which handles message dispatching, registering handlers,
 * sending requests (with reply channels), and receiving messages.
 */
export abstract class SbmSocket extends EventEmitter {
  protected _transport?: Transport;
  protected _handlers: Map<string, Array<(message: Message) => Promise<Message | null>>> = new Map();
  protected abortController: AbortController = new AbortController();
  public authStatus: AuthStatus = AuthStatus.None;
  public clientId: string = ""; // a GUID string

  protected onConnectionStatusChanged(e: ConnectionStatusEventArgs) {
    this.emit("connectionStatusChanged", e);
  }

  protected onClientIdReceived(clientId: string) {
    this.emit("clientIdReceived", clientId);
  }

  protected startReceiving() {
    if (!this._transport) {
      throw new Error("Transport is not initialized.");
    }
    (async () => {
      try {
        for await (const message of this._transport!.receiveAsync(this.abortController.signal)) {
          try {
            await this.handleMessageAsync(message);
          } catch (err) {
            console.error("An exception occurred while handling the message:", err);
          }
        }
      } catch (err) {
        console.error("An exception occurred:", err);
      }
      this.emit("connectionStatusChanged", new ConnectionStatusEventArgs(ConnectionStatus.Disconnected));
    })();
  }

  protected async handleMessageAsync(message: Message) {
    const handlers = this._handlers.get(message.channel);
    if (handlers) {
      // Create a copy so that handlers can unregister safely
      const handlersCopy = [...handlers];
      for (const handler of handlersCopy) {
        try {
          const response = await handler(message);
          if (response) {
            response.replyTo = message.messageId;
            response.targetId = message.senderId;
            response.senderId = this.clientId;
            if (this._transport) {
              await this._transport.sendAsync(response);
            }
          }
        } catch (err) {
          // Optionally log the error
        }
      }
    }
  }

  /**
   * Registers an asynchronous handler that may return a response message.
   * Returns a function that, when called, unregisters the handler.
   */
  public onHandler(
    channel: string,
    handler: (message: Message) => Promise<Message | null>
  ): () => void {
    if (!this._handlers.has(channel)) {
      this._handlers.set(channel, []);
    }
    this._handlers.get(channel)!.push(handler);
    return () => {
      const handlers = this._handlers.get(channel)!;
      if (!handlers) {
        return;
      }
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
      if (handlers.length === 0) {
        this._handlers.delete(channel);
      }
    };
  }

  // Overload: Register a handler that does not return a response.
  public onMessage(channel: string, handler: (message: Message) => void): () => void {
    return this.onHandler(channel, async (message: Message) => {
      handler(message);
      return null;
    });
  }

  public sendAsync(message: Message): Promise<void> {
    if (!this._transport) {
      throw new Error("Transport is not initialized.");
    }
    message.senderId = this.clientId;
    return this._transport.sendAsync(message);
  }

  public sendRequestAsync(request: Message, timeout: number = 15000): Promise<Message> {
    if (!this._transport) {
      throw new Error("Transport is not initialized.");
    }
    request.senderId = this.clientId;
    return new Promise<Message>((resolve, reject) => {
      const replyChannel = `${request.channel}_reply_${request.messageId}`;
      const unregister = this.onHandler(replyChannel, async (message: Message) => {
        if (message.replyTo === request.messageId) {
          resolve(message);
          unregister();
        }
        return null;
      });
      this.sendAsync(request).catch(reject);
      setTimeout(() => {
        unregister();
        reject(new Error("Request timed out."));
      }, timeout);
    });
  }

  public isAuthenticated(): boolean {
    return this.authStatus === AuthStatus.Authenticated;
  }

  public authenticationGuard() {
    if (!this.isAuthenticated()) {
      throw new Error("Unauthorized");
    }
  }

  public dispose() {
    this.abortController.abort();
    if (this._transport && typeof (this._transport as any).dispose === "function") {
      (this._transport as any).dispose();
    }
  }
}
