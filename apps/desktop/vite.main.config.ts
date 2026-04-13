import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node20",
    rollupOptions: {
      external: ["bufferutil", "utf-8-validate"],
    },
  },
  define: {
    "process.env.SUPABASE_URL": process.env.SUPABASE_URL
      ? JSON.stringify(process.env.SUPABASE_URL) : "undefined",
    "process.env.SUPABASE_PUBLISHABLE_KEY": process.env.SUPABASE_PUBLISHABLE_KEY
      ? JSON.stringify(process.env.SUPABASE_PUBLISHABLE_KEY) : "undefined",
    "process.env.TOKEN_SERVICE_URL": process.env.TOKEN_SERVICE_URL
      ? JSON.stringify(process.env.TOKEN_SERVICE_URL) : "undefined",
  },
});
