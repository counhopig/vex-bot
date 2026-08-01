export type {
  ChannelId,
  ChatType,
  InboundMessageContext,
  OutboundMessage,
  SendResult,
  ChannelMeta,
  ChannelCapabilities,
  ChannelAdapter,
  ChannelRegistry,
} from "./ChannelAdapter.js";
export { ChannelRegistryImpl } from "./ChannelRegistry.js";

export {
  WebChatChannel,
  parseRequestFrame,
  parseParams,
  getRequestId,
  filterWebChatSessions,
  canAccessBackendLogs,
  type WebChatChannelOptions,
} from "./webchat/WebChatChannel.js";
