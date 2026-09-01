import type { WorkItem, ProjectContext, ProgressUpdateAction } from './models.js';

export interface GitHubAdapter {
  listWorkItems(context: ProjectContext): Promise<WorkItem[]>;
  applyProgressUpdate(action: ProgressUpdateAction): Promise<{
    commentUrl: string;
    projectStatusUpdated: boolean;
  }>;
  checkConnection(installationId?: string): Promise<void>;
}

export interface GitHubInstallationChoice {
  id: string;
  accountLogin: string;
  accountType: 'Organization' | 'User';
  repositorySelection: 'all' | 'selected';
}

export interface GitHubRepositoryChoice {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
}

export interface GitHubSetupAdapter {
  listInstallations(): Promise<GitHubInstallationChoice[]>;
  listInstallationRepositories(installationId: string): Promise<GitHubRepositoryChoice[]>;
  checkConnection(installationId?: string): Promise<void>;
}

export interface DiscordButton {
  customId: string;
  label: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
}

export interface DiscordThreadMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  isBot: boolean;
}

export interface DiscordAdapter {
  sendChannelMessage(channelId: string, content: string): Promise<string>;
  sendDirectMessage(userId: string, content: string, buttons?: DiscordButton[]): Promise<string>;
  createThread?: (input: {
    channelId: string;
    content: string;
    threadName: string;
    mentionUserIds: string[];
  }) => Promise<{ messageId: string; threadId: string }>;
  listThreadMessages?: (threadId: string, limit?: number) => Promise<DiscordThreadMessage[]>;
  checkConnection(): Promise<void>;
}

export interface QueueAdapter {
  enqueue(
    queueName: string,
    jobName: string,
    payload: object,
    options: { jobId: string; attempts?: number },
  ): Promise<void>;
  checkConnection(): Promise<void>;
}
