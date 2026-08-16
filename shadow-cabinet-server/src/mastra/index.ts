import { chatRoute, workflowRoute } from "@mastra/ai-sdk";
import { Mastra } from "@mastra/core/mastra";

import { cfoAgent, chairAgent, cmoAgent, cooAgent, csoAgent } from "./agents/index.ts";
import { boardHistoryRoute } from "./routes/board-history.ts";
import { boardReceptionRoute } from "./routes/board-reception.ts";
import { boardThreadsRoute } from "./routes/board-threads.ts";
import { companyDataUploadRoute } from "./routes/company-data-upload.ts";
import { createStorage } from "./storage/index.ts";
import { boardSessionWorkflow } from "./workflows/board-session.ts";

export const mastra = new Mastra({
  agents: { cfoAgent, cmoAgent, cooAgent, csoAgent, chairAgent },
  workflows: { boardSession: boardSessionWorkflow },
  storage: createStorage(),
  server: {
    apiRoutes: [
      // The board: one CEO question in, three rounds of debate closed by the
      // chair's single answer out.
      workflowRoute({
        path: "/board",
        workflow: "boardSession",
      }),
      boardHistoryRoute,
      boardThreadsRoute,
      boardReceptionRoute,
      companyDataUploadRoute,
      // Kept for debugging a single persona in isolation.
      chatRoute({
        path: "/chat/:agentId",
        sendReasoning: true,
      }),
    ],
  },
});
