# Deploy · AegisCallZK → Monad Testnet

İki ayrı şey dağıtılıyor:

| Ne | Nasıl | Nerede |
|---|---|---|
| **AegisCallZK kontratı** | Ignition (Hardhat 3) **veya** `deploy.js` (Hardhat 2) | `ignition/modules/AegisCallZK.ts`, `contracts/scripts/deploy.js` |
| **Next.js arayüzü** | Vercel / herhangi bir Node host | `app/`, `components/`, `lib/` |

> ⚠️ **İki Hardhat sürümü bir arada.** Depoda Hardhat 3 (kök) ve Hardhat 2
> (`contracts/`) kurulu. İkisi de çalışır ama kafa karıştırıcıdır; en sonda
> ["Tekilleştirme"](#tekilleştirme-önerisi) notu var. Şimdilik ikisi de test
> edilmiş durumda.

---

## Ağ bilgisi

| | |
|---|---|
| Chain ID | `10143` |
| RPC | `https://testnet-rpc.monad.xyz` |
| Yedek RPC | `https://rpc-testnet.monadinfra.com`, `https://rpc.ankr.com/monad_testnet` |
| Explorer | <https://testnet.monadscan.com> · <https://testnet.monadvision.com> |
| Faucet | <https://faucet.monad.xyz> |
| Para birimi | MON (18 ondalık) |

> 🚨 **Sık yapılan hata:** birçok kılavuzda `https://rpc.testnet.monad.xyz` yazıyor.
> Bu adres **artık çözülmüyor**. Doğru adres `testnet-rpc.monad.xyz`.

> ℹ️ Monad testnet **2025-12-16'da genesis'ten sıfırlandı**. Daha önce dağıtılmış
> kontratların adresleri ve bakiyeler artık geçersiz.

---

## Adım 0 — Güvenlik: anahtarınızı döndürün

`contracts/.env` içindeki `MONAD_TESTNET_PRIVATE_KEY` düz metin olarak duruyor ve bu
oturumun terminal çıktısına da düştü. **O anahtarı artık güvenli kabul etmeyin.**

```bash
# 1) Faucet'ten yeni bir cüzdan oluşturun / yeni bir testnet hesabı alın
#    https://faucet.monad.xyz
# 2) contracts/.env içindeki anahtarı yenisyle değiştirin
# 3) eski anahtarı artık hiçbir yerde kullanmayın
```

Testnet parası olduğu için doğrudan bir kayıp yok; ama bu anahtarı ileride
mainnet'te kullanacaksanız sonuç felaket olur. `.env` dosyaları `.gitignore`
içinde — orada kalsınlar.

---

## Şu anki dağıtım ✅

| | |
|---|---|
| Kontrat | `0x1B648c7d9B12C4567309F154D54e4514A06dcAF9` |
| Explorer | <https://testnet.monadscan.com/address/0x1B648c7d9B12C4567309F154D54e4514A06dcAF9> |
| Derleme | `production` profili (optimizer açık) — 6633 bayt |
| Owner bakiye | ~49.8 MON |

Doğrulamak için:

```bash
npm run test:deployed      # 28 kontrol
```

Bu, "Ignition başarıyla dedi" demekten çok güçlü bir kontrol:

- adres gerçekten bir sözleşme, kodu EIP-170 sınırı içinde
- **zincirdeki bytecode, yerel `production` derlemesiyle bayt bayt aynı** (yanlış
  sürüm deploy edilmişse burada yakalanır)
- constructor durumu: owner, `PROOF_VERSION`, eşikler, `SESSION_TTL`,
  `RE_ENROLL_COOLDOWN`
- `challengeSetRoot` doğru türetilmiş (`keccak("AEGIS_CHALLENGE_SET", 10143, adres)`)
- **frontend'in `lib/abi.ts`'i kontratın ABI'siyle birebir aynı** — 33 fonksiyon,
  9 event, kritik fonksiyonların imzaları tek tek karşılaştırılır
- `pack.ts` ile kontratın `DOMAIN` değeri aynı
- UI'ın bağlandığı tüm view'lar çalışıyor; `getSession`'ın 10 struct alanı
  frontend'in `OnChainSession` tipiyle eşleşiyor
- `decodeLivenessProof` zincirde, frontend'in `packLivenessProof`'ı ile **aynı
  kelimeden** aynı sonucu veriyor

> Başka bir adresi doğrulamak için:
> `AEGIS_ADDRESS=0x... npm run test:deployed`

---

## Adım 1 — Cüzdanı oluşturun ve fonlayın

1. Yeni bir cüzdan açın (MetaMask / Rabby / …). **Bu, arayüzde kullanacağınız
   cüzdanın aynısı olmalı.**
2. Monad Testnet'i ekleyin:
   - Ağ adı: `Monad Testnet`
   - RPC: `https://testnet-rpc.monad.xyz`
   - Chain ID: `10143`
   - Para birimi: `MON`
   - Explorer: `https://testnet.monadscan.com`
3. <https://faucet.monad.xyz> adresine gidip cüzdan adresinizi yapıştırın.

Bakiyeyi doğrulayın:

```bash
# deployer adresi (contracts/.env'deki anahtardan türetilir)
node -e "console.log(require('viem/accounts').privateKeyToAccount('0x'+process.env.KEY).address)"
```

Bakiye 0 ise deploy edemezsiniz. Faucet'i tekrarlayın.

---

## Adım 2 — Anahtarı girin

`contracts/.env`:

```dotenv
# ⚠️ 0x ön eki olmadan da çalışır (config'de normalize ediliyor)
MONAD_TESTNET_PRIVATE_KEY=0x...
MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz
```

Kök `hardhat.config.ts` hem `.env` hem `contracts/.env` dosyalarını okur; ikisinden
birini düzenlemeniz yeterli. (Hardhat 3'ün kendi `.env` desteği yoktur — bu yüzden
config içine küçük bir yükleyici konuldu. Hardhat 2 `contracts/.env`'yi kendisi
otomatik okur.)

---

## Adım 3 — Kontratı dağıtın

### Yöntem A — Ignition (Hardhat 3, önerilen)

```bash
npx hardhat ignition deploy ignition/modules/AegisCallZK.ts --network monadTestnet
```

Onay: `yes`

> 🚨 Scaffold'tan gelen `ignition/modules/Counter.ts` **Counter kontratını**
> dağıtır ve Aegis ile ilgisi yoktur. Doğru modül `AegisCallZK.ts`.

Başarılıysa adresi `ignition/deployments/chain-10143/` altındaki journal'a yazar.
Aynı ağa tekrar çalıştırırsanız **yeni kontrat dağıtmaz**, mevcut olanı kullanır
(yeniden dağıtmak için `--reset`).

### Yöntem B — deploy.js (Hardhat 2, doğrulanmış)

```bash
npm run contract:deploy
```

Bu yol ayrıca:
- deployer bakiyesi 0 isse **faucet yönlendirmesiyle** net bir hata verir,
- dağıtımdan sonra `.env.local` içine
  `NEXT_PUBLIC_AEGIS_CONTRACT_ADDRESS=0x...` yazar,
- kontratın `owner`, eşik ve `challengeSetRoot` değerlerini konsola basar.

Önce yerelde dene (testnet parası harcamadan):

```bash
npm --prefix contracts run deploy:local
# → deployer : 0xf39F…2266   contract : 0x5FbD…1aa3
```

---

## Adım 4 — Arayüzü bağlayın

Dağıtım çıktısındaki adresi `.env.local` içine yazın (deploy.js zaten yazıyor):

```dotenv
NEXT_PUBLIC_AEGIS_CONTRACT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
```

Sonra:

```bash
npm run dev
```

Tarayıcıda `http://localhost:3000`:
1. Sağ üstteki **Cüzdanı bağla** → kurulu cüzdana tıklayın (logolar listede).
2. Cüzdan Monad Testnet'te olduğundan emin olun.
3. **Adım 1** → `🎙️ Biyometrik Baseline Kaydet` → konuşun → `registerBaseline`.
4. **Adım 2** → `📞 Start Secure Call` → dinamik kodu okuyun → kanıt gönderilir.

İşlem geçmişi: <https://testnet.monadscan.com/address/0x…>

---

## Adım 5 — Arayüzü yayınlayın

### Vercel (en hızlı yol)

```bash
npm i -g vercel
vercel            # preview
vercel --prod     # production
```

Ortam değişkeni olarak ekleyin:

| Değişken | Değer |
|---|---|
| `NEXT_PUBLIC_AEGIS_CONTRACT_ADDRESS` | dağıtılan adres |
| `NEXT_PUBLIC_MONAD_RPC_URL` | `https://testnet-rpc.monad.xyz` (isteğe bağlı) |

> `NEXT_PUBLIC_*` değişkenleri **build sırasında gömülür**. Vercel'da
> değişkeni ekledikten sonra **yeniden deploy** gerekir.

### Kendi sunucunuz

```bash
npm run build
npm run start          # PORT=3111 npm run start
```

`lib/zk/vault.ts` localStorage kullandığı için uygulama **istemci tarafında**
çalışır; SSR tarafında veri yoktur. Statik export (`output: "export"`) da
çalışır çünkü sayfa dinamik veri çekmiyor.

---

## Sorun giderme

| Belirti | Sebep | Çözüm |
|---|---|---|
| `ProviderError: Invalid params` (Ignition) | Deployer hesabı yok → `accounts: []` | `MONAD_TESTNET_PRIVATE_KEY` tanımlı mı? Hardhat 3 `.env`'i **kendisi okumaz** |
| `getaddrinfo ENOTFOUND rpc.testnet.monad.xyz` | Ölü RPC adresi | `testnet-rpc.monad.xyz` kullanın (hem `hardhat.config.ts` hem `.env`) |
| `insufficient funds` / bakiye 0 | Faucet'ten fonlanmamış | <https://faucet.monad.xyz> |
| `nonce too low` | Aynı anda iki deploy | `npx hardhat ignition … --reset` |
| Arayüzde "Kontrat adresi tanımlı değil" | `.env.local` yok / yeniden build edilmedi | Adresi ekleyip yeniden başlat |
| `ChainNotConfiguredError` | Cüzdan'da Monad Testnet tanımlı değil | Cüzdan ayarlarından ağı ekleyin |
| `StaleAuthNonce` | Kanıt hazırlanırken nonce değişti | Tekrar deneyin; `authNonce` tek kullanımlıktır |
| `BaselineBindingMismatch` | commitment ≠ kayıtlı olan | Yerel vault'u silin, baseline'ı yeniden kaydedin |
| `HH13: ts-node is not installed` | `contracts/` içinden Hardhat 2 çalıştırılıyor | `npm run contract:install` |
| Kök `npx hardhat` Aegis testlerini çalıştırmıyor | Hardhat 2 config'i değil Hardhat 3 config'i yüklendi | `contracts/hardhat.config.ts` **.ts** olmalı (gölgeleme önlemi) |

---

## Tam doğrulama (deploy'dan bağımsız)

```bash
npm run check
```

| Adım | Beklenen |
|---|---|
| `typecheck` | sessiz |
| `contract:test` | `35 passing` |
| `verify` | `39 passed, 0 failed` |
| `test:wallets` | `22 passed, 0 failed` |
| `test:capture` | `26 passed, 0 failed` |
| `test:deployed` | `28 passed, 0 failed` *(deploy sonrası)* |

### "Kayıt kullanılamaz" hatası alıyorsanız

Arayüz artık reddedilen kayıtta **ölçülen değerleri** gösterir: tepe/ortalama
seviye (tam ölçek yüzdesi), F0, sesli kare oranı, tonal oranı, süre. Kayıt
sırasında da canlı seviye çubuğu vardır.

Eğer hâlâ "mikrofon neredeyse hiç ses almıyor" diyorsa, tepe değeri eşiğin
altındadır; bu tarayıcı/mikrofon kazancı meselesidir ve kayıt kalitesiyle
ilgili değildir. Windows'ta: Ayarlar → Sistem → Ses → Giriş cihazı →
Mikrofon düzeyi. Tarayıcı adres çubuğundaki mikrofon simgesinden de izin
verilebilir.

---

## Tekilleştirme önerisi

Şu an iki Hardhat var:

```
/                       Hardhat 3  · hardhat.config.ts · test/ · ignition/
contracts/              Hardhat 2  · hardhat.config.ts · src/ · test/ · scripts/
```

Risk: Hardhat 2 config dosyasını `findUp` ile **yukarı doğru** arar ve önceliği
`.ts` → `.cts` → `.js` yapar. Kökte bir `hardhat.config.ts` olduğu için, `contracts/`
içinden çalıştırılan Hardhat 2 yanlışlıkla kök config'i yükler ve **Aegis
testleri yerine Counter testlerini koşar**. `contracts/hardhat.config.ts`'nin
`.ts` olması bunu engelliyor — bu yüzden `.js`'ten `.ts`'e taşındı. Config'i
`contracts/hardhat.config.js` olarak geri alırsanız bu sessiz hata geri gelir.

**Önerilen:** Her şeyi kökteki Hardhat 3'e taşımak —
`contracts/src/AegisCallZK.sol` → `contracts/AegisCallZK.sol`,
35 testi Hardhat 3 + `node:test` + viem'e çevirmek, `deploy.js`'ı kaldırıp
Ignition'ı tek yol yapmak. Bu ~120 MB'lık kopyalanmış `node_modules`'u ve
"hangi hardhat?" belirsizliğini ortadan kaldırır. İstiyorsanız yapayım.
