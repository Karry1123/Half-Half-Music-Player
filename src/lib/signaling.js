// WebSocket 信令客户端：连接建立前的消息先排队。
export class Signaling {
  constructor(url) {
    this.queue = [];
    this.onmessage = null;
    this.onopen = null;
    this.onclose = null;
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      for (const m of this.queue.splice(0)) this.ws.send(m);
      this.onopen?.();
    };
    this.ws.onmessage = (e) => this.onmessage?.(JSON.parse(e.data));
    this.ws.onclose = () => this.onclose?.();
  }

  send(msg) {
    const s = JSON.stringify(msg);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }
}
