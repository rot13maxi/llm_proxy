/**
 * Format Transformer: Anthropic ↔ OpenAI
 * 
 * Mapping:
 * ┌────────────────────────┬─────────────────────────────────────────┐
 * │ Anthropic              │ OpenAI                                  │
 * ├────────────────────────┼─────────────────────────────────────────┤
 * │ messages[]             │ messages[] (same structure)             │
 * │ system (string)        │ messages[0] with role: "system"         │
 * │ max_tokens             │ max_tokens                              │
 * │ temperature            │ temperature                             │
 * │ top_p                  │ top_p                                   │
 * ├────────────────────────┼─────────────────────────────────────────┤
 * │ content[] (array)      │ content (string)                        │
 * │ type: "text"           │ (implicit)                              │
 │ ────────────────────────┼─────────────────────────────────────────│
 * │ role: "user"           │ role: "user"                            │
 * │ role: "assistant"      │ role: "assistant"                       │
 * │ type: "message"        │ (in response)                           │
 * └────────────────────────┴─────────────────────────────────────────┘
 */

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface OpenAIResponse {
  id: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  created: number;
  model: string;
}

export interface OpenAIStreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
  created: number;
  model: string;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string }>;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class Transformer {
  /**
   * Convert Anthropic request to OpenAI format
   */
  anthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
    const messages: OpenAIMessage[] = [];

    // Handle system message
    if (req.system) {
      messages.push({ role: 'system', content: req.system });
    }

    // Convert messages
    for (const msg of req.messages) {
      let content: string;
      
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else {
        // Array of content blocks - extract text
        content = msg.content
          .filter(c => c.type === 'text')
          .map(c => c.text || '')
          .join('');
      }

      messages.push({
        role: msg.role,
        content
      });
    }

    return {
      model: req.model,
      messages,
      temperature: req.temperature,
      top_p: req.top_p,
      max_tokens: req.max_tokens,
      stream: false // Handle streaming separately
    };
  }

  /**
   * Convert OpenAI response to Anthropic format
   */
  openAIToAnthropic(resp: OpenAIResponse): AnthropicResponse {
    const choice = resp.choices[0];
    
    return {
      id: resp.id,
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'text',
        text: choice.message.content
      }],
      model: resp.model,
      usage: {
        input_tokens: resp.usage.prompt_tokens,
        output_tokens: resp.usage.completion_tokens
      }
    };
  }

  /**
   * Convert OpenAI stream chunk to Anthropic stream format
   * Returns null for chunks that should be filtered out
   */
  openAIStreamToAnthropic(chunk: OpenAIStreamChunk): string | null {
    // Parse the SSE data
    if (!chunk.choices || chunk.choices.length === 0) {
      return null;
    }

    const choice = chunk.choices[0];
    const delta = choice.delta;

    // Build Anthropic-style chunk
    const anthropicChunk = {
      type: 'content_block_delta',
      delta: {
        type: 'text_delta',
        text: delta?.content || ''
      },
      index: 0
    };

    // If finish_reason, add message_stop
    if (choice.finish_reason) {
      return `data: ${JSON.stringify(anthropicChunk)}\n\n` +
             `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
    }

    return `data: ${JSON.stringify(anthropicChunk)}\n\n`;
  }

  /**
   * Extract usage from OpenAI response (streaming or non-streaming)
   */
  extractUsage(resp: OpenAIResponse | OpenAIStreamChunk): {
    inputTokens: number;
    outputTokens: number;
  } {
    const usage = resp.usage;
    if (!usage) {
      return { inputTokens: 0, outputTokens: 0 };
    }

    return {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0
    };
  }
}
