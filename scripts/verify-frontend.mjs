/**
 * Cross-language verification for the browser-side prover.
 *
 *   node scripts/verify-frontend.mjs
 *
 * Two things are checked that unit tests inside a single language cannot:
 *
 *   1. PARITY  — the 32-byte word and the 20-byte freshness binding produced by
 *      `lib/zk/pack.ts` are byte-identical to what the deployed Solidity
 *      computes. A single endianness slip here would make every real call fail
 *      with `BaselineBindingMismatch`, and it would only show up on-chain.
 *
 *   2. LIVENESS ENGINE — the attack harness in `lib/zk/spoof.ts` feeds
 *      synthesised attacker audio through the *unmodified* detector, and we
 *      assert each attack class is actually caught. A detector that never
 *      rejects anything would look identical to a working one in a demo.
 *
 * The TypeScript is transpiled to a temp dir and executed in Node, so this
 * exercises the exact same source the browser bundles. See
 * `scripts/lib/transpile.mjs` for why the TypeScript API is used rather than
 * the `tsc` CLI.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { transpileToCjs } from "./lib/transpile.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, ".zkverify");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✔\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// --------------------------------------------------------------------------
// 0. transpile the browser TypeScript so Node can load it
// --------------------------------------------------------------------------
console.log("\x1b[1m0. transpiling lib/ to a temp dir\x1b[0m");
rmSync(OUT, { recursive: true, force: true });
transpileToCjs(ROOT, OUT, "lib");

// CommonJS output (see scripts/lib/transpile.mjs), so use `require`.
const req = createRequire(join(ROOT, "package.json"));
const pack = req(join(OUT, "lib/zk/pack.js"));
const livenessMod = req(join(OUT, "lib/zk/liveness.js"));
const spoof = req(join(OUT, "lib/zk/spoof.js"));
const featuresMod = req(join(OUT, "lib/audio/features.js"));
const baselineMod = req(join(OUT, "lib/zk/baseline.js"));
const { keccak256, concat, slice, encodeAbiParameters } = req("viem");

// ---------------------------------------------------------------------------
// 1. Solidity parity
// ---------------------------------------------------------------------------
section("1. Solidity <-> TypeScript parity (deployed contract)");

function requireHardhat() {
  // hardhat lives in contracts/node_modules, so resolve from there.
  const contractsRequire = createRequire(join(ROOT, "contracts", "package.json"));
  const prev = process.cwd();
  process.chdir(join(ROOT, "contracts"));
  try {
    return contractsRequire("hardhat");
  } finally {
    process.chdir(prev);
  }
}
const hre = requireHardhat();

const { createPublicClient, createWalletClient, custom, defineChain, getAddress, toHex } = req("viem");

const chain = defineChain({
  id: 10143,
  name: "Monad Testnet (in-process hardhat)",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

await hre.run("compile");
const art = await hre.artifacts.readArtifact("AegisCallZK");

const accounts = (await hre.network.provider.send("eth_accounts", [])).map((a) =>
  getAddress(a.toLowerCase()),
);
const [owner, alice] = accounts;

const publicClient = createPublicClient({ chain, transport: custom(hre.network.provider) });
const walletClient = createWalletClient({
  chain,
  transport: custom(hre.network.provider),
  account: owner,
});

const deployHash = await walletClient.deployContract({
  abi: art.abi,
  bytecode: art.bytecode,
  account: owner,
  chain,
});
const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
const address = getAddress(deployReceipt.contractAddress);

const call = (functionName, args, account = owner) =>
  walletClient.writeContract({ abi: art.abi, address, functionName, args, account, chain });
const send = async (functionName, args, account = owner) =>
  publicClient.waitForTransactionReceipt({ hash: await call(functionName, args, account) });

const COMMITMENT = "0x" + "11".repeat(32);
await send("registerBaseline", [alice, COMMITMENT], alice);

// -- 1a. domain separator -------------------------------------------------
const contractDomain = await publicClient.readContract({
  abi: art.abi,
  address,
  functionName: "DOMAIN",
  chain,
});
check(
  "DOMAIN = keccak256(\"AEGIS_CALL_ZK_V1\")",
  contractDomain === keccak256(toHex("AEGIS_CALL_ZK_V1")),
  `contract=${contractDomain}`,
);
check("pack.ts CONTRACT_DOMAIN matches the contract", contractDomain === pack.CONTRACT_DOMAIN);

// -- 1b. freshness binding ------------------------------------------------
for (const challengeId of [0, 3, 7]) {
  for (const authNonce of [0, 1, 42]) {
    const ts = pack.computeBinding({
      commitment: COMMITMENT,
      user: alice,
      challengeId,
      authNonce,
    });
    const sol = await publicClient.readContract({
      abi: art.abi,
      address,
      functionName: "expectedBinding",
      args: [alice, challengeId],
      chain,
    });
    if (authNonce !== 0) continue; // the view always uses the *current* nonce
    check(
      `computeBinding(challengeId=${challengeId}, authNonce=0)`,
      ts.toLowerCase() === sol.toLowerCase(),
      `ts=${ts} sol=${sol}`,
    );
  }
}

// -- 1c. full proof word round-trip --------------------------------------
const word = pack.packLivenessProof({
  version: pack.PROOF_VERSION,
  challengeId: 3,
  livenessBps: 8742,
  similarityBps: 9013,
  flags: pack.ATTACK_FLAGS.TEMPO_SPOOF,
  sigAnchor: 0xab,
  authNonce: 0,
  binding: pack.computeBinding({ commitment: COMMITMENT, user: alice, challengeId: 3, authNonce: 0 }),
});
check("packed word is exactly 32 bytes", word.length === 66, `len=${word.length}`);

const decoded = await publicClient.readContract({
  abi: art.abi,
  address,
  functionName: "decodeLivenessProof",
  args: [word],
  chain,
});
check("decodeLivenessProof.version", decoded.version === pack.PROOF_VERSION);
check("decodeLivenessProof.challengeId", decoded.challengeId === 3);
check("decodeLivenessProof.livenessBps", decoded.livenessBps === 8742);
check("decodeLivenessProof.similarityBps", decoded.similarityBps === 9013);
check("decodeLivenessProof.flags", decoded.flags === pack.ATTACK_FLAGS.TEMPO_SPOOF);
check("decodeLivenessProof.sigAnchor", decoded.sigAnchor === 0xab);
check("decodeLivenessProof.authNonce", decoded.authNonce === 0);
check(
  "decodeLivenessProof.binding",
  decoded.binding.toLowerCase() === pack.computeBinding({ commitment: COMMITMENT, user: alice, challengeId: 3, authNonce: 0 }).toLowerCase(),
);

// local decoder must agree with the contract's
const local = pack.unpackLivenessProof(word);
check(
  "unpackLivenessProof matches the on-chain decoder",
  local.challengeId === decoded.challengeId &&
    local.livenessBps === decoded.livenessBps &&
    local.similarityBps === decoded.similarityBps &&
    local.flags === decoded.flags &&
    local.sigAnchor === decoded.sigAnchor &&
    local.authNonce === decoded.authNonce &&
    local.binding.toLowerCase() === decoded.binding.toLowerCase(),
);

// describeProofWord's byte slices must tile the whole word with no gaps
const rows = pack.describeProofWord(word);
check("describeProofWord tiles all 32 bytes", rows.reduce((n, r) => n + r.size, 0) === 32);

// -- 1d. a word carrying attack flags is *recorded*, not reverted --------
// The word decoded above deliberately carries TEMPO_SPOOF, so it is a
// *rejection*. The transaction must still be mined, so the rejection leaves a
// permanent audit trail instead of a revert string. Submitted first because
// `authNonce` is single-use: every submission burns one.
const flaggedRc = await send("verifyCallWithLiveness", [alice, word, 3], alice);
check(
  "attack flags are mined as LivenessRejected (audit trail preserved)",
  flaggedRc.status === "success" &&
    flaggedRc.logs.some(
      (l) =>
        l.topics[0] ===
        keccak256(toHex("LivenessRejected(address,uint8,uint8,uint8,uint16,uint16,uint32)")),
    ),
);
check(
  "a flagged word does NOT open a session",
  !(await publicClient.readContract({
    abi: art.abi,
    address,
    functionName: "isSessionActive",
    args: [alice],
    chain,
  })),
);
check(
  "a rejected attempt still burns the authNonce",
  (await publicClient.readContract({
    abi: art.abi,
    address,
    functionName: "getSession",
    args: [alice],
    chain,
  })).authNonce === 1,
);

// -- 1e. a clean word is accepted on-chain ------------------------------
const cleanWord = pack.packLivenessProof({
  version: pack.PROOF_VERSION,
  challengeId: 3,
  livenessBps: 8742,
  similarityBps: 9013,
  flags: 0,
  sigAnchor: 0xab,
  authNonce: 1, // the previous attempt burned nonce 0
  binding: pack.computeBinding({ commitment: COMMITMENT, user: alice, challengeId: 3, authNonce: 1 }),
});
const acceptedRc = await send("verifyCallWithLiveness", [alice, cleanWord, 3], alice);
check(
  "a clean word from pack.ts is ACCEPTED on-chain",
  acceptedRc.status === "success" &&
    acceptedRc.logs.some(
      (l) =>
        l.topics[0] ===
        keccak256(toHex("LivenessVerified(address,uint8,uint16,uint16,uint32,uint64)")),
    ),
);
check(
  "acceptance opens the session",
  await publicClient.readContract({
    abi: art.abi,
    address,
    functionName: "isSessionActive",
    args: [alice],
    chain,
  }),
);

// -- 1f. replay of that same word is refused ----------------------------
let replayRejected = false;
try {
  await send("verifyCallWithLiveness", [alice, cleanWord, 3], alice);
} catch {
  replayRejected = true;
}
check("replaying the same word is refused", replayRejected);

// ---------------------------------------------------------------------------
// 2. liveness engine vs the attack harness
// ---------------------------------------------------------------------------
section("2. liveness engine vs attack harness (detector unmodified)");

const RATE = 16_000;
const seedOf = (n) => new Uint8Array(32).fill(n);
/** Fixed speaker identity: the "enrolled human". */
const VOICE = seedOf(7);
/** A different person entirely. */
const STRANGER_VOICE = seedOf(99);

/** Enrol, then attempt a call, exactly like the browser does. */
function makeBaseline(samples) {
  return baselineMod.createBaselineProof(samples, RATE);
}

const ISSUED_AT = Date.now();

/**
 * @param readDelayMs how long the human took to read the code before pressing
 *   record. A genuine interaction has one; a prerecorded/synthesised response
 *   effectively does not.
 */
function attempt({
  baselineEmbedding,
  samples,
  priorDigests = [],
  challengeId = 0,
  readDelayMs = 900,
}) {
  const capture = featuresMod.analyseVoiceprint(samples, RATE);
  // mirror the app: digest of the int16 PCM representation
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  }
  const audioDigest = keccak256(new Uint8Array(pcm.buffer));
  const challenge = {
    id: challengeId,
    template: { id: challengeId, title: "t", instruction: "", spokenPrompt: "", tails: [] },
    code: "1234",
    token: "x",
    request: "",
    seed: "0x" + "11".repeat(32),
    issuedAt: ISSUED_AT,
    expiresAt: ISSUED_AT + 60_000,
    expectOnsetAfterMs: ISSUED_AT,
  };
  return livenessMod.scoreLiveness({
    capture,
    baselineEmbedding,
    challenge,
    audioDigest,
    priorDigests,
    captureStartedAt: ISSUED_AT + readDelayMs,
  });
}

const spoken = spoof.normalise(
  spoof.synthesiseSpoof({
    kind: "impostor",
    baselineF0: 120,
    seconds: 3.4,
    voiceSeed: VOICE,
    seed: seedOf(1),
  }),
);
const enrollment = makeBaseline(spoken);
check(
  "a 3.4s voiced sample is accepted for enrollment",
  enrollment.ok,
  enrollment.problems.join(", "),
);
if (!enrollment.ok) {
  console.error("\n  cannot continue: enrollment gate rejected the test signal");
  process.exit(1);
}

// Scoring only needs the enrolled embedding, so that is all we keep here —
// exactly like the local vault does in the app.
const baselineEmbedding = enrollment.embedding;

// The same human, a *different* sentence: same voiceSeed, different seed.
const spokenAgain = spoof.normalise(
  spoof.synthesiseSpoof({
    kind: "impostor",
    baselineF0: 120,
    seconds: 3.4,
    voiceSeed: VOICE,
    seed: seedOf(2),
  }),
);
const honest = attempt({ baselineEmbedding, samples: spokenAgain });
check(
  "same speaker, fresh recording → no attack flags",
  honest.verdict.flags === 0,
  `flags=${livenessMod.decodeFlags(honest.verdict.flags).join(",")} reasons=${honest.verdict.reasons.join(" | ")}`,
);
check(
  "same speaker → similarity above the floor",
  honest.similarityBps > 0 && honest.cosine > livenessMod.LIVENESS_THRESHOLDS.similarityFloor,
  `sim=${honest.similarityBps} cos=${honest.cosine.toFixed(3)}`,
);
check(
  "same speaker → honest audio is not looped",
  honest.voiceprint.features.loopScore < livenessMod.LIVENESS_THRESHOLDS.loopCorrelationCeiling,
  `loopScore=${honest.voiceprint.features.loopScore.toFixed(3)}`,
);

// replay of the exact enrollment buffer
const replay = attempt({
  baselineEmbedding,
  samples: spoken,
  priorDigests: [enrollment.audioDigest],
});
check(
  "REPLAY is detected (digest ledger)",
  (replay.verdict.flags & pack.ATTACK_FLAGS.REPLAY) !== 0,
  `flags=${livenessMod.decodeFlags(replay.verdict.flags).join(",")}`,
);

// a stitched/looped sample: the same 1.7s buffer twice
const half = spoken.slice(0, Math.floor(RATE * 1.7));
const looped = new Float32Array(half.length * 2);
looped.set(half, 0);
looped.set(half, half.length);
const loopedResult = attempt({ baselineEmbedding, samples: looped });
check(
  "REPLAY is detected (autocorrelation loop detector)",
  (loopedResult.verdict.flags & pack.ATTACK_FLAGS.REPLAY) !== 0,
  `loopScore=${loopedResult.voiceprint.features.loopScore.toFixed(3)}`,
);

// vocoder / TTS voice
const tts = spoof.normalise(spoof.synthesiseSpoof({ kind: "synthetic", seconds: 3.4 }));
const ttsResult = attempt({ baselineEmbedding, samples: tts });
check(
  "SYNTHETIC voice is detected (machine-stable pitch)",
  (ttsResult.verdict.flags & pack.ATTACK_FLAGS.SYNTHETIC) !== 0,
  `jitter=${ttsResult.voiceprint.features.f0Jitter.toFixed(4)} flags=${livenessMod.decodeFlags(ttsResult.verdict.flags).join(",")}`,
);

// a different human being
const stranger = spoof.normalise(
  spoof.synthesiseSpoof({
    kind: "impostor",
    baselineF0: 120,
    seconds: 3.4,
    voiceSeed: STRANGER_VOICE,
    seed: seedOf(3),
  }),
);
const strangerResult = attempt({ baselineEmbedding, samples: stranger });
// What actually matters is not "is it flagged" but "would the call have been
// accepted": the contract refuses anything below minSimilarityBps.
const CONTRACT_MIN_SIMILARITY = 6200;
check(
  "an IMPOSTOR falls below the contract's similarity threshold",
  strangerResult.verdict.flags !== 0 ||
    strangerResult.similarityBps < CONTRACT_MIN_SIMILARITY,
  `cos=${strangerResult.cosine.toFixed(3)} sim=${strangerResult.similarityBps}bps flags=${livenessMod.decodeFlags(strangerResult.verdict.flags).join(",")}`,
);
check(
  "the honest speaker stays above the contract's similarity threshold",
  honest.similarityBps >= CONTRACT_MIN_SIMILARITY,
  `sim=${honest.similarityBps}bps`,
);
check(
  "the impostor scores materially lower than the real speaker",
  strangerResult.cosine < honest.cosine - 0.05,
  `impostor cos=${strangerResult.cosine.toFixed(3)} vs speaker cos=${honest.cosine.toFixed(3)}`,
);

// silence
const silence = new Float32Array(RATE * 3);
const silenceResult = attempt({ baselineEmbedding, samples: silence });
check(
  "digital silence is rejected (no speech energy)",
  silenceResult.similarityBps === 0 || silenceResult.livenessBps < 4000,
  `sim=${silenceResult.similarityBps} live=${silenceResult.livenessBps}`,
);

// instant replay of a prerecorded answer: no read-and-react delay
const instant = attempt({
  baselineEmbedding,
  samples: spoof.normalise(
    spoof.synthesiseSpoof({
      kind: "impostor",
      baselineF0: 120,
      seconds: 3.4,
      voiceSeed: VOICE,
      seed: seedOf(4),
      leadInMs: 0, // the attacker's recording starts the moment record opens
    }),
  ),
  readDelayMs: 0,
});
check(
  "an answer with no read-and-react delay is flagged (TEMPO_SPOOF)",
  (instant.verdict.flags & pack.ATTACK_FLAGS.TEMPO_SPOOF) !== 0,
  `latency=${instant.responseLatencyMs.toFixed(0)}ms flags=${livenessMod.decodeFlags(instant.verdict.flags).join(",")}`,
);

// ---------------------------------------------------------------------------
// 3. biometric key binding
// ---------------------------------------------------------------------------
section("3. sign-to-contract key binding");

const keyMod = req(join(OUT, "lib/zk/biometricKey.js"));
const digestA = keccak256(toHex("template-A"));
const digestB = keccak256(toHex("template-B"));
const keyA = keyMod.deriveBiometricKey(digestA);

const msg = keccak256(toHex("challenge-message"));
const sigA = keyMod.signLiveness(msg, keyA);
check("a signature verifies against its own commitment", keyMod.verifyLivenessSignature(keyA.commitment, msg, sigA.signature));
check(
  "a signature over a different message does NOT verify",
  !keyMod.verifyLivenessSignature(keyA.commitment, keccak256(toHex("other-message")), sigA.signature),
);

const keyB = keyMod.keyForTemplate(keyA.salt, digestB);
const sigB = keyMod.signLiveness(msg, keyB);
check(
  "a DIFFERENT biometric template cannot sign against the registered key",
  !keyMod.verifyLivenessSignature(keyA.commitment, msg, sigB.signature),
);
check(
  "the different template derives a different commitment",
  keyB.commitment.toLowerCase() !== keyA.commitment.toLowerCase(),
);
check(
  "C is a valid 32-byte x-only secp256k1 point",
  /^0x[0-9a-f]{64}$/.test(keyA.commitment) && keyA.commitment === keyA.commitment.toLowerCase(),
);

// ---------------------------------------------------------------------------
// 6. Step 1 gate — the "can't reach step 2" trap
// ---------------------------------------------------------------------------
// Regresyon: `step1Done = hasLocalBaseline && isEnrolledOnChain` ve commitment'i
// yazma panelinin `hasLocalBaseline` koşuluna bağlanması, ilk kayıtta o düğmeyi
// görünmez kılıyordu. Kullanıcı konuşmasını kaydediyor, "canlı konuşma
// doğrulandı" yazıyor ve zincire yazacak hiçbir yol kalmıyordu — 2. adım hiç
// açılmıyor. Saf bir boolean ifadesiydi, dolayısıyla saf bir fonksiyona
// çekilip her kombinasyonu test edilebiliyor.
section("6. ADIM 1 KAPISI — her duruma erişilebilir mi?");
const { step1State, isStep1Done, step1Hint, step1Blockers } = req(join(OUT, "lib/chain/step1.js"));

const st = (o) => step1State({ hasAddress: true, ...o });

check("cüzdan yokken hicbir sey yapilamaz", step1State({ hasAddress: false, baselineCaptured: true, hasLocalBaseline: true, isEnrolledOnChain: true }) === "no-wallet");
check("hicbisey yokken kayit ekrani acilir", st({}) === "empty");
check(
  "KAYIT SONRASI 'zincire yaz' ekrani gorunur (regresyon)",
  st({ baselineCaptured: true }) === "awaiting-registration",
  st({ baselineCaptured: true }),
);
check(
  "zincirde var ama yerel witness yok -> kurtarma yolu (orphan)",
  st({ isEnrolledOnChain: true }) === "orphan",
  st({ isEnrolledOnChain: true }),
);
check("her iki parca da varsa adim 1 bitti", st({ hasLocalBaseline: true, isEnrolledOnChain: true }) === "done");
check("sadece yerel witness varsa zincire yazilmali", st({ hasLocalBaseline: true }) === "awaiting-registration");

// isStep1Done yalnizca TAM durumda true olmali
const all = [];
for (const hasAddress of [true, false])
  for (const baselineCaptured of [true, false])
    for (const hasLocalBaseline of [true, false])
      for (const isEnrolledOnChain of [true, false]) {
        const inputs = { hasAddress, baselineCaptured, hasLocalBaseline, isEnrolledOnChain };
        all.push({ inputs, state: step1State(inputs), done: isStep1Done(inputs) });
      }
check("16 durumun hepsi tanimli", all.every((s) => typeof s.state === "string" && s.state.length > 0));
check(
  "adim 1 yalnizca witness + zincir birlikteyken bitti",
  all.every((s) => s.done === (s.inputs.hasLocalBaseline && s.inputs.isEnrolledOnChain && s.inputs.hasAddress)),
);
check(
  "cuzdan bagli degilken adim 1 hicbir kosulda bitmis sayilmaz",
  all.filter((s) => !s.inputs.hasAddress).every((s) => !s.done),
);
// `all` cüzdanı olmayan durumları da iceriyor; bunlar "no-wallet" ve zaten
// kilitli. Asil regresyon kontrolleri yalnizca cuzdan bagli varyantlara bakiyor.
const connected = all.filter((s) => s.inputs.hasAddress);

check(
  "BOYLE BIR DURUM YOK: kanit var + yerel witness yok + zincirde kayitli degil -> kilitli degil",
  connected
    .filter((s) => s.inputs.baselineCaptured && !s.inputs.hasLocalBaseline && !s.inputs.isEnrolledOnChain)
    .every((s) => s.state === "awaiting-registration"),
);
check(
  "BOYLE BIR DURUM YOK: kanit var + zincirde kayitli degil -> 'zincire yaz' yolu var",
  connected
    .filter((s) => s.inputs.baselineCaptured && !s.inputs.isEnrolledOnChain)
    .every((s) => s.state === "awaiting-registration"),
);
check(
  "BOYLE BIR DURUM YOK: witness var ama zincirde kayitli degil -> 'zincire yaz' yolu var",
  connected
    .filter((s) => s.inputs.hasLocalBaseline && !s.inputs.isEnrolledOnChain)
    .every((s) => s.state === "awaiting-registration"),
);

// Kilitli her durumda kullaniciya NE yapacagi soylenmeli
check("kilitli her durumda ipucu bos degil", all.filter((s) => !s.done).every((s) => step1Hint(s.state).trim().length > 0));
check(
  "engeller listeleniyor (teşhis cümlesi değil, engelin adı)",
  all.filter((s) => !s.done).every((s) => step1Blockers(s.inputs).length > 0),
);
check("bitmis durumda ipucu yok", step1Hint("done") === "");
check(
  "'zincire yaz' ipucu registerBaseline'i adiyle soyluyor",
  step1Hint("awaiting-registration").includes("registerBaseline"),
);
check(
  "orphan ipucu resetBaseline'i adiyle soyluyor",
  step1Hint("orphan").includes("resetBaseline"),
);

// ---------------------------------------------------------------------------
// 7. Revert mesajlari — kullanici "0x08c379a0" gormemeli
// ---------------------------------------------------------------------------
// Regresyon: `resetBaseline` hatasi kullaniciya ham biçimde gidiyordu. Gercek
// neden `CooldownActive(3599)`: baseline ZİNCİRE YAZILDIĞI andan itibaren bir
// saatlik bekleme başlıyor, yani demo'nun kendi mutlu yolu kullanıcıyı bir
// saat kilitliyor. Kullanıcı bunu ancak yanlış cümleyle anlar.
section("7. REVERT MESAJLARI");
const tx = req(join(OUT, "lib/chain/txErrors.js"));

// viem revert'i üç katmanlı sarar; zincirin tamamı taranmalı.
const viemShaped = {
  shortMessage: "The contract function \"resetBaseline\" reverted",
  message: "Error: The contract function \"resetBaseline\" reverted with the following reason:",
  cause: {
    shortMessage: "execution reverted",
    message: "Error: execution reverted: CooldownActive(3599)",
    cause: {
      data: "0x1c4e6b7f00000000000000000000000000000000000000000000000000000000000e0f",
      message: "CooldownActive(3599)",
    },
  },
};
const cooldownMsg = tx.describeTxError(viemShaped, "resetBaseline");
check("hata adi cozuluyor (CooldownActive)", cooldownMsg.includes("CooldownActive") || cooldownMsg.includes("Bekleme süresi"), cooldownMsg);
check("kalan sure hesaplanip soyleniyor", /59 dakika/.test(cooldownMsg), cooldownMsg);
check("kullaniciya baska hesap oneriliyor", cooldownMsg.includes("başka bir hesaba"), cooldownMsg);
check("hata mesaji ham hex degil", !cooldownMsg.includes("0x08c379a0") && !/0x[0-9a-f]{6,}/.test(cooldownMsg));

check(
  "AlreadyRegistered anlasilir bir cumleye donusuyor",
  tx.describeTxError({ shortMessage: "reverted: AlreadyRegistered(0xB5f3…a76)" }, "registerBaseline").includes("zaten kayıtlı"),
);
check(
  "bilinmeyen hata ham olarak birakilir (uydurma mesaj yok)",
  tx.describeTxError(new Error("boom"), "verifyCall").includes("boom"),
);
check("hata nesnesi olmasa da cokmez", typeof tx.describeTxError(null, "verifyCall") === "string");

// Harita ile ABI İKİ YÖNLÜ örtüşmeli. Tek yönlü bir kontrol, kontrata yeni
// hata eklendiğinde sessizce ham revert göstermeye devam ederdi — ki onceki
// halinde tam olarak olan buydu (SessionNotActive/ChallengeExpired/LockedOut
// kontratta hic yok, buna karsilik 8 gercek hata hic eşlenmemisti).
const known = new Set(tx.KNOWN_CONTRACT_ERRORS);
const rendered = new Set(tx.RENDERED_ERRORS);
check(
  "haritadaki her hata ABI'de mevcut (olmayan = ölü kod)",
  [...rendered].every((n) => known.has(n)),
  [...rendered].filter((n) => !known.has(n)).join(",") || "hepsi eslesti",
);
check(
  "ABI'deki her hata ekranda anlamli bir mesaja sahip (eksik = ham revert)",
  [...known].every((n) => rendered.has(n)),
  [...known].filter((n) => !rendered.has(n)).join(",") || "hepsi eslesti",
);
check("15 hata da kapsaniyor", tx.KNOWN_CONTRACT_ERRORS.length === 15, `${tx.KNOWN_CONTRACT_ERRORS.length}`);

// --- dokümantasyon bütünlüğü ---------------------------------------------
// README'deki mimari diyagramlar hem GitHub'da (markdown) hem uygulamada
// (`next/image` → /public) görünür. Kökte bırakılan bir görsel README'de
// çalışır ama Next.js onu servis etmez ve panel sessizce boş kalır — o yüzden
// dosya yolu, varlığı ve boyut eşleşmesi test ediliyor.
section("10. MİMARİ DİYAGRAMLAR");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const DIAGRAMS = [
  ["01-client-enrolment.png", 1537, 656],
  ["02-onchain-verification.png", 1492, 677],
];
for (const [file, w, h] of DIAGRAMS) {
  const at = join(ROOT, "public", "diagrams", file);
  check(`${file} public/diagrams altinda`, existsSync(at), at);
  if (existsSync(at)) {
    const buf = readFileSync(at);
    // PNG genişlik/yükseklik IHDR'da: 8. bayttan sonraki 4+4 bayt.
    const pngW = buf.readUInt32BE(16);
    const pngH = buf.readUInt32BE(20);
    check(
      `${file} boyutlari kodla tutarli (CLS kaymasi olmaz)`,
      pngW === w && pngH === h,
      `png=${pngW}x${pngH} kod=${w}x${h}`,
    );
  }
  check(`${file} README'de referans veriliyor`, readme.includes(`public/diagrams/${file}`));
}
check("README'de mimari bolumu var", readme.includes("## Mimari akış"));
check(
  "README uyusmazliklari acikca yaziyor (SNARK kutusu sessizce gecilmemis)",
  readme.includes("ZK-SNARK Verifier Contract") && /karşılığı yok/i.test(readme),
);
check(
  "README'de video kanali olmadigi belirtiliyor",
  /video kanalı yok/i.test(readme),
);
check(
  "kok dizinde orphan gorsel kalmadi",
  !existsSync(join(ROOT, "web2_Diagram.png")) && !existsSync(join(ROOT, "web3_diagram.png")),
);

// Argümanli hatalar argümanini da gostermeli — "ChallengeMismatch" tekillestirme
// bilgisi vermedigi icin kullanici ne yapacagini bilemez.
check(
  "ChallengeMismatch hangi challenge oldugunu soyluyor",
  tx.describeTxError({ shortMessage: "reverted: ChallengeMismatch(3, 5)" }, "verifyCall").includes("3") &&
    tx.describeTxError({ shortMessage: "reverted: ChallengeMismatch(3, 5)" }, "verifyCall").includes("5"),
);
const staleMsg = tx.describeTxError({ shortMessage: "reverted: StaleAuthNonce(4, 7)" }, "verifyCall");
check(
  "StaleAuthNonce bayat nonce'u degerleriyle soyluyor",
  /nonce/i.test(staleMsg) && staleMsg.includes("4") && staleMsg.includes("7"),
  staleMsg,
);
check(
  "BaselineBindingMismatch witness kaybolmus diyor",
  tx.describeTxError({ shortMessage: "reverted: BaselineBindingMismatch()" }, "verifyCall").includes("witness"),
);

// Bekleme süresi matematiği kontratın private view'ıyla birebir aynı olmalı.
const cd = (changedAt, cooldown, now) => tx.cooldownRemaining({ lastBaselineChangeAt: changedAt, cooldownSeconds: cooldown, nowSeconds: now });
check("hic kayit yapmamis adres HICBEY BIR KISITLAMAYA tabi degil", cd(0n, 3600, 1_000_000) === 0);
check("kayittan hemen sonra tam sure", cd(1_000n, 3600, 1_000) === 3600);
check("saat gecmis yarida yarisi kaldi", cd(1_000n, 3600, 2_800) === 1_800);
check("saat dolunca engel kalkiyor", cd(1_000n, 3600, 4_600) === 0);
check("saat gecince negatif olmuyor", cd(1_000n, 3600, 99_999) === 0);
check("cooldown 0 ise hicbir engel yok", cd(1_000n, 0, 1_000) === 0);

check("sure bicimi: saniye", tx.formatDuration(42) === "42 saniye", tx.formatDuration(42));
check("sure bicimi: dakika", tx.formatDuration(600) === "10 dakika", tx.formatDuration(600));
check("sure bicimi: saat", tx.formatDuration(3600) === "1 saat", tx.formatDuration(3600));
check("sure bicimi: saat + dakika", tx.formatDuration(5400) === "1 saat 30 dakika", tx.formatDuration(5400));

// ---------------------------------------------------------------------------
// 8. Yazma hatalari — "Execution reverted for an unknown reason" duzelmeli
// ---------------------------------------------------------------------------
// Regresyon: kullanici `registerBaseline` gonderdi ve cevap
// "Execution reverted for an unknown reason" idi. Canli kontrat uzerinden
// dogrulandı: kontrat saglikli, her revert yolu duzgun 4 baytlik selector
// donuyor. Sorun suydu — cuzdan, gonderim oncesi kendi RPC ucunda simule
// ediyor ve bazi public uc noktalari revert verisini `-32000` ile YUTUYOR.
// Sonuc: revert yok sayiliyor ve kullanici 15 hatadan birinin anlamini ogrenemiyor.
//
// cozum: ayni cagri `from = adres` ile kendi RPC'mizde `eth_call` olarak
// tekrarlamak.
section("8. YAZMA HATA TESHISI");
const diag = req(join(OUT, "lib/chain/txDiagnostics.js"));
const abi = req(join(OUT, "lib/chain/contract.js")).aegisCallZkAbi;

// Canli zincirden alinan gercek revert payload'lari (testnet-rpc.monad.xyz)
const LIVE = {
  alreadyRegistered:
    "0x45ed80e9000000000000000000000000b5f3e266d9849f02bc1e0d2947c77e1ee41f3a76",
  commitmentAlreadySet: "0x5484c73f",
  zeroAddress: "0xd92e233d",
  cooldownActive:
    "0xc1ab61a10000000000000000000000000000000000000000000000000000000000000714",
  notRegistered:
    "0xbfc6c337000000000000000000000000000000000000000000000000000000000000dead",
};

check(
  "canli revert: AlreadyRegistered cozuluyor",
  diag.decodeRevertData(LIVE.alreadyRegistered, abi) === "AlreadyRegistered",
  diag.decodeRevertData(LIVE.alreadyRegistered, abi),
);
check(
  "canli revert: CooldownActive cozuluyor",
  diag.decodeRevertData(LIVE.cooldownActive, abi) === "CooldownActive",
);
check(
  "canli revert: NotRegistered cozuluyor",
  diag.decodeRevertData(LIVE.notRegistered, abi) === "NotRegistered",
);
check(
  "canli revert: ZeroAddress cozuluyor",
  diag.decodeRevertData(LIVE.zeroAddress, abi) === "ZeroAddress",
);
check(
  "canli revert: CommitmentAlreadySet cozuluyor",
  diag.decodeRevertData(LIVE.commitmentAlreadySet, abi) === "CommitmentAlreadySet",
);
check("veri yoksa isim de yok", diag.decodeRevertData(undefined, abi) === undefined);
check("bos veri isim vermiyor", diag.decodeRevertData("0x", abi) === undefined);

// Cooldown argumani hex selector'in ARDINDAN gelir; ham veride hata adi YOKTUR.
check(
  "CooldownActive(1812) icinden kalan sure cikariliyor (regresyon)",
  tx.renderContractError("CooldownActive", LIVE.cooldownActive, abi).includes("30 dakika"),
  tx.renderContractError("CooldownActive", LIVE.cooldownActive, abi),
);
check(
  "AlreadyRegistered ham veriden anlamli cumleye donusuyor",
  tx.renderContractError("AlreadyRegistered", LIVE.alreadyRegistered, abi).includes("zaten kayıtlı"),
);
check(
  "NotRegistered de cozuluyor",
  tx.renderContractError("NotRegistered", LIVE.notRegistered, abi).includes("kayıtlı değil"),
);
check(
  "argümansız hata veri olmadan da duzgun metin veriyor",
  tx.renderContractError("ZeroAddress").includes("sıfır"),
);

// Bilinmeyen selector: uydurma isim URETILMEMELI.
check(
  "ABI disi selector uydurma hata adi uretmiyor",
  diag.decodeRevertData("0xdeadbeef", abi) === undefined,
  String(diag.decodeRevertData("0xdeadbeef", abi)),
);
check(
  "selector eslesmesi elle de calisiyor (decodeErrorResult basarisiz olsa bile)",
  diag.selectorName("0x45ed80e9" + "00".repeat(12), abi) === "AlreadyRegistered",
  String(diag.selectorName("0x45ed80e9" + "00".repeat(12), abi)),
);
check("selector girdisi ABI disiysa undefined", diag.selectorName("0xdeadbeef", abi) === undefined);

// --- siniflandirma: wallet hatasi, kendi simülasyonumuz, ikisi birlikte -----
const render = (name, data) => tx.renderContractError(name, data, abi);
const walletSaysUnknown = "registerBaseline gönderilemedi: Execution reverted for an unknown reason.";

const decodedVerdict = diag.classifyWriteFailure({
  walletMessage: walletSaysUnknown,
  simulation: { reachable: true, ok: false, data: LIVE.cooldownActive, errorName: "CooldownActive" },
  functionName: "registerBaseline",
  renderError: render,
});
check(
  "wallet 'unknown reason' dediginde bizim cozumumuz kazanir",
  decodedVerdict.walletMessage.includes("Bekleme süresi") && decodedVerdict.authoritative,
  decodedVerdict.walletMessage,
);
check(
  "cooldown mesaji kalan sureyi iceriyor",
  decodedVerdict.walletMessage.includes("30 dakika"),
  decodedVerdict.walletMessage,
);

const walletSide = diag.classifyWriteFailure({
  walletMessage: walletSaysUnknown,
  simulation: { reachable: true, ok: true },
  functionName: "registerBaseline",
  renderError: render,
});
check(
  "simulasyon BASARILIYSA sorun kontratta degil, gonderim tarafinda",
  walletSide.walletMessage.includes("kontratta değil") && walletSide.authoritative,
  walletSide.walletMessage,
);

const lossyNode = diag.classifyWriteFailure({
  walletMessage: walletSaysUnknown,
  simulation: { reachable: true, ok: false, code: -32000, nodeMessage: "execution reverted" },
  functionName: "registerBaseline",
  renderError: render,
});
check(
  "dugum veri tasimiyorsa bu acikca soyleniyor (RPC onerisi veriliyor)",
  lossyNode.walletMessage.includes("-32000") && lossyNode.walletMessage.includes("RPC"),
  lossyNode.walletMessage,
);

const unreachable = diag.classifyWriteFailure({
  walletMessage: "cüzdan bağlantı hatası",
  simulation: { reachable: false, ok: false, nodeMessage: "Monad RPC'lerine ulaşılamadı" },
  functionName: "registerBaseline",
  renderError: render,
});
check(
  "hicbir uca ulasilamazsa cuzdanin mesaji korunur",
  unreachable.walletMessage.includes("bağlantı") && !unreachable.authoritative,
  unreachable.walletMessage,
);

check("simulasyon yokken bile mesaj uretiliyor", typeof decodedVerdict.walletMessage === "string" && decodedVerdict.walletMessage.length > 0);

// --- ASIL REGRESYON: canli hata nesnesinin TAM sekli ----------------------
// `estimateGas` hatası canlı zincirden bu şekilde geliyor. viem `data`'yı
// ExecutionRevertedError'da undefined yapıp mesajı node'un metninden kuruyor,
// sonuç "for an unknown reason" — oysa veri iki seviye aşağıda sağlam duruyor.
// Düzeltme: veri zincirden çıkarılıp lokalde çözülüyor (ağ turu gerekmez).
section("9. CANLI HATA NESNESİ — veri 3 seviye aşağıda");

/** The real chain, reproduced verbatim via viem's estimateGas. */
function viemRevertError(data) {
  return {
    name: "EstimateGasExecutionError",
    message: "Execution reverted for an unknown reason.",
    shortMessage: "Execution reverted for an unknown reason.",
    cause: {
      name: "ExecutionRevertedError",
      message: "Execution reverted for an unknown reason.",
      shortMessage: "Execution reverted for an unknown reason.",
      data: undefined,
      cause: {
        name: "RpcRequestError",
        message: "RPC Request failed.",
        shortMessage: "RPC Request failed.",
        data,
        cause: {
          message: "execution reverted",
          data,
          code: 3,
        },
      },
    },
  };
}

check(
  "revert verisi zincirin derinliginde bulunuyor",
  tx.deepestRevertData(viemRevertError(LIVE.alreadyRegistered)) === LIVE.alreadyRegistered,
  String(tx.deepestRevertData(viemRevertError(LIVE.alreadyRegistered))),
);
check("veri yoksa bulunmuyor (uydurma veri uretilmiyor)", tx.deepestRevertData({ message: "x" }) === undefined);

const liveAlready = tx.describeTxError(viemRevertError(LIVE.alreadyRegistered), "registerBaseline");
check(
  "canli hatadan anlamli mesaj cikiyor (regresyon)",
  liveAlready.includes("zaten kayıtlı") && !liveAlready.includes("unknown reason"),
  liveAlready,
);

const liveCooldown = tx.describeTxError(viemRevertError(LIVE.cooldownActive), "resetBaseline");
check(
  "canli cooldown hatasindan kalan sure cikiyor",
  liveCooldown.includes("Bekleme süresi") && liveCooldown.includes("30 dakika"),
  liveCooldown,
);

const liveNotReg = tx.describeTxError(viemRevertError(LIVE.notRegistered), "resetBaseline");
check("canli NotRegistered hatasi cozuluyor", liveNotReg.includes("kayıtlı değil"), liveNotReg);

const liveZero = tx.describeTxError(viemRevertError(LIVE.zeroAddress), "registerBaseline");
check("canli ZeroAddress hatasi cozuluyor", liveZero.includes("sıfır"), liveZero);

const liveUnknownSel = tx.describeTxError(viemRevertError("0xdeadbeef" + "00".repeat(32)), "verifyCall");
check(
  "ABI disi selector uydurma isim degil, selector'in kendisi soyleniyor",
  liveUnknownSel.includes("0xdeadbeef") && !/reddedildi: Kontrat \w+/.test(liveUnknownSel),
  liveUnknownSel,
);

// Gerçekten veri taşımayan hata: dürüst kalıyor, uydurma çözüm üretmiyor.
const noData = tx.describeTxError(
  { shortMessage: "User rejected the request", message: "User rejected the request" },
  "registerBaseline",
);
check(
  "veri yokken uydurma sebep yok (kullanici reddi oldugu gibi gorunuyor)",
  noData.includes("User rejected") && !noData.includes("reddedildi"),
  noData,
);

// ---------------------------------------------------------------------------
console.log(
  `\n${failed === 0 ? "[32m" : "[31m"}${passed} passed, ${failed} failed[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);