/**
 * The liveness challenge bank.
 *
 * There are 8 challenge ids (0..7) and the contract keeps a per-id enable flag,
 * so new phrasings can be rolled out (or a leaked id disabled) without a
 * migration. A challenge instance is *fresh*: it mixes the on-chain
 * `nextChallengeSeed` with 32 bytes of local CSPRNG entropy, so it is neither
 * predictable from the chain nor reproducible by an attacker who recorded a
 * previous session.
 */
import { hash, randomBytes, type Bytes32 } from "./primitives";

export const CHALLENGE_BANK_SIZE = 8;
export const CHALLENGE_TTL_MS = 60_000;

export type ChallengeTemplate = {
  id: number;
  /** short label for the UI */
  title: string;
  /** what the UI shows */
  instruction: string;
  /** the fixed part of the spoken phrase */
  spokenPrompt: string;
  /** trailing syllable variations so the phrase is not always identical */
  tails: string[];
};

export const CHALLENGE_BANK: ChallengeTemplate[] = [
  {
    id: 0,
    title: "Dynamic code",
    instruction: "Ekrandaki dinamik kodu sesli teyit edin",
    spokenPrompt: "Kodum şudur",
    tails: ["teşekkürler", "tekrar ediyorum", "onaylıyorum"],
  },
  {
    id: 1,
    title: "Code + vowel",
    instruction: "Kodu okuyun, ardından ekrandaki ünlüyü söyleyin",
    spokenPrompt: "Doğrulama kodum",
    tails: ["çok teşekkürler", "anlaşıldı", "doğru okudum"],
  },
  {
    id: 2,
    title: "Countdown phrase",
    instruction: "Kodu ve ardından 'doğrulandı' kelimesini söyleyin",
    spokenPrompt: "Benim doğrulama numaram",
    tails: ["doğrulandı", "onaylandı", "teyit edildi"],
  },
  {
    id: 3,
    title: "Random colour",
    instruction: "Kodu söyleyip ekrandaki rengi belirtin",
    spokenPrompt: "Kodum ve rengim",
    tails: ["bu kadar", "teşekkür ederim", "sonuç bu"],
  },
  {
    id: 4,
    title: "Reverse order",
    instruction: "Kodu tersten söyleyin (ör. 12 → 21)",
    spokenPrompt: "Ters kodum",
    tails: ["anlaşıldı", "teşekkürler", "bu da doğru"],
  },
  {
    id: 5,
    title: "Spoken word",
    instruction: "Kodu ve ekrandaki kelimeyi birlikte söyleyin",
    spokenPrompt: "Kodum ve kelimem",
    tails: ["edebilirsiniz", "teşekkürler", "onaylıyorum"],
  },
  {
    id: 6,
    title: "Slow code",
    instruction: "Kodu yavaşça, her rakamı ayrı söyleyin",
    spokenPrompt: "Yavaş kodum",
    tails: ["bu kadar", "teşekkür ederim", "son nokta"],
  },
  {
    id: 7,
    title: "Filler phrase",
    instruction: "Kodu söyleyip ekrandaki cümleyi tekrar edin",
    spokenPrompt: "Doğrulama kodum ve cümlem",
    tails: ["şimdi tamam", "ilginç", "peki bu kadar"],
  },
];

const COLOURS: Array<[string, string]> = [
  ["kırmızı", "red"],
  ["mavi", "blue"],
  ["yeşil", "green"],
  ["sarı", "yellow"],
  ["mor", "purple"],
];

const WORDS = ["pazartesi", "zeytin", "kale", "fırtına", "çınar", "lale", "kömür", "deniz"];

export type LivenessChallenge = {
  id: number;
  template: ChallengeTemplate;
  /** 4 digits, animated in the UI */
  code: string;
  /** extra token the user must also say (colour / word / reversed code) */
  token: string;
  /** the full sentence the UI asks for */
  request: string;
  /** H(domain ‖ chainSeed ‖ entropy) */
  seed: Bytes32;
  issuedAt: number;
  expiresAt: number;
  /** ms since the challenge became visible when speech starts */
  expectOnsetAfterMs: number;
};

export type IssueChallengeInput = {
  /** optional forced id (demo controls); otherwise random */
  id?: number;
  /** `nextChallengeSeed(user)` from the contract */
  chainSeed: Bytes32;
  /** wallet address, mixed in so two users never share a challenge */
  user: string;
  enabledIds?: number[];
};

export function issueChallenge(input: IssueChallengeInput): LivenessChallenge {
  const enabled = input.enabledIds?.length ? input.enabledIds : CHALLENGE_BANK.map((c) => c.id);
  const id = input.id ?? enabled[randomIndex(enabled.length)];
  const template = CHALLENGE_BANK.find((c) => c.id === id);
  if (!template) throw new Error(`unknown challenge id ${id}`);

  const code = randomDigits(id === 4 ? 4 : 4);
  const reversed = code.split("").reverse().join("");

  let token: string;
  switch (template.id) {
    case 1: {
      const [tr] = COLOURS[randomIndex(COLOURS.length)];
      token = tr;
      break;
    }
    case 3: {
      const [, en] = COLOURS[randomIndex(COLOURS.length)];
      token = en;
      break;
    }
    case 4:
      token = reversed;
      break;
    case 5:
      token = WORDS[randomIndex(WORDS.length)];
      break;
    case 7:
      token = template.tails[randomIndex(template.tails.length)];
      break;
    default:
      token = template.tails[randomIndex(template.tails.length)];
  }

  const seed = hash("0x41454749535f4348414c4c454e47455f5631", input.chainSeed, input.user, randomBytes(32));
  const now = Date.now();

  return {
    id,
    template,
    code,
    token,
    request: `${template.instruction} — «${spokenCodeFor(id, code, token)}»`,
    seed,
    issuedAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
    expectOnsetAfterMs: now,
  };
}

/** What the user is actually expected to say, rendered as one phrase. */
export function spokenCodeFor(id: number, code: string, token: string): string {
  const t = CHALLENGE_BANK.find((c) => c.id === id)!;
  const digits = code.split("").join(" ");
  switch (id) {
    case 4:
      return `${digits} — ters: ${token.split("").join(" ")}`;
    case 1:
    case 3:
      return `${digits}, ${token}`;
    case 5:
      return `${digits}, ${token}`;
    case 6:
      return code.split("").join(" ... ");
    case 7:
      return `${digits}, "${token}"`;
    default:
      return `${t.spokenPrompt} ${digits}${token ? `, ${token}` : ""}`;
  }
}

export function isChallengeExpired(challenge: LivenessChallenge, now = Date.now()): boolean {
  return now > challenge.expiresAt;
}

function randomDigits(length: number): string {
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    // leading digit non-zero so the code is always 4 spoken digits
    out.push(String(i === 0 ? 1 + randomIndex(9) : randomIndex(10)));
  }
  return out.join("");
}

function randomIndex(upperExclusive: number): number {
  if (upperExclusive <= 1) return 0;
  const out = new Uint32Array(1);
  // rejection-sample to stay uniform
  const limit = Math.floor(0xffffffff / upperExclusive) * upperExclusive;
  let value: number;
  do {
    crypto.getRandomValues(out);
    value = out[0];
  } while (value >= limit);
  return value % upperExclusive;
}
