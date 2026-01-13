import type { Config } from "tailwindcss";

export default {
  // Scan everything under /src (app, components, etc.)
  content: ["./src/**/*.{ts,tsx,js,jsx,mdx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;

