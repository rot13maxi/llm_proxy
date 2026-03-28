import Dockerode from 'dockerode';
import { request } from 'undici';

interface ContainerConfig {
  containerName: string;
  backendPort: number;
  healthCheckPath: string;
  startTimeoutSeconds: number;
}

/**
 * Container lifecycle manager for explicit operator actions (alias flips).
 *
 * No idle timer. No auto-start. Containers are started/stopped on purpose.
 */
export class ContainerManager {
  private docker: Dockerode;
  private registry: Map<string, ContainerConfig> = new Map();

  constructor() {
    this.docker = new Dockerode();
  }

  register(modelName: string, config: ContainerConfig): void {
    this.registry.set(modelName, config);
  }

  async start(modelName: string): Promise<boolean> {
    const config = this.registry.get(modelName);
    if (!config) {
      console.error(`[ContainerManager] No config registered for ${modelName}`);
      return false;
    }

    const container = this.docker.getContainer(config.containerName);
    console.log(`[ContainerManager] ${config.containerName}: starting`);

    try {
      const inspect = await container.inspect();
      if (inspect.State.Running) {
        console.log(`[ContainerManager] ${config.containerName}: already running, waiting for health`);
      } else {
        await container.start();
        console.log(`[ContainerManager] ${config.containerName}: started, waiting for health`);
      }

      const backendUrl = `http://${config.containerName}:${config.backendPort}`;
      const startTime = Date.now();
      while (Date.now() - startTime < config.startTimeoutSeconds * 1000) {
        try {
          const response = await request(
            `${backendUrl}${config.healthCheckPath}`,
            { method: 'GET', signal: AbortSignal.timeout(5000) }
          );
          if (response.statusCode === 200) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`[ContainerManager] ${config.containerName}: healthy after ${elapsed}s`);
            return true;
          }
        } catch {
          // Continue waiting
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      console.error(`[ContainerManager] ${config.containerName}: failed health check within ${config.startTimeoutSeconds}s`);
      return false;
    } catch (error) {
      console.error(`[ContainerManager] ${config.containerName}: error starting:`, error);
      return false;
    }
  }

  async stop(modelName: string): Promise<void> {
    const config = this.registry.get(modelName);
    if (!config) {
      console.error(`[ContainerManager] No config registered for ${modelName}`);
      return;
    }

    const container = this.docker.getContainer(config.containerName);
    console.log(`[ContainerManager] ${config.containerName}: stopping`);

    try {
      const inspect = await container.inspect();
      if (!inspect.State.Running) {
        console.log(`[ContainerManager] ${config.containerName}: already stopped`);
        return;
      }

      await container.stop({ t: 30 });
      console.log(`[ContainerManager] ${config.containerName}: stop signal sent, waiting for container to fully stop...`);

      const stopTimeout = 120000;
      const startTime = Date.now();
      while (Date.now() - startTime < stopTimeout) {
        const current = await container.inspect();
        if (!current.State.Running && !current.State.Paused) {
          console.log(`[ContainerManager] ${config.containerName}: fully stopped after ${Math.round((Date.now() - startTime) / 1000)}s`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      console.log(`[ContainerManager] ${config.containerName}: waiting 5s for GPU memory release...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      console.log(`[ContainerManager] ${config.containerName}: resources released`);
    } catch (error: any) {
      if (error?.statusCode === 304) {
        console.log(`[ContainerManager] ${config.containerName}: already stopped`);
        return;
      }
      console.error(`[ContainerManager] ${config.containerName}: error stopping:`, error);
    }
  }
}
