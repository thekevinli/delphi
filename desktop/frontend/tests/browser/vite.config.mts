import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "next/navigation": "vinext/shims/navigation" } },
  define: { "process.env.NEXT_PUBLIC_API_BASE_URL": JSON.stringify("") },
  server: { host: "127.0.0.1", port: 3218, strictPort: true },
});
