"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowLeft, Zap } from "lucide-react";
import { toast, Toaster } from "sonner";
import { Code } from "@repo/ui/code";

const FullBeaverMascot = () => {
  return (
    <svg
      width="300"
      height="300"
      viewBox="0 0 300 300"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="drop-shadow-2xl"
    >
      {/* Tail - Animated Wag */}
      <motion.g
        animate={{ rotate: [0, 5, 0, -5, 0] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        style={{ originX: "150px", originY: "220px" }}
      >
        <ellipse
          cx="150"
          cy="240"
          rx="60"
          ry="25"
          fill="#3E2723"
          transform="rotate(0)"
        />
        {/* Tail Texture (Crosshatch) */}
        <path
          d="M110 230 L190 250"
          stroke="#4E342E"
          strokeWidth="2"
          opacity="0.5"
        />
        <path
          d="M110 250 L190 230"
          stroke="#4E342E"
          strokeWidth="2"
          opacity="0.5"
        />
        <path
          d="M130 225 L170 255"
          stroke="#4E342E"
          strokeWidth="2"
          opacity="0.5"
        />
        <path
          d="M130 255 L170 225"
          stroke="#4E342E"
          strokeWidth="2"
          opacity="0.5"
        />
      </motion.g>

      {/* Feet */}
      <ellipse cx="120" cy="250" rx="15" ry="10" fill="#3E2723" />
      <ellipse cx="180" cy="250" rx="15" ry="10" fill="#3E2723" />

      {/* Body */}
      <ellipse cx="150" cy="180" rx="70" ry="80" fill="#795548" />
      {/* Belly patch */}
      <ellipse cx="150" cy="190" rx="45" ry="55" fill="#8D6E63" opacity="0.5" />

      {/* Arms */}
      <motion.ellipse
        cx="90"
        cy="160"
        rx="12"
        ry="25"
        fill="#5D4037"
        transform="rotate(20 90 160)"
        animate={{ rotate: [20, 30, 20] }}
        transition={{
          duration: 2,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 0.5,
        }}
      />
      <motion.ellipse
        cx="210"
        cy="160"
        rx="12"
        ry="25"
        fill="#5D4037"
        transform="rotate(-20 210 160)"
        animate={{ rotate: [-20, -30, -20] }}
        transition={{
          duration: 2,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 0.5,
        }}
      />

      {/* HEAD GROUP (Shifted down slightly from original relative coords) */}
      <g transform="translate(50, 30)">
        {/* Ears */}
        <circle cx="40" cy="50" r="20" fill="#5D4037" />
        <circle cx="160" cy="50" r="20" fill="#5D4037" />
        <circle cx="40" cy="50" r="12" fill="#3E2723" />
        <circle cx="160" cy="50" r="12" fill="#3E2723" />

        {/* Head Shape */}
        <path
          d="M100 180C150 180 180 150 180 100C180 50 150 20 100 20C50 20 20 50 20 100C20 150 50 180 100 180Z"
          fill="#795548"
        />

        {/* Cheeks/Snout area */}
        <ellipse cx="100" cy="120" rx="60" ry="35" fill="#8D6E63" />

        {/* Eyes */}
        <ellipse cx="70" cy="90" rx="15" ry="18" fill="white" />
        <ellipse cx="130" cy="90" rx="15" ry="18" fill="white" />

        {/* Rolling Pupils */}
        <motion.circle
          cx="70"
          cy="90"
          r="6"
          fill="black"
          animate={{ cx: [70, 76, 70, 64, 70], cy: [90, 96, 90, 84, 90] }}
          transition={{ duration: 4, repeat: Infinity }}
        />
        <motion.circle
          cx="130"
          cy="90"
          r="6"
          fill="black"
          animate={{ cx: [130, 136, 130, 124, 130], cy: [90, 96, 90, 84, 90] }}
          transition={{ duration: 4, repeat: Infinity }}
        />

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
      </g>
    </svg>
  );
};

export default function DemoPage() {
  const callApi = async () => {
    try {
      const res = await fetch("/api/hello");
      const text = await res.text();
      toast(text, {
        icon: <Zap className="w-4 h-4 text-[#375BD2]" />,
        style: {
          background: "#1a1d26",
          border: "1px solid rgba(55,91,210,0.2)",
          color: "white",
        },
      });
    } catch {
      toast.error("Failed to call API");
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0c0c0c] text-white items-center justify-center relative overflow-hidden">
      <Toaster />
      {/* Background Elements */}
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-linear-to-br from-[#375BD2]/20 to-black/80 z-10 mix-blend-overlay" />
      </div>

      <main className="z-10 flex flex-col items-center gap-12 p-8">
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="relative"
        >
          {/* Glow Effect */}
          <div className="absolute inset-0 bg-[#375BD2]/30 blur-[60px] rounded-full scale-150" />

          <motion.div
            animate={{ y: [0, -20, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          >
            <FullBeaverMascot />
          </motion.div>
        </motion.div>

        <div className="text-center space-y-4 flex flex-col items-center">
          <h1 className="text-4xl font-bold text-white">Bóbr Demo</h1>

          <div className="flex gap-4">
            <Link href="/">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="flex items-center gap-2 px-6 py-3 bg-zinc-800 text-white rounded-full font-semibold shadow-lg hover:bg-zinc-700 transition-all border border-white/10"
              >
                <ArrowLeft className="w-5 h-5" />
                Back to Home
              </motion.button>
            </Link>

            <motion.button
              onClick={callApi}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="flex items-center gap-2 px-6 py-3 bg-[#375BD2] text-white rounded-full font-semibold shadow-lg shadow-[#375BD2]/30 hover:shadow-[#375BD2]/50 transition-all"
            >
              <Zap className="w-5 h-5" />
              Call API
            </motion.button>
          </div>

          <div className="mt-8 p-4 bg-black/40 rounded-xl border border-white/10 backdrop-blur-sm">
            <p className="text-zinc-400 mb-2 text-sm">Shared UI Component:</p>
            <Code className="bg-[#1a1d26] px-4 py-2 rounded-lg text-[#375BD2] font-mono">
              console.log(&quot;Hello from Bóbr!&quot;);
            </Code>
          </div>
        </div>
      </main>
    </div>
  );
}
