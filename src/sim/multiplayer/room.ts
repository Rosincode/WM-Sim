import { connectMqtt, type MqttConnection } from './mqtt';

// Eén gedeelde kamer waarin alle spelers elkaar vinden. De browsers praten via publieke
// MQTT-brokers (er is geen eigen server). Er gaan alleen spelgegevens overheen: posities en de
// stand van het magazijn. NOOIT WMS-gegevens of inloggegevens: iedereen kan meelezen.

/**
 * We verbinden met alle brokers tegelijk en sturen elk bericht via allemaal; dubbele berichten
 * vallen bij de ontvanger weg. Zo vinden spelers elkaar ook als één broker (voor één van hen) hapert.
 */
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
/** Willekeurig voorvoegsel zodat de kamer niet botst met andermans berichten op de broker. */
const PREFIX = 'hal-9d41f6c2';
const SETTLE_MS = 1500; // zo lang kijken we na het verbinden wie er al is, voordat we host kunnen worden
const PEER_TIMEOUT_MS = 5000;
const GONE_GRACE_MS = 1500;
const RETRY_MS = 3000;

export type Peer = { id: string; since: number; lastSeen: number; seq: number };
export type RoomStatus = 'connecting' | 'online' | 'offline';
type Handler = (kind: string, from: Peer, data: unknown) => void;

export function createRoom(roomName: string) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  const since = Date.now();
  const room = roomName.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'main';
  const base = `${PREFIX}/${room}`;
  const peers = new Map<string, Peer>();
  const handlers: Handler[] = [];
  const leaveHandlers: ((peer: Peer) => void)[] = [];

  const open = new Set<MqttConnection>();
  const failed = new Set<string>();
  let onlineAt = 0;
  let seq = 0;
  let left = false;

  function drop(peerId: string) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peers.delete(peerId);
    leaveHandlers.forEach((h) => h(peer));
  }

  function send(kind: string, data: unknown) {
    if (!open.size) return;
    const payload = JSON.stringify({ t: since, q: ++seq, d: data });
    for (const c of open) c.publish(`${base}/${kind}/${id}`, payload);
  }

  function receive(topic: string, payload: string) {
    if (!topic.startsWith(`${base}/`)) return;
    const [kind, from] = topic.slice(base.length + 1).split('/');
    if (!kind || !from || from === id) return;
    if (kind === 'bye') return drop(from);
    if (kind === 'gone') {
      // Eén van de verbindingen van die speler viel weg; hoor je daarna niets meer, dan is hij echt weg.
      const peer = peers.get(from);
      if (peer) peer.lastSeen = Math.min(peer.lastSeen, performance.now() - PEER_TIMEOUT_MS + GONE_GRACE_MS);
      return;
    }
    let msg: { t?: unknown; q?: unknown; d?: unknown };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'number' || typeof msg.q !== 'number') return;
    let peer = peers.get(from);
    if (!peer) peers.set(from, (peer = { id: from, since: msg.t, lastSeen: 0, seq: 0 }));
    peer.lastSeen = performance.now();
    if (msg.q <= peer.seq) return; // al ontvangen via een andere broker
    peer.seq = msg.q;
    peer.since = msg.t;
    for (const h of handlers) {
      try {
        h(kind, peer, msg.d);
      } catch (err) {
        console.warn('[multiplayer] bericht genegeerd:', err); // de brokers zijn publiek: onzin mag de game niet breken
      }
    }
  }

  function connect(url: string) {
    if (left) return;
    const c = connectMqtt({
      url,
      clientId: `g${id}`,
      will: { topic: `${base}/gone/${id}`, payload: '{}' },
      onOpen() {
        if (!open.size) onlineAt = performance.now();
        open.add(c);
        failed.delete(url);
        c.subscribe(`${base}/+/+`);
        c.publish(`${base}/hi/${id}`, JSON.stringify({ t: since, q: ++seq, d: null }));
      },
      onMessage: receive,
      onClose() {
        open.delete(c);
        failed.add(url);
        if (!open.size) [...peers.keys()].forEach(drop);
        if (!left) setTimeout(() => connect(url), RETRY_MS);
      },
    });
  }

  let started = false;
  const status = (): RoomStatus => (open.size ? 'online' : failed.size < BROKERS.length ? 'connecting' : 'offline');

  return {
    id,
    room,
    peers,
    /** Begin met verbinden. Pas aanroepen als de game draait: een blokkerende opstart laat de verbinding verlopen. */
    start() {
      if (started) return;
      started = true;
      BROKERS.forEach(connect);
    },
    get status() {
      return status();
    },
    /** Via hoeveel van de brokers we nu verbonden zijn, bijvoorbeeld "2/2". */
    get links() {
      return `${open.size}/${BROKERS.length}`;
    },
    get congested() {
      return [...open].some((c) => c.congested);
    },
    /**
     * De host laat de wereld draaien (vrachtwagens, nieuwe orders): de speler die het langst binnen is.
     * Zonder verbinding speel je alleen en ben je dus zelf host.
     */
    get isHost() {
      if (!open.size) return true;
      if (performance.now() - onlineAt < SETTLE_MS) return false;
      for (const p of peers.values()) if (p.since < since || (p.since === since && p.id < id)) return false;
      return true;
    },
    send,
    on(h: Handler) {
      handlers.push(h);
    },
    onLeave(h: (peer: Peer) => void) {
      leaveHandlers.push(h);
    },
    /** Elke frame: spelers die niets meer van zich laten horen verdwijnen. */
    update() {
      const now = performance.now();
      for (const p of peers.values()) if (now - p.lastSeen > PEER_TIMEOUT_MS) drop(p.id);
    },
    leave() {
      if (left) return;
      send('bye', null);
      left = true;
      for (const c of open) c.close();
    },
  };
}

export type Room = ReturnType<typeof createRoom>;
