import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node20",
    rollupOptions: {
      external: ["bufferutil", "utf-8-validate"],
    },
  },
});
