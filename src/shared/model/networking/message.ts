export class Message {
  channel: string;
  data?: any;
  replyTo?: string;
  messageId: string;
  senderId: string;
  targetId?: string;

  constructor(channel: string, data?: any, targetId?: string) {
    this.channel = channel;
    this.data = data;
    this.targetId = targetId;
    this.messageId = crypto.randomUUID();
    this.senderId = ""; // to be set by the socket
  }

  public as<T>(): T {
    return this.data as T;
  }

  public asTypeless(): { [key: string]: any } {
    return this.data as { [key: string]: any };
  }

  public senderIsServer(): boolean {
    // We assume the server uses an empty or “zero” GUID
    return this.senderId === "" || this.senderId === "00000000-0000-0000-0000-000000000000";
  }

  public static fromReply(source: Message, data: any): Message {
    const reply = new Message(`${source.channel}_reply_${source.messageId}`, data);
    reply.replyTo = source.messageId;
    reply.targetId = source.senderId;
    // senderId will be set by the sending socket
    return reply;
  }
}
