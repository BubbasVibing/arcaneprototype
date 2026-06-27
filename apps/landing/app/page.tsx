"use client"

import { useEffect, useRef, useState } from "react"
import { Copy, Check } from "lucide-react"
import { AnimatedText } from "@/components/animated-text"
import { SmoothScroll } from "@/components/smooth-scroll"
import { BentoGrid } from "@/components/bento-grid"
import { FinalCTA } from "@/components/final-cta"
import { Footer } from "@/components/footer"

const THE_FLOW = [
  {
    num: "001",
    barWidth: "25%",
    title: "Vibe-coded code looks done.",
    desc: "Agentic coding is astonishing at turning a prompt into a working app. But the demo ships — then it doesn't hold up. Slow, bloated, insecure, fragile.",
  },
  {
    num: "002",
    barWidth: "50%",
    title: "Arcane watches every change.",
    desc: "A thin CLI streams each file save to Arcane Cloud over TLS. No local toolchain. No horsepower needed. Runs on any computer.",
  },
  {
    num: "003",
    barWidth: "75%",
    title: "Cloud scores it in real time.",
    desc: "Complexity, dead code, performance, security — analyzed server-side against a shadow copy of your repo.",
  },
  {
    num: "004",
    barWidth: "100%",
    title: "Terminal + browser, simultaneously.",
    desc: "One result event fans out to your CLI and your web dashboard at the same moment. You and your team see the same live data, at the same time.",
  },
]

function FlowCard({ item }: { item: typeof THE_FLOW[0] }) {
  const [hovered, setHovered] = useState(false)
  const blue = "#1930fe"
  const color = hovered ? blue : "#a8a29e"
  const barColor = hovered ? blue : "#d6d3d1"
  const titleColor = hovered ? blue : "#1c1917"

  return (
    <div
      key={item.num}
      className="py-10 px-6 flex flex-col gap-5 cursor-default transition-colors duration-200"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="font-mono text-sm font-medium transition-colors duration-200" style={{ color }}>
        {item.num}
      </span>
      {/* progress bar — width increases per step */}
      <div className="h-px w-full bg-stone-200 relative">
        <div
          className="absolute inset-y-0 left-0 h-full transition-all duration-300"
          style={{ width: item.barWidth, backgroundColor: barColor }}
        />
        <div
          className="absolute w-2 h-2 rounded-full transition-all duration-300"
          style={{ left: item.barWidth, top: "50%", transform: "translate(-50%, -50%)", backgroundColor: barColor }}
        />
      </div>
      <h3
        className="text-base font-semibold leading-snug transition-colors duration-200"
        style={{ color: titleColor }}
      >
        {item.title}
      </h3>
      <p className="text-sm text-stone-400 leading-relaxed">{item.desc}</p>
    </div>
  )
}

function HowItWorks() {
  return (
    <section className="border-t border-stone-200">
      {/* Headline */}
      <div className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-5xl md:text-6xl font-light text-zinc-900 leading-[1.05]">
          the problem.<br />
          arcane fixes it.
        </h2>
      </div>

      {/* Grid */}
      <div className="border-t border-stone-200">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-stone-200">
            {THE_FLOW.map((item) => (
              <FlowCard key={item.num} item={item} />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}


export default function TerraPage() {
  const [isLoaded, setIsLoaded] = useState(false)
  const [scrollY, setScrollY] = useState(0)
  const [dynamicWordIndex, setDynamicWordIndex] = useState(0)
  const [wordFade, setWordFade] = useState(true)
  const [dashboardScrollOffset, setDashboardScrollOffset] = useState(0)
  const [copied, setCopied] = useState(false)
  const logoOpacity = Math.max(0, 1 - scrollY / 180)
  const dashboardRef = useRef<HTMLDivElement>(null)
  const heroRef = useRef<HTMLDivElement>(null)

  const CLI_COMMAND = "npm i @yassine115/arcane-cli"

  const handleCopy = () => {
    navigator.clipboard.writeText(CLI_COMMAND)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const dynamicWords = ["Quality", "Performance", "Security", "Scalability", "Dependencies"]

  useEffect(() => {
    const wordInterval = setInterval(() => {
      setWordFade(false)
      setTimeout(() => {
        setDynamicWordIndex((prev) => (prev + 1) % dynamicWords.length)
        setWordFade(true)
      }, 300)
    }, 3000)
    return () => clearInterval(wordInterval)
  }, [])

  useEffect(() => {
    const handleScroll = () => {
      setScrollY(window.scrollY)
      if (dashboardRef.current) {
        const dashboardRect = dashboardRef.current.getBoundingClientRect()
        const viewportHeight = window.innerHeight
        const rotationStart = viewportHeight * 0.8
        const rotationEnd = viewportHeight * 0.2
        if (dashboardRect.top >= rotationStart) {
          setDashboardScrollOffset(0)
        } else if (dashboardRect.top <= rotationEnd) {
          setDashboardScrollOffset(15)
        } else {
          const scrollRange = rotationStart - rotationEnd
          const currentProgress = rotationStart - dashboardRect.top
          const rotationProgress = currentProgress / scrollRange
          setDashboardScrollOffset(rotationProgress * 15)
        }
      }
    }
    handleScroll()
    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  useEffect(() => {
    setIsLoaded(true)
  }, [])

  return (
    <SmoothScroll>
      <div className="relative min-h-screen bg-[#0B0C0F] text-[#F2F3F5] overflow-x-hidden">
        {/* Fading corner logo */}
        <div
          className="fixed left-5 top-4 z-40 transition-opacity duration-200"
          style={{ opacity: logoOpacity, pointerEvents: logoOpacity < 0.05 ? "none" : "auto" }}
        >
          <button
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="p-0 m-0 block leading-none"
          >
            <span
              className="text-white font-semibold tracking-tight text-2xl"
              style={{ textShadow: "0 1px 4px rgba(0,0,0,0.35)" }}
            >
              Arcane
            </span>
          </button>
        </div>

        {/* Hero */}
        <section
          ref={heroRef}
          className={`relative min-h-screen flex flex-col items-center justify-center px-4 pt-24 pb-16 md:pt-32 md:pb-24 transition-all duration-[1200ms] ease-[cubic-bezier(0.16,1,0.3,1)] overflow-hidden ${isLoaded ? "scale-100 opacity-100" : "scale-[1.03] opacity-0"}`}
          style={{
            backgroundImage: `url('/hero-landscape.png')`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundAttachment: "fixed",
          }}
        >
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              transform: `translateY(${scrollY * 0.5}px)`,
              backgroundImage: `url('/hero-landscape.png')`,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#F6F1E9] via-[#0B0C0F]/60 to-transparent pointer-events-none" />

          <div
            className="max-w-[1120px] w-full mx-auto relative z-10"
            style={{ transform: `translateY(${scrollY * 0.2}px)` }}
          >
            <div className="text-center mb-8 md:mb-12">
              <h1 className="font-serif text-[44px] leading-[1.1] md:text-[72px] md:leading-[1.05] font-medium mb-6 text-balance">
                <span
                  className={`block stagger-reveal text-7xl font-light transition-all duration-500 md:text-8xl ${
                    wordFade ? "opacity-100 blur-0" : "opacity-0 blur-lg"
                  }`}
                >
                  Monitor <AnimatedText key={dynamicWordIndex} text={dynamicWords[dynamicWordIndex]} delay={0} />
                </span>
                <span className="block stagger-reveal text-7xl font-light md:text-8xl" style={{ animationDelay: "90ms" }}>
                  in real time
                </span>
              </h1>
              <p
                className="text-[#A7ABB3] text-base md:text-lg max-w-[540px] mx-auto mb-8 leading-relaxed stagger-reveal text-white"
                style={{ animationDelay: "180ms" }}
              >
                Catch what your AI agent misses — live code evaluation as you build.
              </p>
              <div className="stagger-reveal" style={{ animationDelay: "270ms" }}>
                <button
                  onClick={handleCopy}
                  className="group inline-flex items-center gap-3 px-6 py-4 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 backdrop-blur-md transition-all duration-300 text-white"
                >
                  <span className="text-[#A7ABB3] text-sm font-mono select-none">$</span>
                  <span className="text-sm font-mono">{CLI_COMMAND}</span>
                  <span className="ml-2 text-[#A7ABB3] group-hover:text-white transition-colors">
                    {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </span>
                </button>
              </div>
            </div>

            <div className="mt-12 md:mt-20 stagger-reveal" style={{ animationDelay: "360ms" }} ref={dashboardRef}>
              <div style={{ perspective: "1200px" }}>
                <div
                  className="relative aspect-[16/10] md:aspect-[16/9] rounded-[24px] overflow-hidden"
                  style={{
                    transform: `rotateX(${dashboardScrollOffset}deg)`,
                    transformStyle: "preserve-3d",
                    transition: "transform 0.05s linear",
                  }}
                >
                  <img
                    src="/dashboard-screenshot.png"
                    alt="Dashboard"
                    className="object-cover dashboard-image w-full h-auto"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Sections */}
        <div className="bg-[#F6F1E9]">
          <HowItWorks />
          <BentoGrid />
          <FinalCTA />
          <Footer />
        </div>
      </div>
    </SmoothScroll>
  )
}
