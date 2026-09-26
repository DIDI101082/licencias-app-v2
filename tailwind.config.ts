import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Colores de la interfaz: cambian con el modo claro/oscuro (ver globals.css)
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        line: "rgb(var(--c-line) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        canvas: "rgb(var(--c-canvas) / <alpha-value>)",
        brand: {
          50: "#EBF1FE",
          100: "#D2E0FD",
          300: "#7EA1F8",
          500: "#2F5CF0",
          600: "#1E48DC",
          700: "#1737AE",
        },
        amber: {
          500: "#C4842B",
        },
      },
      fontFamily: {
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
