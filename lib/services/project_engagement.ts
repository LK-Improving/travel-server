/**
 * 功能开关受限的消息反馈与收藏服务。对齐 Python 版 app/services/project_engagement.py。
 */
import type { Subject } from '../auth/subject';
import {
  getProjectAssistantMessage,
  upsertProjectMessageFeedback,
  deleteProjectMessageFeedback,
  getProjectConversation,
  favoriteProjectConversation,
  unfavoriteProjectConversation,
} from '../repositories/conversations';
import { FeatureDisabledError, AuthRequiredError, ConversationNotOwnedError, LookupError } from '../errors';

function checkFlag(value: Record<string, unknown>, flag: string): void {
  if (!Boolean((value.featureFlags as unknown as Record<string, unknown> | null)?.[flag] ?? false)) {
    throw new FeatureDisabledError('当前项目未开启该功能');
  }
}

export class ProjectEngagementService {
  constructor() {}

  async setFeedback(subject: Subject, publicId: string, messageId: string, value: string): Promise<Record<string, unknown>> {
    const message = await getProjectAssistantMessage(subject, publicId, messageId);
    if (!message) throw new ConversationNotOwnedError('消息不存在或不属于当前会话');
    checkFlag(message as unknown as Record<string, unknown>, 'messageFeedbackEnabled');
    return upsertProjectMessageFeedback(subject, messageId, value);
  }

  async removeFeedback(subject: Subject, publicId: string, messageId: string): Promise<boolean> {
    const message = await getProjectAssistantMessage(subject, publicId, messageId);
    if (!message) throw new ConversationNotOwnedError('消息不存在或不属于当前会话');
    checkFlag(message as unknown as Record<string, unknown>, 'messageFeedbackEnabled');
    return deleteProjectMessageFeedback(subject, messageId);
  }

  async favorite(subject: Subject, publicId: string, conversationId: string): Promise<Record<string, unknown>> {
    if (subject.kind !== 'user') throw new AuthRequiredError('收藏会话需要登录');
    const conversation = await getProjectConversation(subject, publicId, conversationId);
    if (!conversation) throw new ConversationNotOwnedError('会话不存在或不属于当前项目');
    checkFlag(conversation as unknown as Record<string, unknown>, 'conversationFavoriteEnabled');
    const result = await favoriteProjectConversation(subject, publicId, conversationId);
    if (!result) throw new LookupError('会话不存在或不属于当前用户');
    return result;
  }

  async unfavorite(subject: Subject, publicId: string, conversationId: string): Promise<boolean> {
    if (subject.kind !== 'user') throw new AuthRequiredError('收藏会话需要登录');
    const conversation = await getProjectConversation(subject, publicId, conversationId);
    if (!conversation) throw new ConversationNotOwnedError('会话不存在或不属于当前项目');
    checkFlag(conversation as unknown as Record<string, unknown>, 'conversationFavoriteEnabled');
    return unfavoriteProjectConversation(subject, publicId, conversationId);
  }
}

export const engagementService = new ProjectEngagementService();
