import { connectMqtt, type MqttConnection } from './mqtt';

// Eén gedeelde kamer waarin alle spelers elkaar vinden. De browsers praten via een publieke
// MQTT-broker (er is geen eigen server). Er gaan alleen spelgegevens overheen: posities en de
// stand van het magazijn. NOOIT WMS-gegevens of inloggegevens: iedereen kan meelezen.

/** Op volgorde geprobeerd; iedereen gebruikt dezelfde volgorde en komt zo op dezelfde broker uit. */
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
/** Willekeurig voorvoegsel zodat de kamer niet botst met andermans berichten op de broker. */
const PREFIX = 'hal-9d41f6c2';
const SETTLE_MS = 1500; // zo lang kijken we na het verbinden wie er al is, voordat we host kunnen worden
const PEER_TIMEOUT_MS = 5000;
const RETRY_MS = 3000;

export type Peer = { id: string; since: number; lastSeen: number };
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

  let conn: MqttConnection | null = null;
  let status: RoomStatus = 'connecting';
  let onlineAt = 0;
  let broker = 0;
  let left = false;

  function drop(peerId: string) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peers.delete(peerId);
    leaveHandlers.forEach((h) => h(peer));
  }

  function send(kind: string, data: unknown) {
    if (status === 'online') conn?.publish(`${base}/${kind}/${id}`, JSON.stringify({ t: since, d: data }));
  }

  function connect() {
    if (left) return;
    status = 'connecting';
    let opened = false;
    const c = connectMqtt({
      url: BROKERS[broker % BROKERS.length],
      clientId: `g${id}`,
      will: { topic: `${base}/bye/${id}`, payload: '{}' },
      onOpen() {
        opened = true;
        status = 'online';
        onlineAt = performance.now();
        c.subscribe(`${base}/+/+`);
        send('hi', null);
      },
      onMessage(topic, payload) {
        if (!topic.startsWith(`${base}/`)) return;
        const [kind, from] = topic.slice(base.length + 1).split('/');
        if (!kind || !from || from === id) return;
        if (kind === 'bye') return drop(from);
        let msg: { t?: unknown; d?: unknown };
        try {
          msg = JSON.parse(payload);
        } catch {
          return;
        }
        if (!msg || typeof msg.t !== 'number') return;
        let peer = peers.get(from);
        if (!peer) peers.set(from, (peer = { id: from, since: msg.t, lastSeen: 0 }));
        peer.since = msg.t;
        peer.lastSeen = performance.now();
        for (const h of handlers) {
          try {
            h(kind, peer, msg.d);
          } catch (err) {
            console.warn('[multiplayer] bericht genegeerd:', err); // de broker is publiek: onzin mag de game niet breken
          }
        }
      },
      onClose() {
        if (conn !== c) return;
        conn = null;
        status = 'offline';
        [...peers.keys()].forEach(drop);
        if (!opened) broker++; // deze broker is onbereikbaar: probeer de volgende
        if (!left) setTimeout(connect, RETRY_MS);
      },
    });
    conn = c;
  }

  let started = false;

  return {
    /** Begin met verbinden. Pas aanroepen als de game draait: een blokkerende opstart laat de verbinding verlopen. */
    start() {
      if (started) return;
      started = true;
      connect();
    },
    id,
    room,
    peers,
    get status() {
      return status;
    },
    get brokerHost() {
      return new URL(BROKERS[broker % BROKERS.length]).hostname;
    },
    get congested() {
      return conn?.congested ?? false;
    },
    /**
     * De host laat de wereld draaien (vrachtwagens, nieuwe orders): de speler die het langst binnen is.
     * Zonder verbinding speel je alleen en ben je dus zelf host.
     */
    get isHost() {
      if (status !== 'online') return true;
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
      conn?.close();
    },
  };
}

export type Room = ReturnType<typeof createRoom>;
