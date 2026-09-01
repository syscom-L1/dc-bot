import type { GitHubAdapter } from '../domain/adapters.js';
import type { ProjectBindingStore } from '../persistence/contracts.js';

/**
 * GitHub remains the source of truth, so reconciliation deliberately re-reads
 * every active binding instead of trying to repair a second task database.
 */
export class GitHubReconciliationService {
  public constructor(
    private readonly bindings: ProjectBindingStore,
    private readonly github: GitHubAdapter,
  ) {}

  public async run(): Promise<{ projects: number; items: number }> {
    const projects = await this.bindings.listActive();
    let items = 0;
    for (const project of projects) {
      items += (await this.github.listWorkItems(project)).length;
    }
    return { projects: projects.length, items };
  }
}
