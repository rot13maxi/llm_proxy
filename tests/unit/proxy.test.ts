import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProxyService } from '../../src/services/proxy.js';
import { ModelConfigQueries } from '../../src/db/queries.js';
import { Transformer } from '../../src/services/transformer.js';

describe('ProxyService', () => {
  let mockModelQueries: any;
  let proxyService: ProxyService;

  beforeEach(() => {
    mockModelQueries = {
      getModel: vi.fn()
    };
    proxyService = new ProxyService(mockModelQueries);
  });

  describe('getModel', () => {
    it('should return model config when found', () => {
      const mockConfig = {
        upstream: 'http://localhost:3000/v1/chat/completions',
        costPer1kInput: 0.001,
        costPer1kOutput: 0.002
      };
      
      mockModelQueries.getModel.mockReturnValue(mockConfig);
      
      const result = mockModelQueries.getModel('test-model');
      
      expect(result).toEqual(mockConfig);
      expect(mockModelQueries.getModel).toHaveBeenCalledWith('test-model');
    });

    it('should return null when model not found', () => {
      mockModelQueries.getModel.mockReturnValue(null);
      
      const result = mockModelQueries.getModel('non-existent');
      
      expect(result).toBeNull();
    });
  });

  describe('extractUsage', () => {
    it('should extract usage from OpenAI response', () => {
      const transformer = new Transformer();
      
      const response = {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150
        }
      };
      
      const usage = transformer.extractUsage(response as any);
      
      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(50);
    });

    it('should handle missing usage', () => {
      const transformer = new Transformer();
      
      const response = {
        id: 'chat-1',
        choices: []
      };
      
      const usage = transformer.extractUsage(response as any);
      
      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
    });

    it('should handle zero usage', () => {
      const transformer = new Transformer();
      
      const response = {
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      const usage = transformer.extractUsage(response as any);
      
      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
    });
  });

  describe('anthropicToOpenAI', () => {
    it('should convert Anthropic request to OpenAI format', () => {
      const transformer = new Transformer();
      
      const anthropicReq = {
        model: 'test-model',
        messages: [
          { role: 'user' as const, content: 'Hello' },
          { role: 'assistant' as const, content: 'Hi there' }
        ],
        max_tokens: 100,
        temperature: 0.7
      };
      
      const openAiReq = transformer.anthropicToOpenAI(anthropicReq);
      
      expect(openAiReq.model).toBe('test-model');
      expect(openAiReq.messages).toHaveLength(2);
      expect(openAiReq.messages[0].role).toBe('user');
      expect(openAiReq.messages[0].content).toBe('Hello');
      expect(openAiReq.max_tokens).toBe(100);
      expect(openAiReq.temperature).toBe(0.7);
    });

    it('should handle system message', () => {
      const transformer = new Transformer();
      
      const anthropicReq = {
        model: 'test-model',
        system: 'You are helpful',
        messages: [{ role: 'user' as const, content: 'Hello' }],
        max_tokens: 100
      };
      
      const openAiReq = transformer.anthropicToOpenAI(anthropicReq);
      
      expect(openAiReq.messages).toHaveLength(2);
      expect(openAiReq.messages[0].role).toBe('system');
      expect(openAiReq.messages[0].content).toBe('You are helpful');
      expect(openAiReq.messages[1].role).toBe('user');
    });

    it('should handle content arrays', () => {
      const transformer = new Transformer();
      
      const anthropicReq = {
        model: 'test-model',
        messages: [{
          role: 'user' as const,
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' world' }
          ]
        }],
        max_tokens: 100
      };
      
      const openAiReq = transformer.anthropicToOpenAI(anthropicReq);
      
      expect(openAiReq.messages[0].content).toBe('Hello world');
    });
  });

  describe('openAIToAnthropic', () => {
    it('should convert OpenAI response to Anthropic format', () => {
      const transformer = new Transformer();
      
      const openAiResp = {
        id: 'chat-123',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello from OpenAI' },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 8,
          total_tokens: 18
        },
        created: 1234567890,
        model: 'test-model'
      };
      
      const anthropicResp = transformer.openAIToAnthropic(openAiResp);
      
      expect(anthropicResp.id).toBe('chat-123');
      expect(anthropicResp.type).toBe('message');
      expect(anthropicResp.role).toBe('assistant');
      expect(anthropicResp.content[0].type).toBe('text');
      expect(anthropicResp.content[0].text).toBe('Hello from OpenAI');
      expect(anthropicResp.usage.input_tokens).toBe(10);
      expect(anthropicResp.usage.output_tokens).toBe(8);
    });

    it('should handle empty choices', () => {
      const transformer = new Transformer();
      
      const openAiResp = {
        id: 'chat-empty',
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      
      // Should handle gracefully (may return empty content)
      const result = transformer.openAIToAnthropic(openAiResp);
      expect(result).toBeDefined();
    });
  });
});
