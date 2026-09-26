"use client";

import { useEffect, useRef } from "react";

/**
 * Live microphone visualiser.
 *
 * Renders the level history as a radial waveform around a static core. When
 * idle it breathes slowly; while recording it tracks the RMS envelope in real
 * time so the user can see the mic is actually picking them up.
 */
export function VoiceOrb({
  history,
  active,
  size = 148,
  danger = false,
}: {
  history: number[];
  active: boolean;
  size?: number;
  danger?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef(history);
  historyRef.current = history;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    let raf = 0;
    let t = 0;

    const draw = () => {
      t += 0.016;
      ctx.clearRect(0, 0, size, size);

      const cx = size / 2;
      const cy = size / 2;
      const baseRadius = size * 0.26;

      const accent = danger ? "255, 77, 94" : active ? "74, 222, 155" : "124, 92, 255";

      // --- outer pulse rings (idle breathe / active throb) ----------------
      if (active || danger) {
        for (let i = 0; i < 2; i++) {
          const phase = (t * 0.9 + i * 0.5) % 1;
          ctx.beginPath();
          ctx.arc(cx, cy, baseRadius + phase * size * 0.24, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${accent},${(1 - phase) * 0.35})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // --- radial waveform from the level history -------------------------
      const bars = 72;
      const hist = historyRef.current;
      for (let i = 0; i < bars; i++) {
        const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
        const idx = hist.length ? hist[Math.min(hist.length - 1, Math.floor((i / bars) * hist.length))] : 0;
        const idleWave = (Math.sin(t * 2 + i * 0.28) + 1) / 2;
        const level = active ? Math.min(1, idx * 7.5) : idleWave * 0.16;
        const len = size * 0.06 + level * size * 0.24;
        const r1 = baseRadius + size * 0.08;
        const r2 = r1 + len;

        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
        ctx.lineTo(cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2);
        ctx.strokeStyle = `rgba(${accent},${0.25 + level * 0.7})`;
        ctx.lineWidth = active ? 2 : 1.4;
        ctx.lineCap = "round";
        ctx.stroke();
      }

      // --- core ------------------------------------------------------------
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius);
      grad.addColorStop(0, `rgba(${accent},${active ? 0.4 : 0.22})`);
      grad.addColorStop(1, `rgba(${accent},0)`);
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius * 0.34, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${accent},${active ? 0.95 : 0.55})`;
      ctx.fill();

      raf = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(raf);
  }, [active, size, danger]);

  return <canvas ref={canvasRef} style={{ width: size, height: size }} aria-hidden />;
}
