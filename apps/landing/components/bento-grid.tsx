"use client"

import { useEffect, useRef, useState } from "react"
import { useInView } from "framer-motion"

const DIMENSIONS = [
  { label: "security",     key: "security"    },
  { label: "complexity",   key: "complexity"  },
  { label: "dead code",    key: "deadcode"    },
  { label: "type safety",  key: "types"       },
  { label: "dependencies", key: "deps"        },
  { label: "secrets",      key: "secrets"     },
]

const BASE_SCORES: Record<string, number> = {
  security:   88,
  complexity: 74,
  deadcode:   61,
  types:      92,
  deps:       83,
  secrets:    100,
}

const EVENTS = [
  { at: 800,   dim: "complexity",  delta: -14, msg: "payments.ts",  detail: "nested loop over growing data" },
  { at: 2200,  dim: "deadcode",    delta: -12, msg: "cart.ts",      detail: "3 unused exports" },
  { at: 3800,  dim: "security",    delta: -22, msg: "auth.ts",      detail: "SQL injection risk · high" },
  { at: 5200,  dim: "types",       delta: -8,  msg: "orders.ts",    detail: "2 new `any` casts" },
  { at: 6600,  dim: "secrets",     delta: -30, msg: "config.ts",    detail: "hardcoded API key" },
  { at: 8000,  dim: "deps",        delta: -9,  msg: "package.json", detail: "1 vulnerable dep added" },
  { at: 9600,  dim: "complexity",  delta: -8,  msg: "checkout.ts",  detail: "complexity 14 → 22" },
  { at: 11500, dim: "security",    delta: +22, msg: "auth.ts",      detail: "injection fixed" },
  { at: 13000, dim: "secrets",     delta: +30, msg: "config.ts",    detail: "key moved to env" },
  { at: 14500, dim: "deadcode",    delta: +8,  msg: "cart.ts",      detail: "exports cleaned up" },
]

const LOOP_DURATION = 16000
const TOTAL_SEGMENTS = 20

function SegmentedBar({ value }: { value: number }) {
  const filled = Math.round((value / 100) * TOTAL_SEGMENTS)

  return (
    <div className="flex items-center gap-[2px] w-full">
      {Array.from({ length: TOTAL_SEGMENTS }).map((_, i) => {
        const isFilled = i < filled
        return (
          <div
            key={i}
            style={{
              flex: "1 1 0",
              height: 20,
              borderRadius: 2,
              minWidth: 0,
              transition: "background-color 0.4s ease",
              backgroundColor: isFilled ? "#1c1917" : "#e2dfd9",
              backgroundImage: "none",
              backgroundSize: "auto",
              backgroundPosition: "0 0",
            }}
          />
        )
      })}
    </div>
  )
}

export function BentoGrid() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-80px" })
  const [scores, setScores] = useState<Record<string, number>>(BASE_SCORES)
  const [log, setLog] = useState<Array<{ msg: string; detail: string; delta: number; id: number }>>([])

  useEffect(() => {
    if (!isInView) return

    function runCycle() {
      setScores({ ...BASE_SCORES })
      setLog([])
      const timers: ReturnType<typeof setTimeout>[] = []
      EVENTS.forEach((ev, idx) => {
        const t = setTimeout(() => {
          setScores((prev) => ({
            ...prev,
            [ev.dim]: Math.max(0, Math.min(100, prev[ev.dim] + ev.delta)),
          }))
          setLog((prev) =>
            [{ msg: ev.msg, detail: ev.detail, delta: ev.delta, id: Date.now() + idx }, ...prev].slice(0, 7)
          )
        }, ev.at)
        timers.push(t)
      })
      return timers
    }

    const initial = runCycle()
    const loopInterval = setInterval(runCycle, LOOP_DURATION)
    return () => {
      initial.forEach(clearTimeout)
      clearInterval(loopInterval)
    }
  }, [isInView])

  return (
    <section ref={ref} className="border-t border-stone-200 py-24">
      <div className="max-w-6xl mx-auto px-6">

        {/* TOP ROW — headline + description left, terminal right */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center mb-14">

          {/* LEFT — headline + short description */}
          <div className="pt-2">
            <h2 className="text-5xl md:text-6xl font-light text-zinc-900 leading-[1.05] mb-6">
              Real-time intelligence.<br />
              Zero unnecessary work.
            </h2>
            <p className="text-base text-stone-400 leading-relaxed max-w-sm">
              Every file save streams to Arcane Cloud. Security, complexity, dead code, and type safety scores update live — in your terminal and browser simultaneously.
            </p>
          </div>

          {/* RIGHT — white Mac terminal panel */}
          <div
            className="rounded-2xl p-6 font-mono"
            style={{
              background: "#ffffff",
              border: "1px solid #e5e7eb",
              boxShadow: "0 4px 24px 0 rgba(0,0,0,0.07), 0 1.5px 4px 0 rgba(0,0,0,0.04)",
            }}
          >
            {/* Terminal title bar */}
            <div
              className="flex items-center gap-2 mb-6 pb-4"
              style={{ borderBottom: "1px solid #f3f4f6" }}
            >
              <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <div className="w-3 h-3 rounded-full bg-[#ffbd2e]" />
              <div className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-auto flex items-center gap-1.5 text-xs text-emerald-600">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" />
                watching
              </span>
            </div>

            <div className="space-y-5">
              {DIMENSIONS.map((dim) => {
                const val = scores[dim.key]
                return (
                  <div key={dim.key} className="flex items-center gap-2">
                    <span className="text-xs w-20 shrink-0 text-stone-400">{dim.label}</span>
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <SegmentedBar value={val} />
                    </div>
                    <span className="text-sm font-bold tabular-nums shrink-0 w-7 text-right text-zinc-800">
                      {val}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* BOTTOM ROW — change timeline full width */}
        <div className="border-t border-stone-200 pt-8">
          <div className="font-mono text-xs text-stone-400 mb-5 tracking-widest">CHANGE TIMELINE</div>
          {log.length === 0 ? (
            <div className="text-xs text-stone-300 font-mono animate-pulse">watching for changes…</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-3">
              {log.slice(0, 8).map((entry, i) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 font-mono text-xs"
                  style={{ opacity: Math.max(0.15, 1 - i * 0.1) }}
                >
                  <span
                    className="shrink-0 w-3 text-center leading-none"
                    style={{ color: entry.delta < 0 ? "#dc2626" : "#059669", fontSize: "9px" }}
                  >
                    {entry.delta < 0 ? "▼" : "▲"}
                  </span>
                  <span
                    className="shrink-0 w-6 text-right font-semibold tabular-nums"
                    style={{ color: entry.delta < 0 ? "#dc2626" : "#059669" }}
                  >
                    {Math.abs(entry.delta)}
                  </span>
                  <span className="text-zinc-700 truncate">{entry.msg}</span>
                  <span className="text-stone-400 truncate">— {entry.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </section>
  )
}
