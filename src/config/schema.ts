import { z } from 'zod';

export const ModelConfigSchema = z.object({
  name: z.string(),
  upstream: z.string().url(),
  cost_per_1k_input: z.number().positive(),
  cost_per_1k_output: z.number().positive()
});

export const RateLimitSchema = z.object({
  requests_per_minute: z.number().positive().default(60),
  tokens_per_minute: z.number().positive().default(100000)
});

export const AdminAuthSchema = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  api_key: z.string().optional()
}).refine(
  (data) => {
    const hasBasicAuth = data.username && data.password;
    const hasApiKey = data.api_key;
    return hasBasicAuth || hasApiKey;
  },
  {
    message: 'Either username/password or api_key must be provided for admin auth'
  }
);

export const ServerConfigSchema = z.object({
  port: z.number().positive().default(4000),
  host: z.string().default('0.0.0.0')
});

export const DatabaseConfigSchema = z.object({
  path: z.string().default('./data/llm_proxy.db'),
  retention_days: z.number().positive().default(90)
});

export const ConfigSchema = z.object({
  server: ServerConfigSchema,
  database: DatabaseConfigSchema,
  admin: AdminAuthSchema,
  models: z.array(ModelConfigSchema).min(1, 'At least one model must be configured'),
  rate_limits: z.object({
    default: RateLimitSchema
  }).optional()
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type RateLimit = z.infer<typeof RateLimitSchema>;
