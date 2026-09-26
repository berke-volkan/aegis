/**
 * Step-1 gate.
 *
 * Step 2 opens only when a baseline is both *proven* (this session produced a
 * commitment) and *registered* (that commitment is on chain) — and only then is
 * the local witness written to storage, because the signing key is derived from
 * the voiceprint and must never outlive an unused enrolment.
 *
 * That creates a trap the obvious boolean expression walks straight into:
 *
 *   `step1Done = hasLocalBaseline && isEnrolledOnChain`
 *
 * reads as "done when both parts are present", but `hasLocalBaseline` only ever
 * becomes true *after* the on-chain write confirms, so the two are not
 * independent — they are the same fact. Gating the "write it on chain" UI on
 * `hasLocalBaseline` therefore hides the very button that produces it, and the
 * user is stranded on step 1 with a green "live speech verified" badge and no
 * way forward. That is exactly what happened.
 *
 * So the two halves are tracked separately here, and every state gets an
 * explicit name. The component renders from these names rather than
 * re-deriving the conditions inline.
 */

export type Step1Inputs = {
  /** a wallet is connected */
  hasAddress: boolean;
  /** this session produced a baseline proof that passed every gate */
  baselineCaptured: boolean;
  /** the local witness (signing salt + embedding) is in storage */
  hasLocalBaseline: boolean;
  /** the contract reports `registered` for this address */
  isEnrolledOnChain: boolean;
};

export type Step1State =
  /** no wallet: nothing can be signed or written */
  | "no-wallet"
  /** nothing captured yet — show the recorder */
  | "empty"
  /** proof made, not on chain — the single remaining action */
  | "awaiting-registration"
  /** chain holds a baseline but the local witness is gone — unrecoverable without a reset */
  | "orphan"
  /** proof made, chain registered, witness stored — step 2 is open */
  | "done";

export function step1State(i: Step1Inputs): Step1State {
  if (!i.hasAddress) return "no-wallet";
  if (i.hasLocalBaseline && i.isEnrolledOnChain) return "done";
  if (i.isEnrolledOnChain) return "orphan";
  // The proof exists independently of storage, so this is reachable on a first
  // run — which is the whole point of tracking it separately.
  if (i.baselineCaptured) return "awaiting-registration";
  if (i.hasLocalBaseline) return "awaiting-registration";
  return "empty";
}

export function isStep1Done(i: Step1Inputs): boolean {
  return step1State(i) === "done";
}

/** What the user must do next, in their language. Never a diagnosis. */
export function step1Hint(state: Step1State): string {
  switch (state) {
    case "no-wallet":
      return "Cüzdanı bağlayın.";
    case "empty":
      return "Mikrofonu açıp cümleyi okuyun.";
    case "awaiting-registration":
      return "Konuşman doğrulandı. Adım 1'deki “registerBaseline · C'yi yaz” düğmesine bas.";
    case "orphan":
      return "Zincire kayıtlı baseline var ama bu tarayıcıdaki yerel witness kaybolmuş — Adım 1'deki resetBaseline düğmesini kullan.";
    case "done":
      return "";
  }
}

/** Named blockers, for the diagnostic line under the hint. */
export function step1Blockers(i: Step1Inputs): string[] {
  const out: string[] = [];
  if (!i.hasAddress) out.push("cüzdan bağlı değil");
  if (!i.hasLocalBaseline) out.push("yerel witness yok");
  if (!i.isEnrolledOnChain) out.push("commitment zincire yazılmadı");
  return out;
}
