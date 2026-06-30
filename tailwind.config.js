/**
 * File: tailwind.config.js
 * Semantic colour tokens → CSS variables in styles/globals.css (the single source of truth).
 * Use these everywhere (bg-surface, text-ink, bg-accent, …); never raw slate/blue or hex.
 */
module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        // Dark rail
        sidebar: "var(--sidebar-bg)",
        "sidebar-fg": "var(--sidebar-fg)",
        "sidebar-active": "var(--sidebar-fg-active)",
        "sidebar-muted": "var(--sidebar-muted)",
        "sidebar-line": "var(--sidebar-border)",
        // Light workspace
        content: "var(--content-bg)",
        surface: "var(--surface)",
        "surface-muted": "var(--surface-muted)",
        line: "var(--border)",
        ink: "var(--text)",
        muted: "var(--text-muted)",
        // Brand accent
        accent: "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "accent-soft": "var(--accent-soft)",
        // Status
        ok: "var(--ok)",
        "ok-soft": "var(--ok-soft)",
        warn: "var(--warn)",
        "warn-soft": "var(--warn-soft)",
        danger: "var(--danger)",
        "danger-soft": "var(--danger-soft)",

        // Legacy pre-auth palette (login/register/landing) — retained until those screens
        // are migrated in a later pass. Do NOT use in admin screens.
        gdBg: "#0f172a",
        gdPanel: "#1e293b",
        gdAccent: "#38bdf8",
        gdText: "#f8fafc",
        gdSubtext: "#94a3b8",
        gdBorder: "#334155"
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.25rem"
      },
      boxShadow: {
        card: "0 1px 2px 0 rgba(15,30,51,0.06), 0 1px 3px 0 rgba(15,30,51,0.08)"
      }
    }
  },
  plugins: []
};
