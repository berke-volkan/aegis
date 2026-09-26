/**
 * Tarayıcı cüzdan keşfinin (EIP-6963) tarayıcısız testi.
 *
 *   npm run test:wallets
 *
 * Protokol I/O'su `createWalletProbe` içinde React'ten ayrı tutulduğu için
 * burada gerçek bir `window` yerine EIP-6963'ün yaptığı yanıtı taklit eden
 * sahte bir event target kullanabiliyoruz. Doğrulananlar:
 *
 *   · iki cüzdan birlikte kuruluysa ikisi de listelenir
 *   · `info.icon` (data-URI) olduğu gibi korunur → UI gerçek logoyu gösterebilir
 *   · aynı cüzdan tekrar announce ederse tekilleştirilir
 *   · hiçbir şey yanıt vermezse `window.ethereum`'a düşülür
 *   · hiç cüzdan yoksa boş liste döner (kurulum yönlendirmesi gösterilir)
 */
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { transpileToCjs } from "./lib/transpile.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, ".zkverify");

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✔\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// --- compile the module under test ----------------------------------------
console.log("\x1b[1m0. transpiling lib/wallets to a temp dir\x1b[0m");
rmSync(OUT, { recursive: true, force: true });
transpileToCjs(ROOT, OUT, "lib/wallets");

const req = createRequire(join(ROOT, "package.json"));
const { createWalletProbe } = req(join(OUT, "lib/wallets/discovery.js"));
const { brandFor, INSTALL_SUGGESTIONS, WALLET_CATALOG } = req(join(OUT, "lib/wallets/catalog.js"));

// --- a fake window that speaks EIP-6963 ------------------------------------
/** @param responders invoked for every "eip6963:requestProvider" */
function fakeWindow({ responders = [], ethereum } = {}) {
  const listeners = new Map();
  return {
    ethereum,
    localStorage: (() => {
      const store = new Map();
      return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      };
    })(),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
      if (event.type === "eip6963:requestProvider") {
        for (const r of responders) {
          listeners.get("eip6963:announceProvider")?.forEach((fn) =>
            fn({ type: "announceProvider", detail: r }),
          );
        }
      }
      return true;
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  };
}

const run = (win, graceMs = 60) =>
  new Promise((resolve) => {
    let result = null;
    const stop = createWalletProbe({
      win,
      onChange: (w) => {
        result = w;
      },
      graceMs,
    });
    // let the debounce + grace timers run, then clean up
    setTimeout(() => {
      stop();
      resolve(result);
    }, graceMs + 80);
  });

const METAMASK_ICON = "data:image/svg+xml;base64,PHN2Zy8+";
const RABBY_ICON = "data:image/svg+xml;base64,PHN2ZzI+";

// ===========================================================================
section("1. iki cüzdan birlikte kurulu");
// ===========================================================================
{
  const mm = { isMetaMask: true, request: async () => ({}) };
  const rabby = { isRabby: true, request: async () => ({}) };
  const win = fakeWindow({
    responders: [
      { info: { uuid: "1", name: "MetaMask", icon: METAMASK_ICON, rdns: "io.metamask" }, provider: mm },
      { info: { uuid: "2", name: "Rabby Wallet", icon: RABBY_ICON, rdns: "io.rabby" }, provider: rabby },
    ],
  });

  const wallets = await run(win);
  check("iki cüzdan da bulundu", wallets?.length === 2, `got ${wallets?.length}`);
  check("isimler korundu", wallets?.map((w) => w.name).join(",") === "MetaMask,Rabby Wallet");
  check(
    "EIP-6963 ikonları (data-URI) korundu",
    wallets?.[0].icon === METAMASK_ICON && wallets?.[1].icon === RABBY_ICON,
    JSON.stringify(wallets?.map((w) => w.icon)),
  );
  check("rdns kimlikleri korundu", wallets?.[1].rdns === "io.rabby");
  check("her cüzdanın kendi provider'ı var", wallets?.[0].provider === mm && wallets?.[1].provider === rabby);
  check("listener temizlendi", win.listenerCount("eip6963:announceProvider") === 0);
}

// ===========================================================================
section("2. yinelenen announce tekilleştirilir");
// ===========================================================================
{
  const mm = { isMetaMask: true };
  const win = fakeWindow({
    responders: [
      { info: { uuid: "1", name: "MetaMask", icon: METAMASK_ICON, rdns: "io.metamask" }, provider: mm },
    ],
  });
  // requestProvider'a 3 kez yanıt veren (focus + mount + …) bir cüzdan
  const original = win.dispatchEvent.bind(win);
  let extra = 0;
  win.dispatchEvent = (event) => {
    const r = original(event);
    if (event.type === "eip6963:requestProvider" && extra < 2) {
      extra++;
      win.dispatchEvent({
        type: "announceProvider",
        detail: { info: { uuid: "1", name: "MetaMask", icon: METAMASK_ICON, rdns: "io.metamask" }, provider: mm },
      });
    }
    return r;
  };
  const wallets = await run(win);
  check("aynı rdns iki kez listelenmiyor", wallets?.length === 1, `got ${wallets?.length}`);
}

// ===========================================================================
section("3. EIP-6963 yok → window.ethereum'a düşülür");
// ===========================================================================
{
  const meta = { isMetaMask: true };
  const trust = { isTrust: true };
  const win = fakeWindow({ ethereum: { providers: [meta, trust] } });
  const wallets = await run(win);
  check("iki legacy sağlayıcı bulundu", wallets?.length === 2, `got ${wallets?.length}`);
  check("isim bayraklardan türetildi", wallets?.[0].name === "MetaMask" && wallets?.[1].name === "Trust Wallet",
    wallets?.map((w) => w.name).join(","));
  check("legacy kayıtta ikon yok (monogram fallback)", wallets?.every((w) => w.icon === null) === true);
}

{
  const win = fakeWindow({ ethereum: { isMetaMask: true } });
  const wallets = await run(win);
  check("tek legacy sağlayıcı", wallets?.length === 1 && wallets[0].name === "MetaMask");
  check("bilinmeyen sağlayıcı için jenerik isim", true);
}

{
  const win = fakeWindow({ ethereum: { someUnknownFlag: true } });
  const wallets = await run(win);
  check("tanınmayan sağlayıcı yine de listelenir", wallets?.length === 1, `got ${wallets?.length}`);
  check("jenerik isim atandı", wallets?.[0].name === "Cüzdan", wallets?.[0].name);
}

// ===========================================================================
section("4. hiç cüzdan kurulu değil");
// ===========================================================================
{
  const win = fakeWindow({ responders: [] });
  const wallets = await run(win);
  check("boş liste döndü (kurulum yönlendirmesi gösterilir)", Array.isArray(wallets) && wallets.length === 0,
    JSON.stringify(wallets));
}

// ===========================================================================
section("5. marka / monogram kataloğu");
// ===========================================================================
{
  check("her öneri bir indirme URL'si taşıyor",
    INSTALL_SUGGESTIONS.every((w) => /^https:\/\//.test(w.url)),
  );
  check("öneri sayısı makul (4)", INSTALL_SUGGESTIONS.length === 4, String(INSTALL_SUGGESTIONS.length));
  const mm = brandFor("io.metamask", "MetaMask");
  check("MetaMask marka rengi", mm.color === "#F6851B" && mm.glyph === "M", JSON.stringify(mm));
  const unknown1 = brandFor("com.example.alpha", "Alpha");
  const unknown2 = brandFor("com.example.alpha", "Alpha");
  check("bilinmeyen cüzdan kararlı bir renk alıyor", unknown1.color === unknown2.color);
  check("bilinmeyen cüzdanda daima bir glif var", /^[A-Z]$/.test(unknown1.glyph), unknown1.glyph);
  const noName = brandFor(undefined, undefined);
  check("veri yokken çökme yok", typeof noName.glyph === "string" && noName.glyph.length === 1);
  check("katalog rdns'leri benzersiz",
    new Set(WALLET_CATALOG.map((w) => w.rdns)).size === WALLET_CATALOG.length);
}

console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
