/**
 * File: tailwind.config.js
 * Last edited: 2025-10-27 21:25 Europe/London
 */
module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        gdBg: "#0f172a",           // deep slate/navy for header
        gdPanel: "#1e293b",        // panel background
        gdAccent: "#38bdf8",       // cyan accent
        gdText: "#f8fafc",         // near-white
        gdSubtext: "#94a3b8",      // muted
        gdBorder: "#334155"        // border / hairlines
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.25rem"
      },
      boxShadow: {
        card: "0 16px 32px -8px rgba(0,0,0,0.6)"
      }
    }
  },
  plugins: []
};
