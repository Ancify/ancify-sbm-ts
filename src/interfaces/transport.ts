import { Message } from "../shared/model/networking/message";
import { ConnectionStatusEventArgs } from "../shared/model/networking/connectionStatus";
import { EventEmitter } from "events";

/**
 * The Transport interface abstracts different transport layers such as TCP and WebSockets.
 */
export interface Transport extends EventEmitter {
  alwaysReconnect: boolean;
  maxConnectWaitTime: number;

  connectAsync(maxRetries?: number, delayMilliseconds?: number, isReconnect?: boolean): Promise<void>;
  sendAsync(message: Message): Promise<void>;
  reconnect(): Promise<void>;
  receiveAsync(abortSignal?: AbortSignal): AsyncIterable<Message>;
  onAuthenticated(): void;
  close(): void;

  // Transport implementations should emit a "connectionStatusChanged" event with a ConnectionStatusEventArgs instance.
}
