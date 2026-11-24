// Links phones together. Phones talk directly to each other (WebRTC); a public matchmaking server
// (PeerJS cloud) only introduces them, and only sees a random session code, never the numbers or any video.
import Peer, { type DataConnection, type PeerOptions } from "peerjs";
import QRCode from "qrcode";

export type ViewMsg = {
  k: "view";
  alpha: number | null;                 // this phone's lean reading, degrees (+ = top leans right), null if not reading yet
  heading: number | null;               // compass direction the camera faces
  bend: { frac: number; low: number; up: number } | null; // bend 0..1 of the way up; lean below and above it
};
export type ResultMsg = { k: "result"; lines: string[]; locked: boolean; ok: boolean; phones: number };
export type HelloMsg = { k: "hello"; name: string };
type Msg = ViewMsg | ResultMsg | HelloMsg;

export type PeerView = { name: string; view: ViewMsg; at: number };

function brokerOptions(): PeerOptions {
  // ?broker=host:port points at a different matchmaking server (used for testing)
  const b = new URLSearchParams(location.search).get("broker");
  if (!b) return {};
  const [host, port] = b.split(":");
  return { host, port: Number(port) || 9000, path: "/", secure: false };
}

export class Team {
  role: "none" | "host" | "helper" = "none";
  status = "";
  joinUrl = "";
  name = "";                                   // helper: the name the host gave this phone
  hostResult: ResultMsg | null = null;         // helper: latest combined result from the host
  hostResultAt = 0;
  peers = new Map<string, PeerView>();         // host: latest reading from each connected phone
  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>();
  private hostConn: DataConnection | null = null;
  private joinId = "";
  private retry = 0;
  private count = 0;
  onChange: () => void = () => {};

  get connected(): boolean { return this.role === "host" ? this.conns.size > 0 : !!this.hostConn?.open; }

  /** Start hosting. Resolves with the link friends open (or scan) to join. */
  async host(): Promise<string> {
    this.stop();
    this.role = "host"; this.status = "Setting up..."; this.onChange();
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = "tp" + Math.random().toString(36).slice(2, 7);
      try {
        const peer = await this.open(id);
        this.peer = peer;
        peer.on("connection", (c) => this.accept(c));
        peer.on("disconnected", () => { try { peer.reconnect(); } catch { /* ignore */ } });
        peer.on("error", (e) => { this.status = "Connection problem: " + e.type; this.onChange(); });
        this.joinUrl = location.origin + location.pathname + location.search + "#join=" + id;
        this.status = "Waiting for other phones. Have them scan the code.";
        this.onChange();
        return this.joinUrl;
      } catch (e: any) {
        if (e?.type === "unavailable-id") continue;
        this.status = "Can't reach the connection service right now. Check the internet and try again.";
        this.role = "none"; this.onChange();
        throw e;
      }
    }
    throw new Error("no id");
  }

  private open(id?: string): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, brokerOptions()) : new Peer(brokerOptions());
      const t = setTimeout(() => { reject({ type: "timeout" }); try { peer.destroy(); } catch { /* ignore */ } }, 12000);
      peer.on("open", () => { clearTimeout(t); resolve(peer); });
      peer.on("error", (e) => { clearTimeout(t); reject(e); });
    });
  }

  private accept(c: DataConnection) {
    const name = `Phone ${++this.count + 1}`; // the host phone is Phone 1
    c.on("open", () => { this.conns.set(name, c); c.send({ k: "hello", name } satisfies HelloMsg); this.onChange(); });
    c.on("data", (d) => { const m = d as Msg; if (m?.k === "view") { this.peers.set(name, { name, view: m, at: performance.now() }); } });
    const gone = () => { this.conns.delete(name); this.peers.delete(name); this.onChange(); };
    c.on("close", gone); c.on("error", gone);
  }

  /** Readings from phones that have spoken recently. */
  live(maxAgeMs = 2500): PeerView[] {
    const now = performance.now();
    for (const [n, p] of this.peers) if (now - p.at > 8000) this.peers.delete(n);
    return [...this.peers.values()].filter((p) => now - p.at <= maxAgeMs);
  }

  broadcast(r: ResultMsg) { for (const c of this.conns.values()) if (c.open) c.send(r); }

  /** Join a host's session from a link. */
  join(hostId: string) {
    this.role = "helper"; this.joinId = hostId; this.status = "Connecting..."; this.onChange();
    this.attempt();
  }
  private async attempt() {
    if (this.role !== "helper") return;
    try {
      if (!this.peer || this.peer.destroyed) {
        this.peer = await this.open();
        this.peer.on("disconnected", () => { try { this.peer?.reconnect(); } catch { /* ignore */ } });
      }
      const c = this.peer.connect(this.joinId, { reliable: true });
      this.hostConn = c;
      const t = setTimeout(() => { if (!c.open) { this.status = "Can't reach the host. Is their phone still showing the code?"; try { c.close(); } catch { /* ignore */ } this.onChange(); this.again(); } }, 12000);
      c.on("open", () => { clearTimeout(t); this.status = "Connected to the host"; this.onChange(); });
      c.on("data", (d) => {
        const m = d as Msg;
        if (m?.k === "hello") { this.name = m.name; this.onChange(); }
        if (m?.k === "result") { this.hostResult = m; this.hostResultAt = performance.now(); this.onChange(); }
      });
      c.on("close", () => { this.status = "Lost the host. Trying again..."; this.hostConn = null; this.hostResult = null; this.onChange(); this.again(); });
      c.on("error", () => { this.status = "Connection problem. Trying again..."; this.onChange(); this.again(); });
    } catch (e: any) {
      this.status = "Can't reach the connection service right now."; this.onChange(); this.again();
    }
  }
  private again() { clearTimeout(this.retry); this.retry = window.setTimeout(() => this.attempt(), 3000); }

  send(m: ViewMsg) { if (this.hostConn?.open) this.hostConn.send(m); }

  stop() {
    clearTimeout(this.retry);
    for (const c of this.conns.values()) { try { c.close(); } catch { /* ignore */ } }
    try { this.hostConn?.close(); } catch { /* ignore */ }
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.peer = null; this.conns.clear(); this.peers.clear(); this.hostConn = null; this.hostResult = null;
    this.role = "none"; this.status = ""; this.joinUrl = ""; this.name = ""; this.count = 0;
    this.onChange();
  }

  async qr(canvas: HTMLCanvasElement) { if (this.joinUrl) await QRCode.toCanvas(canvas, this.joinUrl, { width: 260, margin: 2 }); }
}
