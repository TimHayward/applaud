import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        ink: {
          50: "#f7f7f8",
          100: "#eeeef1",
          200: "#d9d9e0",
          300: "#b4b4c0",
          400: "#838395",
          500: "#5a5a6d",
          600: "#3f3f50",
          700: "#2a2a38",
          800: "#1b1b25",
          900: "#0f0f17",
        },
        accent: {
          DEFAULT: "#ff6a3d",
          soft: "#ffecd9",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
