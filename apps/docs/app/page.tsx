"use client";

import { motion } from "framer-motion";
import { calculate } from "../lib/calculator";
import { useState, useEffect } from "react";
import { Calculator, Zap, Shield, Scale } from "lucide-react";

const DinoMascot = ({
  focusValue,
  isIdle,
}: {
  focusValue: number;
  isIdle: boolean;
}) => {
  // Map focusValue (1-100) to head tilt/movement
  const headRotate = ((focusValue - 50) / 50) * 10;

  return (
    <svg
      width="220"
      height="220"
      viewBox="0 0 220 220"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="drop-shadow-2xl"
    >
      {/* Body/Neck */}
      <path
        d="M110 180C110 180 90 160 90 130C90 100 110 90 110 90V180Z"
        fill="#2E7D32"
      />
      <path
        d="M110 180C110 180 130 160 130 130C130 100 110 90 110 90V180Z"
        fill="#1B5E20"
      />

      {/* Head Group - Animated */}
      <motion.g
        animate={{ rotate: headRotate }}
        transition={{ type: "spring", stiffness: 100, damping: 15 }}
        style={{ originX: "110px", originY: "90px" }}
      >
        {/* Head Shape */}
        <path
          d="M60 50C60 30 80 10 110 10C150 10 170 40 170 70C170 100 140 110 110 110C80 110 60 90 60 50Z"
          fill="#4CAF50"
        />
        {/* Jaw/Snout */}
        <path
          d="M60 70H130C140 70 145 80 145 90C145 105 130 110 110 110H80C70 110 60 90 60 70Z"
          fill="#81C784"
        />

        {/* Eye - Blinking Animation */}
        <g transform="translate(90, 40)">
          <circle cx="0" cy="0" r="12" fill="white" />
          <motion.circle
            cx="0"
            cy="0"
            r="5"
            fill="black"
            animate={
              isIdle ? { scaleY: [1, 0.1, 1, 1, 0.1, 1] } : { scaleY: 1 }
            }
            transition={{
              duration: 4,
              times: [0, 0.05, 0.1, 0.5, 0.55, 0.6],
              repeat: Infinity,
              repeatDelay: 2,
            }}
          />
        </g>

        {/* Nostril */}
        <circle cx="75" cy="60" r="4" fill="#1B5E20" opacity="0.6" />

        {/* Spikes */}
        <path d="M110 10L120 -5L130 10H110Z" fill="#1B5E20" />
        <path d="M135 15L145 0L155 15H135Z" fill="#1B5E20" />
        <path d="M85 15L95 0L105 15H85Z" fill="#1B5E20" />
      </motion.g>
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
    <div className="min-h-screen flex flex-col bg-[#050f0a] text-white overflow-hidden selection:bg-emerald-500/30 items-center justify-center relative">
      {/* Background Gradients */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[800px] h-[800px] bg-emerald-600/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[600px] h-[600px] bg-teal-600/10 rounded-full blur-[120px]" />
      </div>

      <main className="w-full max-w-3xl px-6 flex flex-col items-center gap-24 z-10">
        {/* Hero Text */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-6"
        >
          <h1 className="text-7xl md:text-8xl font-bold tracking-tighter bg-clip-text text-transparent bg-linear-to-b from-white via-white to-emerald-500 drop-shadow-[0_0_30px_rgba(16,185,129,0.3)] pb-2">
            Docuzaurs
          </h1>
          <div className="space-y-2">
            <p className="text-xl md:text-2xl font-light text-zinc-300">
              Eating prehistoric setups for lunch.
            </p>
            <p className="text-zinc-400 text-sm md:text-base max-w-md mx-auto leading-relaxed">
              Roaring fast CI with{" "}
              <span className="text-emerald-500 font-medium">
                monstrous performance
              </span>{" "}
              thanks to tree shaking and build caching.
            </p>
          </div>
        </motion.div>

        {/* Mascot & Interactive Card Combined */}
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="w-full bg-[#0a1f15]/60 border border-emerald-500/20 rounded-3xl p-8 backdrop-blur-xl shadow-[0_0_50px_-12px_rgba(16,185,129,0.25)] flex flex-col items-center gap-8"
        >
          {/* Mascot - Floating Animation */}
          <motion.div
            animate={{ y: [0, -10, 0] }}
            transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
            className="transform -mt-24 mb-[-20px] hover:scale-105 transition-transform duration-300 drop-shadow-[0_20px_40px_rgba(0,0,0,0.5)]"
          >
            <DinoMascot focusValue={inputVal} isIdle={isIdle} />
          </motion.div>

          <div className="w-full space-y-8">
            {/* Slider Control */}
            <div className="space-y-4">
              <div className="flex justify-between items-end px-2">
                <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">
                  Docs Version
                </label>
                <span className="font-mono text-2xl font-bold text-emerald-500">
                  v{inputVal}.0
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
                  className="w-full h-2 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-emerald-500 z-20 relative focus:outline-none focus:ring-2 focus:ring-emerald-500/50 hover:accent-emerald-400 transition-all"
                />
              </div>
            </div>

            {/* Result Display */}
            <div className="bg-black/40 rounded-xl p-6 border border-emerald-500/10 font-mono relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-20 transition-opacity duration-500">
                <Calculator className="w-20 h-20 text-white" />
              </div>

              <div className="space-y-3 relative z-10">
                <div className="flex items-center gap-2 text-zinc-500 text-xs uppercase tracking-wider">
                  <Scale className="w-3 h-3" />
                  <span>@repo/ui/utils/sub.ts</span>
                </div>
                <div className="text-xl md:text-2xl flex items-center gap-3 p-2">
                  <span className="text-purple-400 font-semibold">sub</span>
                  <span className="text-zinc-500">(</span>
                  <span className="text-white">{inputVal}</span>
                  <span className="text-zinc-500">)</span>
                  <span className="text-zinc-600">→</span>
                  <span className="text-emerald-400 font-bold drop-shadow-[0_0_15px_rgba(52,211,153,0.3)]">
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
              process.env.NEXT_PUBLIC_BOBR_WEB_URL || "http://localhost:3000"
            }
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="group relative px-8 py-4 bg-emerald-500 text-white rounded-full font-bold transition-all shadow-[0_0_40px_-10px_rgba(16,185,129,0.4)] hover:shadow-[0_0_60px_-15px_rgba(16,185,129,0.6)] overflow-hidden border border-white/10 cursor-pointer"
          >
            <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-in-out" />
            <span className="relative flex items-center gap-3">
              See Bóbr
              <ArrowRight className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
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
            <div className="p-2 rounded-full bg-white/5 group-hover:bg-white/10 transition-colors text-emerald-500">
              <Zap className="w-5 h-5" />
            </div>
            <span className="font-medium text-zinc-400 group-hover:text-zinc-200 transition-colors">
              Iterate faster
            </span>
          </div>
          <div className="flex flex-col items-center gap-2 text-center group cursor-default">
            <div className="p-2 rounded-full bg-white/5 group-hover:bg-white/10 transition-colors text-teal-400">
              <Shield className="w-5 h-5" />
            </div>
            <span className="font-medium text-zinc-400 group-hover:text-zinc-200 transition-colors">
              Save time
            </span>
          </div>
          <div className="flex flex-col items-center gap-2 text-center group cursor-default">
            <div className="p-2 rounded-full bg-white/5 group-hover:bg-white/10 transition-colors text-green-400">
              <Scale className="w-5 h-5" />
            </div>
            <span className="font-medium text-zinc-400 group-hover:text-zinc-200 transition-colors">
              Balanced runs
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
