#!/usr/bin/env node
/**
 * scripts/sessionToEnv.js
 * ---------------------------------------------------------------------------
 * Bulut (Render vb.) dağıtımları için oturum dosyasını ortam değişkenine çevirir.
 * Dosya sistemi kalıcı olmadığından cookie'ler SESSION_STATE_B64 env'i ile verilir.
 *
 * Kullanım:
 *   npm run session:env                      # .env → SESSION_STATE_PATH dosyasını okur
 *   npm run session:env -- --out session.env # dosyaya yazar (kopyala-yapıştır için)
 *   node scripts/sessionToEnv.js --dosya data/sessions/arena.json
 *
 * Çıktı:  SESSION_STATE_B64=<base64>
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from '../src/config/index.js';
import { normalizeStorageState } from '../src/automation/sessionStore.js';

function arg(ad) {
  const i = process.argv.indexOf(ad);
  return i > -1 ? process.argv[i + 1] : null;
}

const kaynak = arg('--dosya') || config.session.statePath;
const cikti = arg('--out');

if (!fs.existsSync(kaynak)) {
  console.error(`\n❌ Oturum dosyası yok: ${kaynak}`);
  console.error('   Önce oturum kaydedin:  npm run session:save\n');
  process.exit(1);
}

const ham = fs.readFileSync(kaynak, 'utf8');
let durum;
try {
  durum = normalizeStorageState(ham, path.basename(kaynak)); // geçerlilik kontrolü
} catch (err) {
  console.error(`\n❌ Oturum dosyası geçersiz: ${err.message}\n`);
  process.exit(1);
}

const b64 = Buffer.from(ham, 'utf8').toString('base64');
const satir = `SESSION_STATE_B64=${b64}`;
const ozet = [
  `# arena-proxy — Render ortam değişkeni (oturum)`,
  `# Kaynak dosya : ${path.relative(ROOT_DIR, kaynak)}`,
  `# Cookie       : ${durum.cookies.length} adet`,
  `# localStorage : ${durum.origins.length} origin`,
  `# UYARI        : Bu değer oturumunuz kadar değerlidir — kimseyle paylaşmayın.`,
  `#                Env'i değiştirdikten sonra servisi yeniden dağıtın (Render → Manual Deploy).`,
].join('\n');

if (cikti) {
  fs.writeFileSync(cikti, `${ozet}\n${satir}\n`, { mode: 0o600 });
  console.log(`\n✅ Yazıldı: ${cikti}  (izin 600)`);
  console.log('   İçeriği Render → Environment → "Add from .env" ile yapıştırabilirsiniz.\n');
} else {
  console.log(ozet);
  console.log(`\n${satir}\n`);
  console.log('→ Render → arena-proxy servisi → Environment → SESSION_STATE_B64 değerine yapıştırın.\n');
}
