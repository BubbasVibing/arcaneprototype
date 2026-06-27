"use client"

import { motion, useInView } from "framer-motion"
import { useRef } from "react"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

export function FinalCTA() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })

  return (
    <section className="py-24 px-6 border-t border-stone-200">
      <motion.div
        ref={ref}
        initial={{ opacity: 0, y: 40 }}
        animate={isInView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="max-w-6xl mx-auto text-center"
      >
        <h2 className="text-4xl sm:text-5xl lg:text-6xl font-light text-zinc-900 mb-6 tracking-tight">
          Your agent writes fast.<br />Arcane keeps it shippable.
        </h2>
        <p className="text-lg text-stone-500 mb-10 max-w-xl mx-auto">
          Free to start. Runs on any computer. No local toolchain needed.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Button
            size="lg"
            className="bg-zinc-900 text-white hover:bg-zinc-700 rounded-full px-8 h-12 text-sm font-medium"
          >
            Get Started Free
            <ArrowRight className="ml-2 w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="rounded-full px-8 h-12 text-sm font-medium border-stone-300 text-zinc-600 hover:bg-stone-100 hover:text-zinc-900 bg-transparent"
          >
            View Docs
          </Button>
        </div>
      </motion.div>
    </section>
  )
}
