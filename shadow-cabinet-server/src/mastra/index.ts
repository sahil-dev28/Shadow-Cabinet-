import { chatRoute } from "@mastra/ai-sdk";
import { Mastra } from "@mastra/core/mastra";

import { cfoAgent } from "./agents/cfo-agent.ts";

export const mastra = new Mastra({
  agents: { cfoAgent },
  server: {
    apiRoutes: [
      // Streams an agent's reply in AI SDK UI message format so the
      // assistant-ui frontend can consume it directly.
      // POST /chat/<agentId>, e.g. /chat/cfo-agent
      chatRoute({
        path: "/chat/:agentId",
        sendReasoning: true,
      }),
    ],
  },
});
