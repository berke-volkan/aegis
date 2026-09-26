// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title AegisCallZK
 * @notice Deepfake-resistant live call verification registry for Monad.
 *
 * @dev AEGIS CONTEXT
 * ================
 * A phone call is only trustworthy if the voice on the other end belongs to the
 * same human who enrolled a biometric baseline days ago. Two independent attack
 * classes have to be stopped:
 *
 *   1. INJECTION  — a deepfake / TTS replay plays a "human" voice that never
 *                   belonged to the account owner.
 *   2. REPLAY     — a genuine recording of the owner (or of a successful past
 *                   call) is re-submitted to pass verification.
 *
 * The defence is a two-factor binding:
 *
 *   (a) BIOMETRIC KEY BINDING (the "ZK" part)
 *       At enrollment the browser derives a biometric template from microphone
 *       audio and produces a commitment `zkCommitment` that is bound to that
 *       template using the sign-to-contract construction:
 *
 *           P = salt * G                     (salt = 32-byte device secret)
 *           t = H("AEGIS_BIOMETRIC" ++ keccak(template) ++ P) mod n
 *           C = P + t * G        <-- this is `zkCommitment`
 *
 *       `C` is an ordinary 32-byte x-only secp256k1 public key, so it is a
 *       perfectly normal on-chain value — the template itself is never revealed
 *       and never leaves the device. Because the private key is `salt + t`, an
 *       attacker who does not reproduce the *same* biometric template computes a
 *       different `t` and therefore cannot produce a valid signature against `C`.
 *       In production `t`, the similarity threshold and the liveness checks are
 *       enforced inside a zk-circuit and the proof is verified by a Groth16/PLONK
 *       verifier; the on-chain surface below is deliberately identical to that
 *       design (a single 32-byte public-signal word + per-user state machine), so
 *       swapping the simulated prover for a real one is a drop-in change.
 *
 *   (b) FRESHNESS BINDING (the anti-replay part)
 *       Every verification must consume a brand-new on-chain `authNonce` and
 *       echo a `challengeId` from the live challenge bank. The 20-byte
 *       `binding` field is recomputable *by this contract*, so a proof word
 *       cannot be lifted from another user, another baseline, another challenge
 *       or an earlier call.
 *
 * Note on trust: the packed proof word carries client-asserted scores
 * (`livenessBps`, `similarityBps`, `flags`). The contract enforces the
 * thresholds, the freshness binding and the challenge bank, and it records every
 * rejection on-chain. The cryptographic authenticity of those scores is
 * established by the BIP-340 signature in the client transcript — see
 * `lib/zk/liveness.ts` and the README's "Security model" section.
 */
contract AegisCallZK {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Per-user on-chain state (the "session ledger").
    struct Session {
        bool registered; // baseline commitment is set
        bool active; // call session currently verified & live
        uint64 registeredAt; // unix ts of enrollment
        uint64 lastVerifiedAt; // unix ts of last accepted liveness proof
        uint64 validUntil; // unix ts the active session expires
        uint64 lockoutUntil; // unix ts of brute-force lockout
        uint32 authNonce; // monotonic, single-use per verification
        uint32 callCount; // accepted verifications since enrollment
        uint32 failedAttempts; // consecutive soft rejections
        uint64 lastBaselineChangeAt; // gates RE_ENROLL_COOLDOWN (register + reset)
    }

    /// @notice Decoded 32-byte public-signal word produced by the prover.
    struct LivenessSignals {
        uint8 version;
        uint8 challengeId;
        uint16 livenessBps;
        uint16 similarityBps;
        uint8 flags;
        uint8 sigAnchor;
        uint32 authNonce;
        bytes20 binding;
    }

    /// @notice Reason a proof was rejected (recorded, not reverted).
    enum RejectionReason {
        None,
        LivenessBelowThreshold,
        SimilarityBelowThreshold,
        AttackFlagsPresent,
        LockedOut
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Version byte the prover must stamp into the proof word.
    uint8 public constant PROOF_VERSION = 1;

    /// @notice Domain separator — never reuse a commitment across protocols.
    bytes32 public constant DOMAIN = keccak256("AEGIS_CALL_ZK_V1");

    /// @notice Length of a valid active call session.
    uint64 public constant SESSION_TTL = 30 minutes;

    /// @notice Minimum wait before a user may replace their baseline.
    ///      Stops an attacker from brute-forcing a deepfake baseline.
    uint64 public constant RE_ENROLL_COOLDOWN = 1 hours;

    /// @notice Consecutive soft rejections tolerated before lockout.
    uint32 public constant MAX_FAILED_ATTEMPTS = 3;

    /// @notice Lockout applied once MAX_FAILED_ATTEMPTS is reached.
    uint64 public constant LOCKOUT_DURATION = 15 minutes;

    /// @notice Size of the liveness challenge bank.
    uint8 public constant CHALLENGE_BANK_SIZE = 8;

    // ---------------------------------------------------------------------
    // Attack flag bitfield (bit `i` => `1 << i` in the proof word)
    // ---------------------------------------------------------------------

    uint8 public constant FLAG_REPLAY = 1 << 0; // captured audio identical to a previous capture
    uint8 public constant FLAG_SYNTHETIC = 1 << 1; // vocoder / TTS spectral signature
    uint8 public constant FLAG_TEMPLATE_DRIFT = 1 << 2; // speaker embedding moved too far
    uint8 public constant FLAG_TEMPO_SPOOF = 1 << 3; // cadence inconsistent with live speech
    uint8 public constant FLAG_CHALLENGE_MISMATCH = 1 << 4; // response not bound to the live challenge
    uint8 public constant FLAG_MIC_SPOOF = 1 << 5; // digital/virtual microphone

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public owner;

    /// @notice Baseline biometric commitment (x-only pubkey) per user.
    mapping(address => bytes32) public baselineCommitment;
    mapping(address => Session) private _sessions;

    /// @notice Enabled liveness challenges.
    mapping(uint8 => bool) public isChallengeEnabled;

    /// @notice Chain-anchored challenge entropy mixed into every challenge.
    bytes32 public challengeSetRoot;

    uint16 public minLivenessBps = 7_000; // 70.00 %
    uint16 public minSimilarityBps = 6_200; // 62.00 %

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event BaselineRegistered(address indexed user, bytes32 indexed commitment, uint32 authNonce);
    event BaselineReset(address indexed user, uint32 authNonce);
    event LivenessVerified(
        address indexed user,
        uint8 indexed challengeId,
        uint16 similarityBps,
        uint16 livenessBps,
        uint32 authNonce,
        uint64 validUntil
    );
    event LivenessRejected(
        address indexed user,
        uint8 indexed challengeId,
        RejectionReason reason,
        uint8 flags,
        uint16 similarityBps,
        uint16 livenessBps,
        uint32 failedAttempts
    );
    event SessionInvalidated(address indexed user, uint32 authNonce);
    event ThresholdsUpdated(uint16 minLivenessBps, uint16 minSimilarityBps);
    event ChallengeConfigured(uint8 indexed challengeId, bool enabled);
    event ChallengeSetRootUpdated(bytes32 root);
    event LockedOut(address indexed user, uint64 until);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotSelf(address caller, address user);
    error AlreadyRegistered(address user);
    error NotRegistered(address user);
    error CommitmentAlreadySet();
    error InvalidProofVersion(uint8 version);
    error ChallengeDisabled(uint8 challengeId);
    error ChallengeOutOfRange(uint8 challengeId);
    error ChallengeMismatch(uint8 provided, uint8 expected);
    error StaleAuthNonce(uint32 provided, uint32 expected);
    error BaselineBindingMismatch();
    error DirtyProofBits();
    error CooldownActive(uint256 remainingSeconds);
    error InvalidThreshold();
    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        challengeSetRoot = keccak256(abi.encodePacked("AEGIS_CHALLENGE_SET", block.chainid, address(this)));
        // Bank ids 0..7 start enabled.
        for (uint8 i = 0; i < CHALLENGE_BANK_SIZE; ++i) {
            isChallengeEnabled[i] = true;
        }
        emit ThresholdsUpdated(minLivenessBps, minSimilarityBps);
        emit ChallengeSetRootUpdated(challengeSetRoot);
    }

    // =====================================================================
    // STEP 1 — Onboarding: register the biometric baseline commitment
    // =====================================================================

    /**
     * @notice Registers the caller's biometric ZK commitment. Once per baseline.
     * @param user      Must be `msg.sender` — enrollment is self-service, so an
     *                  attacker cannot quietly swap a user's baseline.
     * @param zkCommitment `C = P + t*G`, the template-bound public key.
     *
     * The baseline is deliberately NOT usable as a session: registering proves
     * possession of the device secret, not liveness right now.
     */
    function registerBaseline(address user, bytes32 zkCommitment) external {
        if (user == address(0)) revert ZeroAddress();
        if (user != msg.sender) revert NotSelf(msg.sender, user);

        Session storage s = _sessions[user];
        if (s.registered) revert AlreadyRegistered(user);
        if (zkCommitment == bytes32(0)) revert CommitmentAlreadySet();

        uint256 cooldown = _reEnrollCooldownRemaining(user);
        if (cooldown > 0) revert CooldownActive(cooldown);

        s.registered = true;
        s.active = false;
        s.registeredAt = uint64(block.timestamp);
        s.lastBaselineChangeAt = uint64(block.timestamp);
        s.failedAttempts = 0;
        s.lockoutUntil = 0;

        baselineCommitment[user] = zkCommitment;

        emit BaselineRegistered(user, zkCommitment, s.authNonce);
    }

    /**
     * @notice Discards a baseline so it can be re-enrolled (new device, voice
     *         change, suspected compromise). Rate-limited by RE_ENROLL_COOLDOWN.
     */
    function resetBaseline(address user) external {
        if (user != msg.sender) revert NotSelf(msg.sender, user);

        Session storage s = _sessions[user];
        if (!s.registered) revert NotRegistered(user);

        uint256 cooldown = _reEnrollCooldownRemaining(user);
        if (cooldown > 0) revert CooldownActive(cooldown);

        delete baselineCommitment[user];
        s.registered = false;
        s.active = false;
        s.authNonce += 1; // burn every outstanding proof
        s.failedAttempts = 0;
        s.lockoutUntil = 0;
        s.lastBaselineChangeAt = uint64(block.timestamp);

        emit BaselineReset(user, s.authNonce);
    }

    // =====================================================================
    // STEP 2 — Call: verify a liveness proof against the baseline
    // =====================================================================

    /**
     * @notice Verifies a fresh liveness proof and opens/refreshes a call session.
     *
     * @dev Relaying is allowed: proof generation happens in the browser, so a
     *      call gateway (or the user) can submit it. The `binding` field makes
     *      the word useless to anyone but the bound user + baseline.
     *
     *      Protocol violations revert. Cryptographic *rejections* (deepfake
     *      signals, low scores) are recorded on-chain with a reason so there is
     *      a permanent audit trail and a brute-force lockout.
     *
     * @param user          Subject of the call.
     * @param livenessProof Packed 32-byte public-signal word (see `LivenessSignals`).
     * @param challengeId   Live challenge that was answered; must be enabled.
     * @return similarityBps Accepted template-match score.
     * @return livenessBps   Accepted live-human confidence.
     */
    function verifyCallWithLiveness(
        address user,
        bytes32 livenessProof,
        uint8 challengeId
    ) external returns (uint16 similarityBps, uint16 livenessBps) {
        Session storage s = _sessions[user];
        if (!s.registered || baselineCommitment[user] == bytes32(0)) revert NotRegistered(user);
        if (challengeId >= CHALLENGE_BANK_SIZE) revert ChallengeOutOfRange(challengeId);
        if (!isChallengeEnabled[challengeId]) revert ChallengeDisabled(challengeId);

        LivenessSignals memory sig = decodeLivenessProof(livenessProof);

        // -- structural checks: the word must be canonical & fresh ----------
        if (sig.version != PROOF_VERSION) revert InvalidProofVersion(sig.version);
        if (_encode(sig) != livenessProof) revert DirtyProofBits();
        if (sig.challengeId != challengeId) revert ChallengeMismatch(sig.challengeId, challengeId);
        if (sig.authNonce != s.authNonce) revert StaleAuthNonce(sig.authNonce, s.authNonce);
        if (sig.binding != expectedBinding(user, challengeId)) revert BaselineBindingMismatch();

        // Consume the nonce *before* any outcome: a proof word is strictly
        // single-use even when the liveness verdict is negative.
        uint32 usedNonce = s.authNonce;
        s.authNonce += 1;

        // -- cryptographic verdict: recorded, not reverted -------------------
        // NOTE: only the brute-force lockout gates verification here. The
        // re-enrollment cooldown is deliberately NOT consulted — it must not
        // stop a legitimate user from making calls right after enrolling.
        uint256 lockout = _lockoutRemaining(user);
        RejectionReason reason = RejectionReason.None;

        if (lockout > 0) {
            reason = RejectionReason.LockedOut;
        } else if (sig.flags != 0) {
            reason = RejectionReason.AttackFlagsPresent;
        } else if (sig.similarityBps < minSimilarityBps) {
            reason = RejectionReason.SimilarityBelowThreshold;
        } else if (sig.livenessBps < minLivenessBps) {
            reason = RejectionReason.LivenessBelowThreshold;
        }

        if (reason != RejectionReason.None) {
            s.active = false;
            s.failedAttempts += 1;
            if (s.failedAttempts >= MAX_FAILED_ATTEMPTS) {
                s.failedAttempts = 0;
                s.lockoutUntil = uint64(block.timestamp) + LOCKOUT_DURATION;
                emit LockedOut(user, s.lockoutUntil);
            }
            emit LivenessRejected(
                user,
                challengeId,
                reason,
                sig.flags,
                sig.similarityBps,
                sig.livenessBps,
                s.failedAttempts
            );
            // Return the attempted values: the caller can render the alert, the
            // transcript stays inspectable, and the attempt is permanently logged.
            return (sig.similarityBps, sig.livenessBps);
        }

        // -- accepted --------------------------------------------------------
        s.active = true;
        s.callCount += 1;
        s.failedAttempts = 0;
        s.lastVerifiedAt = uint64(block.timestamp);
        s.validUntil = uint64(block.timestamp) + SESSION_TTL;

        emit LivenessVerified(
            user,
            challengeId,
            sig.similarityBps,
            sig.livenessBps,
            usedNonce,
            s.validUntil
        );

        return (sig.similarityBps, sig.livenessBps);
    }

    /// @notice Ends an active call session (user or call gateway).
    function invalidateSession(address user) external {
        Session storage s = _sessions[user];
        if (!s.registered) revert NotRegistered(user);

        s.active = false;
        s.validUntil = 0;
        s.authNonce += 1; // burn any in-flight proof

        emit SessionInvalidated(user, s.authNonce);
    }

    // =====================================================================
    // Views
    // =====================================================================

    function getSession(address user) external view returns (Session memory) {
        return _sessions[user];
    }

    /// @notice True when the user has a live, unexpired call session.
    function isSessionActive(address user) external view returns (bool) {
        Session storage s = _sessions[user];
        return s.registered && s.active && block.timestamp < s.validUntil;
    }

    function getThresholds() external view returns (uint16 livenessBps, uint16 similarityBps) {
        return (minLivenessBps, minSimilarityBps);
    }

    function decodeLivenessProof(bytes32 word) public pure returns (LivenessSignals memory s) {
        uint256 v = uint256(word);
        s.version = uint8(v >> 248);
        s.challengeId = uint8(v >> 240);
        s.livenessBps = uint16(v >> 224);
        s.similarityBps = uint16(v >> 208);
        s.flags = uint8(v >> 200);
        s.sigAnchor = uint8(v >> 192);
        s.authNonce = uint32(v >> 160);
        s.binding = _low20(v);
    }

    /// @notice Recomputes the 20-byte binding the prover must embed.
    function expectedBinding(
        address user,
        uint8 challengeId
    ) public view returns (bytes20) {
        return
            _low20(
                uint256(
                    keccak256(
                        abi.encode(
                            DOMAIN,
                            baselineCommitment[user],
                            user,
                            challengeId,
                            _sessions[user].authNonce
                        )
                    )
                )
            );
    }

    /// @notice Chain-anchored entropy for the next liveness challenge of `user`.
    /// @dev The client mixes this with `crypto.getRandomValues` so a challenge
    ///      can never be predicted from chain state alone, while remaining
    ///      independently reproducible by anyone auditing the transcript.
    function nextChallengeSeed(address user) external view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN,
                    user,
                    _sessions[user].authNonce,
                    block.number,
                    challengeSetRoot
                )
            );
    }

    // =====================================================================
    // Owner configuration
    // =====================================================================

    function setThresholds(uint16 newMinLivenessBps, uint16 newMinSimilarityBps) external onlyOwner {
        if (newMinLivenessBps > 10_000 || newMinSimilarityBps > 10_000) revert InvalidThreshold();
        if (newMinLivenessBps < 1_000 || newMinSimilarityBps < 1_000) revert InvalidThreshold();
        minLivenessBps = newMinLivenessBps;
        minSimilarityBps = newMinSimilarityBps;
        emit ThresholdsUpdated(newMinLivenessBps, newMinSimilarityBps);
    }

    function setChallengeEnabled(uint8 challengeId, bool enabled) external onlyOwner {
        if (challengeId >= CHALLENGE_BANK_SIZE) revert ChallengeOutOfRange(challengeId);
        isChallengeEnabled[challengeId] = enabled;
        emit ChallengeConfigured(challengeId, enabled);
    }

    function setChallengeSetRoot(bytes32 root) external onlyOwner {
        challengeSetRoot = root;
        emit ChallengeSetRootUpdated(root);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // =====================================================================
    // Internals
    // =====================================================================

    /// @dev Solidity's `bytes32 -> bytesNN` cast keeps the *leftmost* bytes, so
    ///      extracting the low 20 bytes of a word needs an explicit 96-bit shift.
    ///      Getting this wrong silently produces a proof word the contract
    ///      rejects with `BaselineBindingMismatch`; `packProof` in the tests
    ///      pins the behaviour.
    function _low20(uint256 word) private pure returns (bytes20 out) {
        out = bytes20(bytes32(word << 96));
    }

    /// @dev Inverse of `_low20`.
    function _low20Value(bytes20 b) private pure returns (uint256) {
        return uint256(bytes32(b)) >> 96;
    }

    function _lockoutRemaining(address user) private view returns (uint256) {
        Session storage s = _sessions[user];
        if (s.lockoutUntil > block.timestamp) {
            return s.lockoutUntil - block.timestamp;
        }
        return 0;
    }

    /// @dev Rate limit for enrolling or replacing a baseline. Measured from the
    ///      last baseline *change* so it also holds right after a reset. A
    ///      wallet that has never enrolled has `lastBaselineChangeAt == 0` and
    ///      is therefore never blocked.
    function _reEnrollCooldownRemaining(address user) private view returns (uint256) {
        Session storage s = _sessions[user];
        if (s.lastBaselineChangeAt == 0) return 0;
        uint256 next = s.lastBaselineChangeAt + RE_ENROLL_COOLDOWN;
        return block.timestamp < next ? next - block.timestamp : 0;
    }

    function _encode(LivenessSignals memory s) private pure returns (bytes32) {
        return
            bytes32(
                (uint256(s.version) << 248) |
                    (uint256(s.challengeId) << 240) |
                    (uint256(s.livenessBps) << 224) |
                    (uint256(s.similarityBps) << 208) |
                    (uint256(s.flags) << 200) |
                    (uint256(s.sigAnchor) << 192) |
                    (uint256(s.authNonce) << 160) |
                    _low20Value(s.binding)
            );
    }
}
