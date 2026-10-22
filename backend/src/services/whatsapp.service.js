/**
 * WhatsApp sender - the wabridge engine (github.com/jabez4jc/wabridge) embedded in-process.
 *
 * wabridge is a CLI whose session lives in ~/.wabridge and is linked from a terminal, so its
 * socket logic is reproduced here instead: linked by scanning a QR shown in Settings, with the
 * session kept beside the database (database/whatsapp-auth/, which update.sh leaves alone), so it
 * survives restarts and updates. A linked session reconnects on its own after any drop except a
 * logout from the phone.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from 'baileys';
import { log } from '../core/logger.js';
import { notify } from './notify.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same resolution as core/database.js, so the session sits next to whichever DB is in use.
const DB_PATH = path.resolve(__dirname, '../../', process.env.DATABASE_PATH || './database/simplifyed.db');
// Test runs keep their databases in the same folder, so they get a session folder of their own:
// the API contract sweep calls /whatsapp/logout, which once deleted the real linked session.
const DATA_DIR = process.env.NODE_TEST_CONTEXT
  ? path.join(os.tmpdir(), `simplifyed-whatsapp-test-${process.pid}`)
  : path.dirname(DB_PATH);
export const AUTH_DIR = path.join(DATA_DIR, process.env.NODE_TEST_CONTEXT ? 'auth' : 'whatsapp-auth');
// Attachments wait here until every message carrying them has been sent and later pruned
export const MEDIA_DIR = path.join(DATA_DIR, process.env.NODE_TEST_CONTEXT ? 'media' : 'whatsapp-media');

/**
 * How WhatsApp shows a file. JPEG/PNG, MP4/3GP and the common audio formats play inline (16 MB
 * cap); everything else - PDF, text, Office files, ZIP, GIF, WebP, HEIC... - goes as a document,
 * which WhatsApp accepts in any format.
 */
export const INLINE_MAX_BYTES = 16 * 1024 * 1024;
export function mediaKind(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/png') return 'image';
  if (m === 'video/mp4' || m === 'video/3gpp') return 'video';
  if (/^audio\/(aac|mp4|mpeg|mp3|amr|ogg|opus|x-m4a)$/.test(m)) return 'audio';
  return 'document';
}

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60000;

// Baileys logs through pino; it is silenced here - connection events are logged below.
const silent = { level: 'silent', child: () => silent, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

class WhatsAppService {
  constructor() {
    this.sock = null;
    this.status = 'disconnected'; // disconnected | connecting | qr | open
    this.qr = null; // data: URL of the current QR while waiting to be scanned
    this.stopped = true;
    this.reconnectMs = RECONNECT_MIN_MS;
    this.reconnectTimer = null;
  }

  isLinked() {
    return fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
  }

  /** On boot: reconnect a session linked earlier. An unlinked app waits for Connect in Settings. */
  async boot() {
    if (this.isLinked()) await this.start();
  }

  async start() {
    if (this.sock) return;
    clearTimeout(this.reconnectTimer);
    this.stopped = false;
    this.status = 'connecting';
    try {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        version,
        logger: silent,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silent) },
        markOnlineOnConnect: false,
      });
      this.sock = sock;
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) => this.onConnectionUpdate(sock, update)
        .catch((err) => log.warn('whatsapp_update_failed', { error: err.message })));
    } catch (err) {
      this.sock = null;
      this.status = 'disconnected';
      log.warn('whatsapp_start_failed', { error: err.message });
      this.scheduleReconnect();
    }
  }

  async onConnectionUpdate(sock, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return;
    if (qr) {
      this.status = 'qr';
      this.qr = await QRCode.toDataURL(qr);
    }
    if (connection === 'open') {
      this.status = 'open';
      this.qr = null;
      this.reconnectMs = RECONNECT_MIN_MS;
      log.info('whatsapp_connected', { user: this.phone() });
      // Send what queued up while disconnected (imported lazily: the outbox imports this module)
      import('./whatsapp-outbox.service.js').then(({ default: outbox }) => outbox.drain());
    }
    if (connection === 'close') {
      this.sock = null;
      this.status = 'disconnected';
      this.qr = null;
      if (this.stopped) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        log.warn('whatsapp_logged_out');
        await notify('WhatsApp logged out', 'WhatsApp was unlinked from the phone. Reconnect it on the WhatsApp page (Connection tab).', { severity: 'error' });
        return;
      }
      // A QR nobody scanned: stop rather than cycle codes in the background forever.
      if (!sock.authState?.creds?.me) {
        log.info('whatsapp_qr_expired');
        return;
      }
      log.warn('whatsapp_disconnected', { code });
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.start(), this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
  }

  /** Unlink this app from WhatsApp and delete the saved session. */
  async logout() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = null;
    try {
      if (sock?.authState?.creds?.me) await sock.logout();
      else sock?.end(undefined);
    } catch (err) {
      log.warn('whatsapp_logout_failed', { error: err.message });
    } finally {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      this.status = 'disconnected';
      this.qr = null;
    }
  }

  /** Close the connection on shutdown, keeping the session for the next boot. */
  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.sock?.end(undefined);
    this.sock = null;
  }

  phone() {
    return this.sock?.user?.id?.split(/[:@]/)[0] || null;
  }

  getStatus() {
    return { status: this.status, phone: this.status === 'open' ? this.phone() : null, qr: this.qr };
  }

  /** Send a text to a number (digits with country code). Throws when not connected or not on WhatsApp. */
  async sendText(phone, text) {
    return this.sendMessage(phone, text);
  }

  /**
   * Send text and attachments ([{ file, name, mime }] stored in MEDIA_DIR) to one number. The text
   * rides as the first attachment's caption where WhatsApp allows one (image, video, document);
   * audio takes no caption, so the text then goes first on its own. Further files follow without one.
   */
  async sendMessage(phone, text, media = []) {
    if (!this.sock || this.status !== 'open') throw new Error('WhatsApp not connected');
    const [result] = await this.sock.onWhatsApp(phone);
    if (!result?.exists) throw new Error(`${phone} is not on WhatsApp`);
    let caption = text || undefined;
    if (!media.length || mediaKind(media[0].mime) === 'audio') {
      if (caption) await this.sock.sendMessage(result.jid, { text: caption });
      caption = undefined;
    }
    for (const m of media) {
      const source = { url: path.join(MEDIA_DIR, path.basename(m.file)) };
      const kind = mediaKind(m.mime);
      const content = kind === 'document'
        ? { document: source, mimetype: m.mime || 'application/octet-stream', fileName: m.name, caption }
        : kind === 'audio' ? { audio: source, mimetype: m.mime, ptt: false }
          : { [kind]: source, caption };
      await this.sock.sendMessage(result.jid, content);
      caption = undefined;
    }
  }
}

export default new WhatsAppService();
