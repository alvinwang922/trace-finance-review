import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { serpPlugin } from "./server/serp";

export default defineConfig(({ mode }) => ({
  plugins: [react(), serpPlugin({ ...loadEnv(mode, ".", ""), ...process.env })],
}));
