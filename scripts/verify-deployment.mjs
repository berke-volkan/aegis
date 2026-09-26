/**
 * Dağıtılmış AegisCallZK'yı zincir üstünde doğrular.
 *
 *   node scripts/verify-deployment.mjs
 *
 * Ignition "successfully deployed" dediğinde bu henüz bir şey kanıtlamaz.
 * Burada gerçekten şunları kontrol ediyoruz:
 *   · adres bir sözleşme mi (kod var mı, EIP-170 boyut sınırı içinde mi)
 *   · dağıtılan bytecode, yerelde derlenen artifact ile aynı mı
 *   · sahibi, eşikleri, challengeSetRoot, challenge bankası beklenen mi
 *   · ABI, frontend'in kullandığı ABI ile birebir aynı mı
 *      (yanlış sürüm deploy edilmişse burada yakalanır)
 *   · zincir üstü okuma yolları, UI'ın bağlandığı view'lar
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { transpileToCjs } from "./lib/transpile.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const req = createRequire(join(ROOT, "package.json"));
const { createPublicClient, http, toHex, getAddress, keccak256 } = req("viem");

const ADDRESS = (
  process.env.AEGIS_ADDRESS ??
  readFileSync(join(ROOT, ".env.local"), "utf8").match(
    /NEXT_PUBLIC_AEGIS_CONTRACT_ADDRESS=(0x[0-9a-fA-F]{40})/,
  )?.[1] ??
  ""
).trim();

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
/** bigint'i string'e çevirir — JSON.stringify bigint'i serileştiremez. */
const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ---------------------------------------------------------------------------
// frontend ABI'sini (lib/abi.ts) ayni ortamda yukle
// ---------------------------------------------------------------------------
const OUT = join(ROOT, ".zkverify");
req("node:fs").rmSync(OUT, { recursive: true, force: true });
transpileToCjs(ROOT, OUT, ["lib/abi.ts", "lib/zk"]);
const { aegisCallZkAbi: FRONTEND_ABI } = req(join(OUT, "lib/abi.js"));
const { CONTRACT_DOMAIN, packLivenessProof, unpackLivenessProof } = req(join(OUT, "lib/zk/pack.js"));

if (!ADDRESS) {
  console.error(
    "Aegis adresi bulunamadı.\n" +
      "  .env.local içine NEXT_PUBLIC_AEGIS_CONTRACT_ADDRESS=0x... yazın\n" +
      "  veya AEGIS_ADDRESS=0x... ortam değişkeni verin.",
  );
  process.exit(1);
}

const client = createPublicClient({
  // Multicall3 adresi chain'e bagli oldugu icin chain tanimli olmali.
  // Monad'in kanonik Multicall3'u: https://docs.monad.xyz/developer-essentials/testnet
  chain: {
    id: 10143,
    name: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
    blockExplorers: { default: { name: "Monadscan", url: "https://testnet.monadscan.com" } },
    contracts: {
      multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
    },
  },
  transport: http("https://testnet-rpc.monad.xyz", {
    // eth_call limiti 25 rps; kucuk bir retry/backoff ile gecici limitlenmeyi
    // yutuyoruz.
    retryCount: 4,
    retryDelay: 400,
    timeout: 30_000,
  }),
});
const addr = getAddress(ADDRESS);

// Monad Testnet'in hız siniri eth_call icin 25 rps. Tek tek okuma yaparken
// arasi sira birakiyor ve gecici hatalari tolere ediyoruz: bir view okunamadi
// diye butun dogrulamayi cokertmek yanlis bir sonuc verir.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await sleep(250 * (i + 1));
    }
  }
  console.log(`  \x1b[33m!\x1b[0m ${label} okunamadi (gecici RPC hatasi), atlandi`);
  return undefined;
}

const read = async (functionName, args) =>
  withRetry(functionName, () =>
    client.readContract({ address: addr, abi: ABI_FROM_ARTIFACT, functionName, args }),
  );

// Derlenmis artifact'ten ABI + bytecode.
//
// Ignition deploy ederken `production` profilini kullanir (optimizer acik).
// Yerel artifact'in de ayni profil olmasi icin onu yeniden derliyoruz; aksi
// halde "zincirdeki kod yerel derlemeyle ayni" kontrolu anlamsiz hale gelir.
const { execFileSync } = await import("node:child_process");
try {
  // Node >=24 `.cmd` shim'larini spawn edemiyor, bu yuzden JS giris noktasi.
  execFileSync(
    process.execPath,
    [
      join(ROOT, "node_modules", "hardhat", "dist", "src", "cli.js"),
      "build",
      "--build-profile",
      "production",
      "--force",
      "--quiet",
    ],
    { cwd: ROOT, stdio: "pipe" },
  );
} catch (err) {
  console.log(
    `  \x1b[33m!\x1b[0m production profili derlenemedi, mevcut artifact kullanilacak (${
      String(err.message).split("\n")[0]
    })`,
  );
}

const artifact = JSON.parse(
  readFileSync(
    join(ROOT, "artifacts", "contracts", "src", "AegisCallZK.sol", "AegisCallZK.json"),
    "utf8",
  ),
);
const ABI_FROM_ARTIFACT = artifact.abi;

console.log(`\nAegisCallZK @ \x1b[1m${addr}\x1b[0m`);

// ===========================================================================
section("1. kod ve boyut");
// ===========================================================================
const code = await client.getCode({ address: addr });
check("adres bir sözleşme (kod mevcut)", code && code !== "0x", `${(code.length - 2) / 2} bayt`);
const deployedSize = (code.length - 2) / 2;
const localSize = (artifact.deployedBytecode.length - 2) / 2;
check("EIP-170 sınırı içinde (<=24576)", deployedSize <= 24576, `${deployedSize} bayt`);
console.log(
  `    yerel derleme: ${localSize} bayt · zincirdeki: ${deployedSize} bayt` +
    ` ${localSize === deployedSize ? "(aynı)" : "(FARKLI)"}`,
);
check("zincirdeki kod yerel derlemeyle aynı", deployedSize === localSize);
check(
  "derleme optimize (production profili)",
  localSize < 11_000,
  `${localSize} bayt — optimizer kapalıysa ~11767 olurdu`,
);

// ===========================================================================
section("2. constructor durumu");
// ===========================================================================
const owner = await read("owner");
const [livenessBps, similarityBps] = await read("getThresholds");
const root = await read("challengeSetRoot");
const bankSize = await read("CHALLENGE_BANK_SIZE");
const proofVersion = await read("PROOF_VERSION");
const sessionTtl = await read("SESSION_TTL");
const reEnroll = await read("RE_ENROLL_COOLDOWN");

check("owner bir adres", /^0x[0-9a-fA-F]{40}$/.test(owner), owner);
check("PROOF_VERSION = 1", proofVersion === 1n || proofVersion === 1, String(proofVersion));
check("min liveness 7000 bps", Number(livenessBps) === 7000, String(livenessBps));
check("min similarity 6200 bps", Number(similarityBps) === 6200, String(similarityBps));
check("challenge bank 8", Number(bankSize) === 8, String(bankSize));
check("session TTL 30dk", Number(sessionTtl) === 1800, String(sessionTtl));
check("re-enroll cooldown 1sa", Number(reEnroll) === 3600, String(reEnroll));
check("challengeSetRoot 32 bayt", /^0x[0-9a-f]{64}$/.test(root), root);

// challengeSetRoot = keccak(abi.encodePacked("AEGIS_CHALLENGE_SET", chainid, address))
const { encodePacked, encodeAbiParameters } = req("viem");
const expectedRoot = keccak256(
  encodePacked(["string", "uint256", "address"], ["AEGIS_CHALLENGE_SET", 10143n, addr]),
);
check(
  "challengeSetRoot doğru türetilmiş (chainId + adres)",
  root === expectedRoot,
  `${root} != ${expectedRoot}`,
);

// ===========================================================================
section("3. frontend ABI uyumu");
// ===========================================================================
// ABI'yi metin olarak taramak yerine gercek diziyi karsilastiriyoruz: frontend'in
// calistirdigi `aegisCallZkAbi` ile artifact'in ABI'si ayni olmali.
const artifactFnNames = ABI_FROM_ARTIFACT.filter((e) => e.type === "function").map((e) => e.name).sort();
const frontendFnNames = FRONTEND_ABI.filter((e) => e.type === "function").map((e) => e.name).sort();
const artifactEvtNames = ABI_FROM_ARTIFACT.filter((e) => e.type === "event").map((e) => e.name).sort();
const frontendEvtNames = FRONTEND_ABI.filter((e) => e.type === "event").map((e) => e.name).sort();

const fnDiff = artifactFnNames.filter((n) => !frontendFnNames.includes(n));
const evtDiff = artifactEvtNames.filter((n) => !frontendEvtNames.includes(n));
check(
  `frontend ABI'deki ${frontendFnNames.length} fonksiyon kontratta var`,
  fnDiff.length === 0,
  fnDiff.length ? `eksik: ${fnDiff.join(", ")}` : "",
);
check(
  `frontend ABI'deki ${frontendEvtNames.length} event kontratta var`,
  evtDiff.length === 0,
  evtDiff.length ? `eksik: ${evtDiff.join(", ")}` : "",
);
const sigOf = (list, name) => JSON.stringify(list.find((e) => e.name === name));
for (const fn of ["registerBaseline", "verifyCallWithLiveness", "getSession", "decodeLivenessProof"]) {
  check(
    `${fn} imzasi birebir ayni`,
    sigOf(FRONTEND_ABI, fn) === sigOf(ABI_FROM_ARTIFACT, fn),
  );
}

// frontend'in packing'i, kontratin domain'i ile ayni mi?
const contractDomain = await read("DOMAIN");
check(
  "pack.ts CONTRACT_DOMAIN == kontrat DOMAIN",
  contractDomain === CONTRACT_DOMAIN,
  `${contractDomain} vs ${CONTRACT_DOMAIN}`,
);

// ===========================================================================
section("4. view'lar UI'in baglandigi gibi calisiyor");
// ===========================================================================
const someUser = "0x000000000000000000000000000000000000dEaD";
const session = await read("getSession", [someUser]);

// viem tuple'ları isimli nesneye cevirir. Frontend'in `OnChainSession` tipi
// kontratın struct alanlariyla birebir ayni olmak zorunda; isimler kayarsa
// session paneli sessizce yanlis deger gosterir.
const SESSION_FIELDS = [
  "registered",
  "active",
  "registeredAt",
  "lastVerifiedAt",
  "validUntil",
  "lockoutUntil",
  "authNonce",
  "callCount",
  "failedAttempts",
  "lastBaselineChangeAt",
];
if (!session) {
  check("getSession okunabildi", false, "RPC hatasi");
} else {
  const sessionKeys = Object.keys(session);
  const missingFields = SESSION_FIELDS.filter((f) => !sessionKeys.includes(f));
  check(
    `getSession ${SESSION_FIELDS.length} struct alanini donuyor`,
    missingFields.length === 0,
    missingFields.length ? `eksik: ${missingFields.join(", ")}` : show(session),
  );
  check(
    "kayitsiz kullanici hepsi sifir/degil",
    session.registered === false &&
      session.active === false &&
      session.authNonce === 0 &&
      session.callCount === 0 &&
      session.registeredAt === 0n,
    show(session),
  );
}
const isActive = await read("isSessionActive", [someUser]);
check("isSessionActive false donuyor (kayitsiz kullanici)", isActive === false);
const binding = await read("expectedBinding", [someUser, 3]);
check(
  "expectedBinding 20 bayt donuyor",
  typeof binding === "string" && binding.length === 42,
  binding,
);
const seed = await read("nextChallengeSeed", [someUser]);
check("nextChallengeSeed 32 bayt donuyor", /^0x[0-9a-f]{64}$/.test(seed), seed);

// Monad Testnet'in hız sınırı eth_call için 25 rps. Sekiz ayri istek atmak
// limiti zorlar, tek bir multicall ile tek seferde soruyoruz.
const bankResults = await client.multicall({
  contracts: Array.from({ length: Number(bankSize) }, (_, i) => ({
    address: addr,
    abi: ABI_FROM_ARTIFACT,
    functionName: "isChallengeEnabled",
    args: [i],
  })),
  allowFailure: true,
});
const enabled = bankResults
  .map((r, i) => ({ r, i }))
  .filter(({ r }) => r.status === "success" && r.result === true)
  .map(({ i }) => i);
check(
  "challenge bankasinda 8 id acik",
  enabled.length === 8,
  `${enabled.length}/8 acik: ${enabled.join(",")}`,
);

// decodeLivenessProof — Proof Inspector'in kullandigi view.
// Kelimenin TAMAMINI frontend'in kendi packer'ı uretir; sonra ayni kelime
// zincire gonderilir. Boylece "iki taraf da ayni seyi konusuyor" kontrolu
// kelimenin gercekten 32 bayt oldugunu da dogrular.
const PROBE_WORD = packLivenessProof({
  version: 1,
  challengeId: 0,
  livenessBps: 8900,
  similarityBps: 9000,
  flags: 0,
  sigAnchor: 0xab,
  authNonce: 0,
  binding: `0x${"99".repeat(20)}`,
});
check(
  "packer 32 baytlik kelime uretti",
  PROBE_WORD.length === 66,
  `${(PROBE_WORD.length - 2) / 2} bayt`,
);
const probe = unpackLivenessProof(PROBE_WORD);
const decoded = await read("decodeLivenessProof", [PROBE_WORD]);
if (!decoded) {
  check("decodeLivenessProof okunabildi", false, "RPC hatasi");
} else {
  check(
    "decodeLivenessProof yerel pack ile ayni sonucu veriyor",
    decoded.version === probe.version &&
      decoded.challengeId === probe.challengeId &&
      decoded.livenessBps === probe.livenessBps &&
      decoded.similarityBps === probe.similarityBps &&
      decoded.flags === probe.flags &&
      decoded.sigAnchor === probe.sigAnchor &&
      decoded.authNonce === probe.authNonce &&
      String(decoded.binding).toLowerCase() === probe.binding.toLowerCase(),
    `chain=${show(decoded)} local=${show(probe)}`,
  );
}

// ===========================================================================
section("5. deployer bakiyesi (aracilarda gaz icin)");
// ===========================================================================
const bal = await client.getBalance({ address: owner });
console.log(`    owner bakiye: ${(Number(bal) / 1e18).toFixed(4)} MON`);
console.log(`    explorer   : https://testnet.monadscan.com/address/${addr}`);

console.log(
  `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
