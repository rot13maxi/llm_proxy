import { describe, it, expect } from 'vitest';
import { Transformer } from '../../src/services/transformer.js';

describe('Transformer', () => {
  const transformer = new Transformer();

  describe('anthropicToOpenAI', () => {
    it('should convert Anthropic messages to OpenAI format', () => {
      const anthropicReq = {
        model: 'test-model',
        messages: [
          { role: 'user' as const, content: 'Hello' },
          { role: 'assistant' as const, content: 'Hi there!' }
        ],
        max_tokens: 100
      };

      const result = transformer.anthropicToOpenAI(anthropicReq);

      expect(result.model).toBe('test-model');
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(result.max_tokens).toBe(100);
    });

    it('should handle system message', () => {
      const anthropicReq = {
        model: 'test-model',
        system: 'You are a helpful assistant',
        messages: [{ role: 'user' as const, content: 'Hello' }]
      };

      const result = transformer.anthropicToOpenAI(anthropicReq);

      expect(result.messages[0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant'
      });
    });

    it('should handle array content blocks', () => {
      const anthropicReq = {
        model: 'test-model',
        messages: [{
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'Hello' }]
        }]
      };

      const result = transformer.anthropicToOpenAI(anthropicReq);

      expect(result.messages[0].content).toBe('Hello');
    });

    it('should handle multiple content blocks', () => {
      const anthropicReq = {
        model: 'test-model',
        messages: [{
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: 'Hello ' },
            { type: 'text' as const, text: 'World' }
          ]
        }]
      };

      const result = transformer.anthropicToOpenAI(anthropicReq);

      expect(result.messages[0].content).toBe('Hello World');
    });
  });

  describe('openAIToAnthropic', () => {
    it('should convert OpenAI response to Anthropic format', () => {
      const openAIResp = {
        id: 'test-id',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        },
        created: 1234567890,
        model: 'test-model'
      };

      const result = transformer.openAIToAnthropic(openAIResp);

      expect(result.id).toBe('test-id');
      expect(result.type).toBe('message');
      expect(result.role).toBe('assistant');
      expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }]);
      expect(result.usage).toEqual({
        input_tokens: 10,
        output_tokens: 5
      });
    });
  });

  describe('extractUsage', () => {
    it('should extract usage from response', () => {
      const response = {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150
        }
      };

      const result = transformer.extractUsage(response);

      expect(result).toEqual({
        inputTokens: 100,
        outputTokens: 50
      });
    });

    it('should return zeros when no usage', () => {
      const response = { choices: [] };

      const result = transformer.extractUsage(response);

      expect(result).toEqual({
        inputTokens: 0,
        outputTokens: 0
      });
    });
  });
});
