// Minimale MQTT 3.1.1-client over WebSocket: verbinden, abonneren, publiceren (QoS 0) en keep-alive.
// Bewust zonder dependency; genoeg om kleine JSON-berichten tussen spelers door te sturen.

const enc = new TextEncoder();
const dec = new TextDecoder();
const KEEP_ALIVE_S = 60;
const PING_MS = 25_000;
const CONNECT_TIMEOUT_MS = 8_000;

export interface MqttOptions {
  url: string;
  clientId: string;
  /** Bericht dat de broker verstuurt als de verbinding wegvalt zonder nette afmelding. */
  will?: { topic: string; payload: string };
  onOpen: () => void;
  onMessage: (topic: string, payload: string) => void;
  onClose: () => void;
}

function str(s: string) {
  const b = enc.encode(s);
  const out = new Uint8Array(b.length + 2);
  out[0] = b.length >> 8;
  out[1] = b.length & 255;
  out.set(b, 2);
  return out;
}

function packet(header: number, ...parts: Uint8Array[]) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const lenBytes: number[] = [];
  let rest = len;
  do {
    let b = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) b |= 128;
    lenBytes.push(b);
  } while (rest > 0);
  const out = new Uint8Array(1 + lenBytes.length + len);
  out[0] = header;
  out.set(lenBytes, 1);
  let o = 1 + lenBytes.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function connectMqtt(o: MqttOptions) {
  const ws = new WebSocket(o.url, 'mqtt');
  ws.binaryType = 'arraybuffer';
  let buf = new Uint8Array(0);
  let ready = false;
  let done = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  let packetId = 1;

  const send = (p: Uint8Array<ArrayBuffer>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(p);
  };

  function finish() {
    if (done) return;
    done = true;
    clearInterval(ping);
    clearTimeout(timeout);
    try {
      ws.close();
    } catch {
      // al dicht
    }
    o.onClose();
  }
  const timeout = setTimeout(() => !ready && finish(), CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    const flags = 0x02 | (o.will ? 0x04 : 0); // schone sessie (+ testament)
    const will = o.will ? [str(o.will.topic), str(o.will.payload)] : [];
    send(packet(0x10, str('MQTT'), Uint8Array.of(4, flags, KEEP_ALIVE_S >> 8, KEEP_ALIVE_S & 255), str(o.clientId), ...will));
  };
  ws.onclose = finish;
  ws.onerror = finish;

  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const chunk = new Uint8Array(e.data);
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf);
    merged.set(chunk, buf.length);
    buf = merged;
    drain();
  };

  /** Een WebSocket-frame kan meerdere of halve MQTT-pakketten bevatten. */
  function drain() {
    while (!done && buf.length >= 2) {
      let len = 0;
      let mult = 1;
      let i = 1;
      let b: number;
      do {
        if (i >= buf.length) return; // lengteveld nog niet compleet
        b = buf[i++];
        len += (b & 127) * mult;
        mult *= 128;
      } while (b & 128 && i <= 4);
      if (buf.length < i + len) return;
      const header = buf[0];
      const body = buf.subarray(i, i + len);
      buf = buf.slice(i + len);
      handle(header, body);
    }
  }

  function handle(header: number, body: Uint8Array) {
    const type = header >> 4;
    if (type === 2) {
      // CONNACK
      if (body[1] !== 0) return finish();
      ready = true;
      clearTimeout(timeout);
      ping = setInterval(() => send(Uint8Array.of(0xc0, 0)), PING_MS);
      o.onOpen();
    } else if (type === 3) {
      // PUBLISH
      const topicLen = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + topicLen));
      const idBytes = header & 6 ? 2 : 0; // bij QoS > 0 volgt een pakket-id
      o.onMessage(topic, dec.decode(body.subarray(2 + topicLen + idBytes)));
    }
  }

  return {
    get ready() {
      return ready && !done;
    },
    /** Te veel onverstuurde data: sla dan niet-essentiële berichten over. */
    get congested() {
      return ws.bufferedAmount > 64 * 1024;
    },
    subscribe(filter: string) {
      packetId = (packetId % 65535) + 1;
      send(packet(0x82, Uint8Array.of(packetId >> 8, packetId & 255), str(filter), Uint8Array.of(0)));
    },
    publish(topic: string, payload: string) {
      if (ready) send(packet(0x30, str(topic), enc.encode(payload)));
    },
    close: finish,
  };
}

export type MqttConnection = ReturnType<typeof connectMqtt>;
