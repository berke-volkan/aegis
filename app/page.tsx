import { AegisConsole } from "@/components/AegisConsole";
import { WalletBar } from "@/components/WalletBar";

export default function Page() {
  return (
    <main className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-edge/80 bg-void/80 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="relative grid size-8 place-items-center rounded-lg border border-aegis/40 bg-aegis/10">
              <span className="text-sm">🛡️</span>
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-aegis" />
            </div>
            <div className="leading-none">
              <div className="text-sm font-bold tracking-tight text-ink">Aegis</div>
              <div className="mt-0.5 font-mono text-[9px] tracking-[0.16em] text-ink-faint">
                CALL VERIFICATION ZK
              </div>
            </div>
          </div>
          <WalletBar />
        </div>
      </header>

      <AegisConsole />
    </main>
  );
}
