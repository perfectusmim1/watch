const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6,
});

const PORT = process.env.PORT || 3000;

// TRT1 canlı yayın kaynağı (iptv-org güncel linki)
const TRT1_MASTER = 'https://tv-trt1.medya.trt.com.tr/master.m3u8';

/* ------------------------------------------------------------------ */
/* Statik dosyalar                                                     */
/* ------------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, 'public')));

// Kök -> ana sayfa (oda oluşturma)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// /room/:id -> aynı SPA, istemci route'a göre odaya katılır
app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------------------------------------------------------ */
/* HLS Proxy — TRT1 stream'ini CORS garantili şekilde iletir.          */
/* Tüm istemciler bu proxy'den beslenir → tutarlı gecikme + senkron.    */
/* master.m3u8 + segment .ts/.m3u8 isteklerini yönlendirir.            */
/* ------------------------------------------------------------------ */

// relative URL'leri proxy köküne rewrite eden yardımcı
function rewriteM3u8(body, baseUrl) {
  // Satır satır gezip relative/path olanları absolute proxy URL'e çevir
  return body
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        // URI="..." özelliklerini de rewrite et
        return line.replace(/URI="([^"]+)"/g, (m, uri) => {
          if (/^https?:\/\//i.test(uri)) return m; // zaten absolute
          return `URI="${baseUrl}/${uri.replace(/^\/+/, '')}"`;
        });
      }
      if (/^https?:\/\//i.test(trimmed)) return line; // zaten absolute (farklı CDN)
      return `${baseUrl}/${trimmed.replace(/^\/+/, '')}`;
    })
    .join('\n');
}

app.get('/stream/*', (clientReq, clientRes) => {
  // İstek yolundan segment path'ini çıkar: /stream/<path>
  const subPath = clientReq.params[0] || '';

  // master.m3u8 kök çağrısı -> TRT1 master
  // alt playlistler / segmentler de aynı CDN host'una gider
  let targetUrl;
  if (subPath === '' || subPath === 'master.m3u8') {
    targetUrl = TRT1_MASTER;
  } else {
    // TRT CDN host'una göre absolute URL oluştur
    targetUrl = `https://tv-trt1.medya.trt.com.tr/${subPath}`;
  }

  const url = new URL(targetUrl);
  const lib = url.protocol === 'https:' ? https : http;

  // Timeout güvenliği: CDN cevap vermezse istemci sonsuza kadar beklemesin
  const upstreamReq = lib.get(
    url,
    {
      headers: {
        // Bazı CDN'ler User-Agent/Referer bekler
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Referer: 'https://www.trt1.com.tr/',
        Origin: 'https://www.trt1.com.tr',
      },
      timeout: 15000, // 15 sn — bağlantı/cevap için makul sınır
    },
    (upstreamRes) => {
      // 3xx ise location'u proxy'ye rewrite et
      if (
        upstreamRes.statusCode >= 300 &&
        upstreamRes.statusCode < 400 &&
        upstreamRes.headers.location
      ) {
        const loc = upstreamRes.headers.location;
        // Mutlak URL ise aynı CDN demektir → host bilgisinden relative path üret
        let rel = loc;
        try {
          if (/^https?:\/\//i.test(loc)) {
            rel = new URL(loc).pathname.replace(/^\/+/, '');
          } else {
            rel = loc.replace(/^\/+/, '');
          }
        } catch (_) {
          rel = loc.replace(/^\/+/, '');
        }
        clientRes.redirect(302, `/stream/${rel}`);
        return;
      }

      if (upstreamRes.statusCode !== 200 && upstreamRes.statusCode !== 206) {
        clientRes.status(upstreamRes.statusCode || 502).end();
        return;
      }

      const contentType = upstreamRes.headers['content-type'] || '';
      const isMaster = subPath === '' || subPath === 'master.m3u8';

      // m3u8 ise rewrite; ikili (segment) ise direkt ilet
      if (
        contentType.includes('mpegurl') ||
        contentType.includes('application/vnd.apple.mpegurl') ||
        subPath.endsWith('.m3u8')
      ) {
        const chunks = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8');
          if (isMaster) {
            body = rewriteM3u8(body, '/stream');
          } else {
            body = rewriteM3u8(body, '/stream');
          }
          clientRes.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          clientRes.setHeader('Cache-Control', 'no-cache');
          clientRes.setHeader('Access-Control-Allow-Origin', '*');
          clientRes.end(body);
        });
      } else {
        // ts/mp4 segment akışı — buffer olmadan ilet (düşük gecikme)
        clientRes.setHeader('Content-Type', contentType);
        clientRes.setHeader('Access-Control-Allow-Origin', '*');
        clientRes.setHeader('Cache-Control', 'public, max-age=60');
        upstreamRes.pipe(clientRes);
      }
    }
  );

  upstreamReq.on('error', (err) => {
    console.error('[proxy] hata:', err.message);
    if (!clientRes.headersSent) clientRes.status(502).end('Stream proxy error');
    else clientRes.end();
  });

  // Bağlantı kuruldu ama cevap geç gelirse → zaman aşımı ile sonlandır
  upstreamReq.on('timeout', () => {
    console.error('[proxy] zaman aşımı:', targetUrl);
    upstreamReq.destroy();
    if (!clientRes.headersSent) clientRes.status(504).end('Stream proxy timeout');
    else clientRes.end();
  });
});

/* ------------------------------------------------------------------ */
/* Oda yönetimi (bellek içi)                                          */
/* ------------------------------------------------------------------ */
const rooms = new Map(); // roomId -> { id, name, hostSocketId, users: Map(socketId -> {name, isHost}), messages: [] }

const CHAT_HISTORY_LIMIT = 100; // oda başına tutulacak en fazla mesaj
const CHAT_MAX_LEN = 500; // tek bir mesajın en fazla karakter uzunluğu

function genRoomId() {
  return crypto.randomBytes(3).toString('hex'); // 6 karakter
}

function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    users: Array.from(room.users.values()).map((u) => ({
      name: u.name,
      isHost: u.isHost,
    })),
  };
}

function broadcastRoomState(room) {
  io.to(room.id).emit('room-state', roomSummary(room));
}

// Odaya sistem mesajı ekle ve kalan herkese yayınla
// (to = null ise odadaki herkese, socket.id verilirse sadece dışındakilere)
function pushSystemMessage(room, text, excludeSocketId) {
  const msg = {
    id: crypto.randomBytes(6).toString('hex'),
    name: '',
    text,
    ts: Date.now(),
    system: true,
  };
  room.messages.push(msg);
  if (room.messages.length > CHAT_HISTORY_LIMIT) {
    room.messages.splice(0, room.messages.length - CHAT_HISTORY_LIMIT);
  }
  if (excludeSocketId) {
    io.to(room.id).except(excludeSocketId).emit('chat-message', msg);
  } else {
    io.to(room.id).emit('chat-message', msg);
  }
}

/* ------------------------------------------------------------------ */
/* Socket.IO — senkronizasyon kanalı                                  */
/* ------------------------------------------------------------------ */
io.on('connection', (socket) => {
  console.log(`[io] bağlandı: ${socket.id}`);

  socket.on('join', ({ roomId, name }, ack) => {
    // Oda yoksa ilk katılan host olur (yeni oda oluştur)
    let room = rooms.get(roomId);
    let isHost = false;
    if (!room) {
      isHost = true;
      room = {
        id: roomId,
        name: name ? `${name}'in Odası` : 'İzleme Odası',
        hostSocketId: socket.id,
        users: new Map(),
        messages: [],
      };
      rooms.set(roomId, room);
    }

    socket.join(roomId);
    room.users.set(socket.id, { name: name || 'İzleyici', isHost });

    socket.data.roomId = roomId;
    socket.data.name = name || 'İzleyici';

    if (typeof ack === 'function') {
      ack({
        ok: true,
        isHost: room.users.get(socket.id).isHost,
        room: roomSummary(room),
        messages: room.messages,
      });
    }

    broadcastRoomState(room);

    // Sohbet: yeni katılan hariç herkese sistem mesajı bildir
    pushSystemMessage(room, `${name || 'İzleyici'} katıldı`, socket.id);

    // Yeni katılanlara mevcut host state'ini hemen iste
    if (room.hostSocketId && room.hostSocketId !== socket.id) {
      io.to(room.hostSocketId).emit('request-state', { to: socket.id });
    }
  });

  // Sohbet mesajı — doğrula ve odaya yayınla (gönderen dahil herkes alır)
  socket.on('chat-message', (payload, ack) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room) return;

    const text = typeof payload === 'string' ? payload : payload && payload.text;
    if (typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, CHAT_MAX_LEN);
    if (!trimmed) return;

    const msg = {
      id: crypto.randomBytes(6).toString('hex'),
      name: socket.data.name || 'İzleyici',
      text: trimmed,
      ts: Date.now(),
      system: false,
    };
    room.messages.push(msg);
    if (room.messages.length > CHAT_HISTORY_LIMIT) {
      room.messages.splice(0, room.messages.length - CHAT_HISTORY_LIMIT);
    }
    io.to(room.id).emit('chat-message', msg);
    if (typeof ack === 'function') ack({ ok: true, id: msg.id });
  });

  // Host → tüm odaya komut yayınla (play/pause/seek-live/mute/volume/quality)
  socket.on('host-command', (cmd) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return; // yalnızca host
    socket.to(room.id).emit('command', cmd);
  });

  // Host → belirli bir izleyiciye anlık state gönder (ilk katılım)
  socket.on('state-snapshot', ({ to, state }) => {
    io.to(to).emit('command', { type: 'snapshot', state });
  });

  // Periyodik senkron: host pozisyonunu broadcast eder
  socket.on('sync-time', (t) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || room.hostSocketId !== socket.id) return;
    socket.to(room.id).emit('sync-time', t);
  });

  socket.on('leave', () => {
    leaveRoom(socket);
  });

  socket.on('disconnect', () => {
    console.log(`[io] ayrıldı: ${socket.id}`);
    leaveRoom(socket);
  });
});

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  const leavingName = room.users.get(socket.id)?.name || socket.data.name || 'İzleyici';
  const wasHost = room.users.get(socket.id)?.isHost;
  room.users.delete(socket.id);

  if (room.users.size === 0) {
    rooms.delete(roomId);
    console.log(`[io] oda silindi (boş): ${roomId}`);
    return;
  }

  // Host ayrılırsa, yeni host ataması yap (ilk kalan kişi)
  if (wasHost) {
    const nextSocketId = room.users.keys().next().value;
    room.users.get(nextSocketId).isHost = true;
    room.hostSocketId = nextSocketId;
    io.to(nextSocketId).emit('you-are-host');
    console.log(`[io] yeni host: ${nextSocketId} (oda ${roomId})`);
  }

  // Sohbet: kalan herkese ayrılış bildir
  pushSystemMessage(room, `${leavingName} ayrıldı`);

  broadcastRoomState(room);
}

/* ------------------------------------------------------------------ */
server.listen(PORT, () => {
  console.log(`\n  WatchFriend çalışıyor → http://localhost:${PORT}`);
  console.log(`  Stream proxy       → http://localhost:${PORT}/stream/master.m3u8\n`);
});
