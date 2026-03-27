import express, { type Express, type Request, type Response } from 'express';
import * as http from 'http';

/**
 * Mock upstream server for integration testing
 * 
 * Records all incoming requests and returns configurable responses
 */
export class MockUpstreamServer {
  private app: Express;
  private server: http.Server | null = null;
  private port: number = 0;
  
  // Request recording
  private requests: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];
  
  // Response configuration
  private responseConfig: ResponseConfig | null = null;
  private streamingChunks: string[] | null = null;
  private delayMs: number = 0;

  constructor() {
    this.app = express();
    this.app.use(express.json({ limit: '10mb' }));
    
    // Catch-all endpoint that records requests and returns configured response
    this.app.post('*', this.handleRequest.bind(this));
    this.app.get('*', this.handleRequest.bind(this));
  }

  async start(port: number = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, () => {
        const actualPort = this.server?.address() as { port: number };
        this.port = actualPort?.port || port;
        resolve(this.port);
      });
      this.server?.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleRequest(req: Request, res: Response): void {
    // Record the request
    this.requests.push({
      method: req.method,
      path: req.path,
      body: req.body,
      headers: req.headers as Record<string, string>
    });

    // Apply delay if configured
    if (this.delayMs > 0) {
      setTimeout(() => this.sendResponse(res), this.delayMs);
    } else {
      this.sendResponse(res);
    }
  }

  private sendResponse(res: Response): void {
    if (this.streamingChunks) {
      // Streaming response (SSE)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let chunkIndex = 0;
      const sendNextChunk = () => {
        if (chunkIndex < this.streamingChunks!.length) {
          res.write(`data: ${this.streamingChunks![chunkIndex++]}\n\n`);
          setTimeout(sendNextChunk, 10);
        } else {
          res.end();
        }
      };
      sendNextChunk();
    } else if (this.responseConfig) {
      // Regular response
      const config = this.responseConfig;
      res.status(config.status || 200);
      
      if (config.headers) {
        Object.entries(config.headers).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
      }
      
      if (config.body) {
        if (typeof config.body === 'object') {
          res.json(config.body);
        } else {
          res.send(config.body);
        }
      } else {
        res.end();
      }
    } else {
      // Default response
      res.status(200).json({
        id: 'mock-response',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Mock response' },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        },
        model: 'mock-model'
      });
    }
  }

  // Getters for test assertions
  getRequests(): Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> {
    return this.requests;
  }

  clearRequests(): void {
    this.requests = [];
  }

  getPort(): number {
    return this.port;
  }

  // Response configuration
  setResponse(config: ResponseConfig): void {
    this.responseConfig = config;
    this.streamingChunks = null;
  }

  setStreamingResponse(chunks: string[]): void {
    this.streamingChunks = chunks;
    this.responseConfig = null;
  }

  setErrorResponse(status: number, message: string): void {
    this.responseConfig = {
      status,
      body: { error: message }
    };
    this.streamingChunks = null;
  }

  setSlowResponse(ms: number): void {
    this.delayMs = ms;
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }
}

export interface ResponseConfig {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}
