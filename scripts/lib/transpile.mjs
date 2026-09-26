/**
 * TypeScript → CommonJS transpile yardımcısı (paylaşılan).
 *
 * Neden `tsc` CLI değil: doğrulama betikleri `lib/` altındaki dosyaları geçici bir
 * klasöre derleyip Node'da `require` ediyor. `tsc` CLI ile bunu yapmak sürüm
 * kaprisine bağlı:
 *
 *   · TS ≥ 5.0  → dosyalar komut satırında verilirken tsconfig yanında hata verir (TS5112)
 *   · TS ≥ 6.0  → eski `node` (node10) çözümlemesi kullanımdan kaldırılır
 *   · node16/nodenext çözümlemesi → kaynaklara `.js` uzantısı eklemeyi zorunlu
 *     kılar, ki bu Next.js/bundler tarafında yanlış olurdu
 *
 * `ts.transpileModule` dosya başına, çözümleme yapmadan ve tip kontrolü
 * yapmadan derler: sürümden bağımsızdır ve görevi olan şeyi yapar. Tip kontrolü
 * zaten `npm run typecheck` ile ayrıca yapılıyor.
 *
 * Çıktı CommonJS olur ve göreli import'lar uzantısız kalır — Node'un CJS
 * çözümlemesi bunu memnuniyetle kabul eder.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

/**
 * @param {string} root   repo kökü
 * @param {string} outDir derleme çıktısının yazılacağı dizin
 * @param {string[]|string} files repo köküne görecel `.ts` dosyalar — bir dizin
 *   verilirse (örn. `"lib"`) tüm alt dosyalar özyinelemeli alınır
 * @returns {string} çıktı dizini
 */
export function transpileToCjs(root, outDir, files) {
  // typescript normalde ESM-only import edilemez; CJS çözümleyiciyle alıyoruz.
  const require_ = createRequire(join(root, "package.json"));
  const ts = require_("typescript");

  const compilerOptions = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    useDefineForClassFields: true,
  };

  for (const rel of expand(root, files)) {
    const source = readFileSync(join(root, rel), "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName: rel,
      compilerOptions,
      // transpileModule tek dosyada çalışır; çok dosyalı tip kontrolü burada
      // istenmez (bkz. `npm run typecheck`).
      reportDiagnostics: false,
    });
    const dest = join(outDir, rel.replace(/\.ts$/, ".js"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, outputText, "utf8");
  }

  // Repo kökü `"type": "module"` olabilir (Hardhat 3 ESM ister), bu durumda
  // `.js` dosyaları ESM sanılır ve `exports is not defined` patlar. Çıktı
  // dizinine kendi manifest'ini yazarak betiği kök ayardan bağımsız kılar.
  writeFileSync(
    join(outDir, "package.json"),
    `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
    "utf8",
  );

  return outDir;
}

/**
 * Dosya listesini genişletir: bir dizin verilmişse içindeki tüm `.ts`
 * dosyaları özyinelemeli toplar.
 *
 * Betiklerin dosya listesini elle tutması, `lib/` altına yeni bir modül
 * eklendiğinde sessizce `MODULE_NOT_FOUND` ile patlıyordu — hatayı ancak tam
 * `npm run check` çalıştırınca görüyordun. Dizin vermek yeterli.
 */
function expand(root, files) {
  const out = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      // Dizin değil — düz dosya girdisi olarak ele al.
      out.push(rel);
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = relative(root, join(abs, entry.name)).split(sep).join("/");
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(child);
    }
  };
  for (const f of [files].flat()) walk(f);
  return out;
}
