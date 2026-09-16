import { ConversationStateStore } from '../shared/conversation-state-store.mjs';

/**
 * Email adds one need on top of the shared conversation store: mail threads are
 * identified by Message-ID headers, so the inbound chain (References /
 * In-Reply-To) must resolve back to the conversation key we already created.
 * The map is bounded — only the most recent ids are kept, since a thread that
 * has been quiet for thousands of messages is not worth unbounded growth.
 */
const MAX_THREAD_IDS = 2_000;

export class EmailStateStore extends ConversationStateStore {
  #threadIds = new Map();

  /** Record that `messageId` belongs to `conversationKey`. */
  rememberThreadId(messageId, conversationKey) {
    if (typeof messageId !== 'string' || !messageId || typeof conversationKey !== 'string') return;
    // Re-insert so the freshest ids survive eviction.
    this.#threadIds.delete(messageId);
    this.#threadIds.set(messageId, conversationKey);
    while (this.#threadIds.size > MAX_THREAD_IDS) {
      this.#threadIds.delete(this.#threadIds.keys().next().value);
    }
  }

  /** Conversation key previously associated with this Message-ID, if any. */
  conversationForThreadId(messageId) {
    return this.#threadIds.get(messageId) ?? null;
  }

  /** Read-only view used by the threading resolver. */
  get threadMap() {
    return this.#threadIds;
  }
}
