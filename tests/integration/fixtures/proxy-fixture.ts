import { MockUpstreamServer } from './mock-upstream.js';
import { LLMServer } from '../../../src/server.js';
import Database from 'better-sqlite3';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Test fixture for integration tests
 * 
 * Sets up a complete test environment with:
 * - Mock upstream server
 * - Real proxy server instance
 * - In-memory SQLite database
 * - Pre-seeded API key
 */
export class ProxyTestFixture {
  private mockServer: MockUpstreamServer;
  private proxyServer: LLMServer | null = null;
  private dbPath: string;
  private configPath: string;
  private apiKey: string = '';
  private proxyPort: number = 0;
  private configPort: number = 0;
  private keyRateLimitRpm?: number;
  private keyRateLimitTpm?: number;

  constructor(options?: {
    rateLimitRpm?: number;
    rateLimitTpm?: number;
  }) {
    this.mockServer = new MockUpstreamServer();
    this.keyRateLimitRpm = options?.rateLimitRpm;
    this.keyRateLimitTpm = options?.rateLimitTpm;
    
    // Create temp directories for DB and config
    const tempDir = mkdtempSync(join(tmpdir(), 'llm-proxy-test-'));
    this.dbPath = join(tempDir, 'test.db');
    this.configPath = join(tempDir, 'config.yaml');
    
    // Create config file
    this.writeConfig(options);
  }

  private writeConfig(options?: { rateLimitRpm?: number; rateLimitTpm?: number }): void {
    const config = `
server:
  port: 0
  host: 127.0.0.1

database:
  path: ${this.dbPath}
  retention_days: 1

admin:
  username: test-admin
  password: test-password

models:
  - name: test-model
    upstream: http://127.0.0.1:${this.mockServer.getPort()}/v1/chat/completions
    cost_per_1k_input: 0.001
    cost_per_1k_output: 0.002

rate_limits:
  default:
    requests_per_minute: ${options?.rateLimitRpm || 60}
    tokens_per_minute: ${options?.rateLimitTpm || 100000}
`;
    writeFileSync(this.configPath, config.trim());
  }

  async setup(): Promise<void> {
    // Start mock upstream server on random port
    await this.mockServer.start(0);
    
    // Write config with actual mock port
    this.writeConfig();
    
    // Override config path
    process.env.CONFIG_PATH = this.configPath;
    
    // Create and start proxy server
    this.proxyServer = new LLMServer();
    await this.proxyServer.start();
    this.proxyPort = this.proxyServer.getPort();
    
    // Create a test API key via direct DB access
    await this.createTestApiKey();
  }

  private async createTestApiKey(): Promise<void> {
    const { hash } = await import('@node-rs/argon2');
    const { v4: uuidv4 } = await import('uuid');
    
    const db = Database(this.dbPath);
    
    // Generate a real API key
    const uuid = uuidv4();
    const fullKey = `sk-${uuid}`;
    const keyPrefix = uuid.slice(0, 8);
    const keyHash = await hash(fullKey, { memoryCost: 65536, timeCost: 2, parallelism: 1 });
    
    db.prepare(`
      INSERT OR REPLACE INTO api_keys (key_prefix, key_hash, name, is_active, rate_limit_rpm, rate_limit_tpm)
      VALUES (?, ?, 'test-key', 1, ?, ?)
    `).run(keyPrefix, keyHash, this.keyRateLimitRpm, this.keyRateLimitTpm);
    
    this.apiKey = fullKey;
    
    db.close();
  }

  async teardown(): Promise<void> {
    try {
      // Stop proxy server
      if (this.proxyServer) {
        await this.proxyServer.stop();
        this.proxyServer = null;
      }
    } catch (err) {
      // Ignore teardown errors
    }
    
    try {
      // Stop mock server
      await this.mockServer.stop();
    } catch (err) {
      // Ignore teardown errors
    }
    
    // Clean up env
    delete process.env.CONFIG_PATH;
  }

  // Getters for test assertions
  getProxyUrl(): string {
    return `http://127.0.0.1:${this.proxyPort}`;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  getMockServer(): MockUpstreamServer {
    return this.mockServer;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getMetricsUrl(): string {
    return `${this.getProxyUrl()}/metrics`;
  }

  getAdminUrl(): string {
    return `${this.getProxyUrl()}/admin`;
  }
}
