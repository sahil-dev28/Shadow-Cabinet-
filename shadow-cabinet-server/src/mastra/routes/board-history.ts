import { registerApiRoute } from "@mastra/core/server";

/**
 * Message history for one board thread, so the web app can rehydrate a
 * conversation the CEO left earlier. All personas share the thread, so any
 * one agent's memory handle reads the same transcript.
 */
export const boardHistoryRoute = registerApiRoute("/board/:threadId/messages", {
  method: "GET",
  createHandler: async ({ mastra }) => {
    return async (c) => {
      const threadId = c.req.param("threadId");
      const agent = mastra.getAgentById("cfo-agent");
      const memory = await agent.getMemory();

      if (!memory) {
        return c.json({ messages: [] });
      }

      const thread = await memory.getThreadById({ threadId });
      if (!thread) {
        return c.json({ messages: [] });
      }

      const { messages } = await memory.recall({ threadId, perPage: false });
      return c.json({ messages });
    };
  },
});
