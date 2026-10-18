import type { ClientMsg, ServerMsg } from './types';

type Handler = (msg: ServerMsg) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  onOpen: () => void = () => {};
  onClose: (ev: CloseEvent | null) => void = () => {};
  connected = false;

  static defaultUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  connect(url = Net.defaultUrl()): void {
    this.close();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('ws connect failed', e);
      setTimeout(() => this.onClose(null), 0);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.onOpen();
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      this.onClose(ev);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
      for (const h of this.handlers) {
        try {
          h(msg);
        } catch (e) {
          console.error('handler error for', msg.t, e);
        }
      }
    };
  }

  on(h: Handler): void {
    this.handlers.push(h);
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      this.connected = false;
      try { ws.close(); } catch { /* ignore */ }
    }
  }
}
