import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { ConfigSchema, type Config } from './schema.js';
import { ZodError } from 'zod';

/**
 * Load and validate configuration from YAML file
 * 
 * Config file lookup order:
 * 1. --config CLI argument
 * 2. CONFIG_PATH environment variable
 * 3. /config.yaml (Docker volume mount)
 * 4. ./config.yaml (relative to cwd)
 * 5. /etc/llm-proxy/config.yaml
 */
export function loadConfig(): Config {
  const configPath = findConfigPath();
  
  if (!configPath) {
    throw new Error(
      'Configuration file not found. Please provide config.yaml or set CONFIG_PATH environment variable.'
    );
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(content) as unknown;
  
  try {
    return ConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      const errors = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('\n  ');
      throw new Error(`Invalid configuration:\n  ${errors}`);
    }
    throw error;
  }
}

function findConfigPath(): string | null {
  // Check CLI argument
  const cliConfig = process.argv.find(arg => arg.startsWith('--config='));
  if (cliConfig) {
    return cliConfig.split('=')[1];
  }

  // Check environment variable
  const envConfig = process.env.CONFIG_PATH;
  if (envConfig) {
    if (!fs.existsSync(envConfig)) {
      throw new Error(
        `CONFIG_PATH is set to '${envConfig}' but the file does not exist.`
      );
    }
    return envConfig;
  }

  // Check Docker volume mount path
  const dockerConfig = '/config.yaml';
  if (fs.existsSync(dockerConfig)) {
    return dockerConfig;
  }

  // Check current directory
  const localConfig = path.join(process.cwd(), 'config.yaml');
  if (fs.existsSync(localConfig)) {
    return localConfig;
  }

  // Check system config directory
  const systemConfig = '/etc/llm-proxy/config.yaml';
  if (fs.existsSync(systemConfig)) {
    return systemConfig;
  }

  return null;
}

// Export for testing
export { findConfigPath };
export type { Config } from './schema.js';
