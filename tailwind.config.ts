import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0F1115",
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
