import { chatRoute } from "@mastra/ai-sdk";
import { Mastra } from "@mastra/core/mastra";

import { cfoAgent } from "./agents/cfo-agent.ts";

export const mastra = new Mastra({
  agents: { cfoAgent },
  server: {
    apiRoutes: [
      chatRoute({
        path: "/chat/:agentId",
        sendReasoning: true,
      }),
    ],
  },
});
