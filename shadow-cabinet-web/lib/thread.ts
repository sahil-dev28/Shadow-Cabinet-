/** Every board thread belongs to the same CEO in this prototype. */
export const BOARD_RESOURCE_ID = "ceo";

export function newThreadId(): string {
  return `board-${crypto.randomUUID()}`;
}
