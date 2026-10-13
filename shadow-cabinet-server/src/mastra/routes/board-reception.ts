import { registerApiRoute } from "@mastra/core/server";
import { z } from "zod";

const receptionSchema = z.object({
  convene: z
    .boolean()
    .describe(
      "True only if answering needs the executive board: a business decision, a question about company performance, or a request for advice. Greetings, thanks, small talk, and questions about what this app is do not need the board.",
    ),
  reply: z
    .string()
    .describe(
      "If convene is false, the reply to send instead, in one or two sentences. Empty string if convene is true.",
    ),
});

/**
 * Decides whether a message is worth convening the board for.
 *
 * A board session is nine agent calls and several minutes. Spending that on
 * "hi" is the difference between a prototype that feels considered and one
 * that feels broken, so a single cheap call gates the expensive path.
 */
export const boardReceptionRoute = registerApiRoute("/board/reception", {
  method: "POST",
  createHandler: async ({ mastra }) => {
    return async (c) => {
      const { question } = (await c.req.json()) as { question?: string };

      if (!question?.trim()) {
        return c.json({ convene: false, reply: "What would you like to ask the board?" });
      }

      const agent = mastra.getAgentById("cfo-agent");

      const response = await agent.generate(
        `You are the receptionist for a virtual executive board of a logistics
company. The board answers business questions grounded in the company's own
P&L and KPI data, and takes minutes to convene.

Decide whether this message needs the board:

"${question}"

If it does not, write the reply yourself: greet briefly, say what the board is
for, and invite a business question. Never invent company figures.`,
        {
          model: "anthropic/claude-haiku-5-5",
          structuredOutput: { schema: receptionSchema },
        },
      );

      // Unreadable classification means convene: a slow answer beats refusing
      // a real question.
      return c.json(response.object ?? { convene: true, reply: "" });
    };
  },
});
