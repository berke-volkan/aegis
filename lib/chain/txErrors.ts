/**
 * Revert-message rendering.
 *
 * wagmi/viem wraps a custom-error revert in three nested layers
 * (`ContractFunctionExecutionError` → `cause` → `ContractFunctionRevertedError`
 * → `data`), so reading `error.message` alone shows the user a raw selector
 * like `0x08c379a0…` and nothing else. The chain is walked instead, and the
 * ABI-decoded error name plus its numeric arguments are turned into a sentence
 * that says what to do next.
 *
 * The `CooldownActive` case is the one that matters most: it is what a user
 * hits after a *successful* enrolment, when both `registerBaseline` and
 * `resetBaseline` start reverting, and it is the single most confusing state
 * this console can be in. Naming the remaining time turns "this is broken" into
 * "come back in 43 minutes" — or, better, into "use another account".
 */
import { decodeErrorResult, toFunctionSelector, type Abi } from "viem";

import { aegisCallZkAbi } from "./contract";

/** Seconds → a short human duration. */
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "0 saniye";
  if (secs < 60) return `${Math.ceil(secs)} saniye`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} dakika`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} saat` : `${h} saat ${rem} dakika`;
}

/**
 * Remaining re-enrol wait for a session, matching the contract's private
 * `_reEnrollCooldownRemaining`:
 *
 *   if (lastBaselineChangeAt == 0) return 0;
 *   return block.timestamp < lastBaselineChangeAt + RE_ENROLL_COOLDOWN ? … : 0;
 *
 * A wallet that has never enrolled has `lastBaselineChangeAt == 0` and is
 * therefore never blocked — that "use a fresh account" escape hatch only works
 * if this case is honoured.
 */
export function cooldownRemaining(params: {
  lastBaselineChangeAt: bigint | number;
  cooldownSeconds: number;
  nowSeconds: number;
}): number {
  const changedAt = Number(params.lastBaselineChangeAt);
  if (changedAt === 0 || params.cooldownSeconds === 0) return 0;
  const left = changedAt + params.cooldownSeconds - params.nowSeconds;
  return left > 0 ? left : 0;
}

type Renderer = (args: string[]) => string;

/**
 * Every custom error `AegisCallZK.sol` can raise.
 *
 * The list is checked against the ABI in `scripts/verify-frontend.mjs` in *both*
 * directions: a name here that the contract cannot throw would be dead code,
 * and a contract error missing here would surface as a raw selector. Adding an
 * `error` to the contract therefore fails the test suite until it is explained.
 */
const TX_ERRORS: Record<string, Renderer> = {
  NotOwner: () => "Bu işlem yalnızca kontrat sahibine açık.",
  NotSelf: () =>
    "İşlemi gönderen cüzdan, kaydedilen adresle aynı değil. Cüzdan hesabını değiştirin.",
  AlreadyRegistered: () =>
    "Bu adres zaten kayıtlı. Önce resetBaseline ile kaydı silin.",
  NotRegistered: () => "Bu adres kayıtlı değil.",
  CommitmentAlreadySet: () => "Commitment sıfır olamaz.",
  InvalidProofVersion: ([v]) =>
    `Kanıt sürümü tanınmıyor (sürüm ${v}). Sayfa ile kontrat uyumsuz; uygulamayı yenileyin.`,
  ChallengeDisabled: ([id]) =>
    `Bu challenge kontratta kapalı (id ${id}). Farklı bir challenge deneyin.`,
  ChallengeOutOfRange: ([id]) =>
    `Challenge id'si geçersiz (${id}). Bankada 8 challenge var, 0–7 aralığında olmalı.`,
  ChallengeMismatch: ([provided, expected]) =>
    `Gönderilen challenge ile beklenen eşleşmiyor (gelen ${provided}, beklenen ${expected}). ` +
    `Bu bir replay denemesi.`,
  StaleAuthNonce: ([provided, expected]) =>
    `authNonce bayat (gönderilen ${provided}, beklenen ${expected}). ` +
    `Önceki oturumun kanıtı — sayfayı yenileyip yeni challenge isteyin.`,
  BaselineBindingMismatch: () =>
    "Kanıt bu baseline'a ait değil: binding 20 baytı eşleşmiyor. " +
    "Yerel witness ile zincire yazılan commitment farklı — hesap değişmiş ya da tarayıcı verisi silinmiş olabilir.",
  DirtyProofBits: () =>
    "Kanıt kelimesinde temizlenmesi gereken bitler kaldı (worklet dışı kalan alanlar sıfır değil). " +
    "Bu istemci ile üretilmiş bir kanıt değil.",
  CooldownActive: ([n]) => {
    const secs = Number(n);
    if (Number.isFinite(secs) && secs > 0) {
      return (
        `Bekleme süresi dolmadı: ${formatDuration(secs)}. ` +
        `Süre, baseline'ın zincire yazıldığı andan itibaren başlar ve hem ` +
        `registerBaseline hem resetBaseline için geçerlidir. ` +
        `Beklemek istemiyorsanız cüzdanınızda başka bir hesaba geçin — ` +
        `hiç kayıt yapılmamış bir adresin bekleme süresi hiç başlamaz.`
      );
    }
    return "Yeniden kayıt bekleme süresi dolmamış.";
  },
  InvalidThreshold: () => "Eşik değerleri geçersiz (0–10_000 aralığı dışında).",
  ZeroAddress: () => "Adres sıfır olamaz.",
};

/** Flattens viem's nested error chain into one searchable string. */
export function errorChain(err: unknown, depth = 0): string {
  if (!err || depth > 6) return "";
  const e = err as { shortMessage?: string; message?: string; cause?: unknown; data?: unknown };
  const parts: string[] = [];
  if (typeof e.data === "string") parts.push(e.data);
  if (e.shortMessage) parts.push(e.shortMessage);
  if (e.message) parts.push(e.message);
  if (e.cause) parts.push(errorChain(e.cause, depth + 1));
  return parts.filter(Boolean).join(" | ");
}

/**
 * Finds the revert payload buried deepest in a viem error chain.
 *
 * viem throws away the payload on the way up, but only on the way up. A real
 * `estimateGas` failure looks exactly like this (reproduced against the live
 * deployment):
 *
 *   EstimateGasExecutionError   "Execution reverted for an unknown reason."
 *   └─ ExecutionRevertedError   data: undefined        ← dropped here
 *      └─ RpcRequestError       data: 0x45ed80e9…      ← present and intact
 *         └─ (raw node error)  message: "execution reverted", code: 3
 *
 * `ExecutionRevertedError` sets `data` to `undefined` and builds its message
 * from the node's *message string* alone. A custom error lives in `data`, not in
 * that string, so the name is never recovered and viem reports "unknown
 * reason" for all fifteen of the contract's errors.
 *
 * The node did nothing wrong — it answered `code: 3` with a perfectly decodable
 * payload. So the payload is dug back out of the chain and decoded here.
 */
export function deepestRevertData(err: unknown): string | undefined {
  let best: string | undefined;
  const walk = (e: unknown, depth: number): void => {
    if (!e || depth > 8) return;
    const o = e as { data?: unknown; cause?: unknown };
    // a revert payload is 4 selector bytes plus at least one 32-byte word
    if (typeof o.data === "string" && /^0x[0-9a-f]{8,}$/i.test(o.data) && o.data.length >= 10) {
      best = o.data;
    }
    if (o.cause) walk(o.cause, depth + 1);
  };
  walk(err, 0);
  return best;
}

/** Extracts the args from a decoded `Name(arg1, arg2)` tail. */
function argsFrom(tail: string): string[] {
  if (!tail.startsWith("(")) return [];
  const close = tail.indexOf(")");
  if (close < 0) return [];
  return tail
    .slice(1, close)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

/** Resolves a raw revert payload to one of the contract's error names. */
export function errorNameOf(data: string): string | undefined {
  try {
    return decodeErrorResult({ abi: aegisCallZkAbi, data: data as `0x${string}` }).errorName;
  } catch {
    const selector = data.slice(0, 10).toLowerCase();
    for (const item of aegisCallZkAbi) {
      if (item.type !== "error") continue;
      try {
        const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
        if (toFunctionSelector(sig).toLowerCase() === selector) return item.name;
      } catch {
        // an entry viem cannot hash
      }
    }
    return undefined;
  }
}

export function describeTxError(err: unknown, fn: string): string {
  const haystack = errorChain(err);

  // 1. viem bazen hatayi metne yazar; en hizli yol.
  for (const name of Object.keys(TX_ERRORS)) {
    if (haystack.includes(name)) {
      return `${fn} reddedildi: ${TX_ERRORS[name](argsFrom(haystack.slice(haystack.indexOf(name) + name.length)))}`;
    }
  }

  // 2. Asil durum: veri zincirin icinde, isim degil. Cikarip coz.
  const data = deepestRevertData(err);
  if (data) {
    const name = errorNameOf(data);
    if (name) return `${fn} reddedildi: ${renderContractError(name, data)}`;
    return (
      `${fn} reddedildi: kontrat 0x${data.slice(2, 10)} selector'ı ile döndü, ` +
      `bu ABI'de tanımlı değil.`
    );
  }

  // 3. Gercekten hiç veri yok — cüzdanın/RPC'nin kendi cümlesi.
  const first = haystack.split(" | ").find(Boolean) ?? "bilinmeyen hata";
  return `${fn} gönderilemedi: ${first}`;
}

/**
 * Renders a revert we already know the name of.
 *
 * Used by the diagnostic path, which learns the error name from *our* node's
 * `eth_call` rather than from the wallet's error object.
 *
 * The arguments are decoded from the raw payload with the ABI — they are *not*
 * scraped out of it. A revert payload is a 4-byte selector followed by ABI-
 * encoded arguments; the error's name never appears in it, so looking for the
 * name in the hex silently yields "no arguments" and every duration-bearing
 * error renders as its argument-less fallback.
 */
export function renderContractError(name: string, data?: string, abi?: Abi): string {
  const render = TX_ERRORS[name];
  if (!render) return `Kontrat ${name} hatası verdi.`;

  let args: string[] = [];
  if (data && data.length >= 10) {
    const target = abi ?? aegisCallZkAbi;
    try {
      const decoded = decodeErrorResult({ abi: target, data: data as `0x${string}` });
      if (decoded.errorName === name) {
        args = Object.values((decoded.args ?? {}) as Record<string, unknown>).map((v) =>
          typeof v === "bigint" ? v.toString() : String(v),
        );
      }
    } catch {
      // fall through to the selector-only path
    }
    if (args.length === 0) {
      // selector matches but decoding failed: at least the first word is
      // usually a duration or an id, so read it positionally.
      const body = data.slice(10);
      for (let i = 0; i + 64 <= body.length; i += 64) {
        const word = body.slice(i, i + 64);
        if (word !== "0".repeat(64)) args.push(BigInt("0x" + word).toString());
      }
    }
  }
  return render(args);
}

/** Custom errors the deployed contract can raise, straight from its ABI. */
export const KNOWN_CONTRACT_ERRORS: readonly string[] = aegisCallZkAbi
  .filter((e) => e.type === "error")
  .map((e) => e.name as string);

/** Error names this module can render into a sentence. */
export const RENDERED_ERRORS: readonly string[] = Object.keys(TX_ERRORS);
