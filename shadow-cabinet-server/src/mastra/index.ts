import { chatRoute } from "@mastra/ai-sdk";
import { Mastra } from "@mastra/core/mastra";

import { cfoAgent, cmoAgent, cooAgent, csoAgent } from "./agents/index.ts";
import { createStorage } from "./storage.ts";

export const mastra = new Mastra({
  agents: { cfoAgent, cmoAgent, cooAgent, csoAgent },
  storage: createStorage(),
  server: {
    apiRoutes: [
      chatRoute({
        path: "/chat/:agentId",
        sendReasoning: true,
      }),
    ],
  },
});
