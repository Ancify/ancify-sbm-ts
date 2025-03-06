export class ConnectData {
  host: string;
  port: number;
  meta: string[];

  constructor(host: string, port: number, meta: string[] = []) {
    this.host = host;
    this.port = port;
    this.meta = meta;
  }

  public static fromObject(obj: any): ConnectData {
    return new ConnectData(obj.host, obj.port, obj.meta ?? []);
  }
}
