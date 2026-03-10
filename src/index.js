const fetch = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '15000', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10);

if (!TELEGRAM_TOKEN) {
  throw new Error('TELEGRAM_TOKEN eksik. .env dosyasını kontrol et.');
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

/**
 * Chat bazlı oturum yapısı:
 * sessions[chatId] = {
 *   monitoring: boolean,
 *   muted: boolean,
 *   interval: Timeout | null,
 *   knownStates: {
 *     [site]: {
 *       isUp: boolean,
 *       statusCode: number | null,
 *       detail: string,
 *       lastCheckedAt: Date
 *     }
 *   }
 * }
 */
const sessions = Object.create(null);

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
  return (process.env.SITES_TO_CHECK || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(normalizeSite);
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

function isPrivateChat(msg) {
  return msg && msg.chat && msg.chat.type === 'private';
}

function formatDate(date) {
  return new Date(date).toLocaleString('tr-TR');
}

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ['▶️ BAŞLAT', '⏹️ DURDUR'],
        ['📊 DURUM', '🔎 KONTROL ET'],
        ['🌐 TÜM SİTELER', '🔕 SUSTUR'],
        ['🔔 AKTİF ET', '❓ YARDIM']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

function inlineSiteButtons(site) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🌐 Siteye Git', url: site }
        ],
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

async function fetchWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'advanced-site-monitor-bot/1.0'
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildStatusCard(site, result) {
  const checkedAt = formatDate(result.lastCheckedAt);

  if (result.isUp) {
    return (
      `✅ <b>Site Kontrol Bildirimi</b>\n` +
      `Kontrol Sonucu: ${escapeHtml(String(result.statusCode))}\n` +
      `Sunucu Durumu: Aktif\n` +
      `Erişim Durumu: Açık\n` +
      `Siteye Gitmek İçin: <a href="${escapeHtml(site)}">Tıkla</a>\n` +
      `Kontrol Zamanı: ${escapeHtml(checkedAt)}`
    );
  }

  return (
    `🚨 <b>Site Kontrol Bildirimi</b>\n` +
    `Kontrol Sonucu: ${escapeHtml(result.detail)}\n` +
    `Sunucu Durumu: Sorunlu\n` +
    `Erişim Durumu: Engelli veya Ulaşılamıyor\n` +
    `Siteye Gitmek İçin: <a href="${escapeHtml(site)}">Tıkla</a>\n` +
    `Kontrol Zamanı: ${escapeHtml(checkedAt)}\n` +
    `Herhangi bir erişim engeli veya kesinti tespit edilmiştir.`
  );
}

function stateChanged(prev, next) {
  if (!prev) return true;
  if (prev.isUp !== next.isUp) return true;
  if (prev.statusCode !== next.statusCode) return true;
  if (prev.detail !== next.detail) return true;
  return false;
}

async function checkSite(site) {
  try {
    const response = await fetchWithTimeout(site);
    const ok = response.ok;
    const status = response.status;

    if (ok) {
      return {
        site,
        isUp: true,
        statusCode: status,
        detail: `${status} Aktif`,
        lastCheckedAt: new Date()
      };
    }

    return {
      site,
      isUp: false,
      statusCode: status,
      detail: `${status} Hatası`,
      lastCheckedAt: new Date()
    };
  } catch (error) {
    const detail = error.name === 'AbortError'
      ? `Timeout (${REQUEST_TIMEOUT_MS}ms)`
      : (error.message || 'Bağlantı Hatası');

    return {
      site,
      isUp: false,
      statusCode: null,
      detail,
      lastCheckedAt: new Date()
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
    await sendMessage(chatId, '⚠️ Kontrol edilecek site bulunamadı. .env içindeki SITES_TO_CHECK alanını doldur.');
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

    if (!state) {
      lines.push(`• ${site} → Henüz kontrol edilmedi`);
      continue;
    }

    if (state.isUp) {
      active += 1;
      lines.push(`• ${site} → ✅ Aktif (${state.statusCode})`);
    } else {
      down += 1;
      lines.push(`• ${site} → 🚨 Sorunlu (${state.detail})`);
    }
  }

  const text =
    `<b>Genel Durum Raporu</b>\n` +
    `Toplam Site: ${sites.length}\n` +
    `Aktif: ${active}\n` +
    `Sorunlu: ${down}\n` +
    `İzleme: ${session.monitoring ? 'Açık' : 'Kapalı'}\n` +
    `Bildirim: ${session.muted ? 'Susturulmuş' : 'Aktif'}\n\n` +
    lines.map(escapeHtml).join('\n');

  await sendMessage(chatId, text);
}

async function startMonitoring(chatId) {
  const session = ensureSession(chatId);

  if (session.monitoring) {
    await sendMessage(chatId, '✅ İzleme zaten aktif.', mainMenu());
    return;
  }

  session.monitoring = true;

  await sendMessage(
    chatId,
    `✅ <b>Site Kontrol Botu Başlatıldı</b>\n` +
      `Kontrol Aralığı: ${CHECK_INTERVAL_MS / 1000} saniye\n` +
      `İzlenen Site Sayısı: ${getSites().length}`,
    mainMenu()
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
    await sendMessage(chatId, '⚠️ İzleme zaten kapalı.', mainMenu());
    return;
  }

  session.monitoring = false;

  if (session.interval) {
    clearInterval(session.interval);
    session.interval = null;
  }

  await sendMessage(chatId, '⏹️ İzleme durduruldu.', mainMenu());
}

async function muteNotifications(chatId) {
  const session = ensureSession(chatId);
  session.muted = true;
  await sendMessage(chatId, '🔕 Bildirimler susturuldu.', mainMenu());
}

async function unmuteNotifications(chatId) {
  const session = ensureSession(chatId);
  session.muted = false;
  await sendMessage(chatId, '🔔 Bildirimler tekrar aktif.', mainMenu());
}

async function help(chatId) {
  const text =
    `<b>Kullanılabilir Komutlar</b>\n` +
    `/start - botu başlatır ve menüyü açar\n` +
    `/stop - izlemeyi durdurur\n` +
    `/check - tüm siteleri hemen kontrol eder\n` +
    `/status - genel durumu gösterir\n` +
    `/mute - bildirimleri susturur\n` +
    `/unmute - bildirimleri tekrar açar\n` +
    `/sites - izlenen siteleri listeler\n\n` +
    `<b>Butonlar</b>\n` +
    `▶️ BAŞLAT - otomatik izlemeyi açar\n` +
    `⏹️ DURDUR - otomatik izlemeyi kapatır\n` +
    `📊 DURUM - özet rapor gösterir\n` +
    `🔎 KONTROL ET - ilk siteyi manuel kontrol eder\n` +
    `🌐 TÜM SİTELER - hepsini manuel kontrol eder`;

  await sendMessage(chatId, text, mainMenu());
}

async function listSites(chatId) {
  const sites = getSites();

  if (!sites.length) {
    await sendMessage(chatId, '⚠️ İzlenen site yok.');
    return;
  }

  const text =
    `<b>İzlenen Siteler</b>\n\n` +
    sites.map((site, index) => `${index + 1}. ${escapeHtml(site)}`).join('\n');

  await sendMessage(chatId, text, mainMenu());
}

bot.onText(/\/start/, async (msg) => {
  if (!isPrivateChat(msg)) return;
  await startMonitoring(msg.chat.id);
});

bot.onText(/\/stop/, async (msg) => {
  if (!isPrivateChat(msg)) return;
  await stopMonitoring(msg.chat.id);
});

bot.onText(/\/help/, async (msg) => {
  if (!isPrivateChat(msg)) return;
  await help(msg.chat.id);
});

bot.onText(/\/check/, async (msg) => {
  if (!isPrivateChat(msg)) return;

  await sendMessage(msg.chat.id, '🔎 Manuel kontrol başlatıldı...', mainMenu());
  await checkAllForChat(msg.chat.id, { notifyAlways: true });
});

bot.onText(/\/status/, async (msg) => {
  if (!isPrivateChat(msg)) return;
  await sendSummary(msg.chat.id);
});

bot.onText(/\/mute/, async (msg) => {
  if (!isPrivateChat(msg)) return;
  await muteNotifications(msg.chat.id);
});

bot.onText(/\/unmute/, async (msg) => {
  if (!isPrivateChat(msg)) return;
  await unmuteNotifications(msg.chat.id);
});

bot.onText(/\/sites/, async (msg) => {
  if (!isPrivateChat(msg)) return;
  await listSites(msg.chat.id);
});

bot.on('message', async (msg) => {
  if (!isPrivateChat(msg)) return;
  if (!msg.text) return;

  const text = msg.text.trim();
  const chatId = msg.chat.id;

  if (
    text === '/start' ||
    text === '/stop' ||
    text === '/help' ||
    text === '/check' ||
    text === '/status' ||
    text === '/mute' ||
    text === '/unmute' ||
    text === '/sites'
  ) {
    return;
  }

  if (text === '▶️ BAŞLAT') {
    await startMonitoring(chatId);
    return;
  }

  if (text === '⏹️ DURDUR') {
    await stopMonitoring(chatId);
    return;
  }

  if (text === '📊 DURUM') {
    await sendSummary(chatId);
    return;
  }

  if (text === '🔎 KONTROL ET') {
    const firstSite = getSites()[0];

    if (!firstSite) {
      await sendMessage(chatId, '⚠️ İlk kontrol için site bulunamadı.', mainMenu());
      return;
    }

    const result = await checkSite(firstSite);
    ensureSession(chatId).knownStates[firstSite] = result;
    await sendSiteResult(chatId, firstSite, result);
    return;
  }

  if (text === '🌐 TÜM SİTELER') {
    await sendMessage(chatId, '🔎 Tüm siteler manuel olarak kontrol ediliyor...', mainMenu());
    await checkAllForChat(chatId, { notifyAlways: true });
    return;
  }

  if (text === '🔕 SUSTUR') {
    await muteNotifications(chatId);
    return;
  }

  if (text === '🔔 AKTİF ET') {
    await unmuteNotifications(chatId);
    return;
  }

  if (text === '❓ YARDIM') {
    await help(chatId);
  }
});

bot.on('callback_query', async (query) => {
  const message = query.message;
  if (!message || message.chat.type !== 'private') return;

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

console.log('Bot çalışıyor...');
console.log(`Kontrol aralığı: ${CHECK_INTERVAL_MS} ms`);
console.log(`İzlenen siteler: ${getSites().join(', ') || 'YOK'}`);