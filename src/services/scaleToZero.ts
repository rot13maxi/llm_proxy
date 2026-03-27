import Dockerode from 'dockerode';
import { request } from 'undici';

/**
 * Scale-to-zero orchestration service
 * 
 * Manages Docker container lifecycle per-model:
 * - Starts containers on first request
 * - Stops containers after idle timeout
 * - Health checks before serving traffic
 * - Returns readiness status for proxy decisions
 */
export class ScaleToZeroService {
  private docker: Dockerode;
  private containers: Map<string, Dockerode.Container> = new Map();
  private containerState: Map<string, ContainerState> = new Map();
  private idleTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    this.docker = new Dockerode();
  }

  /**
   * Initialize scale-to-zero for a model
   */
  init(modelName: string, config: {
    containerName: string;
    backendPort: number;
    idleTimeoutMinutes: number;
    startTimeoutSeconds: number;
    healthCheckPath: string;
    healthCheckIntervalMs: number;
  }): void {
    const container = this.docker.getContainer(config.containerName);
    this.containers.set(modelName, container);
    this.containerState.set(modelName, {
      isRunning: false,
      isStarting: false,
      isStopping: false,
      config
    });
    console.log(`[ScaleToZero] Initialized ${modelName} → ${config.containerName}:${config.backendPort}`);
  }

  /**
   * Check if a model's backend is ready to serve traffic
   */
  async isReady(modelName: string): Promise<boolean> {
    const state = this.containerState.get(modelName);
    if (!state) return true; // No scale-to-zero config, assume ready

    if (!state.isRunning) return false;
    if (state.isStarting) return false;

    // Quick health check
    try {
      const response = await request(
        `${this.getBackendUrl(state.config)}${state.config.healthCheckPath}`,
        { method: 'GET', signal: AbortSignal.timeout(5000) }
      );
      return response.statusCode === 200;
    } catch {
      return false;
    }
  }

  /**
   * Start container for a model
   * Returns promise that resolves when container is healthy
   */
  async start(modelName: string): Promise<boolean> {
    const state = this.containerState.get(modelName);
    if (!state) {
      console.warn(`[ScaleToZero] No config for ${modelName}`);
      return false;
    }

    // Guard against concurrent starts
    if (state.isStarting || state.isRunning || state.isStopping) {
      console.log(`[ScaleToZero] ${modelName}: skip start (isStarting=${state.isStarting}, isRunning=${state.isRunning}, isStopping=${state.isStopping})`);
      return state.isRunning;
    }

    state.isStarting = true;
    console.log(`[ScaleToZero] ${modelName}: starting ${state.config.containerName}`);

    const container = this.containers.get(modelName);
    if (!container) {
      console.error(`[ScaleToZero] ${modelName}: container not found`);
      state.isStarting = false;
      return false;
    }

    try {
      const inspect = await container.inspect();

      if (inspect.State.Running) {
        console.log(`[ScaleToZero] ${modelName}: container already running, waiting for health`);
      } else {
        await container.start();
        console.log(`[ScaleToZero] ${modelName}: container started, waiting for health`);
      }

      const startTime = Date.now();
      while (Date.now() - startTime < state.config.startTimeoutSeconds * 1000) {
        try {
          const response = await request(
            `${this.getBackendUrl(state.config)}${state.config.healthCheckPath}`,
            { method: 'GET', signal: AbortSignal.timeout(5000) }
          );
          if (response.statusCode === 200) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`[ScaleToZero] ${modelName}: healthy after ${elapsed}s`);
            state.isRunning = true;
            state.isStarting = false;
            this.resetIdleTimer(modelName);
            return true;
          }
        } catch {
          // Continue waiting
        }

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (elapsed % 30 < state.config.healthCheckIntervalMs / 1000) {
          console.log(`[ScaleToZero] ${modelName}: waiting for health... ${elapsed}s / ${state.config.startTimeoutSeconds}s`);
        }
        await new Promise(resolve => setTimeout(resolve, state.config.healthCheckIntervalMs));
      }

      console.error(`[ScaleToZero] ${modelName}: failed to become healthy within ${state.config.startTimeoutSeconds}s`);
      state.isStarting = false;
      return false;
    } catch (error) {
      console.error(`[ScaleToZero] ${modelName}: error starting container:`, error);
      state.isStarting = false;
      return false;
    }
  }

  /**
   * Stop container for a model
   */
  async stop(modelName: string): Promise<void> {
    const state = this.containerState.get(modelName);
    if (!state) return;

    if (state.isStopping || !state.isRunning || state.isStarting) {
      console.log(`[ScaleToZero] ${modelName}: skip stop (isStopping=${state.isStopping}, isRunning=${state.isRunning}, isStarting=${state.isStarting})`);
      return;
    }

    state.isStopping = true;
    console.log(`[ScaleToZero] ${modelName}: stopping ${state.config.containerName}`);

    // Clear idle timer
    const idleTimer = this.idleTimers.get(modelName);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(modelName);
    }

    const container = this.containers.get(modelName);
    try {
      if (container) {
        await container.stop({ t: 30 });
        state.isRunning = false;
        console.log(`[ScaleToZero] ${modelName}: container stopped`);
      }
    } catch (error) {
      console.error(`[ScaleToZero] ${modelName}: error stopping container:`, error);
    } finally {
      state.isStopping = false;
    }
  }

  /**
   * Reset idle timer for a model
   * Call this on each successful request
   */
  resetIdleTimer(modelName: string): void {
    const state = this.containerState.get(modelName);
    if (!state || !state.isRunning) return;

    // Clear existing timer
    const existingTimer = this.idleTimers.get(modelName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(async () => {
      console.log(`[ScaleToZero] ${modelName}: idle for ${state.config.idleTimeoutMinutes} minutes, stopping`);
      await this.stop(modelName);
    }, state.config.idleTimeoutMinutes * 60 * 1000);

    this.idleTimers.set(modelName, timer);
  }

  /**
   * Get backend URL from upstream config
   * Extracts host:port from upstream URL like "http://sglang-27b:8001/v1/chat/completions"
   */
  private getBackendUrl(config: {
    containerName: string;
    backendPort: number;
    idleTimeoutMinutes: number;
    startTimeoutSeconds: number;
    healthCheckPath: string;
    healthCheckIntervalMs: number;
  }): string {
    return `http://${config.containerName}:${config.backendPort}`;
  }

  /**
   * Cleanup on shutdown
   */
  async shutdown(): Promise<void> {
    console.log('[ScaleToZero] Shutting down...');

    // Clear all idle timers
    for (const [modelName, timer] of this.idleTimers) {
      clearTimeout(timer);
      console.log(`[ScaleToZero] ${modelName}: cleared idle timer`);
    }
    this.idleTimers.clear();

    // Stop all running containers
    const stopPromises: Promise<void>[] = [];
    for (const [modelName, state] of this.containerState) {
      if (state.isRunning) {
        stopPromises.push(this.stop(modelName));
      }
    }
    await Promise.all(stopPromises);
  }
}

interface ContainerState {
  isRunning: boolean;
  isStarting: boolean;
  isStopping: boolean;
  config: {
    containerName: string;
    backendPort: number;
    idleTimeoutMinutes: number;
    startTimeoutSeconds: number;
    healthCheckPath: string;
    healthCheckIntervalMs: number;
  };
}
