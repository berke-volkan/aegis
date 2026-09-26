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

export function describeTxError(err: unknown, fn: string): string {
  const haystack = errorChain(err);
  for (const [name, render] of Object.entries(TX_ERRORS)) {
    const at = haystack.indexOf(name);
    if (at < 0) continue;
    return `${fn} reddedildi: ${render(argsFrom(haystack.slice(at + name.length)))}`;
  }
  const first = haystack.split(" | ").find(Boolean) ?? "bilinmeyen hata";
  return `${fn} gönderilemedi: ${first}`;
}

/**
 * Renders a revert we already know the name of.
 *
 * Used by the diagnostic path, which learns the error name from *our* node's
 * `eth_call` rather than from the wallet's error object. The arguments are
 * pulled back out of the raw payload so `CooldownActive(1812)` still says how
 * long is left.
 */
export function renderContractError(name: string, data?: string): string {
  const render = TX_ERRORS[name];
  if (!render) return `Kontrat ${name} hatası verdi.`;
  const at = data ? data.indexOf(name) : -1;
  const args = at >= 0 && data ? argsFrom(data.slice(at + name.length)) : [];
  return render(args);
}

/** Custom errors the deployed contract can raise, straight from its ABI. */
export const KNOWN_CONTRACT_ERRORS: readonly string[] = aegisCallZkAbi
  .filter((e) => e.type === "error")
  .map((e) => e.name as string);

/** Error names this module can render into a sentence. */
export const RENDERED_ERRORS: readonly string[] = Object.keys(TX_ERRORS);
