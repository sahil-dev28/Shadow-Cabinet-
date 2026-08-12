import { chatRoute, workflowRoute } from "@mastra/ai-sdk";
import { Mastra } from "@mastra/core/mastra";

import { cfoAgent, cmoAgent, cooAgent, csoAgent } from "./agents/index.ts";
import { boardHistoryRoute } from "./routes/board-history.ts";
import { companyDataUploadRoute } from "./routes/company-data-upload.ts";
import { createStorage } from "./storage/index.ts";
import { boardSessionWorkflow } from "./workflows/board-session.ts";

export const mastra = new Mastra({
  agents: { cfoAgent, cmoAgent, cooAgent, csoAgent },
  workflows: { boardSession: boardSessionWorkflow },
  storage: createStorage(),
  server: {
    apiRoutes: [
      // The board: one CEO question in, a two-pass debate transcript out.
      workflowRoute({
        path: "/board",
        workflow: "boardSession",
      }),
      boardHistoryRoute,
      companyDataUploadRoute,
      // Kept for debugging a single persona in isolation.
      chatRoute({
        path: "/chat/:agentId",
        sendReasoning: true,
      }),
    ],
  },
});
