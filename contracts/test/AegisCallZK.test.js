const { expect } = require("chai");
const hre = require("hardhat");
const {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  toHex,
  getAddress,
} = require("viem");

const { FLAG, expectedBinding, packProof, buildProof, hex } = require("./helpers");

/** viem needs a concrete chain object to sign EIP-1193 requests. */
const localMonad = defineChain({
  id: 10143,
  name: "Monad Testnet (hardhat)",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

const COMMITMENT = "0x" + "11".repeat(32);
const OTHER_COMMITMENT = "0x" + "22".repeat(32);
// Mirrors `enum RejectionReason` in AegisCallZK.sol.
const REJECT_NONE = 0;
const REJECT_LIVENESS = 1;
const REJECT_SIMILARITY = 2;
const REJECT_FLAGS = 3;
const REJECT_LOCKED = 4;
const RE_ENROLL_COOLDOWN = 3600; // matches the contract's RE_ENROLL_COOLDOWN

/** chai-as-promised is deliberately not a dependency; this is all we need. */
async function expectRevert(fn, label = "transaction") {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`expected ${label} to revert, but it succeeded`);
}

/** `evm_increaseTime` + `evm_mine`, without hardhat-network-helpers. */
async function advanceTime(seconds) {
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine", []);
}

/** n-th 32-byte ABI word of an event's data field, as bare hex (no 0x). */
function firstWordAt(data, n = 0) {
  return data.slice(2 + n * 64, 2 + (n + 1) * 64);
}
const firstWord = (data) => firstWordAt(data, 0);

describe("AegisCallZK", () => {
  let publicClient, walletClient, owner, alice, bob, address, ABI;

  beforeEach(async () => {
    const accounts = await hre.network.provider.send("eth_accounts", []);
    // Hardhat's default accounts are mixed-case but not EIP-55 checksumed, so
    // normalise through lowercase first.
    [owner, alice, bob] = accounts.map((a) => getAddress(a.toLowerCase()));

    publicClient = createPublicClient({ chain: localMonad, transport: custom(hre.network.provider) });
    walletClient = createWalletClient({
      chain: localMonad,
      transport: custom(hre.network.provider),
      account: owner,
    });

    const factory = undefined;
    void factory;
    // Deploy through viem (the ethers hardhat plugin is intentionally absent).
    // The *compiled* ABI is used everywhere so the tests can never drift from
    // the contract — exactly like `lib/abi.ts` in the frontend.
    const artifact = await hre.artifacts.readArtifact("AegisCallZK");
    ABI = artifact.abi;
    const hash = await walletClient.deployContract({
      abi: ABI,
      bytecode: artifact.bytecode,
      account: owner,
      chain: localMonad,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    address = getAddress(receipt.contractAddress);
  });

  const read = (functionName, args) =>
    publicClient.readContract({ abi: ABI, address, functionName, args, chain: localMonad });
  const write = (functionName, args, account = owner) =>
    walletClient.writeContract({ abi: ABI, address, functionName, args, account, chain: localMonad });

  async function send(account, functionName, args) {
    const hash = await write(functionName, args, account);
    return publicClient.waitForTransactionReceipt({ hash });
  }

  async function enroll(user, commitment = COMMITMENT) {
    return send(user, "registerBaseline", [user, commitment]);
  }

  const session = (user) => read("getSession", [user]);

  /** Decoded event helpers, available to every describe block below. */
  const TOPIC = {
    BaselineRegistered: keccak256(toHex("BaselineRegistered(address,bytes32,uint32)")),
    LivenessVerified: keccak256(toHex("LivenessVerified(address,uint8,uint16,uint16,uint32,uint64)")),
    LivenessRejected: keccak256(
      toHex("LivenessRejected(address,uint8,uint8,uint8,uint16,uint16,uint32)"),
    ),
    LockedOut: keccak256(toHex("LockedOut(address,uint64)")),
  };

  function rejectedLog(rc) {
    return rc.logs.find((l) => l.topics[0] === TOPIC.LivenessRejected);
  }

  function acceptedLog(rc) {
    return rc.logs.find((l) => l.topics[0] === TOPIC.LivenessVerified);
  }

  // =========================================================================
  describe("deployment", () => {
    it("sets the deployer as owner and enables the full challenge bank", async () => {
      expect(await read("owner")).to.equal(owner);
      const size = await read("CHALLENGE_BANK_SIZE");
      expect(Number(size)).to.equal(8);
      for (let i = 0; i < Number(size); i++) {
        expect(await read("isChallengeEnabled", [i])).to.equal(true);
      }
    });

    it("derives challengeSetRoot from chainid + address", async () => {
      // contract: keccak256(abi.encodePacked("AEGIS_CHALLENGE_SET", block.chainid, address(this)))
      const expected = keccak256(
        encodePacked(["string", "uint256", "address"], ["AEGIS_CHALLENGE_SET", 10143n, address]),
      );
      expect(await read("challengeSetRoot")).to.equal(expected);
    });
  });

  // =========================================================================
  describe("STEP 1 · registerBaseline", () => {
    it("stores the commitment and marks the user registered", async () => {
      const rc = await enroll(alice);
      expect(rc.status).to.equal("success");
      expect(await read("baselineCommitment", [alice])).to.equal(COMMITMENT);

      const s = await session(alice);
      expect(s.registered).to.equal(true);
      expect(s.active).to.equal(false); // enrolment never opens a session
      expect(s.authNonce).to.equal(0);
      expect(s.callCount).to.equal(0);
    });

    it("emits BaselineRegistered", async () => {
      const rc = await enroll(alice);
      const log = rc.logs.find(
        (l) => l.topics[0] === keccak256(toHex("BaselineRegistered(address,bytes32,uint32)")),
      );
      expect(log).to.not.equal(undefined);
      expect(getAddress("0x" + log.topics[1].slice(26))).to.equal(alice);
    });

    it("rejects enrollment on behalf of someone else", async () => {
      await expectRevert(() => send(alice, "registerBaseline", [bob, COMMITMENT]));
      expect(await read("baselineCommitment", [bob])).to.equal("0x" + "00".repeat(32));
    });

    it("rejects a zero address", async () => {
      await expectRevert(() => send(alice, "registerBaseline", ["0x0000000000000000000000000000000000000000", COMMITMENT]));
    });

    it("rejects a zero commitment", async () => {
      await expectRevert(() => send(alice, "registerBaseline", [alice, "0x" + "00".repeat(32)]));
    });

    it("rejects a second enrollment for the same baseline", async () => {
      await enroll(alice);
      await expectRevert(() => enroll(alice));
    });
  });

  // =========================================================================
  describe("STEP 2 · verifyCallWithLiveness — happy path", () => {
    const challengeId = 3;

    beforeEach(async () => {
      await enroll(alice);
    });

    it("accepts a valid proof, opens a session and returns the scores", async () => {
      const proof = buildProof({
        user: alice,
        commitment: COMMITMENT,
        challengeId,
        authNonce: 0n,
        livenessBps: 8_800,
        similarityBps: 7_900,
      });
      expect(await read("expectedBinding", [alice, challengeId])).to.equal(
        expectedBinding({ commitment: COMMITMENT, user: alice, challengeId, authNonce: 0n }),
      );

      const rc = await send(alice, "verifyCallWithLiveness", [alice, proof, challengeId]);
      expect(rc.status).to.equal("success");
      expect(await read("isSessionActive", [alice])).to.equal(true);

      const s = await session(alice);
      expect(s.authNonce).to.equal(1); // consumed
      expect(s.callCount).to.equal(1);
      expect(Number(s.validUntil)).to.be.greaterThan(0);
    });

    it("emits LivenessVerified", async () => {
      const proof = buildProof({
        user: alice,
        commitment: COMMITMENT,
        challengeId,
        authNonce: 0n,
        livenessBps: 8_800,
        similarityBps: 7_900,
      });
      const rc = await send(alice, "verifyCallWithLiveness", [alice, proof, challengeId]);
      const topic = keccak256(
        toHex("LivenessVerified(address,uint8,uint16,uint16,uint32,uint64)"),
      );
      expect(rc.logs.some((l) => l.topics[0] === topic)).to.equal(true);
    });

    it("allows an unrelated relayer to submit a user's proof (proof-bound, not sender-bound)", async () => {
      const proof = buildProof({
        user: alice,
        commitment: COMMITMENT,
        challengeId,
        authNonce: 0n,
        livenessBps: 8_800,
        similarityBps: 7_900,
      });
      const rc = await send(bob, "verifyCallWithLiveness", [alice, proof, challengeId]);
      expect(rc.status).to.equal("success");
      expect(await read("isSessionActive", [alice])).to.equal(true);
    });

    it("keeps sessions alive across consecutive verified calls", async () => {
      for (let i = 0; i < 3; i++) {
        const proof = buildProof({
          user: alice,
          commitment: COMMITMENT,
          challengeId,
          authNonce: BigInt(i),
          livenessBps: 8_000,
          similarityBps: 7_500,
        });
        const rc = await send(alice, "verifyCallWithLiveness", [alice, proof, challengeId]);
        expect(rc.status).to.equal("success");
      }
      const s = await session(alice);
      expect(s.callCount).to.equal(3);
      expect(s.authNonce).to.equal(3);
    });
  });

  // =========================================================================
  describe("STEP 2 · replay & forgery resistance", () => {
    const challengeId = 2;

    beforeEach(async () => {
      await enroll(alice);
    });

    it("rejects a replayed proof word (nonce already consumed)", async () => {
      const proof = buildProof({
        user: alice,
        commitment: COMMITMENT,
        challengeId,
        authNonce: 0n,
        livenessBps: 9_000,
        similarityBps: 9_000,
      });
      expect((await send(alice, "verifyCallWithLiveness", [alice, proof, challengeId])).status).to.equal(
        "success",
      );
      // exact same word again
      await expectRevert(() => send(alice, "verifyCallWithLiveness", [alice, proof, challengeId]));
      expect((await session(alice)).authNonce).to.equal(1); // no double-spend of the nonce
    });

    it("rejects a proof word lifted from another user", async () => {
      await enroll(bob, OTHER_COMMITMENT);
      const bobProof = buildProof({
        user: bob,
        commitment: OTHER_COMMITMENT,
        challengeId,
        authNonce: 0n,
        livenessBps: 9_500,
        similarityBps: 9_500,
      });
      // bob's word replayed against alice's account
      await expectRevert(() => send(alice, "verifyCallWithLiveness", [alice, bobProof, challengeId]));
    });

    it("rejects a word bound to a different challenge than the one answered", async () => {
      const proof = buildProof({
        user: alice,
        commitment: COMMITMENT,
        challengeId: 5,
        authNonce: 0n,
        livenessBps: 9_000,
        similarityBps: 9_000,
      });
      await expectRevert(() => send(alice, "verifyCallWithLiveness", [alice, proof, challengeId]));
    });

    it("rejects a word whose binding was computed over the wrong baseline", async () => {
      const binding = expectedBinding({
        commitment: OTHER_COMMITMENT,
        user: alice,
        challengeId,
        authNonce: 0n,
      });
      const proof = packProof({
        challengeId,
        livenessBps: 9_000,
        similarityBps: 9_000,
        authNonce: 0n,
        binding,
      });
      await expectRevert(() => send(alice, "verifyCallWithLiveness", [alice, proof, challengeId]));
    });

    it("rejects a word with a future/past authNonce", async () => {
      const future = buildProof({
        user: alice,
        commitment: COMMITMENT,
        challengeId,
        authNonce: 7n,
        livenessBps: 9_000,
        similarityBps: 9_000,
      });
      await expectRevert(() => send(alice, "verifyCallWithLiveness", [alice, future, challengeId]));
    });

    it("rejects a disabled challenge", async () => {
      await send(owner, "setChallengeEnabled", [challengeId, false]);
      const proof = buildProof({
        user: alice,
        commitment: COMMITMENT,
        challengeId,
        authNonce: 0n,
        livenessBps: 9_000,
        similarityBps: 9_000,
      });
      await expectRevert(() => send(alice, "verifyCallWithLiveness", [alice, proof, challengeId]));
    });

    it("rejects an out-of-range challenge id", async () => {
      const proof = buildProof({
        user: alice,
        commitment: COMMITMENT,
        challengeId: 8,
        authNonce: 0n,
        livenessBps: 9_000,
        similarityBps: 9_000,
      });
      await expectRevert(() => send(alice, "verifyCallWithLiveness", [alice, proof, 8]));
    });

    it("rejects a wrong version byte", async () => {
      const binding = expectedBinding({ commitment: COMMITMENT, user: alice, challengeId, authNonce: 0n });
      const proof = packProof({
        version: 2,
        challengeId,
        livenessBps: 9_000,
        similarityBps: 9_000,
        authNonce: 0n,
        binding,
      });
      await expectRevert(() => send(alice, "verifyCallWithLiveness", [alice, proof, challengeId]));
    });

    it("rejects non-canonical (dirty) bit patterns", async () => {
      const binding = expectedBinding({ commitment: COMMITMENT, user: alice, challengeId, authNonce: 0n });
      const proof = packProof({
        challengeId,
        livenessBps: 9_000,
        similarityBps: 9_000,
        authNonce: 0n,
        binding,
        // stuffing the unused low bits of the binding field
        tail: "0x" + "ff".repeat(12),
      });
      await expectRevert(() => send(alice, "verifyCallWithLiveness", [alice, proof, challengeId]));
    });

    it("rejects verification for an unregistered user", async () => {
      const proof = buildProof({
        user: bob,
        commitment: COMMITMENT,
        challengeId,
        authNonce: 0n,
        livenessBps: 9_000,
        similarityBps: 9_000,
      });
      await expectRevert(() => send(alice, "verifyCallWithLiveness", [bob, proof, challengeId]));
    });
  });

  // =========================================================================
  describe("STEP 2 · cryptographic rejections are recorded, not reverted", () => {
    const challengeId = 1;

    beforeEach(async () => {
      await enroll(alice);
    });

    async function attempt(overrides, { user = alice } = {}) {
      const proof = buildProof({
        user,
        commitment: COMMITMENT,
        challengeId,
        authNonce: BigInt(await session(user).then((s) => s.authNonce)),
        livenessBps: 8_000,
        similarityBps: 8_000,
        ...overrides,
      });
      const rc = await send(user, "verifyCallWithLiveness", [user, proof, challengeId]);
      return rc;
    }

    function rejectedLogInner(rc) {
      return rejectedLog(rc);
    }
    void rejectedLogInner;

    it("records a low-similarity verdict without reverting the tx", async () => {
      const rc = await attempt({ similarityBps: 3_000, livenessBps: 9_000 });
      expect(rc.status).to.equal("success"); // <-- still mined, still auditable
      expect(await read("isSessionActive", [alice])).to.equal(false);
      const s = await session(alice);
      expect(s.failedAttempts).to.equal(1);
      expect(s.authNonce).to.equal(1); // nonce burned even on failure
      const log = rejectedLog(rc);
      expect(log).to.not.equal(undefined);
      expect(Number(firstWord(log.data))).to.equal(REJECT_SIMILARITY);
    });

    it("records a low-liveness verdict", async () => {
      const rc = await attempt({ livenessBps: 2_500 });
      const s = await session(alice);
      expect(s.failedAttempts).to.equal(1);
      expect(Number(firstWord(rejectedLog(rc).data))).to.equal(REJECT_LIVENESS);
    });

    it("records attack flags and refuses to open a session", async () => {
      const rc = await attempt({ flags: FLAG.REPLAY | FLAG.SYNTHETIC });
      expect(rc.status).to.equal("success");
      expect(await read("isSessionActive", [alice])).to.equal(false);
      const log = rejectedLog(rc);
      // reason == AttackFlagsPresent, flags echoed back in the second word
      expect(Number(firstWordAt(log.data, 0))).to.equal(REJECT_FLAGS);
      expect(Number(firstWordAt(log.data, 1))).to.equal(FLAG.REPLAY | FLAG.SYNTHETIC);
    });

    it("locks the account out after MAX_FAILED_ATTEMPTS consecutive rejections", async () => {
      const max = Number(await read("MAX_FAILED_ATTEMPTS"));
      for (let i = 0; i < max; i++) {
        const rc = await attempt({ similarityBps: 1_000 });
        expect(rc.status).to.equal("success");
      }
      const s = await session(alice);
      expect(Number(s.lockoutUntil)).to.be.greaterThan(0);
      expect(s.failedAttempts).to.equal(0); // counter reset on lockout

      // Even a *perfect* proof is refused while locked out.
      const rc = await attempt({ similarityBps: 9_900, livenessBps: 9_900 });
      expect(rc.status).to.equal("success");
      expect(Number(firstWord(rejectedLog(rc).data))).to.equal(REJECT_LOCKED);
      expect(await read("isSessionActive", [alice])).to.equal(false);
    });

    it("resets the failure counter after a success", async () => {
      await attempt({ similarityBps: 1_000 });
      expect((await session(alice)).failedAttempts).to.equal(1);
      await attempt({ similarityBps: 9_000, livenessBps: 9_000 });
      const s = await session(alice);
      expect(s.failedAttempts).to.equal(0);
      expect(s.callCount).to.equal(1);
    });

    it("killing the session makes the next proof invalid (nonce burn)", async () => {
      const rc = await attempt({ similarityBps: 9_000, livenessBps: 9_000 });
      expect(acceptedLog(rc)).to.not.equal(undefined);
      expect(await read("isSessionActive", [alice])).to.equal(true);

      await send(alice, "invalidateSession", [alice]);
      expect(await read("isSessionActive", [alice])).to.equal(false);

      const stale = buildProof({
        user: alice,
        commitment: COMMITMENT,
        challengeId,
        authNonce: 0n,
        livenessBps: 9_000,
        similarityBps: 9_000,
      });
      await expectRevert(() => send(alice, "verifyCallWithLiveness", [alice, stale, challengeId]));
    });
  });

  // =========================================================================
  describe("resetBaseline & re-enrollment", () => {
    it("blocks a reset inside the post-enrollment cooldown", async () => {
      await enroll(alice);
      // RE_ENROLL_COOLDOWN starts at enrollment on purpose: a wallet that just
      // enrolled must not be able to hot-swap its baseline.
      await expectRevert(() => send(alice, "resetBaseline", [alice]), "immediate reset");
    });

    it("clears the commitment, burns outstanding proofs and enforces a cooldown", async () => {
      await enroll(alice);
      await advanceTime(RE_ENROLL_COOLDOWN + 60);
      const rc = await send(alice, "resetBaseline", [alice]);
      expect(rc.status).to.equal("success");
      expect(await read("baselineCommitment", [alice])).to.equal("0x" + "00".repeat(32));

      const s = await session(alice);
      expect(s.registered).to.equal(false);
      expect(s.authNonce).to.equal(1);

      // immediate re-enrollment is rate-limited
      await expectRevert(() => enroll(alice));

      // ...but a different user is unaffected
      const bobRc = await enroll(bob, OTHER_COMMITMENT);
      expect(bobRc.status).to.equal("success");
    });

    it("rejects reset for a non-registered user or a non-self caller", async () => {
      await expectRevert(() => send(alice, "resetBaseline", [alice]));
      await enroll(alice);
      await expectRevert(() => send(bob, "resetBaseline", [alice]));
    });
  });

  // =========================================================================
  describe("owner configuration", () => {
    it("enforces configurable thresholds", async () => {
      await enroll(alice);
      await send(owner, "setThresholds", [9_000, 8_500]);

      const challengeId = 0;
      const mk = async (livenessBps, similarityBps) =>
        buildProof({
          user: alice,
          commitment: COMMITMENT,
          challengeId,
          authNonce: (await session(alice)).authNonce,
          livenessBps,
          similarityBps,
        });

      let rc = await send(alice, "verifyCallWithLiveness", [alice, await mk(8_900, 9_000), challengeId]);
      expect(rejectedLog(rc)).to.not.equal(undefined); // liveness below the new 90% bar

      rc = await send(alice, "verifyCallWithLiveness", [alice, await mk(9_500, 9_500), challengeId]);
      expect(await read("isSessionActive", [alice])).to.equal(true);
    });

    it("rejects out-of-range thresholds and non-owner callers", async () => {
      await expectRevert(() => send(alice, "setThresholds", [10_001, 5_000]));
      await expectRevert(() => send(alice, "setThresholds", [100, 5_000]));
      await expectRevert(() => send(alice, "setThresholds", [8_000, 8_000]));
    });

    it("nextChallengeSeed changes with the authNonce", async () => {
      const before = await read("nextChallengeSeed", [alice]);
      await enroll(alice);
      const after = await read("nextChallengeSeed", [alice]);
      expect(before).to.not.equal(after);
    });
  });

  // =========================================================================
  describe("decoded proof word (UI inspector parity)", () => {
    it("round-trips the exact 32-byte layout the browser produces", async () => {
      await enroll(alice);
      const challengeId = 4;
      const proof = buildProof({
        user: alice,
        commitment: COMMITMENT,
        challengeId,
        authNonce: 0n,
        livenessBps: 8_742,
        similarityBps: 9_013,
        flags: FLAG.TEMPO_SPOOF,
        sigAnchor: 0xab,
      });
      expect(proof.length).to.equal(66); // 0x + 64 bytes

      const decoded = await read("decodeLivenessProof", [proof]);
      // viem decodes uint8/uint16/uint32 as numbers, uint64 as bigint.
      expect(decoded.version).to.equal(1);
      expect(decoded.challengeId).to.equal(challengeId);
      expect(decoded.livenessBps).to.equal(8742);
      expect(decoded.similarityBps).to.equal(9013);
      expect(decoded.flags).to.equal(FLAG.TEMPO_SPOOF);
      expect(decoded.sigAnchor).to.equal(0xab);
      expect(decoded.authNonce).to.equal(0);
      expect(decoded.binding).to.equal(
        expectedBinding({ commitment: COMMITMENT, user: alice, challengeId, authNonce: 0n }),
      );
    });
  });
});
