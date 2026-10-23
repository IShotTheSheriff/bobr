"use client";

import { motion } from "framer-motion";
import { calculate } from "../lib/calculator";
import { useState, useEffect } from "react";
import Image from "next/image";
import { Calculator, Database, Box, Scissors, Target } from "lucide-react";

const BeaverMascot = ({
  focusValue,
  isIdle,
}: {
  focusValue: number;
  isIdle: boolean;
}) => {
  // Map focusValue (1-100) to eye movement
  // X axis: -6 to 6
  // Y axis: 2 to 6 (looking down slightly)
  const pupilX = ((focusValue - 50) / 50) * 6;
  const pupilY = 4 + (Math.abs(focusValue - 50) / 50) * 2;

  // Eye roll animation sequence
  const eyeRollVariants = {
    idle: {
      cx: [70, 70, 76, 70, 64, 70],
      cy: [90, 84, 90, 96, 90, 90],
      transition: {
        duration: 2,
        times: [0, 0.2, 0.4, 0.6, 0.8, 1],
        repeat: Infinity,
        repeatDelay: 3,
      },
    },
    active: {
      cx: 70 + pupilX,
      cy: 90 + pupilY,
      transition: { type: "spring" as const, stiffness: 300, damping: 20 },
    },
  };

  const eyeRollVariantsRight = {
    idle: {
      cx: [130, 130, 136, 130, 124, 130],
      cy: [90, 84, 90, 96, 90, 90],
      transition: {
        duration: 2,
        times: [0, 0.2, 0.4, 0.6, 0.8, 1],
        repeat: Infinity,
        repeatDelay: 3,
      },
    },
    active: {
      cx: 130 + pupilX,
      cy: 90 + pupilY,
      transition: { type: "spring" as const, stiffness: 300, damping: 20 },
    },
  };

  return (
    <svg
      width="200"
      height="200"
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="drop-shadow-2xl"
    >
      {/* Ears */}
      <circle cx="40" cy="50" r="20" fill="#5D4037" />
      <circle cx="160" cy="50" r="20" fill="#5D4037" />
      <circle cx="40" cy="50" r="12" fill="#3E2723" />
      <circle cx="160" cy="50" r="12" fill="#3E2723" />

      {/* Head */}
      <path
        d="M100 180C150 180 180 150 180 100C180 50 150 20 100 20C50 20 20 50 20 100C20 150 50 180 100 180Z"
        fill="#795548"
      />

      {/* Cheeks/Snout area */}
      <ellipse cx="100" cy="120" rx="60" ry="35" fill="#8D6E63" />

      {/* Eyes Container */}
      <g transform="translate(0, -5)">
        {/* Left Eye Background */}
        <ellipse cx="70" cy="90" rx="15" ry="18" fill="white" />
        {/* Right Eye Background */}
        <ellipse cx="130" cy="90" rx="15" ry="18" fill="white" />

        {/* Pupils - Animated */}
        <motion.circle
          r="6"
          fill="black"
          variants={eyeRollVariants}
          animate={isIdle ? "idle" : "active"}
        />
        <motion.circle
          r="6"
          fill="black"
          variants={eyeRollVariantsRight}
          animate={isIdle ? "idle" : "active"}
        />
      </g>

      {/* Nose */}
      <path
        d="M88 115C88 108 112 108 112 115C112 122 100 128 100 128C100 128 88 122 88 115Z"
        fill="#212121"
      />

      {/* Teeth */}
      <rect
        x="90"
        y="128"
        width="8"
        height="12"
        rx="2"
        fill="white"
        stroke="#EFEFEF"
        strokeWidth="1"
      />
      <rect
        x="102"
        y="128"
        width="8"
        height="12"
        rx="2"
        fill="white"
        stroke="#EFEFEF"
        strokeWidth="1"
      />

      {/* Whiskers */}
      <line
        x1="50"
        y1="120"
        x2="30"
        y2="115"
        stroke="#3E2723"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="50"
        y1="125"
        x2="30"
        y2="125"
        stroke="#3E2723"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="150"
        y1="120"
        x2="170"
        y2="115"
        stroke="#3E2723"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="150"
        y1="125"
        x2="170"
        y2="125"
        stroke="#3E2723"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
};

export default function Home() {
  const [inputVal, setInputVal] = useState(50);
  const [isIdle, setIsIdle] = useState(false);
  const [lastInteraction, setLastInteraction] = useState(() => Date.now());
  const result = calculate(inputVal);

  // Idle detection logic
  useEffect(() => {
    const idleTimer = setInterval(() => {
      if (Date.now() - lastInteraction > 3000) {
        // 3 seconds of inactivity
        setIsIdle(true);
      }
    }, 1000);

    return () => clearInterval(idleTimer);
  }, [lastInteraction]);

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputVal(Number(e.target.value));
    setLastInteraction(Date.now());
    setIsIdle(false);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0c0c0c] text-white overflow-hidden selection:bg-blue-500/30 items-center justify-center relative">
      {/* Background Image with Overlay */}
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-linear-to-br from-[#375BD2]/10 to-black/80 z-10 mix-blend-overlay" />
        {/* Placeholder for user image - assuming they will save it as chainlink-bg.png */}
        {/* If not present, it will fallback to dark bg colors */}
        <div className="absolute inset-0 bg-[#080810]" />
        <Image
          src="/bg.avif"
          alt="Background"
          fill
          className="object-cover opacity-60 mix-blend-soft-light"
          priority
        />
      </div>

      <main className="w-full max-w-3xl px-6 flex flex-col items-center gap-16 z-10">
        {/* Hero Text */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-6"
        >
          <h1 className="text-7xl md:text-8xl font-bold tracking-tighter bg-clip-text text-transparent bg-linear-to-b from-white via-white to-[#375BD2] drop-shadow-[0_0_30px_rgba(55,91,210,0.3)] pb-2">
            Bóbr
          </h1>
          <div className="space-y-2">
            <p className="text-xl md:text-2xl font-light text-zinc-300">
              The proper way to beaver CI pipelines.
            </p>
            <p className="text-zinc-400 text-sm md:text-base max-w-md mx-auto leading-relaxed">
              Showcasing optimized{" "}
              <span className="text-[#375BD2] font-medium">
                Bun + Turborepo
              </span>{" "}
              with intelligent caching, tree shaking and no useless runs.
            </p>
          </div>
        </motion.div>

        {/* Mascot & Interactive Card Combined */}
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="w-full bg-[#1a1d26]/60 border border-[#375BD2]/20 rounded-3xl p-8 backdrop-blur-xl shadow-[0_0_50px_-12px_rgba(55,91,210,0.25)] flex flex-col items-center gap-8"
        >
          {/* Mascot - Floating Animation */}
          <motion.div
            animate={{ y: [0, -15, 0] }}
            transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
            className="transform -mt-24 mb-[-20px] hover:scale-105 transition-transform duration-300 drop-shadow-[0_20px_40px_rgba(0,0,0,0.5)]"
          >
            <BeaverMascot focusValue={inputVal} isIdle={isIdle} />
          </motion.div>

          <div className="w-full space-y-8">
            {/* Slider Control */}
            <div className="space-y-4">
              <div className="flex justify-between items-end px-2">
                <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">
                  Slider Input
                </label>
                <span className="font-mono text-2xl font-bold text-[#375BD2]">
                  {inputVal}
                </span>
              </div>

              <div className="relative h-8 flex items-center group">
                {/* Custom Range Slider styling */}
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={inputVal}
                  onChange={handleInput}
                  className="w-full h-2 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-[#375BD2] z-20 relative focus:outline-none focus:ring-2 focus:ring-[#375BD2]/50 hover:accent-[#2c48a8] transition-all"
                />
              </div>
            </div>

            {/* Result Display */}
            <div className="bg-black/40 rounded-xl p-6 border border-[#375BD2]/10 font-mono relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-20 transition-opacity duration-500">
                <Calculator className="w-20 h-20 text-white" />
              </div>

              <div className="space-y-3 relative z-10">
                <div className="flex items-center gap-2 text-zinc-500 text-xs uppercase tracking-wider">
                  <Box className="w-3 h-3" />
                  <span>@repo/ui/utils/add.ts</span>
                </div>
                <div className="text-xl md:text-2xl flex items-center gap-3 p-2">
                  <span className="text-[#375BD2] font-semibold">add</span>
                  <span className="text-zinc-500">(</span>
                  <span className="text-white">{inputVal}</span>
                  <span className="text-zinc-500">)</span>
                  <span className="text-zinc-600">→</span>
                  <span className="text-green-400 font-bold drop-shadow-[0_0_15px_rgba(74,222,128,0.3)]">
                    {result}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Action Buttons */}
        <div className="flex gap-6">
          <motion.a
            href={
              process.env.NEXT_PUBLIC_BOBR_DOCS_URL || "http://localhost:3001"
            }
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="group relative px-8 py-4 bg-[#375BD2] text-white rounded-full font-bold transition-all shadow-[0_0_40px_-10px_rgba(55,91,210,0.4)] hover:shadow-[0_0_60px_-15px_rgba(55,91,210,0.6)] overflow-hidden border border-white/10"
          >
            <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-in-out" />
            <span className="relative flex items-center gap-3">
              See Docuzaurs
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </span>
          </motion.a>

          <motion.a
            href="/demo"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="group relative px-8 py-4 bg-zinc-800 text-white rounded-full font-bold transition-all shadow-[0_0_40px_-10px_rgba(255,255,255,0.1)] hover:bg-zinc-700 overflow-hidden border border-white/10"
          >
            <span className="relative flex items-center gap-3">
              View Demo
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </span>
          </motion.a>
        </div>

        {/* Footer-ish text */}
        <div className="grid grid-cols-3 gap-8 md:gap-16 text-sm text-zinc-500 mt-4 border-t border-white/5 pt-8">
          <div className="flex flex-col items-center gap-2 text-center group cursor-default">
            <div className="p-2 rounded-full bg-white/5 group-hover:bg-white/10 transition-colors text-[#375BD2]">
              <Database className="w-5 h-5" />
            </div>
            <span className="font-medium text-zinc-400 group-hover:text-zinc-200 transition-colors">
              Proper Cache
            </span>
          </div>
          <div className="flex flex-col items-center gap-2 text-center group cursor-default">
            <div className="p-2 rounded-full bg-white/5 group-hover:bg-white/10 transition-colors text-blue-400">
              <Scissors className="w-5 h-5" />
            </div>
            <span className="font-medium text-zinc-400 group-hover:text-zinc-200 transition-colors">
              Tree shaking
            </span>
          </div>
          <div className="flex flex-col items-center gap-2 text-center group cursor-default">
            <div className="p-2 rounded-full bg-white/5 group-hover:bg-white/10 transition-colors text-green-400">
              <Target className="w-5 h-5" />
            </div>
            <span className="font-medium text-zinc-400 group-hover:text-zinc-200 transition-colors">
              No useless runs
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}

function ArrowRight(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}
