import { chatRoute } from "@mastra/ai-sdk";
import { Mastra } from "@mastra/core/mastra";

import { cfoAgent, cmoAgent, cooAgent, csoAgent } from "./agents/index.ts";
import { createStorage } from "./storage.ts";
import { boardSessionWorkflow } from "./workflows/board-session.ts";

export const mastra = new Mastra({
  agents: { cfoAgent, cmoAgent, cooAgent, csoAgent },
  workflows: { boardSession: boardSessionWorkflow },
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
