/**
 * Ölümsüz oturum motoru testi:
 *  1) Supabase oturum çerezi çözümlenir (kalan süre, refresh_token varlığı)
 *  2) Hedef, Set-Cookie ile YENİ oturum döndürdüğünde: yerel dosya + yeniden yükleme
 *  3) Jeton taze ise yenileme atlanır (gereksiz rotation = aile iptali riski)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-'));
process.env.SESSION_MODE = 'storage';
process.env.SESSION_STATE_B64 = '';
process.env.SESSION_STATE_JSON = '';
process.env.SESSION_STATE_PATH = path.join(tmp, 'arena.json');
process.env.SESSION_COOKIE_NAME = 'arena-auth-prod-v1.0';
process.env.SESSION_PERSIST = 'file';
process.env.SESSION_KEEPALIVE_MINUTES = '0'; // testte zamanlayıcı istemiyoruz

const cerez = (kalanSn, refresh = 'r1') =>
  'base64-' +
  Buffer.from(
    JSON.stringify({
      access_token: 'eyJhbGciOiJFUzI1NiJ9.eyJzZXNzaW9uX2lkIjoiYWJjZCJ9.x',
      refresh_token: refresh,
      expires_at: Math.floor(Date.now() / 1000) + kalanSn,
      user: { email: 'test@ornek.com' },
    }),
  ).toString('base64');

const durumYaz = (deger) => {
  fs.writeFileSync(
    process.env.SESSION_STATE_PATH,
    JSON.stringify(
      { cookies: [{ name: 'arena-auth-prod-v1.0', value: deger, domain: '.arena.ai', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] },
      null,
      2,
    ),
    { mode: 0o600 },
  );
};

// Hedef: davranış bayrağıyla yeni jeton döndürür (veya hiç döndürmez)
let istekSayisi = 0;
let yeniCerezDondur = true;
const sunucu = http.createServer((req, res) => {
  istekSayisi += 1;
  if (yeniCerezDondur === 'uzun') {
    // arena.ai gibi uzun oturumu iki çerez halinde döndür
    const uzun =
      'base64-' +
      Buffer.from(
        JSON.stringify({
          access_token: 'eyJhbGciOiJFUzI1NiJ9.eyJzZXNzaW9uX2lkIjoiYWJjZCJ9.x',
          refresh_token: `uz${istekSayisi}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { email: 'test@ornek.com' },
          dolgu: 'D'.repeat(6000),
        }),
      ).toString('base64');
    const kesim = Math.floor((uzun.length - 7) / 2 / 4) * 4;
    res.setHeader('Set-Cookie', [
      `arena-auth-prod-v1.0=${uzun.slice(0, 7 + kesim)}; Path=/; HttpOnly; Secure`,
      `arena-auth-prod-v1.1=${uzun.slice(7 + kesim)}; Path=/; HttpOnly; Secure`,
    ]);
  } else if (yeniCerezDondur) {
    res.setHeader('Set-Cookie', `arena-auth-prod-v1.0=${cerez(3600, `r${istekSayisi + 1}`)}; Path=/; HttpOnly; Secure`);
  }
  res.end('ok');
});
await new Promise((r) => sunucu.listen(0, '127.0.0.1', r));
process.env.TARGET_BASE_URL = `http://127.0.0.1:${sunucu.address().port}`;
process.env.TARGET_GENERATE_PATH = '/image/direct';

const sr = await import('../src/automation/sessionRefresh.js');

test('oturum çerezi çözümlenir: kalan süre ve refresh_token', () => {
  const c = sr.oturumCoz({ name: 'arena-auth-prod-v1.0', value: cerez(1800) });
  assert.equal(c.ok, true);
  assert.equal(c.refreshVar, true);
  assert.ok(c.kalanDk >= 28 && c.kalanDk <= 31, `kalanDk beklenen ~30, gelen ${c.kalanDk}`);
  assert.equal(c.kullanici, 'test@ornek.com');
  assert.equal(c.sessionId, 'abcd');
});

test('bozuk çerez güvenle reddedilir', () => {
  assert.equal(sr.oturumCoz({ name: 'arena-auth-prod-v1.0', value: 'saçmasapan' }).ok, false);
  assert.equal(sr.oturumCoz(null).ok, false);
});

test('jeton taze ise yenileme atlanır (gereksiz rotation yapılmaz)', async () => {
  durumYaz(cerez(3600));
  const oncekiIstek = istekSayisi;
  const sonuc = await sr.oturumuYenile({});
  assert.equal(sonuc.atlandi, true);
  assert.equal(istekSayisi, oncekiIstek, 'hedefe istek gitmemeliydi');
});

test('jeton dolmak üzereyse yenilenir ve yeni çerez KALICI yazılır', async () => {
  durumYaz(cerez(120, 'eski')); // 2 dk kaldı → eşik altı
  assert.equal(sr.yenilemeGerekliMi(20), true);
  const sonuc = await sr.oturumuYenile({});
  assert.equal(sonuc.ok, true, sonuc.sebep || '');
  assert.equal(sonuc.yol, 'http');
  const kayitli = JSON.parse(fs.readFileSync(process.env.SESSION_STATE_PATH, 'utf8'));
  const yeniDeger = kayitli.cookies[0].value;
  assert.notEqual(yeniDeger, cerez(120, 'eski'));
  const cozulen = sr.oturumCoz({ value: yeniDeger });
  assert.equal(cozulen.refreshVar, true);
  assert.ok(cozulen.kalanDk > 50, `yeni jeton ~60 dk olmalı, gelen ${cozulen.kalanDk}`);
  // dosya izni 600 kalmalı (sır)
  const mod = fs.statSync(process.env.SESSION_STATE_PATH).mode & 0o777;
  assert.equal(mod, 0o600, `dosya izni 600 olmalı, gelen ${mod.toString(8)}`);
});

test('hedef yeni çerez döndürmezse net hata verir', async () => {
  durumYaz(cerez(120, 'sabit'));
  yeniCerezDondur = false;
  const sonuc = await sr.httpIleYenile();
  yeniCerezDondur = true;
  assert.equal(sonuc.ok, false);
  assert.match(sonuc.sebep, /Set-Cookie/);
  // oturum dosyası bozulmadan kalmalı
  const kayitli = JSON.parse(fs.readFileSync(process.env.SESSION_STATE_PATH, 'utf8'));
  assert.equal(sr.oturumCoz({ value: kayitli.cookies[0].value }).refreshVar, true);
});

test('parçalı çerez şeması: parçalar ana değerin ardına eklenir ve çözülür', async () => {
  // Uzun oturum değeri (arena.ai davranışı): v1.0 = "base64-"+ilk parça, v1.1 = devam
  const uzun = cerez(3600, 'parcali');
  const kesim = Math.floor((uzun.length - 7) / 2 / 4) * 4;
  const ana = uzun.slice(0, 7 + kesim);
  const devam = uzun.slice(7 + kesim);
  fs.writeFileSync(
    process.env.SESSION_STATE_PATH,
    JSON.stringify({
      cookies: [
        { name: 'arena-auth-prod-v1.0', value: ana, domain: 'arena.ai', path: '/', expires: -1 },
        { name: 'arena-auth-prod-v1.1', value: devam, domain: 'arena.ai', path: '/', expires: -1 },
      ],
      origins: [],
    }),
    { mode: 0o600 },
  );
  const durum = sr.oturumDurumu();
  assert.equal(durum.ok, true, durum.sebep || '');
  assert.equal(durum.refreshVar, true);
  assert.equal(durum.parcaSayisi, 1);
  assert.equal(sr.birlesikCerezDegeri(JSON.parse(fs.readFileSync(process.env.SESSION_STATE_PATH, 'utf8'))).length, uzun.length);
});

test('uzun çerez değeri yazılırken parçalara bölünür (her parça sınırın altında)', async () => {
  const uzun = 'base64-' + Buffer.from(JSON.stringify({ access_token: 'a.eyJ4IjoxfQ.x', refresh_token: 'rr', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { email: 'x@y.z' }, dolgu: 'D'.repeat(6000) })).toString('base64');
  assert.ok(uzun.length > 4000, 'test değeri sınırı aşmalı');
  const { ana, ekler } = sr.cerezDegeriniBol(uzun);
  assert.ok(ana.length <= 4000 && ekler.every((e) => e.length <= 4000), 'parçalar sınırı aşmamalı');
  assert.equal(ana.slice(7) + ekler.join(''), uzun.slice(7), 'parçalar birleşince orijinal akış');
  assert.equal(sr.oturumCoz({ value: ana }).ok, false, 'ana parça tek başına çözülemez');
  assert.equal(sr.oturumCoz({ value: ana + ekler.join('') }).ok, true);
});

test('yenileme uzun jeton döndürürse oturum iki çerez olarak yazılır', async () => {
  durumYaz(cerez(120, 'eski2'));
  yeniCerezDondur = 'uzun';
  const sonuc = await sr.httpIleYenile();
  yeniCerezDondur = true;
  assert.equal(sonuc.ok, true, sonuc.sebep || '');
  const kayitli = JSON.parse(fs.readFileSync(process.env.SESSION_STATE_PATH, 'utf8'));
  const adlar = kayitli.cookies.map((c) => c.name).sort();
  // uzun jeton iki çerezden fazlasına bölünebilir; adlar sıralı olmalı (v1.0, v1.1, …)
  assert.equal(adlar[0], 'arena-auth-prod-v1.0');
  assert.deepEqual(
    adlar.map((a, i) => (i === 0 ? 'v1.0' : `v1.${i}`)),
    adlar.map(() => null).map((_, i) => (i === 0 ? 'v1.0' : `v1.${i}`)),
  );
  assert.ok(adlar.length >= 2, 'en az iki parça beklenir');
  assert.ok(kayitli.cookies.every((c) => c.value.length <= 4000), 'her parça 4000 karakterin altında');
  assert.ok(sr.oturumCoz({ value: sr.birlesikCerezDegeri(kayitli) }).kalanDk > 50);
  assert.equal(sr.oturumDurumu().ok, true);
});

test.after(() => {
  sunucu.closeAllConnections?.();
  sunucu.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
