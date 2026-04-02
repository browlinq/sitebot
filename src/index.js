const fs = require('fs');
const path = require('path');
const http = require('http');
const fetch = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '15000', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10);
const PORT = process.env.PORT || 3000;

const WELCOME_LOGO_URL = 'https://i.hizliresim.com/lgnireg.png';
const DATA_FILE = path.join(__dirname, '..', 'data.json');

if (!TELEGRAM_TOKEN) {
  throw new Error('TELEGRAM_TOKEN eksik.');
}

/**
 * Web service health server
 */
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('AquaBahis bot is running');
}).listen(PORT, () => {
  console.log(`Health server running on port ${PORT}`);
});

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

/**
 * Kalıcı veri yapısı
 */
const db = loadDb();

/**
 * Geçici oturumlar
 */
const sessions = Object.create(null);

/**
 * sessions[chatId] = {
 *   monitoring: boolean,
 *   muted: boolean,
 *   interval: Timeout | null,
 *   knownStates: {
 *     [site]: {
 *       site: string,
 *       isUp: boolean,
 *       statusCode: number | null,
 *       detail: string,
 *       lastCheckedAt: Date,
 *       countryResults?: object
 *     }
 *   }
 * }
 */

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('data.json okunamadı:', error.message);
  }

  const initial = {
    admins: parseCsv(process.env.ADMIN_CHAT_IDS || ''),
    sites: parseCsv(process.env.SITES_TO_CHECK || '').map(normalizeSite).filter(Boolean),
    allowedCountries: parseCsv(process.env.ALLOWED_COUNTRIES || 'TR'),
    blockedCountries: parseCsv(process.env.BLOCKED_COUNTRIES || ''),
    uptime: {}
  };

  saveDb(initial);
  return initial;
}

function saveDb(data = db) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('data.json yazılamadı:', error.message);
  }
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function ensureSession(chatId) {
  const key = String(chatId);

  if (!sessions[key]) {
    sessions[key] = {
      monitoring: false,
      muted: false,
      interval: null,
      knownStates: Object.create(null)
    };
  }

  return sessions[key];
}

function getSites() {
  return (db.sites || []).map(normalizeSite).filter(Boolean);
}

function normalizeSite(site) {
  const value = String(site || '').trim();
  if (!value) return '';

  if (!/^https?:\/\//i.test(value)) {
    return `https://${value}`;
  }

  return value;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isAllowedChat(msg) {
  return msg && msg.chat && ['private', 'group', 'supergroup'].includes(msg.chat.type);
}

function isPrivateChat(msg) {
  return msg && msg.chat && msg.chat.type === 'private';
}

function formatDate(date) {
  return new Date(date).toLocaleString('tr-TR');
}

function isAdmin(chatId) {
  return (db.admins || []).map(String).includes(String(chatId));
}

function addAdmin(chatId) {
  const id = String(chatId);
  if (!db.admins.map(String).includes(id)) {
    db.admins.push(id);
    saveDb();
  }
}

function mainMenu(isUserAdmin = false) {
  const base = [
    ['▶️ BAŞLAT', '⏹️ DURDUR'],
    ['📊 DURUM', '🔎 KONTROL ET'],
    ['🌐 TÜM SİTELER', '🔕 SUSTUR'],
    ['🔔 AKTİF ET', '❓ YARDIM']
  ];

  if (isUserAdmin) {
    base.push(['👑 ADMIN PANEL']);
  }

  return {
    reply_markup: {
      keyboard: base,
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

function inlineSiteButtons(site) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🌐 Siteye Git', url: site }],
        [
          { text: '🔄 Yeniden Kontrol', callback_data: `check:${site}` },
          { text: 'ℹ️ Son Durum', callback_data: `status:${site}` }
        ]
      ]
    }
  };
}

async function sendMessage(chatId, text, extra = {}) {
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra
    });
  } catch (error) {
    console.error(`sendMessage error (${chatId}):`, error.message);
  }
}

async function sendWelcomePhoto(chatId) {
  const caption =
    `💎 <b>AquaBahis Web Sitesi Kontrol Botuna Hoşgeldiniz</b>\n\n` +
    `Bu bot site durumunu, kesintileri ve erişim sorunlarını takip eder.\n\n` +
    `📡 <b>Özellikler</b>\n` +
    `• ${CHECK_INTERVAL_MS / 1000} saniyede bir otomatik kontrol\n` +
    `• Özel tasarımlı down bildirimi\n` +
    `• Uptime yüzdesi\n` +
    `• Ülke bazlı erişim özeti\n` +
    `• Admin paneli / site ekleme / silme\n\n` +
    `👇 Aşağıdaki menüden işlemleri kullanabilirsiniz.`;

  try {
    await bot.sendPhoto(chatId, WELCOME_LOGO_URL, {
      caption,
      parse_mode: 'HTML',
      reply_markup: mainMenu(isAdmin(chatId)).reply_markup
    });
  } catch (error) {
    await sendMessage(
      chatId,
      `💎 <b>AquaBahis Web Sitesi Kontrol Botuna Hoşgeldiniz</b>`,
      mainMenu(isAdmin(chatId))
    );
  }
}

async function fetchWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'aquabahis-monitor-bot/2.0'
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function ensureUptimeSite(site) {
  if (!db.uptime[site]) {
    db.uptime[site] = {
      totalChecks: 0,
      successChecks: 0,
      failureChecks: 0
    };
  }
  return db.uptime[site];
}

function getUptimePercent(site) {
  const row = ensureUptimeSite(site);
  if (!row.totalChecks) return '0.00';
  return ((row.successChecks / row.totalChecks) * 100).toFixed(2);
}

function updateUptime(site, isUp) {
  const row = ensureUptimeSite(site);
  row.totalChecks += 1;

  if (isUp) row.successChecks += 1;
  else row.failureChecks += 1;

  saveDb();
}

function buildStatusCard(site, result) {
  const checkedAt = formatDate(result.lastCheckedAt);
  const uptime = getUptimePercent(site);

  if (result.isUp) {
    return (
      `✅ <b>AquaBahis Site Kontrol Bildirimi</b>\n` +
      `Kontrol Sonucu: ${escapeHtml(String(result.statusCode))} Aktif\n` +
      `Sunucu Durumu: Aktif\n` +
      `Erişim Durumu: Açık\n` +
      `Uptime: %${escapeHtml(uptime)}\n` +
      `Siteye Gitmek İçin: <a href="${escapeHtml(site)}">Tıkla</a>\n` +
      `Kontrol Zamanı: ${escapeHtml(checkedAt)}`
    );
  }

  const countryText = formatCountryResults(result.countryResults);

  return (
    `🚨 <b>AquaBahis Kritik Erişim Uyarısı</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `Kontrol Sonucu: ${escapeHtml(result.detail)}\n` +
    `Sunucu Durumu: Sorunlu\n` +
    `Erişim Durumu: Engelli veya Ulaşılamıyor\n` +
    `Uptime: %${escapeHtml(uptime)}\n` +
    `${countryText ? `Bölgesel Kontrol: ${escapeHtml(countryText)}\n` : ''}` +
    `Siteye Gitmek İçin: <a href="${escapeHtml(site)}">Tıkla</a>\n` +
    `Kontrol Zamanı: ${escapeHtml(checkedAt)}\n` +
    `━━━━━━━━━━━━━━\n` +
    `Herhangi bir erişim engeli veya kesinti tespit edilmiştir.`
  );
}

function formatCountryResults(countryResults) {
  if (!countryResults) return '';

  const entries = Object.entries(countryResults);
  if (!entries.length) return '';

  return entries
    .map(([country, ok]) => `${country}:${ok ? 'Açık' : 'Kapalı'}`)
    .join(', ');
}

function stateChanged(prev, next) {
  if (!prev) return true;
  if (prev.isUp !== next.isUp) return true;
  if (prev.statusCode !== next.statusCode) return true;
  if (prev.detail !== next.detail) return true;

  const prevCountries = JSON.stringify(prev.countryResults || {});
  const nextCountries = JSON.stringify(next.countryResults || {});
  if (prevCountries !== nextCountries) return true;

  return false;
}

/**
 * Basit ülke bazlı kontrol
 * Gerçek geo-proxy olmadan ülkeye özel tam doğrulama yapılamaz.
 * Bu yüzden burada özet alanı var:
 * - allowedCountries listelenir
 * - ana kontrol down ise hepsi kapalı sayılır
 * - ana kontrol up ise hepsi açık varsayılır
 */
function buildCountryResults(isUp) {
  const results = {};
  const countries = db.allowedCountries || [];

  for (const country of countries) {
    results[country] = Boolean(isUp);
  }

  return results;
}

async function checkSite(site) {
  try {
    const response = await fetchWithTimeout(site);
    const ok = response.ok;
    const status = response.status;
    const countryResults = buildCountryResults(ok);

    if (ok) {
      updateUptime(site, true);
      return {
        site,
        isUp: true,
        statusCode: status,
        detail: `${status} Aktif`,
        lastCheckedAt: new Date(),
        countryResults
      };
    }

    updateUptime(site, false);
    return {
      site,
      isUp: false,
      statusCode: status,
      detail: `${status} Hatası`,
      lastCheckedAt: new Date(),
      countryResults
    };
  } catch (error) {
    const detail = error.name === 'AbortError'
      ? `Timeout (${REQUEST_TIMEOUT_MS}ms)`
      : (error.message || 'Bağlantı Hatası');

    updateUptime(site, false);

    return {
      site,
      isUp: false,
      statusCode: null,
      detail,
      lastCheckedAt: new Date(),
      countryResults: buildCountryResults(false)
    };
  }
}

async function sendSiteResult(chatId, site, result) {
  const text = buildStatusCard(site, result);
  await sendMessage(chatId, text, inlineSiteButtons(site));
}

async function checkAllForChat(chatId, options = {}) {
  const session = ensureSession(chatId);
  const sites = getSites();
  const notifyAlways = Boolean(options.notifyAlways);

  if (!sites.length) {
    await sendMessage(chatId, '⚠️ Kontrol edilecek site bulunamadı.');
    return [];
  }

  const results = [];

  for (const site of sites) {
    const result = await checkSite(site);
    const prev = session.knownStates[site];
    const changed = stateChanged(prev, result);

    session.knownStates[site] = result;
    results.push(result);

    console.log(
      `[${formatDate(result.lastCheckedAt)}] chat=${chatId} site=${site} status=${result.isUp ? 'UP' : 'DOWN'} detail=${result.detail}`
    );

    if (!session.muted && (notifyAlways || changed)) {
      await sendSiteResult(chatId, site, result);
    }
  }

  return results;
}

async function sendSummary(chatId) {
  const session = ensureSession(chatId);
  const sites = getSites();

  if (!sites.length) {
    await sendMessage(chatId, '⚠️ Henüz izlenecek site yok.');
    return;
  }

  let active = 0;
  let down = 0;
  const lines = [];

  for (const site of sites) {
    const state = session.knownStates[site];
    const uptime = getUptimePercent(site);

    if (!state) {
      lines.push(`• ${site} → Henüz kontrol edilmedi | Uptime: %${uptime}`);
      continue;
    }

    if (state.isUp) {
      active += 1;
      lines.push(`• ${site} → ✅ Aktif (${state.statusCode}) | Uptime: %${uptime}`);
    } else {
      down += 1;
      lines.push(`• ${site} → 🚨 Sorunlu (${state.detail}) | Uptime: %${uptime}`);
    }
  }

  const text =
    `<b>AquaBahis Genel Durum Raporu</b>\n` +
    `Toplam Site: ${sites.length}\n` +
    `Aktif: ${active}\n` +
    `Sorunlu: ${down}\n` +
    `İzleme: ${session.monitoring ? 'Açık' : 'Kapalı'}\n` +
    `Bildirim: ${session.muted ? 'Susturulmuş' : 'Aktif'}\n` +
    `İzinli Ülkeler: ${(db.allowedCountries || []).join(', ') || '-'}\n\n` +
    lines.map(escapeHtml).join('\n');

  await sendMessage(chatId, text, mainMenu(isAdmin(chatId)));
}

async function sendAdminPanel(chatId) {
  if (!isAdmin(chatId)) {
    await sendMessage(chatId, '⛔ Admin yetkisi yok.');
    return;
  }

  const text =
    `👑 <b>Admin Panel</b>\n\n` +
    `Kullanım:\n` +
    `/addsite https://site.com\n` +
    `/removesite https://site.com\n` +
    `/sites\n` +
    `/admins\n` +
    `/addadmin 123456789\n` +
    `/countries\n` +
    `/addcountry TR\n` +
    `/removecountry TR`;

  await sendMessage(chatId, text, {
    reply_markup: {
      keyboard: [
        ['▶️ BAŞLAT', '⏹️ DURDUR'],
        ['📊 DURUM', '🔎 KONTROL ET'],
        ['🌐 TÜM SİTELER', '🔕 SUSTUR'],
        ['🔔 AKTİF ET', '❓ YARDIM'],
        ['📁 SİTELER', '🌍 ÜLKELER']
      ],
      resize_keyboard: true
    }
  });
}

async function startMonitoring(chatId) {
  const session = ensureSession(chatId);

  if (session.monitoring) {
    await sendMessage(chatId, '✅ İzleme zaten aktif.', mainMenu(isAdmin(chatId)));
    return;
  }

  session.monitoring = true;

  await sendMessage(
    chatId,
    `✅ <b>AquaBahis Kontrol Sistemi Başlatıldı</b>\n` +
      `Kontrol Aralığı: ${CHECK_INTERVAL_MS / 1000} saniye\n` +
      `İzlenen Site Sayısı: ${getSites().length}`,
    mainMenu(isAdmin(chatId))
  );

  await checkAllForChat(chatId, { notifyAlways: true });

  session.interval = setInterval(async () => {
    try {
      if (!session.monitoring) return;
      await checkAllForChat(chatId, { notifyAlways: false });
    } catch (error) {
      console.error(`interval error (${chatId}):`, error.message);
    }
  }, CHECK_INTERVAL_MS);
}

async function stopMonitoring(chatId) {
  const session = ensureSession(chatId);

  if (!session.monitoring) {
    await sendMessage(chatId, '⚠️ İzleme zaten kapalı.', mainMenu(isAdmin(chatId)));
    return;
  }

  session.monitoring = false;

  if (session.interval) {
    clearInterval(session.interval);
    session.interval = null;
  }

  await sendMessage(chatId, '⏹️ İzleme durduruldu.', mainMenu(isAdmin(chatId)));
}

async function muteNotifications(chatId) {
  const session = ensureSession(chatId);
  session.muted = true;
  await sendMessage(chatId, '🔕 Bildirimler susturuldu.', mainMenu(isAdmin(chatId)));
}

async function unmuteNotifications(chatId) {
  const session = ensureSession(chatId);
  session.muted = false;
  await sendMessage(chatId, '🔔 Bildirimler tekrar aktif.', mainMenu(isAdmin(chatId)));
}

async function help(chatId) {
  const text =
    `<b>AquaBahis Bot Komutları</b>\n` +
    `/start - botu başlatır ve menüyü açar\n` +
    `/stop - izlemeyi durdurur\n` +
    `/check - tüm siteleri hemen kontrol eder\n` +
    `/status - genel durumu gösterir\n` +
    `/mute - bildirimleri susturur\n` +
    `/unmute - bildirimleri tekrar açar\n` +
    `/sites - izlenen siteleri listeler\n\n` +
    `<b>Admin Komutları</b>\n` +
    `/addsite URL\n` +
    `/removesite URL\n` +
    `/admins\n` +
    `/addadmin CHAT_ID\n` +
    `/countries\n` +
    `/addcountry TR\n` +
    `/removecountry TR`;

  await sendMessage(chatId, text, mainMenu(isAdmin(chatId)));
}

async function listSites(chatId) {
  const sites = getSites();

  if (!sites.length) {
    await sendMessage(chatId, '⚠️ İzlenen site yok.');
    return;
  }

  const text =
    `<b>İzlenen Siteler</b>\n\n` +
    sites.map((site, index) => `${index + 1}. ${escapeHtml(site)} | Uptime: %${getUptimePercent(site)}`).join('\n');

  await sendMessage(chatId, text, mainMenu(isAdmin(chatId)));
}

async function addSite(chatId, rawSite) {
  if (!isAdmin(chatId)) {
    await sendMessage(chatId, '⛔ Bu komut sadece admin içindir.');
    return;
  }

  const site = normalizeSite(rawSite);
  if (!site) {
    await sendMessage(chatId, '⚠️ Kullanım: /addsite https://site.com');
    return;
  }

  if (db.sites.includes(site)) {
    await sendMessage(chatId, 'ℹ️ Bu site zaten listede.');
    return;
  }

  db.sites.push(site);
  saveDb();
  await sendMessage(chatId, `✅ Site eklendi:\n${escapeHtml(site)}`, mainMenu(true));
}

async function removeSite(chatId, rawSite) {
  if (!isAdmin(chatId)) {
    await sendMessage(chatId, '⛔ Bu komut sadece admin içindir.');
    return;
  }

  const site = normalizeSite(rawSite);
  const before = db.sites.length;
  db.sites = db.sites.filter(s => s !== site);
  saveDb();

  if (db.sites.length === before) {
    await sendMessage(chatId, 'ℹ️ Site listede bulunamadı.');
    return;
  }

  delete db.uptime[site];
  saveDb();

  await sendMessage(chatId, `🗑️ Site silindi:\n${escapeHtml(site)}`, mainMenu(true));
}

async function listAdmins(chatId) {
  if (!isAdmin(chatId)) {
    await sendMessage(chatId, '⛔ Bu komut sadece admin içindir.');
    return;
  }

  const text =
    `<b>Adminler</b>\n\n` +
    db.admins.map((id, index) => `${index + 1}. ${escapeHtml(id)}`).join('\n');

  await sendMessage(chatId, text, mainMenu(true));
}

async function addAdminCommand(chatId, newAdminId) {
  if (!isAdmin(chatId)) {
    await sendMessage(chatId, '⛔ Bu komut sadece admin içindir.');
    return;
  }

  if (!newAdminId) {
    await sendMessage(chatId, '⚠️ Kullanım: /addadmin 123456789');
    return;
  }

  addAdmin(newAdminId);
  await sendMessage(chatId, `✅ Admin eklendi: ${escapeHtml(newAdminId)}`, mainMenu(true));
}

async function listCountries(chatId) {
  const text =
    `<b>İzinli Ülkeler</b>\n\n` +
    ((db.allowedCountries || []).length
      ? db.allowedCountries.map((c, i) => `${i + 1}. ${escapeHtml(c)}`).join('\n')
      : 'Tanımlı ülke yok.');

  await sendMessage(chatId, text, mainMenu(isAdmin(chatId)));
}

async function addCountry(chatId, country) {
  if (!isAdmin(chatId)) {
    await sendMessage(chatId, '⛔ Bu komut sadece admin içindir.');
    return;
  }

  const code = String(country || '').trim().toUpperCase();
  if (!code) {
    await sendMessage(chatId, '⚠️ Kullanım: /addcountry TR');
    return;
  }

  if (!db.allowedCountries.includes(code)) {
    db.allowedCountries.push(code);
    saveDb();
  }

  await sendMessage(chatId, `✅ Ülke eklendi: ${escapeHtml(code)}`, mainMenu(true));
}

async function removeCountry(chatId, country) {
  if (!isAdmin(chatId)) {
    await sendMessage(chatId, '⛔ Bu komut sadece admin içindir.');
    return;
  }

  const code = String(country || '').trim().toUpperCase();
  db.allowedCountries = db.allowedCountries.filter(c => c !== code);
  saveDb();

  await sendMessage(chatId, `🗑️ Ülke silindi: ${escapeHtml(code)}`, mainMenu(true));
}

bot.onText(/\/start/, async (msg) => {
  if (!isAllowedChat(msg)) return;

  const chatId = msg.chat.id;
  ensureSession(chatId);

  if (db.admins.length === 0 && isPrivateChat(msg)) {
    addAdmin(chatId);
  }

  if (isPrivateChat(msg)) {
    await sendWelcomePhoto(chatId);
  } else {
    await sendMessage(
      chatId,
      `✅ <b>AquaBahis Bot Aktif</b>\nBu grup için izleme başlatılıyor.`,
      mainMenu(isAdmin(chatId))
    );
  }

  await startMonitoring(chatId);
});

bot.onText(/\/stop/, async (msg) => {
  if (!isAllowedChat(msg)) return;
  await stopMonitoring(msg.chat.id);
});

bot.onText(/\/help/, async (msg) => {
  if (!isAllowedChat(msg)) return;
  await help(msg.chat.id);
});

bot.onText(/\/check/, async (msg) => {
  if (!isAllowedChat(msg)) return;
  await sendMessage(msg.chat.id, '🔎 Manuel kontrol başlatıldı...', mainMenu(isAdmin(msg.chat.id)));
  await checkAllForChat(msg.chat.id, { notifyAlways: true });
});

bot.onText(/\/status/, async (msg) => {
  if (!isAllowedChat(msg)) return;
  await sendSummary(msg.chat.id);
});

bot.onText(/\/mute/, async (msg) => {
  if (!isAllowedChat(msg)) return;
  await muteNotifications(msg.chat.id);
});

bot.onText(/\/unmute/, async (msg) => {
  if (!isAllowedChat(msg)) return;
  await unmuteNotifications(msg.chat.id);
});

bot.onText(/\/sites/, async (msg) => {
  if (!isAllowedChat(msg)) return;
  await listSites(msg.chat.id);
});

bot.onText(/\/admins/, async (msg) => {
  if (!isAllowedChat(msg)) return;
  await listAdmins(msg.chat.id);
});

bot.onText(/\/addadmin(?:\s+(.+))?/, async (msg, match) => {
  if (!isAllowedChat(msg)) return;
  await addAdminCommand(msg.chat.id, match && match[1]);
});

bot.onText(/\/addsite(?:\s+(.+))?/, async (msg, match) => {
  if (!isAllowedChat(msg)) return;
  await addSite(msg.chat.id, match && match[1]);
});

bot.onText(/\/removesite(?:\s+(.+))?/, async (msg, match) => {
  if (!isAllowedChat(msg)) return;
  await removeSite(msg.chat.id, match && match[1]);
});

bot.onText(/\/countries/, async (msg) => {
  if (!isAllowedChat(msg)) return;
  await listCountries(msg.chat.id);
});

bot.onText(/\/addcountry(?:\s+(.+))?/, async (msg, match) => {
  if (!isAllowedChat(msg)) return;
  await addCountry(msg.chat.id, match && match[1]);
});

bot.onText(/\/removecountry(?:\s+(.+))?/, async (msg, match) => {
  if (!isAllowedChat(msg)) return;
  await removeCountry(msg.chat.id, match && match[1]);
});

bot.on('message', async (msg) => {
  if (!isAllowedChat(msg)) return;
  if (!msg.text) return;

  const text = msg.text.trim();
  const chatId = msg.chat.id;

  if (
    text.startsWith('/start') ||
    text.startsWith('/stop') ||
    text.startsWith('/help') ||
    text.startsWith('/check') ||
    text.startsWith('/status') ||
    text.startsWith('/mute') ||
    text.startsWith('/unmute') ||
    text.startsWith('/sites') ||
    text.startsWith('/admins') ||
    text.startsWith('/addadmin') ||
    text.startsWith('/addsite') ||
    text.startsWith('/removesite') ||
    text.startsWith('/countries') ||
    text.startsWith('/addcountry') ||
    text.startsWith('/removecountry')
  ) {
    return;
  }

  if (text === '▶️ BAŞLAT') return startMonitoring(chatId);
  if (text === '⏹️ DURDUR') return stopMonitoring(chatId);
  if (text === '📊 DURUM') return sendSummary(chatId);
  if (text === '🔕 SUSTUR') return muteNotifications(chatId);
  if (text === '🔔 AKTİF ET') return unmuteNotifications(chatId);
  if (text === '❓ YARDIM') return help(chatId);
  if (text === '👑 ADMIN PANEL') return sendAdminPanel(chatId);
  if (text === '📁 SİTELER') return listSites(chatId);
  if (text === '🌍 ÜLKELER') return listCountries(chatId);

  if (text === '🔎 KONTROL ET') {
    const firstSite = getSites()[0];
    if (!firstSite) return sendMessage(chatId, '⚠️ Site bulunamadı.', mainMenu(isAdmin(chatId)));
    const result = await checkSite(firstSite);
    ensureSession(chatId).knownStates[firstSite] = result;
    return sendSiteResult(chatId, firstSite, result);
  }

  if (text === '🌐 TÜM SİTELER') {
    await sendMessage(chatId, '🔎 Tüm siteler manuel olarak kontrol ediliyor...', mainMenu(isAdmin(chatId)));
    return checkAllForChat(chatId, { notifyAlways: true });
  }
});

bot.on('callback_query', async (query) => {
  const message = query.message;
  if (!message || !['private', 'group', 'supergroup'].includes(message.chat.type)) return;

  const chatId = message.chat.id;
  const data = query.data || '';
  const session = ensureSession(chatId);

  try {
    if (data.startsWith('check:')) {
      const site = data.slice('check:'.length);
      const result = await checkSite(site);
      session.knownStates[site] = result;

      await bot.answerCallbackQuery(query.id, { text: 'Yeniden kontrol edildi.' });
      await sendSiteResult(chatId, site, result);
      return;
    }

    if (data.startsWith('status:')) {
      const site = data.slice('status:'.length);
      const state = session.knownStates[site];

      if (!state) {
        await bot.answerCallbackQuery(query.id, { text: 'Henüz kayıtlı durum yok.' });
        await sendMessage(chatId, `ℹ️ ${escapeHtml(site)} için henüz kayıtlı durum yok.`);
        return;
      }

      const text =
        `ℹ️ <b>Site Son Durum</b>\n` +
        `Site: <a href="${escapeHtml(site)}">${escapeHtml(site)}</a>\n` +
        `Sunucu Durumu: ${state.isUp ? 'Aktif' : 'Sorunlu'}\n` +
        `Detay: ${escapeHtml(state.isUp ? String(state.statusCode) : state.detail)}\n` +
        `Uptime: %${escapeHtml(getUptimePercent(site))}\n` +
        `Bölgesel Kontrol: ${escapeHtml(formatCountryResults(state.countryResults) || '-')}\n` +
        `Son Kontrol: ${escapeHtml(formatDate(state.lastCheckedAt))}`;

      await bot.answerCallbackQuery(query.id, { text: 'Son durum gösterildi.' });
      await sendMessage(chatId, text, inlineSiteButtons(site));
      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error('callback_query error:', error.message);
    try {
      await bot.answerCallbackQuery(query.id, { text: 'Bir hata oluştu.' });
    } catch (_) {}
  }
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

console.log('AquaBahis bot çalışıyor...');
console.log(`Kontrol aralığı: ${CHECK_INTERVAL_MS} ms`);
console.log(`İzlenen siteler: ${getSites().join(', ') || 'YOK'}`);
