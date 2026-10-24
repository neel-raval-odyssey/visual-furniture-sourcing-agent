import { defineConfig } from "vitest/config";

// Runs local demonstrations (*.demo.ts). Kept separate from the unit tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.demo.ts"],
    silent: false,
    // Pinned so console output also shows when Vitest detects an AI agent.
    reporters: ["default"],
  },
});
