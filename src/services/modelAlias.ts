import { ModelAliasQueries } from '../db/queries.js';
import { ContainerManager } from './containerManager.js';
import { ModelConfigQueries } from '../db/queries.js';

export class ModelAliasService {
  constructor(
    private aliasQueries: ModelAliasQueries,
    private modelQueries: ModelConfigQueries,
    private containerManager?: ContainerManager
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

    // 4. Stop current container and wait for it to fully release resources
    let stoppedContainer = '';
    if (this.containerManager) {
      console.log(`[ModelAlias] Flipping ${aliasName} from ${currentModel} to ${targetModel}`);
      console.log(`[ModelAlias] Step 1/3: Stopping ${currentModel}...`);
      await this.containerManager.stop(currentModel);
      stoppedContainer = currentModel;
      console.log(`[ModelAlias] Step 1/3: ${currentModel} stopped`);
    }

    // 5. Start target container
    let healthy = false;
    if (this.containerManager) {
      console.log(`[ModelAlias] Step 2/3: Starting ${targetModel}...`);
      healthy = await this.containerManager.start(targetModel);
      console.log(`[ModelAlias] Step 2/3: ${targetModel} ${healthy ? 'healthy' : 'FAILED health check'}`);
    } else {
      healthy = true;
    }

    // 6. If health check failed, attempt to restore previous container
    if (!healthy) {
      console.error(`[ModelAlias] ERROR: ${targetModel} failed health check, attempting to restore ${currentModel}`);
      if (this.containerManager) {
        const restored = await this.containerManager.start(currentModel);
        if (restored) {
          console.log(`[ModelAlias] Restored ${currentModel} successfully`);
        } else {
          console.error(`[ModelAlias] FAILED to restore ${currentModel} - manual intervention required`);
        }
      }
      return {
        success: false,
        previousModel: currentModel,
        newModel: targetModel,
        containerStatus: { stopped: stoppedContainer, started: targetModel, healthy: false },
        error: `Target model '${targetModel}' failed health check`
      };
    }

    // 7. Update alias (only after successful health check)
    console.log(`[ModelAlias] Step 3/3: Updating alias ${aliasName} -> ${targetModel}`);
    this.setAlias(aliasName, targetModel);

    // 8. Log to history
    this.aliasQueries.logFlip(aliasName, currentModel, targetModel, triggeredBy);

    console.log(`[ModelAlias] Flip complete: ${currentModel} -> ${targetModel}`);
    return {
      success: true,
      previousModel: currentModel,
      newModel: targetModel,
      containerStatus: { stopped: stoppedContainer, started: targetModel, healthy: true }
    };
  }
}
