# 🎬 WatchFriend

TRT1'i arkadaşlarınla **senkron, gecikmesiz** izlemek için minimal watch-party platformu.
Discord ekran paylaşımı mantığı: oda kur, davet et, aynı görüntüyü beraber izle.
Sesli sohbet yok — sadece senkron görüntü. Oda sahibi (host) kontrol eder, herkes aynı anda izler.

> Dünya Kupası için TRT1 entegre. Yayın kaynağı: [iptv-org](https://github.com/iptv-org/iptv)

---

## ✨ Özellikler

- **Oda oluştur / davet et** — benzersiz oda kodu, paylaşılabilir link
- **Senkron oynatma** — herkes aynı proxy'lenmiş TRT1 kaynağını izler, host'un komutları anlık odaya yansır
- **Host kontrolü** — play/pause, canlı uca dön, ses, görüntü kalitesi
- **Sinema modu** — video tüm ekranı kaplar, üst bar/panel/kontroller gizlenir (tam ekran F11 değil; ESC ile çık)
- **Açılır-kapanır panel** — odada kim var görünür, katılımcı listesi
- **Karanlık tema** — ChatGPT tarzı gri/mavi, akıcı animasyonlar
- **Hafif** — framework yok, vanilla JS + HLS.js

---

## 🚀 Kurulum & Çalıştırma

### Gereksinimler
- [Node.js](https://nodejs.org/) 18+

### Yerelde çalıştırma
```bash
npm install
npm start
```
Site açılır: **http://localhost:3000**

---

## ☁️ İnternete açma (arkadaşınla paylaşmak için)

Sadece 2 kişi olacağınız için en kolay yol **Railway** (ücretsiz tier, GitHub'a push → otomatik kalıcı link, cloudflared/tünel gerekmez).

### Yöntem 1 — Railway (önerilen, en kolay)

1. **GitHub'a yükle**
   ```bash
   git init
   git add .
   git commit -m "watchfriend"
   ```
   GitHub'da yeni boş repo aç, push la:
   ```bash
   git remote add origin https://github.com/KULLANICIADI/watchfriend.git
   git branch -M main
   git push -u origin main
   ```

2. **Railway'e bağla**
   - https://railway.app → "Login with GitHub"
   - **New Project → Deploy from GitHub repo** → `watchfriend` seç
   - Railway `package.json`'ı görür, `npm start` çalıştırır, PORT'u otomatik verir
   - **Settings → Networking → Generate Domain** → `watchfriend.up.railway.app` gibi kalıcı link
   - Bu linki arkadaşına gönder, biti. ✅

3. Kodu güncellediğinde `git push` yapman yeterli — Railway otomatik yeniden deploy eder.

> **Not:** Railway free tier'da aylık cömert bir kredi var. Sadece maç süresince açık bırakırsan masrafı yok denecek kadar az.

### Yöntem 2 — Kendi bilgisayarın + cloudflared (hesap gerektirmez, geçici link)

`cloudflared` tamamen **ücretsizdir**, sadece senin PC'nde çalışır:
1. [cloudflared](https://github.com/cloudflare/cloudflared/releases/latest)'i indir
2. Sunucu çalışırken ayrı terminalde:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Çıktıdaki `https://xxxx.trycloudflare.com` linkini arkadaşına gönder
4. **Dezavantaj:** PC'n kapalıyken link ölür, her başlatmada yeni link üretilir.

> Neden Railway'i öneriyorum: PC'n açık kalmasına gerek yok, link kalıcı, güncelleme kolay.

---

## 🎮 Kullanım

1. Ana sayfada **adını gir** → **Oda Oluştur**
2. Sağ panelden **Davet Linkini Kopyala** → arkadaşına gönder
3. Arkadaşın linki açar, adını girer, katılır → **izleyici**
4. Sen (oda sahibi) yayını kontrol edersin; tüm oda senkron oynar

### Host kontrolleri
| Kontrol | Açıklama |
|---------|----------|
| ▶ / ⏸ | Oynat / Duraklat (odaya yansır) |
| 🔴 CANLI | Canlı uca atla (gecikmeyi sıfırla) |
| 🔊 | Ses aç/kapa + ses seviyesi |
| ⚙ Kalite | Görüntü kalitesi (Otomatik/720p/480p vb.) |

---

## 🔧 Teknik

- **Backend:** Express + Socket.IO (oda yönetimi + gerçek zamanlı komutlar)
- **HLS Proxy:** TRT1 stream'i Express üzerinden proxy'lenir → CORS garantili + tutarlı gecikme
- **Frontend:** Vanilla JS + [HLS.js](https://github.com/video-dev/hls.js/) (CDN)
- **Senkron:** host komutları WebSocket ile broadcast; periyodik canlı-ucu senkronu

### TRT1 Yayın Kaynağı
`https://tv-trt1.medya.trt.com.tr/master.m3u8` (iptv-org)

Yayın linki değişirse `server.js` içindeki `TRT1_MASTER` sabitini güncelle.

---

## ❓ Sorun Giderme

**Yayın açılmıyor / siyah ekran**
- TRT1 kaynağı geçici olarak erişilemez olabilir. Tarayıcı konsolunu kontrol et.
- Bazı ağlar/bölgeler TRT CDN'i engelleyebilir; tünel sunucusunun Türkiye'de olduğu dikkate alın.

**Arkadaşım bağlanamıyor**
- Tünelin çalıştığından emin ol (`cloudflared` / `ngrok` terminali açık kalmalı).
- Doğru linki paylaştığından emin ol.

**Otomatik oynatma çalışmıyor**
- Tarayıcı autoplay politikası nedeniyle başta sessiz başlar. Videoya tıklayıp sesi aç.

---

İyi seyirler! ⚽📺
