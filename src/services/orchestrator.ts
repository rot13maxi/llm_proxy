import Dockerode from 'dockerode';
import { request } from 'undici';
import type { ContainerConfig, ModelConfig } from '../config/schema.js';

interface OrchestratorModelEntry {
  modelName: string;
  container: ContainerConfig;
  healthUrl: string;
  containerRef: Dockerode.Container;
}

/**
 * Model Orchestration Service
 *
 * Supports manual model switching for single-GPU setups where only one model
 * can be live at a time. When an alias is flipped (e.g. `current` → other model),
 * the old target's container is stopped *before* the new target's container is
 * started, then we poll the new model's health URL until it responds.
 *
 * This is independent from ScaleToZeroService — keep them orthogonal. They can
 * coexist per-model, but typical usage picks one or the other.
 *
 * Orchestration is opt-in: a model without a `container` block in config is a
 * no-op on flip, and the proxy can run without Docker access at all.
 */
export class ModelOrchestrationService {
  private docker: Dockerode;
  private entries: Map<string, OrchestratorModelEntry> = new Map();

  constructor() {
    this.docker = new Dockerode();
  }

  /** Register a model that has a container configured. */
  register(models: ModelConfig[]): void {
    for (const model of models) {
      if (!model.container) continue;
      const healthUrl = model.container.health_url ?? this.deriveHealthUrl(model.upstream);
      this.entries.set(model.name, {
        modelName: model.name,
        container: model.container,
        healthUrl,
        containerRef: this.docker.getContainer(model.container.name)
      });
      console.log(
        `[Orchestrator] Registered ${model.name} → container ${model.container.name} (health ${healthUrl})`
      );
    }
  }

  /** Any model has orchestration configured? */
  isEnabled(): boolean {
    return this.entries.size > 0;
  }

  hasContainer(modelName: string): boolean {
    return this.entries.has(modelName);
  }

  /**
   * Flip from one model to another: stop `fromModel`'s container, then start
   * `toModel`'s and wait until healthy.
   *
   * Either side can be undefined (e.g. nothing was previously running, or the
   * target has no container configured), in which case that side is skipped.
   *
   * There's a brief disruption window between stop and start — we accept that
   * because the user explicitly said they don't have the compute to overlap.
   */
  async flip(fromModel: string | undefined, toModel: string): Promise<{ stopped?: string; started?: string; healthy: boolean }> {
    const result: { stopped?: string; started?: string; healthy: boolean } = { healthy: true };

    if (fromModel && fromModel !== toModel) {
      const from = this.entries.get(fromModel);
      if (from) {
        await this.stopContainer(from);
        result.stopped = from.container.name;
      }
    }

    const to = this.entries.get(toModel);
    if (!to) {
      // Target has no container - nothing to start.
      return result;
    }

    await this.startContainer(to);
    result.started = to.container.name;
    result.healthy = await this.waitForHealth(to);
    return result;
  }

  private async stopContainer(entry: OrchestratorModelEntry): Promise<void> {
    console.log(`[Orchestrator] Stopping container ${entry.container.name} (model ${entry.modelName})`);
    try {
      const inspect = await entry.containerRef.inspect();
      if (!inspect.State.Running) {
        console.log(`[Orchestrator] ${entry.container.name} already stopped`);
        return;
      }
      await entry.containerRef.stop({ t: 30 });
      console.log(`[Orchestrator] ${entry.container.name} stopped`);
    } catch (err) {
      console.error(`[Orchestrator] Error stopping ${entry.container.name}:`, err);
      throw err;
    }
  }

  private async startContainer(entry: OrchestratorModelEntry): Promise<void> {
    console.log(`[Orchestrator] Starting container ${entry.container.name} (model ${entry.modelName})`);
    try {
      const inspect = await entry.containerRef.inspect();
      if (inspect.State.Running) {
        console.log(`[Orchestrator] ${entry.container.name} already running`);
        return;
      }
      await entry.containerRef.start();
      console.log(`[Orchestrator] ${entry.container.name} started, waiting for health`);
    } catch (err) {
      console.error(`[Orchestrator] Error starting ${entry.container.name}:`, err);
      throw err;
    }
  }

  private async waitForHealth(entry: OrchestratorModelEntry): Promise<boolean> {
    const deadline = Date.now() + entry.container.start_timeout_seconds * 1000;
    const intervalMs = 2000;
    while (Date.now() < deadline) {
      try {
        const response = await request(entry.healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        });
        // Any 2xx/4xx means the server is listening (404/405 on /health is still "up").
        if (response.statusCode < 500) {
          const elapsed = Math.round((Date.now() - (deadline - entry.container.start_timeout_seconds * 1000)) / 1000);
          console.log(`[Orchestrator] ${entry.container.name} healthy after ${elapsed}s (${response.statusCode})`);
          return true;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    console.error(`[Orchestrator] ${entry.container.name} failed to become healthy within ${entry.container.start_timeout_seconds}s`);
    return false;
  }

  private deriveHealthUrl(upstream: string): string {
    try {
      const url = new URL(upstream);
      return `${url.protocol}//${url.host}/health`;
    } catch {
      return upstream;
    }
  }
}
