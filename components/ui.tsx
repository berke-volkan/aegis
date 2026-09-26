"use client";

import { type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "ghost" | "outline" | "danger" | "success";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-plasma text-white hover:bg-plasma-soft disabled:hover:bg-plasma shadow-[0_0_28px_-8px] shadow-plasma/70",
  success:
    "bg-aegis text-void hover:brightness-110 disabled:hover:bg-aegis font-semibold shadow-[0_0_28px_-8px] shadow-aegis/70",
  danger:
    "bg-alert text-white hover:brightness-110 disabled:hover:bg-alert font-semibold shadow-[0_0_28px_-8px] shadow-alert/70",
  outline:
    "border border-edge-bright text-ink hover:border-plasma/70 hover:bg-plasma/10 disabled:hover:border-edge-bright",
  ghost: "text-ink-dim hover:text-ink hover:bg-white/5",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-13 px-6 text-base gap-2.5",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`inline-flex items-center justify-center rounded-xl font-medium transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-plasma/70 focus-visible:ring-offset-2 focus-visible:ring-offset-void disabled:cursor-not-allowed disabled:opacity-45 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
}

export function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Panel({
  children,
  className = "",
  glow,
}: {
  children: ReactNode;
  className?: string;
  glow?: "aegis" | "alert" | "plasma";
}) {
  const glowRing =
    glow === "aegis"
      ? "border-aegis/35 shadow-[0_0_50px_-20px] shadow-aegis/60"
      : glow === "alert"
        ? "border-alert/40 shadow-[0_0_50px_-20px] shadow-alert/60"
        : glow === "plasma"
          ? "border-plasma/35 shadow-[0_0_50px_-20px] shadow-plasma/60"
          : "";
  return <div className={`panel ${glowRing} ${className}`}>{children}</div>;
}

export function Pill({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "aegis" | "alert" | "warn" | "plasma";
  className?: string;
}) {
  const tones = {
    neutral: "border-edge text-ink-dim",
    aegis: "border-aegis/40 text-aegis bg-aegis/10",
    alert: "border-alert/40 text-alert bg-alert/10",
    warn: "border-warn/40 text-warn bg-warn/10",
    plasma: "border-plasma/40 text-plasma-soft bg-plasma/10",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] tracking-tight ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function SectionTitle({
  step,
  title,
  subtitle,
  right,
}: {
  step?: string;
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        {step && (
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-plasma/40 bg-plasma/10 font-mono text-xs text-plasma-soft">
            {step}
          </span>
        )}
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-ink-dim">{subtitle}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

export function Field({
  label,
  children,
  mono = true,
  hint,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </div>
      <div
        className={`truncate text-[13px] text-ink ${mono ? "font-mono" : ""}`}
        title={typeof children === "string" ? children : undefined}
      >
        {children}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-ink-faint">{hint}</div>}
    </div>
  );
}

export function Meter({
  value,
  max = 1,
  tone = "aegis",
  label,
}: {
  value: number;
  max?: number;
  tone?: "aegis" | "alert" | "warn" | "plasma";
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const tones = {
    aegis: "from-aegis to-aegis",
    alert: "from-alert to-alert",
    warn: "from-warn to-warn",
    plasma: "from-plasma to-plasma-soft",
  } as const;
  return (
    <div className="w-full">
      {label && (
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</span>
          <span className="font-mono text-[11px] text-ink-dim">{pct.toFixed(0)}%</span>
        </div>
      )}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/6">
        <div
          className={`h-full rounded-full bg-gradient-to-r transition-[width] duration-500 ${tones[tone]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: "aegis" | "alert" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-edge/60 py-1.5 last:border-0">
      <span className="shrink-0 text-[11px] text-ink-faint">{label}</span>
      <span
        className={`truncate text-right font-mono text-[12px] ${
          tone === "aegis" ? "text-aegis" : tone === "alert" ? "text-alert" : "text-ink-dim"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
