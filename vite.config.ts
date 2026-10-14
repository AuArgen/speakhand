import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Видео кэши (~1 ГБ), Python venv жана бөлмөлөрдүн маалыматы — Vite көзөмөлдөбөсүн.
    watch: { ignored: ["**/tools/**", "**/server/data/**", "**/assets/**", "**/.playwright-mcp/**"] },
  },
});
