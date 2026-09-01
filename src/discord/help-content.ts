import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { ProjectContext } from '../domain/models.js';

export function botHelpText(): string {
  return `🤖 **團隊工作助理｜你只需要記住這些**

**每天回報**
- 平日 16:30 到 #工作摘要 的當日討論串
- 補充一兩句 GitHub 看不到的完成事項、阻塞或下一步
- 17:00 Bot 會自動整合 Issue、PR、CI 與大家的回覆

**專案討論頻道（例如 #syscom）**
- 「@Bot 幫我整理目前討論重點」
- 「@Bot 評估這個功能是否可行」
- 訊息按右鍵 →「應用程式」→「建立 GitHub Issue」

**行程通知頻道**
- 直接輸入「我明天下午請假」，確認後才會發布

**管理員**
- 只需輸入「/bot setup」，畫面會告訴你唯一的下一步

Bot 不會替成員評分，也不會公開點名未回報者。`;
}

export function setupPanelText(): string {
  return `⚙️ **團隊工作助理控制台**

管理員按「開啟快速設定」，Bot 會私下顯示完成進度與下一步，不會洗版。

一般成員不需要設定任何指令，只要每天在 16:30 回報討論串補充一兩句

⏰ 平日 16:30 提醒｜17:00 Azure AI + GitHub 自動彙整`;
}

export function setupPanelRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('setup:start:root').setLabel('開啟快速設定').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup:help:root').setLabel('一般成員說明').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('setup:status:root').setLabel('查看目前狀態').setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('setup:report-open:root').setLabel('測試 16:30 提醒').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup:report-summary:root').setLabel('測試 17:00 彙整').setStyle(ButtonStyle.Success),
    ),
  ];
}

function repositoryLine(project: ProjectContext): string {
  if (project.repositories.length === 0) return '- ❌ 尚未選擇 Repository';
  return project.repositories.map((repository) => {
    const installation = repository.githubInstallationId
      && repository.githubInstallationId !== project.githubInstallationId
      ? '獨立授權'
      : '專案預設授權';
    return `- ✅ ${repository.owner}/${repository.name}（${installation}）`;
  }).join('\n');
}

export function guildStatusText(projects: ProjectContext[]): string {
  if (projects.length === 0) {
    return `❌ 這個伺服器尚未建立專案。

請由管理員執行「/bot setup」，接著按「建立第一個專案」。`;
  }
  const sections = projects.map((project) => `**${project.name}**
- 專案討論：<#${project.discordChannelId}>
- 工作摘要：${project.summaryChannelId ? `✅ <#${project.summaryChannelId}>` : '❌ 未設定'}
- 行程通知：${project.leaveChannelId ? `✅ <#${project.leaveChannelId}>` : '選用，未設定'}
- GitHub Project：${project.githubProjectId ? '✅ 已設定' : '使用 Repository 模式'}
${repositoryLine(project)}`);
  return `🔎 **整合狀態**

${sections.join('\n\n')}

⏰ 平日 16:30 提醒｜17:00 彙整
需要修改時直接執行「/bot setup」。`;
}

export function setupGuidance(action: string): string {
  if (action === 'repository') {
    return `📦 **新增 Repository**

執行「/bot setup」→ 選擇專案 → 按「選擇 Repository」。
Bot 會自動列出 GitHub App 有權限的 Repo，不需要填 owner 或 Installation ID。`;
  }
  return `👤 **綁定成員**

管理員在「/bot setup」按「綁定團隊成員」，選擇 Discord 成員並確認他的 GitHub 帳號。一般成員不需操作設定。`;
}
