import { ModelAliasQueries } from '../db/queries.js';
import { ScaleToZeroService } from './scaleToZero.js';
import { ModelConfigQueries } from '../db/queries.js';

export class ModelAliasService {
  constructor(
    private aliasQueries: ModelAliasQueries,
    private modelQueries: ModelConfigQueries,
    private scaleToZeroService?: ScaleToZeroService
  ) {}

  getAlias(aliasName: string): string | null {
    return this.aliasQueries.getAlias(aliasName);
  }

  setAlias(aliasName: string, modelName: string): void {
    this.aliasQueries.setAlias(aliasName, modelName);
  }

  listAliases() {
    return this.aliasQueries.listAliases();
  }

  getFlipHistory(aliasName?: string, limit?: number) {
    return this.aliasQueries.getFlipHistory(aliasName, limit);
  }

  async flipAlias(
    aliasName: string,
    targetModel: string,
    triggeredBy: string
  ): Promise<{
    success: boolean;
    previousModel: string;
    newModel: string;
    containerStatus: { stopped: string; started: string; healthy: boolean };
    error?: string;
  }> {
    // 1. Validate target model exists
    const targetConfig = this.modelQueries.getModel(targetModel);
    if (!targetConfig) {
      return {
        success: false,
        previousModel: '',
        newModel: '',
        containerStatus: { stopped: '', started: '', healthy: false },
        error: `Target model '${targetModel}' not found`
      };
    }

    // 2. Get current model
    const currentModel = this.getAlias(aliasName);
    if (!currentModel) {
      return {
        success: false,
        previousModel: '',
        newModel: '',
        containerStatus: { stopped: '', started: '', healthy: false },
        error: `Alias '${aliasName}' not configured`
      };
    }

    // 3. No-op if same model
    if (currentModel === targetModel) {
      return {
        success: true,
        previousModel: currentModel,
        newModel: targetModel,
        containerStatus: { stopped: '', started: '', healthy: true }
      };
    }

    // 4. Stop current container (if configured)
    let stoppedContainer = '';
    if (this.scaleToZeroService) {
      await this.scaleToZeroService.stop(currentModel);
      stoppedContainer = currentModel;
    }

    // 5. Start target container (if configured)
    let healthy = false;
    if (this.scaleToZeroService) {
      healthy = await this.scaleToZeroService.start(targetModel);
    } else {
      healthy = true;
    }

    // 6. Validate health
    if (!healthy) {
      return {
        success: false,
        previousModel: currentModel,
        newModel: targetModel,
        containerStatus: { stopped: stoppedContainer, started: targetModel, healthy: false },
        error: `Target model '${targetModel}' failed health check`
      };
    }

    // 7. Update alias
    this.setAlias(aliasName, targetModel);

    // 8. Log to history
    this.aliasQueries.logFlip(aliasName, currentModel, targetModel, triggeredBy);

    return {
      success: true,
      previousModel: currentModel,
      newModel: targetModel,
      containerStatus: { stopped: stoppedContainer, started: targetModel, healthy: true }
    };
  }
}
