"use client"

export function Footer() {
  return (
    <footer className="border-t border-stone-200">
      <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-sm text-stone-400">&copy; {new Date().getFullYear()} Arcane. All rights reserved.</p>
        <div className="flex items-center gap-6">
          <a href="#" className="text-sm text-stone-400 hover:text-zinc-900 transition-colors">Twitter</a>
          <a href="#" className="text-sm text-stone-400 hover:text-zinc-900 transition-colors">GitHub</a>
          <a href="#" className="text-sm text-stone-400 hover:text-zinc-900 transition-colors">Discord</a>
        </div>
      </div>
    </footer>
  )
}
