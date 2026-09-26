/**
 * Kayıt / liveness düzeltmeleri için regresyon testi.
 *
 *   node scripts/verify-capture.mjs
 *
 * Bu, tarayıcıda yaşanan bir hatanın regresyon testidir:
 *
 *   "Kayıt kullanılamaz: no reliable pitch detected / signal level too low"
 *   — kullanıcı yüksek sesle, net konuşmasına rağmen.
 *
 * Üç gerçek hata vardı ve hepsi burada ölçülüyor:
 *
 *   1. KAYIT HIZI. `AnalyserNode` her 8 ms'de *son 2048 örneği* verir; 16 kHz'de
 *      8 ms'de yalnızca 128 yeni örnek üretilir. Tüm pencereyi eklemek örnekleri
 *      ~16 kez tekrarlıyor, tamponu 0,33 sn'de dolduruyor (3,2 sn yerine) ve
 *      sinyale 125 Hz'lik yapay periyod enjekte ediyordu. `simulateRecorder`
 *      aynı hatayı modeller ve düzeltmeyi doğrular.
 *   2. PENCERE. MFCC karesi 25 ms; 120 Hz'de bu yalnızca ~3 periyot. Oto-
 *      korelasyon güvenilmez kalıyor ve `f0` 0'a düşüyordu.
 *   3. EŞİKLER. `rms`/`f0Mean` mutlak eşiklerle karşılaştırılıyordu; kazanç
 *      normalize edildiğinde bu artık anlamsız.
 */
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { transpileToCjs } from "./lib/transpile.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, ".zkverify");
rmSync(OUT, { recursive: true, force: true });
// Tüm `lib/` derlenir: yeni bir modül eklendiğinde liste güncellemeyi unutmak
// betiği sessizce kırıyordu.
transpileToCjs(ROOT, OUT, "lib");

const req = createRequire(join(ROOT, "package.json"));
const { analyseVoiceprint, TARGET_SAMPLE_RATE } = req(join(OUT, "lib/audio/features.js"));
const { estimateF0 } = req(join(OUT, "lib/audio/dsp.js"));
const { WORKLET_SOURCE, resample } = req(join(OUT, "lib/audio/recorder.js"));
const baselineMod = req(join(OUT, "lib/zk/baseline.js"));
const { createBaselineProof } = baselineMod;
const { scoreLiveness } = req(join(OUT, "lib/zk/liveness.js"));
const { evaluateEnrollmentLiveness } = req(join(OUT, "lib/zk/enrollmentLiveness.js"));
const { synthesiseSpoof, normalise } = req(join(OUT, "lib/zk/spoof.js"));

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32mOK \x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const RATE = TARGET_SAMPLE_RATE; // 16000

// ===========================================================================
section("1. KAYIT YOLU — AudioWorklet girdiyi birebir veriyor mu?");
// ===========================================================================

/**
 * Gercek `aegis-capture` worklet kodunu Node'da calistirir.
 *
 * Bu bir *model* degil: `lib/audio/recorder.ts` icindeki kaynak dize aynen
 * derlenir, sahte `AudioWorkletProcessor` tabaniyla instantiate edilir ve
 * tarayicinin gercekten verdigi 128 orneklik render quantum'lari beslenir.
 * Dogrulanan sey uretimde kostan kodun kendisidir.
 */
function loadCaptureProcessor(chunkSize) {
  let registered = null;
  class StubProcessor {
    constructor() {
      this.port = { postMessage() {} };
    }
  }
  const factory = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    `${WORKLET_SOURCE}\n;return AegisCaptureProcessor;`,
  );
  const Cls = factory(StubProcessor, (name, cls) => {
    registered = { name, cls };
  });
  return { registered, Cls, chunkSize };
}

/** Worklet'i 128 orneklik quantum'larla besler, topladigi chunk'lari doner. */
function runWorklet(signal, chunkSize = 1024, { flush = false } = {}) {
  const { registered, Cls } = loadCaptureProcessor(chunkSize);
  const proc = new Cls({ processorOptions: { chunkSize } });
  // The processor installs its flush handler on `this.port` inside the
  // constructor, so the stub port has to be swapped out *after* construction
  // while carrying that handler across.
  const flushHandler = proc.port.onmessage;
  const inbox = [];
  const chunks = [];
  proc.port = { postMessage: (data) => inbox.push(data), onmessage: flushHandler };

  const drain = () => {
    for (const data of inbox.splice(0)) {
      if (!(data && typeof data === "object" && data.flushed === true)) {
        chunks.push(new Float32Array(data));
      }
    }
  };

  let alive = true;
  const QUANTUM = 128; // Web Audio render quantum — sabit
  for (let i = 0; i < signal.length; i += QUANTUM) {
    // Son quantum kisa olabilir; worklet buna dayanikli olmali.
    const quantum = signal.subarray(i, Math.min(i + QUANTUM, signal.length));
    alive = proc.process([[quantum]]) && alive;
    drain();
  }
  if (flush) {
    // Tarayicida `stop()` once yapar; cevap bir sonraki render quantum'unda gelir.
    proc.port.onmessage({ data: { flush: true } });
    drain();
  }

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const flat = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    flat.set(c, at);
    at += c.length;
  }
  return { name: registered.name, flat, chunks, alive, total };
}

/**
 * 3.2 sn'lik, konusma benzeri sinyal.
 *
 * DIKKAT: bu fixture bilerek *periyodik DEGIL*. Ilk surumu saf harmonik yigin +
 * sinusoidal hece zarfidi; 140 Hz ile 4,2 Hz'in ortak periyodu tam 714,3 ms
 * oldugu icin kayit kastedilen her seyden once bir dongu yakalaniyordu
 * (loopScore 0,985) ve "canli konusma Enrollment kapisini gecer" testi dogru
 * bir tespit yuzunden basarisiz oluyordu. Insan konusmasi periyodik degildir:
 * perde duser, hece araliklari esit degildir, formantlar kayar. Fixture da
 * ozellestirildi.
 */
const F0_BASE = 148;
const F0_DECL = 18; // Hz/s — perde konusma boyunca duser
const F0_SWING = 22;
const F0_RATE = 2.3;
const F0_PHASE = 0.7;

/** Anlik perde (u = konusma basindan gecen sure). */
function f0At(u) {
  return F0_BASE - F0_DECL * u + F0_SWING * Math.sin(2 * Math.PI * F0_RATE * u + F0_PHASE);
}

/** ∫₀ᵘ f0 dτ — perde yoruntgesinin kapali formu. */
function phaseAt(u) {
  return (
    2 *
    Math.PI *
    (F0_BASE * u -
      (0.5 * F0_DECL * u * u) -
      (F0_SWING / (2 * Math.PI * F0_RATE)) *
        (Math.cos(2 * Math.PI * F0_RATE * u + F0_PHASE) - Math.cos(F0_PHASE)))
  );
}

function sampleAt(t) {
  if (t < 0.15) return 0.004 * Math.sin(2 * Math.PI * 140 * t); // lead-in sessizligi
  const u = t - 0.15;
  // Düzensiz hece zarfı: iki farklı frekansın bileşimi, tam periyodik değil.
  const syl = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.1 * u + 1.3 * Math.sin(2 * Math.PI * 0.9 * u));
  const ph = phaseAt(u);
  let s = 0;
  for (let k = 1; k <= 12; k++) {
    // Zamanla oynayan formant kayması: her harmonik kendi faz hızını alıyor.
    s += Math.sin(ph * k + 0.18 * Math.sin(2 * Math.PI * 2.1 * u) * k) / k;
  }
  return 0.14 * syl * s * 0.5 + 0.01 * Math.sin(2 * Math.PI * 2300 * t);
}

/** 3.2 sn'lik konuşma. Kayıt ortasındaki perde — referans F0. */
const NOMINAL_F0 = f0At(1.6);

/** Konuşma bölgesinin perde zaman-averajı — F0 ölçümünün referansı. */
function meanF0OverSpeech(from = 0.3, to = 3.05) {
  let sum = 0;
  let n = 0;
  for (let t = from; t < to; t += 1 / RATE) {
    sum += f0At(t - 0.15);
    n++;
  }
  return sum / n;
}

const speech = new Float32Array(RATE * 3.2);
for (let i = 0; i < speech.length; i++) speech[i] = sampleAt(i / RATE);

const work = runWorklet(speech);

check("worklet dogru adla kaydediliyor", work.name === "aegis-capture", work.name);
check("worklet grafigi canli tutuyor (process -> true)", work.alive === true);
check(
  "3,2 sn'lik kayit tam 51200 ornek topluyor (kayip yok)",
  work.total === speech.length,
  `${work.total} / ${speech.length}`,
);

let firstMismatch = -1;
for (let i = 0; i < work.total && firstMismatch < 0; i++) {
  // Bit-bazli: kopya veya atlama varsa ilk sapma burada yakalanir.
  if (work.flat[i] !== speech[i]) firstMismatch = i;
}
check(
  "worklet ciktisi BIT bazli girdiyle ayni (tekrar/sira hatasi yok)",
  firstMismatch < 0,
  firstMismatch >= 0 ? `ilk sapma @${firstMismatch}` : "birebir ayni",
);
check(
  "cikti chunk'lari tam 1024 orneklik (kayma birikmiyor)",
  work.chunks.length === Math.floor(speech.length / 1024) &&
    work.chunks.every((c) => c.length === 1024),
  `${work.chunks.length} chunk`,
);

// Chunk boyutu tam bolunmeyen bir kayit: tampon asiri senaryosu. Onceki surumde
// bu 4608/5000 ornek donuyordu — worklet tamponu yalnizca dolunca gonderiyor,
// son parca hic gonderilmiyordu, yani konusmanin sonu sessizce kayboluyordu.
const ragged = runWorklet(speech.subarray(0, 5000), 512);
const raggedFlushed = runWorklet(speech.subarray(0, 5000), 512, { flush: true });
check(
  "tam bolunmeyen son chunk flush olmadan KAYBOLUYOR (bilinen hata)",
  ragged.total === 4608 && ragged.total < 5000,
  `${ragged.total} / 5000`,
);
check(
  "flush istegi son parca kurtarir: 5000/5000, sirali",
  raggedFlushed.total === 5000 && raggedFlushed.flat[4999] === speech[4999],
  `${raggedFlushed.total} / 5000`,
);
check(
  "flush, tam bolunen kayitlari degistirmez",
  runWorklet(speech, 1024, { flush: true }).total === speech.length,
);

/**
 * Bir kaydin icinde kac kadar OZGUN ses var?
 *
 * AnalyserNode yolu her poll'da 2048 ornek yazarken, ard arda iki poll'un
 * pencereleri 1920 ornek ortusuyor. Yani tampona yazilan veri
 * `buffer[i + 1920] == buffer[i]` seklinde ikilenmis oluyor. Ortusme payini
 * bu lag'de olceriz.
 */
function selfSimilarityAt(buf, lag) {
  if (buf.length <= lag + 1) return 0;
  let num = 0;
  let d1 = 0;
  let d2 = 0;
  const stride = 7; // hizli kaba tarama
  for (let i = 0; i + lag < buf.length; i += stride) {
    const a = buf[i];
    const b = buf[i + lag];
    num += a * b;
    d1 += a * a;
    d2 += b * b;
  }
  return num / (Math.sqrt(d1 * d2) + 1e-12);
}

/** Ilk iki surumun kullandigi yol: AnalyserNode + setInterval(8 ms). */
function simulateAnalyserRecorder(seconds, { fftSize = 2048, pollMs = 8 } = {}) {
  const polls = Math.ceil((seconds * 1000) / pollMs);
  const buffer = new Float32Array(polls * fftSize);
  let captured = 0;
  let clock = 0;
  while (clock < seconds && captured + fftSize <= buffer.length) {
    clock += pollMs / 1000;
    const rendered = Math.floor(clock * RATE);
    const window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      const absolute = rendered - fftSize + i;
      window[i] = absolute >= 0 ? sampleAt(absolute / RATE) : 0;
    }
    buffer.set(window, captured);
    captured += fftSize;
  }
  return buffer.subarray(0, captured);
}

const legacy = simulateAnalyserRecorder(3.2);

// Her poll 2048 ornek yaziyor ama yalnizca 128'i yeniden uretilmis oluyor; bu
// yuzden tampon 1920 ornek geriye kayiyor ve veri `legacy[i] == speech[i-1920]`
// seklinde ikileniyor. Sapma yerini degil, KAYMANIN KENDISINI olcuyoruz.
// Hamponun basi sifir dolgulu oldugu icin yalnizca kaynak indeksi tampon icinde
// olan bolum karsilastiriliyor.
const LEGACY_SHIFT = 2048 - 128;
let shiftHolds = true;
let shiftChecked = 0;
for (let p = 16; p * 2048 < legacy.length; p++) {
  for (let i = 0; i < 2048; i++) {
    const src = p * 128 - LEGACY_SHIFT + i;
    if (src < 0 || src >= speech.length) continue;
    if (legacy[p * 2048 + i] !== speech[src]) {
      shiftHolds = false;
      break;
    }
    shiftChecked++;
  }
  if (!shiftHolds) break;
}
check(
  "ESKI AnalyserNode yolu girdiyi 1920 ornek geriye kaydiriyor (regresyon kaniti)",
  shiftHolds && shiftChecked > 10_000,
  shiftHolds ? `${shiftChecked} ornek dogrulandi` : `kayma=${LEGACY_SHIFT} tutmuyor`,
);
check(
  "ESKI yol 3,2 sn icin ~16x fazla ornek yaziyor (tekrar)",
  legacy.length / speech.length > 12,
  `${(legacy.length / speech.length).toFixed(1)}x`,
);

// Gercek belirti: hatali yol veriyi 1920 ornek periyotla ikiliyor.
const dupLag = 2048 - 128;
check(
  `worklet ciktisinda tekrar yok (lag ${dupLag} benzerlik < 0,5)`,
  selfSimilarityAt(work.flat, dupLag) < 0.5,
  selfSimilarityAt(work.flat, dupLag).toFixed(3),
);
check(
  `ESKI hata kaydi periyodik hale getiriyor (lag ${dupLag} benzerlik > 0,7)`,
  selfSimilarityAt(legacy, dupLag) > 0.7,
  selfSimilarityAt(legacy, dupLag).toFixed(3),
);

// Yeniden ornekleme: cihaz 48 kHz ise 16 kHz'e indirilir. Konusulmasi gereken
// sey uzunluk ve *hizalama*; tepe korunmasi degil (filtresiz 3:1 decimation
// aliasing yapigi icin tepe enerjisi dagilir).
const src48 = Float32Array.from(speech.subarray(0, 4800));
const at48k = resample(src48, 48000, RATE);
check(
  "48 kHz -> 16 kHz yeniden ornekleme sure dogru (1600 ornek)",
  at48k.length === 1600,
  `${at48k.length} ornek`,
);
check(
  "yeniden ornekleme 3'lu kademeli indirmeyle hizali (cosine > 0,995)",
  correlation(at48k, src48, 3) > 0.995,
  `cosine=${correlation(at48k, src48, 3).toFixed(5)}`,
);
check(
  "yeniden ornekleme tepe seviyesini buyuk olculde koruyor (>%85)",
  peakOf(at48k) > peakOf(src48) * 0.85,
  `${((peakOf(at48k) / peakOf(src48)) * 100).toFixed(1)}%`,
);

// ===========================================================================
section("2. PENCERE — 25 ms ile pitch guvenilmez mi?");
// ===========================================================================

// Gercekci konusma: genis bant gurultu eklenmis sinyal. Saf harmonik yigin
// trackers icin fazla kolay; gurultulu sinyal 25 ms pencerenin yetersizligini
// ortaya cikarir.
//
// DIKKAT: `sampleAt` ilk 150 ms sessiz (kullanici kayda baslamadan once), bu
// yuzden pencereler konusma bolgesinden secilmeli.
let seed = 12345;
/**
 * mulberry32. Onceki surum `x = (x * 1103515245 + 12345) & 0x7fffffff` idi —
 * x 2^31'e kadar buyudugu icin carpim 2^53'u asip kayan nokta yuvarlamasina
 * giriyor ve uretilen "gurultu" kisa bir periyoda duserdi. Yanlislikla hem
 * HNR'i gereksiz yere dusuruyor hem de dongu dedektörunu tetikliyordu
 * (beyaz gurultu 0,90 benzerlik ölçüyordu, fiziksel olarak imkânsiz).
 */
function makeRnd(s) {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}
const rnd = makeRnd(seed);
const noisy = new Float32Array(speech.length);
for (let i = 0; i < speech.length; i++) noisy[i] = speech[i] + rnd() * 0.035;

// t = 0,20–0,25 sn → ornek 3200..4000 (konusma icinde)
const wideNoisy = estimateF0(noisy.subarray(3200, 4000), RATE);
const f0Window = f0At((3200 + 4000) / 2 / RATE - 0.15);
check(
  "50 ms pencere gurultulu sinyalde perdeyi buluyor",
  Math.abs(wideNoisy - f0Window) / f0Window < 0.15,
  `${wideNoisy.toFixed(1)} Hz (beklenen ~${f0Window.toFixed(1)})`,
);

// Pencere uzunlugu SNR sinirinda fark yarar. Ayni sinyali iki farkli gurultu
// seviyesinde 25 ms ve 50 ms ile olcup dogruluk karsilastiriyoruz.
function f0ErrorAtNoise(noiseAmp, windowMs) {
  const r = makeRnd(999);
  const buf = new Float32Array(noisy.length);
  for (let i = 0; i < noisy.length; i++) buf[i] = speech[i] + r() * noiseAmp;
  const w = Math.floor((windowMs / 1000) * RATE);
  let err = 0;
  let n = 0;
  for (let start = 3200; start + w < buf.length; start += 160) {
    const f = estimateF0(buf.subarray(start, start + w), RATE);
    if (f > 0) {
      // Fixture perdeyi konusma boyunca dusuruyor; sabit bir hedef degil,
      // o pencereye ait gercek perdeyi karsilastiriyoruz.
      const truth = f0At((start + w / 2) / RATE - 0.15);
      err += Math.abs(f - truth) / truth;
      n++;
    }
  }
  return { meanRelError: n ? err / n : Infinity, tracked: n };
}

const clean25 = f0ErrorAtNoise(0.035, 25);
const clean50 = f0ErrorAtNoise(0.035, 50);
const hard25 = f0ErrorAtNoise(0.11, 25);
const hard50 = f0ErrorAtNoise(0.11, 50);
check(
  "yeterli SNR'da iki pencere de isabetli",
  clean25.meanRelError < 0.15 && clean50.meanRelError < 0.15,
  `25ms=${(clean25.meanRelError * 100).toFixed(0)}% 50ms=${(clean50.meanRelError * 100).toFixed(0)}%`,
);
check(
  "dusuk SNR'da 50 ms pencerede 25 ms'ten daha isabetli",
  hard50.meanRelError < hard25.meanRelError,
  `25ms=${(hard25.meanRelError * 100).toFixed(0)}% 50ms=${(hard50.meanRelError * 100).toFixed(0)}%`,
);
check(
  "ve fark anlamli degil, kozmetik degil (>%25 daha kotu)",
  hard25.meanRelError > hard50.meanRelError * 1.25,
  `25ms=${(hard25.meanRelError * 100).toFixed(0)}% 50ms=${(hard50.meanRelError * 100).toFixed(0)}%`,
);

const fullCapture = analyseVoiceprint(noisy, RATE);
check(
  "tum kayit uzerinde voiced frame orani makul",
  fullCapture.features.voicedRatio > 0.2,
  `${(fullCapture.features.voicedRatio * 100).toFixed(0)}%`,
);

// Fixture'in perde yoruntgesi zaman icinde 126–170 Hz arasinda oynuyor; bu
// yuzden sabit bir hedef degil, konusma bolgesinin ZAMAN ORTALAMASI referans
// alinir. Iddia "oktav hatasi yok" — yani olcum ayni oktavda, 2x degil.
const F0_TRUTH = meanF0OverSpeech();
const f0Ratio = fullCapture.features.f0Mean / F0_TRUTH;
check(
  "F0 ortalamasi perde yoruntgesini izliyor (<%25 hata)",
  Math.abs(f0Ratio - 1) < 0.25,
  `${fullCapture.features.f0Mean.toFixed(1)} Hz (gercek ~${F0_TRUTH.toFixed(1)} Hz)`,
);
check(
  "oktav hatasi yok (2x veya yarimDegil)",
  f0Ratio > 0.62 && f0Ratio < 1.6,
  `oran=${f0Ratio.toFixed(2)}`,
);

// HNR konusma enerjisinin taranmisligini olcer; gurultu eklendikce duser.
// Onceki surum bunu her kayitta sabit bir araliga sikiyordu, ama HNR pratikte
// mikrofonu olcer: ayni konusma temizde 13 dB, gurultuluda -2 dB.
const cleanVp = analyseVoiceprint(speech, RATE);
check(
  "temiz konusmada HNR pozitif ve insani aralikta (6–25 dB)",
  cleanVp.features.hnrDb > 6 && cleanVp.features.hnrDb < 25,
  `${cleanVp.features.hnrDb.toFixed(1)} dB`,
);
check(
  "genis bant gurultu HNR'i dusuruyor (olcum duyarli)",
  fullCapture.features.hnrDb < cleanVp.features.hnrDb - 5,
  `${fullCapture.features.hnrDb.toFixed(1)} dB < ${cleanVp.features.hnrDb.toFixed(1)} dB`,
);
check(
  "insani konusma dongu olarak gorunmuyor (kendi kendini tekrar etmiyor)",
  cleanVp.features.loopScore < 0.6,
  `loopScore=${cleanVp.features.loopScore.toFixed(3)}`,
);

// ===========================================================================
section("3. KAZANC NORMALIZASYONU — sessiz mikrofonu kurtarir");
// ===========================================================================
// Iddia: ayni konusma 1x ve 0,15x kazancinda AYNI karar vermeli. Kazanc
// belirleyici olmamali.
const loud = speech;
const quiet = quietDown(speech, 0.15);
const vpQuiet = analyseVoiceprint(quiet, RATE);
const vpLoud = analyseVoiceprint(loud, RATE);
const quietActive = createBaselineProof(quiet, RATE);
const loudActive = createBaselineProof(loud, RATE);

check(
  "sessiz ve yuksek sesli kayit ayni F0'i buluyor",
  Math.abs(vpQuiet.features.f0Mean - vpLoud.features.f0Mean) < 6,
  `${vpQuiet.features.f0Mean.toFixed(1)} Hz vs ${vpLoud.features.f0Mean.toFixed(1)} Hz`,
);
check("kazanci yuksek kayit kabul ediliyor", loudActive.ok, loudActive.problems.join(" | "));
check(
  "kazanci 6 kat dusuk ama gecerli mikrofon DA kabul ediliyor",
  quietActive.ok,
  quietActive.problems.join(" | "),
);
check(
  "embedding'ler kazanc farkina duyarsiz (cosine > 0,99)",
  cosine(vpQuiet.embedding, vpLoud.embedding) > 0.99,
  cosine(vpQuiet.embedding, vpLoud.embedding).toFixed(4),
);

// Gercekten cok sessiz mikrofon reddedilmeli — ve sebebi net olmali
const veryQuiet = createBaselineProof(quietDown(speech, 0.04), RATE);
check("gercekten cok sessiz mikrofon reddediliyor", !veryQuiet.ok);
check(
  "reddetme sebebi olculen seviyeyi soyleyor",
  veryQuiet.problems.some((p) => p.includes("tepe") && p.includes("%")),
  veryQuiet.problems[0]?.slice(0, 70),
);

// ===========================================================================
section("4. EŞIKLER — gercek konusma reddedilmemeli");
// ===========================================================================
check("normal konusma Enrollment kapisini gecer", loudActive.ok, loudActive.problems.join(" | "));
check(
  "f0 bulundu (0 degilse pitch hatasi yok)",
  loudActive.preview.f0Mean > 60,
  `${loudActive.preview.f0Mean} Hz`,
);
check(
  "konusma orani tespit edildi",
  loudActive.preview.speechFrames / loudActive.preview.totalFrames > 0.3,
  `${loudActive.preview.speechFrames}/${loudActive.preview.totalFrames}`,
);

// Gercekten sessiz kayit HALA reddedilmeli (sifir degil, ama sifir gibi)
const trueSilence = createBaselineProof(new Float32Array(RATE * 3.2), RATE);
check("dijital sessizlik hala reddediliyor", !trueSilence.ok, trueSilence.problems.join(" | "));
check(
  "hata mesaji olculen degeri iceriyor (eylem alinabilir)",
  trueSilence.problems.some((p) => /%/.test(p)),
  trueSilence.problems[0]?.slice(0, 60),
);

// cok kisa kayit reddedilmeli
const tooShort = createBaselineProof(speech.subarray(0, RATE * 0.5), RATE);
check("0,5 sn'lik kayit reddediliyor (cok kisa)", !tooShort.ok);

// ===========================================================================
section("5. LIVENESS SKORU — kazanc degismez, SESSIZLIK yakalanir");
// ===========================================================================
const challenge = {
  id: 0,
  template: { id: 0, title: "t", instruction: "", spokenPrompt: "", tails: [] },
  code: "1234",
  token: "x",
  request: "",
  seed: "0x" + "11".repeat(32),
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  expectOnsetAfterMs: Date.now(),
};
const scoreOf = (samples) =>
  scoreLiveness({
    capture: analyseVoiceprint(samples, RATE),
    baselineEmbedding: vpLoud.embedding,
    challenge,
    audioDigest: "0x" + "00".repeat(32),
    priorDigests: [],
  });

// Kazanc degistiginde puan DA degismemeli (presence gain-invariant).
const loudScore = scoreOf(loud);
const quietScore = scoreOf(quiet);
check(
  "kazanc degisince liveness puani degismiyor",
  Math.abs(loudScore.livenessBps - quietScore.livenessBps) < 1500,
  `${loudScore.livenessBps} vs ${quietScore.livenessBps}`,
);

// Dijital sessizlik yakalanmali.
const silenceScore = scoreOf(new Float32Array(RATE * 3.2));
check(
  "dijital sessizlik dusuk liveness aliyor",
  silenceScore.livenessBps < 3000,
  `liveness=${silenceScore.livenessBps}`,
);
check(
  "dijital sessizlik benzerlik de dusuk",
  silenceScore.similarityBps === 0,
  `similarity=${silenceScore.similarityBps}`,
);

// ===========================================================================
section("6. ADIM 1 LIVENESS — sahte baseline kaydedilmemeli");
// ===========================================================================
// Adim 1'de challenge yok, ama "bu gercekten canli bir insan mi?" sorusu
// Enrollment aninda sorulmali. Aksi halde sahte bir baseline her sonraki
// cagriyi zehirler: benzerlik kontrolü klonu sonsuza kadar kabul eder.

const enrollOf = (samples) => evaluateEnrollmentLiveness(analyseVoiceprint(samples, RATE));

// 1) Gercek konusma gecmeli.
const enrollHuman = enrollOf(speech);
check(
  "canli konusma enrollment liveness'ini geciyor",
  enrollHuman.passes,
  enrollHuman.problems.join(" | "),
);
check(
  "canli konusma yeterli liveness puani aliyor (>= %35)",
  enrollHuman.livenessBps >= 3500,
  `${enrollHuman.livenessBps}`,
);

// 2) Dijital sessizlik reddedilmeli ve sebebi net olmali.
const enrollSilence = enrollOf(new Float32Array(RATE * 3.2));
check("dijital sessizlik enrollment liveness'inde kaliyor", !enrollSilence.passes);
check(
  "sessizlikte MIC_SPOOF isareti kalkiyor",
  enrollSilence.flagNames.includes("MIC_SPOOF"),
  enrollSilence.flagNames.join(",") || "(yok)",
);

// 3) Tekrar eden kayit (loop) yakalanmali — REPLAY.
const loopSrc = speech.subarray(RATE * 0.5, RATE * 1.7); // ~1,2 sn
const looped = new Float32Array(loopSrc.length * 3);
for (let k = 0; k < 3; k++) looped.set(loopSrc, k * loopSrc.length);
const enrollLoop = enrollOf(normalise(looped));
check(
  "döngü kaydi REPLAY olarak isaretleniyor",
  enrollLoop.flagNames.includes("REPLAY"),
  `skor=${enrollLoop.detail.loopScore} · bayraklar=${enrollLoop.flagNames.join(",") || "(yok)"}`,
);
check(
  "döngü kaydi enrollment'da reddediliyor",
  !enrollLoop.passes,
  enrollLoop.problems.join(" | "),
);

// 4) Sentetik/vocoder ses: ISARETLENIR ama ENGELLENMEZ.
//    Jitter'da insan ile vocoder arasindaki fark (0,19 % vs 0,11 %) bir kapı
//    için fazla ince; yanlış reddi kabul etmektense uyarı vermek doğru.
const enrollTts = enrollOf(
  normalise(
    synthesiseSpoof({ kind: "synthetic", seconds: 3.2, seed: new Uint8Array(32).fill(7) }),
  ),
);
check(
  "sentetik ses SYNTHETIC olarak isaretleniyor",
  enrollTts.flagNames.includes("SYNTHETIC"),
  `titreme=%${enrollTts.detail.f0JitterPct} · bayraklar=${enrollTts.flagNames.join(",") || "(yok)"}`,
);
check(
  "sentetik ses icin uyari veriliyor",
  enrollTts.advisories.length > 0,
  enrollTts.advisories.join(" | ") || "(uyari yok)",
);

// 5) Kapinin tamami: createBaselineProof gercekten engelleyenleri reddetmeli.
check("döngü kaydi baseline olarak kaydedilmiyor", !createBaselineProof(normalise(looped), RATE).ok);
check("dijital sessizlik baseline olarak kaydedilmiyor", !createBaselineProof(new Float32Array(RATE * 3.2), RATE).ok);

// 6) Yanlis red olusmamali: basit bir ton degil, konusma benzeri kayit gecmeli.
check(
  "konusma benzeri kayit Enrollment kapisini gecuyor",
  createBaselineProof(speech, RATE).ok,
  createBaselineProof(speech, RATE).problems.join(" | "),
);
check(
  "canli konusma icin hicbir bayrak kalkmiyor",
  enrollHuman.flagNames.length === 0,
  enrollHuman.flagNames.join(",") || "(yok)",
);

// 7) Skorlar her zaman raporlanmali — gecse de gecmese de (UI buna bagli).
check(
  "skorlar gecse de her zaman mevcut",
  typeof enrollHuman.presenceBps === "number" &&
    typeof enrollHuman.naturalnessBps === "number",
);
check(
  "liveness skoru 0..10_000 araliginda",
  [enrollHuman, enrollSilence, enrollLoop, enrollTts].every(
    (r) => r.livenessBps >= 0 && r.livenessBps <= 10_000,
  ),
);
check(
  "her basarisiz kayitta en az bir aciklanabilir sebep var",
  [enrollSilence, enrollLoop].every((r) => r.problems.length > 0),
);
check(
  "gecen kaydin problems listesi bos",
  enrollHuman.problems.length === 0,
);

console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);

// ---------------------------------------------------------------------------
function quietDown(buf, factor) {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] * factor;
  return out;
}
function peakOf(buf) {
  let p = 0;
  for (const v of buf) p = Math.max(p, Math.abs(v));
  return p;
}
/** Normalised correlation of `a` against `b` decimated by `stride`. */
function correlation(a, b, stride) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const y = b[i * stride];
    dot += a[i] * y;
    na += a[i] * a[i];
    nb += y * y;
  }
  return dot / (Math.sqrt(na * nb) + 1e-12);
}
function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
