'use strict';

// SHEEZZI BOT — Production Build

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const yts        = require('yt-search');
const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');

// ── CONFIG ───────────────────────────────────

const CONFIG = {
  phoneNumber  : process.env.PHONE_NUMBER || '',
  clientId     : process.env.CLIENT_ID    || 'sheezzi-bot',
  ytDlpPath    : process.env.YTDLP_PATH   || '/usr/local/bin/yt-dlp',
  ffmpegPath   : process.env.FFMPEG_PATH  || '/usr/bin/ffmpeg',
  tmpDir       : process.env.TMP_DIR      || '/tmp/sheezzi',
  progressStep : 25,
};

// ── VALIDATE CONFIG ──────────────────────────

if (!CONFIG.phoneNumber) {
  console.error('[FATAL] PHONE_NUMBER env variable is not set. Exiting.');
  process.exit(1);
}

// ── LOGGER ───────────────────────────────────

const ts  = () => new Date().toISOString();
const log = {
  info  : (...a) => console.log (`[INFO]  ${ts()}`, ...a),
  warn  : (...a) => console.warn (`[WARN]  ${ts()}`, ...a),
  error : (...a) => console.error(`[ERROR] ${ts()}`, ...a),
  ok    : (...a) => console.log (`[OK]    ${ts()}`, ...a),
};

// ── GRACEFUL SHUTDOWN ────────────────────────

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.warn(`Received ${signal}. Shutting down gracefully...`);
  try {
    await client.destroy();
    log.ok('Client destroyed cleanly.');
  } catch (e) {
    log.error('Error during shutdown:', e.message);
  }
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err.message, err.stack);
  // Don't crash on non-fatal errors
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});

// ── HELPERS ──────────────────────────────────

function progressBar(pct) {
  const filled = Math.min(10, Math.floor(pct / 10));
  return '[' + '='.repeat(filled) + ' '.repeat(10 - filled) + `] ${pct}%`;
}

function ensureTmpDir() {
  if (!fs.existsSync(CONFIG.tmpDir))
    fs.mkdirSync(CONFIG.tmpDir, { recursive: true });
}

function safeUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

// Cleanup stale tmp files older than 30 minutes on startup
function cleanTmpDir() {
  if (!fs.existsSync(CONFIG.tmpDir)) return;
  const now = Date.now();
  const files = fs.readdirSync(CONFIG.tmpDir);
  for (const f of files) {
    const fp = path.join(CONFIG.tmpDir, f);
    try {
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > 30 * 60 * 1000) {
        fs.unlinkSync(fp);
        log.info(`Cleaned stale tmp file: ${f}`);
      }
    } catch { /* ignore */ }
  }
}

// ── CHROMIUM AUTO-DETECT ─────────────────────

function findChromium() {
  // If explicitly set in env, use it (but verify it exists first)
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    log.info(`Using chromium from env: ${envPath}`);
    return envPath;
  }

  // Common paths on Railway / Nixpacks / Debian / Alpine
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/chromium',
    '/usr/local/bin/chromium-browser',
    '/snap/bin/chromium',
    '/nix/var/nix/profiles/default/bin/chromium',
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      log.info(`Found chromium at: ${p}`);
      return p;
    }
  }

  // Let puppeteer use its own bundled browser as last resort
  log.warn('No system chromium found — letting puppeteer use its bundled browser.');
  return undefined;
}

// ── CLIENT ───────────────────────────────────

const client = new Client({
  authStrategy : new LocalAuth({
    clientId  : CONFIG.clientId,
    dataPath  : process.env.SESSION_PATH || '/data/wwebjs_auth',
  }),
  puppeteer : {
    headless       : true,
    executablePath : findChromium(),
    args           : [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
    ],
  },
});

client.on('qr',            (qr)    => {
  log.info('QR code received. If first run, scan with WhatsApp.');
  // Print QR to terminal — Railway logs will show it
  try {
    const qrcode = require('qrcode-terminal');
    qrcode.generate(qr, { small: true });
  } catch {
    log.warn('qrcode-terminal not installed. QR (raw):', qr);
  }
});
client.on('ready',         ()      => log.ok('✅ Client ready.'));
client.on('authenticated', ()      => log.ok('✅ Session saved.'));
client.on('auth_failure',  msg     => log.error('Auth failed:', msg));
client.on('disconnected',  async (reason) => {
  log.warn('Disconnected:', reason);
  if (!isShuttingDown) {
    log.info('Attempting to reinitialize in 10 seconds...');
    setTimeout(() => client.initialize().catch(e => log.error('Reinit failed:', e.message)), 10_000);
  }
});

// ── DOWNLOAD ─────────────────────────────────

// Simple in-memory rate limit: max 3 concurrent downloads globally
let activeDownloads = 0;
const MAX_CONCURRENT = 3;

async function handleDownload(message, type, query) {
  const chat = await message.getChat();

  if (activeDownloads >= MAX_CONCURRENT) {
    return message.reply('Bot is busy. Please try again in a moment. 🙏');
  }

  activeDownloads++;
  log.info(`Active downloads: ${activeDownloads}`);

  try {
    await chat.sendMessage(`🔍 Searching for "${query}"...`);

    const results = await yts(query);
    if (!results.videos.length)
      return message.reply('❌ No results found for that query.');

    const video = results.videos[0];

    // Block very long videos (>15 min) to avoid abuse / storage issues
    if (video.seconds > 900) {
      return message.reply('❌ Video is too long (max 15 minutes). Try a shorter one.');
    }

    log.info(`Found: "${video.title}" — ${video.url}`);

    await chat.sendMessage(
      `✅ Found: *${video.title}*\n\n` +
      `⏱ Duration: ${video.timestamp}\n\n` +
      `⬇️ Downloading your ${type}...\n` +
      `_Please wait up to 45 seconds_`
    );

    ensureTmpDir();
    const ext      = type === 'audio' ? 'mp3' : 'mp4';
    const fileName = path.join(CONFIG.tmpDir, `${type}_${Date.now()}.${ext}`);

    const args = type === 'audio'
      ? [
          '--ffmpeg-location', CONFIG.ffmpegPath,
          '-x', '--audio-format', 'mp3',
          '--audio-quality', '128K',
          '--no-playlist',
          '-o', fileName,
          video.url,
        ]
      : [
          '--ffmpeg-location', CONFIG.ffmpegPath,
          '-f', 'bestvideo[ext=mp4][height<=480]+bestaudio[ext=m4a]/best[ext=mp4][height<=480]/best',
          '--merge-output-format', 'mp4',
          '--no-playlist',
          '-o', fileName,
          video.url,
        ];

    await new Promise((resolve, reject) => {
      const proc = spawn(CONFIG.ytDlpPath, args);
      let lastReported = 0;
      let stderr = '';

      proc.stdout.on('data', (chunk) => {
        const text  = chunk.toString();
        const match = text.match(/(\d{1,3}\.\d)%/);
        if (!match) return;
        const pct = parseFloat(match[1]);
        if (pct < lastReported + CONFIG.progressStep) return;
        lastReported = pct;
        chat.sendMessage(progressBar(pct)).catch(() => {});
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        const match = chunk.toString().match(/(\d{1,3}\.\d)%/);
        if (!match) return;
        const pct = parseFloat(match[1]);
        if (pct < lastReported + CONFIG.progressStep) return;
        lastReported = pct;
        chat.sendMessage(progressBar(pct)).catch(() => {});
      });

      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          log.error('yt-dlp exit code', code, '\nstderr:', stderr.slice(-500));
          return reject(new Error(`yt-dlp exited with code ${code}`));
        }
        resolve();
      });

      // Kill if takes more than 3 minutes
      setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('Download timed out after 3 minutes.'));
      }, 3 * 60 * 1000);
    });

    if (!fs.existsSync(fileName))
      throw new Error('Output file missing after download.');

    // Check file size (WhatsApp limit ~64 MB)
    const { size } = fs.statSync(fileName);
    if (size > 64 * 1024 * 1024) {
      safeUnlink(fileName);
      return message.reply('❌ File too large to send via WhatsApp (>64 MB). Try a shorter video.');
    }

    await chat.sendMessage('✅ Download Complete! Sending now...');

    const media = MessageMedia.fromFilePath(fileName);
    await client.sendMessage(message.from, media, { sendAudioAsVoice: false });
    safeUnlink(fileName);

    log.ok(`Delivered ${type} — "${video.title}" to ${message.from}`);

  } catch (err) {
    log.error('Download failed:', err.message);
    message.reply('❌ Something went wrong. Please try again later.');
  } finally {
    activeDownloads--;
  }
}

// ── COMMANDS ─────────────────────────────────

const MENU = [
  '*『 Sheezzi Song Bot 』*',
  '',
  '*Commands:*',
  '➜ `Download <song name> audio`',
  '➜ `Download <song name> video`',
  '',
  '*Examples:*',
  '➜ `Download maiqada audio`',
  '➜ `Download fitoor video`',
  '',
  '*Limits:*',
  '• Max 15 min duration',
  '• Max 64 MB file size',
  '',
  '*Features:*',
  '• Fast Download',
  '• HD Quality (≤480p)',
  '• Smart Search',
  '',
  '*Developed by Sheezzi* 🚀',
].join('\n');

const COMMANDS = {
  help  : (msg)        => msg.reply(MENU),
  audio : (msg, query) => query
    ? handleDownload(msg, 'audio', query)
    : msg.reply('Please provide a song name.\nExample: Download pasoori audio'),
  video : (msg, query) => query
    ? handleDownload(msg, 'video', query)
    : msg.reply('Please provide a video name.\nExample: Download pasoori video'),
};

// ── MESSAGE HANDLER ──────────────────────────

client.on('message', async (message) => {
  if (isShuttingDown) return;

  const body = message.body.trim().toLowerCase();
  log.info(`Message from ${message.from}: "${body}"`);

  if (['song', 'help', 'menu', 'start'].includes(body))
    return COMMANDS.help(message);

  if (body.startsWith('download')) {
    const rest = body.replace(/^download\s*/, '').trim();

    if (rest.endsWith('audio')) {
      const query = rest.replace(/audio$/, '').trim();
      return COMMANDS.audio(message, query);
    }

    if (rest.endsWith('video')) {
      const query = rest.replace(/video$/, '').trim();
      return COMMANDS.video(message, query);
    }

    return message.reply(
      '⚠️ Please specify *audio* or *video*.\n' +
      'Example: Download pasoori audio'
    );
  }
});

// ── STARTUP ──────────────────────────────────

async function startBot() {
  log.info('Starting Sheezzi Bot (production)...');
  cleanTmpDir();
  ensureTmpDir();
  await client.initialize();

  const state = await client.getState().catch(() => null);
  if (!state || state === 'UNPAIRED') {
    const code = await client.requestPairingCode(CONFIG.phoneNumber).catch(() => null);
    if (code) {
      log.info('No active session found.');
      console.log('\n=============================');
      console.log('  PAIRING CODE:', code);
      console.log('=============================\n');
    }
  }
}

startBot().catch((err) => {
  log.error('Fatal startup error:', err.message);
  process.exit(1);
});
