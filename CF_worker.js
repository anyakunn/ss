// Simple VLESS + WebSocket Worker (with preferred outbound IP + custom DNS)
// Compatible with Clash / Surfboard

import { connect } from 'cloudflare:sockets';

// ===================== CONFIG =====================
const userID = 'bb001d2c-24f1-468c-bdb9-3834f4d2f7bc';               // ← Change this UUID

// Preferred outbound IPs / CIDRs (tried first)
// You can put single IPs or leave empty for pure direct
const preferredProxyIPs = [
  // Examples – replace with the IPs/CIDRs you want to prefer
  '1.1.1.1',
  '1.0.0.1',
  '104.16.0.0',          // example CF range start
  // '162.159.0.0',
];

// Main DNS used by the Worker (for domain resolution)
const DNS_SERVER = '1.1.1.1';                 // Cloudflare DNS (recommended)
// Other options: '8.8.8.8', '8.8.4.4', '9.9.9.9', etc.
// ==================================================

const WS_READY_STATE_OPEN = 1;

export default {
  async fetch(request, env, ctx) {
    try {
      const upgradeHeader = request.headers.get('Upgrade');

      if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        return await handleWebSocket(request);
      }

      return new Response(
        `VLESS Worker running\n\nUUID: ${userID}\nPreferred IPs: ${preferredProxyIPs.join(', ') || 'none (direct)'}\nDNS: ${DNS_SERVER}`,
        { status: 200, headers: { 'Content-Type': 'text/plain' } }
      );
    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 });
    }
  },
};

async function handleWebSocket(request) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  let remoteSocket = null;
  let isClosed = false;

  server.addEventListener('message', async (event) => {
    try {
      if (isClosed) return;

      const data = event.data instanceof ArrayBuffer 
        ? event.data 
        : await event.data.arrayBuffer();

      if (!remoteSocket) {
        const parsed = parseVLESSHeader(new Uint8Array(data), userID);
        if (!parsed) {
          server.close(1000, 'Invalid UUID or header');
          return;
        }

        const { address, port, rawData } = parsed;

        // Resolve domain using the DNS you configured
        let targetHost = address;
        if (!isIP(address)) {
          targetHost = await resolveDNS(address, DNS_SERVER) || address;
        }

        // Try preferred proxy IPs first, then fall back to direct
        remoteSocket = await connectWithPreferred(targetHost, port, preferredProxyIPs);

        // Send remaining early data
        if (rawData && rawData.byteLength > 0) {
          const writer = remoteSocket.writable.getWriter();
          await writer.write(rawData);
          writer.releaseLock();
        }

        // Client → Remote
        server.addEventListener('message', async (e) => {
          if (remoteSocket && !isClosed) {
            try {
              const writer = remoteSocket.writable.getWriter();
              await writer.write(e.data);
              writer.releaseLock();
            } catch {
              safeClose();
            }
          }
        });

        // Remote → Client
        remoteSocket.readable.pipeTo(new WritableStream({
          write(chunk) {
            if (server.readyState === WS_READY_STATE_OPEN) {
              server.send(chunk);
            }
          },
          close() { safeClose(); },
          abort() { safeClose(); }
        })).catch(() => safeClose());

      }
    } catch (err) {
      safeClose();
    }
  });

  server.addEventListener('close', () => safeClose());
  server.addEventListener('error', () => safeClose());

  function safeClose() {
    if (isClosed) return;
    isClosed = true;
    try { server.close(); } catch {}
    try { if (remoteSocket) remoteSocket.close(); } catch {}
  }

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

// Try preferred IPs first, then direct connection
async function connectWithPreferred(hostname, port, preferredList) {
  // 1. Try preferred proxy IPs first
  for (const proxy of preferredList) {
    try {
      const socket = connect({
        hostname: proxy,
        port: port,
      });
      await socket.opened;
      return socket;
    } catch (e) {
      // try next
    }
  }

  // 2. Fallback to direct connection
  const socket = connect({ hostname, port });
  await socket.opened;
  return socket;
}

// Simple DNS resolve using the DNS you set
async function resolveDNS(domain, dnsServer) {
  try {
    const response = await fetch(`https://\( {dnsServer}/dns-query?name= \){domain}&type=A`, {
      headers: { 'Accept': 'application/dns-json' }
    });
    const data = await response.json();
    if (data.Answer && data.Answer.length > 0) {
      return data.Answer[0].data;
    }
  } catch (e) {}
  return null;
}

function isIP(str) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(str) || str.includes(':');
}

function parseVLESSHeader(buffer, expectedUUID) {
  if (buffer.byteLength < 24) return null;

  const uuidBytes = buffer.slice(1, 17);
  const uuid = stringifyUUID(uuidBytes);
  if (uuid !== expectedUUID) return null;

  let offset = 17;
  const addonLen = buffer[offset++];
  offset += addonLen;

  const command = buffer[offset++];
  if (command !== 1) return null; // TCP only in this version

  const port = (buffer[offset] << 8) | buffer[offset + 1];
  offset += 2;

  const addressType = buffer[offset++];
  let address = '';
  let addressLen = 0;

  if (addressType === 1) {          // IPv4
    addressLen = 4;
    address = Array.from(buffer.slice(offset, offset + 4)).join('.');
  } else if (addressType === 2) {   // Domain
    addressLen = buffer[offset++];
    address = new TextDecoder().decode(buffer.slice(offset, offset + addressLen));
  } else {
    return null; // IPv6 skipped for simplicity
  }

  offset += addressLen;
  const rawData = buffer.slice(offset);

  return { address, port, rawData };
}

function stringifyUUID(arr) {
  const hex = [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
  return `\( {hex.slice(0,8)}- \){hex.slice(8,12)}-\( {hex.slice(12,16)}- \){hex.slice(16,20)}-${hex.slice(20)}`;
}
