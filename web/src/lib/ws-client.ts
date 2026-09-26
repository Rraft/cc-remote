import type { ClientMessage, ServerEvent } from './protocol';

/**
 * 单例 WS 客户端：同源于服务端（生产走 tailscale serve 的 HTTPS→WSS；
 * 开发时直连后端端口——Cookie 不区分端口，登录态可复用）。
 * 断线指数退避重连；重连成功后服务端会推 snapshot 恢复现场。
 */

export type WsState = 'closed' | 'connecting' | 'open';
type Listener = (e: ServerEvent) => void;
type StateListener = (s: WsState) => void;

function wsUrl(): string {
  if (import.meta.env.DEV) {
    return `ws://${location.hostname}:8787`;
  }
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
}

class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  private retry = 0;
  private closedByUser = false;
  state: WsState = 'closed';

  connect(): void {
    if (this.ws && (this.state === 'open' || this.state === 'connecting')) return;
    this.closedByUser = false;
    this.setState('connecting');
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.setState('open');
    };
    ws.onmessage = (ev) => {
      try {
        const e = JSON.parse(String(ev.data)) as ServerEvent;
        for (const l of this.listeners) l(e);
      } catch {
        /* 忽略坏帧 */
      }
    };
    ws.onclose = (ev) => {
      this.setState('closed');
      this.ws = null;
      // 4001/401 = 鉴权失败，重连无意义，交给 UI 弹回登录页
      if (this.closedByUser || ev.code === 4001) return;
      const delay = Math.min(1000 * 2 ** this.retry, 30_000);
      this.retry += 1;
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      // onclose 会跟着触发重连
    };
  }

  disconnect(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
    this.setState('closed');
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  onMessage(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onState(l: StateListener): () => void {
    this.stateListeners.add(l);
    l(this.state);
    return () => this.stateListeners.delete(l);
  }

  private setState(s: WsState): void {
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }
}

export const wsClient = new WsClient();
