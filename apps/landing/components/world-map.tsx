"use client"

import { useEffect, useRef, useState } from "react"
import * as d3 from "d3"
import type { Experience } from "@/lib/experience-data"

interface WorldMapProps {
  experiences: Experience[]
  selectedExperience: Experience | null
  onSelectExperience: (exp: Experience | null) => void
}

export function WorldMap({ experiences, selectedExperience, onSelectExperience }: WorldMapProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 1138, height: 640 })
  const [hoveredExp, setHoveredExp] = useState<Experience | null>(null)
  const [projection, setProjection] = useState<d3.GeoProjection | null>(null)

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { width } = containerRef.current.getBoundingClientRect()
        setDimensions({ width: Math.max(width, 1138), height: Math.max(width * (640 / 1138), 640) })
      }
    }
    updateDimensions()
    window.addEventListener("resize", updateDimensions)
    return () => window.removeEventListener("resize", updateDimensions)
  }, [])

  useEffect(() => {
    const { width, height } = dimensions

    const validLocations = experiences.filter((exp) => !exp.location.isRemote)
    let centerLng = 40
    let centerLat = 30

    if (validLocations.length > 0) {
      centerLng = validLocations.reduce((sum, exp) => sum + exp.location.lng, 0) / validLocations.length
      centerLat = validLocations.reduce((sum, exp) => sum + exp.location.lat, 0) / validLocations.length
    }

    const proj = d3
      .geoNaturalEarth1()
      .scale(width / 4)
      .translate([width / 2, height / 2])
      .center([centerLng, centerLat])

    setProjection(() => proj)
  }, [dimensions, experiences])

  const getMarkerPosition = (exp: Experience): [number, number] | null => {
    if (!projection) return null
    return projection([exp.location.lng, exp.location.lat])
  }

  const colorMap: Record<string, string> = {
    pink: "#ec4899",
    yellow: "#eab308",
    green: "#22c55e",
    blue: "#3b82f6",
  }

  const colorClassMap: Record<string, string> = {
    pink: "bg-pink-500",
    yellow: "bg-yellow-500",
    green: "bg-green-500",
    blue: "bg-blue-500",
  }

  return (
    <div ref={containerRef} className="relative w-full h-full">
      <div className="relative w-full h-auto">
        <img src="/map.svg" alt="World Map" className="w-full h-auto" />
      </div>
    </div>
  )
}
