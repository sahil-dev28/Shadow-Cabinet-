import { chatRoute } from "@mastra/ai-sdk";
import { Mastra } from "@mastra/core/mastra";

import { cfoAgent } from "./agents/cfo-agent.ts";
import { cmoAgent } from "./agents/cmo-agent.ts";

export const mastra = new Mastra({
  agents: { cfoAgent, cmoAgent },
  server: {
    apiRoutes: [
      chatRoute({
        path: "/chat/:agentId",
        sendReasoning: true,
      }),
    ],
  },
});
