import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` would otherwise write an apps/web/AGENTS.md on every start; the
  // repository keeps its agent instructions in the root AGENTS.md.
  agentRules: false,
};

export default nextConfig;
