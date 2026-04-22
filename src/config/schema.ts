import { z } from 'zod';

export const ScaleToZeroConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  container_name: z.string().optional(),
  backend_port: z.number().positive().optional().default(8000),
  idle_timeout_minutes: z.number().positive().default(30),
  start_timeout_seconds: z.number().positive().default(360),
  health_check_path: z.string().default('/health'),
  health_check_interval_ms: z.number().positive().default(2000)
}).refine(
  (data) => {
    if (data.enabled && !data.container_name) {
      return false;
    }
    return true;
  },
  {
    message: 'container_name is required when scale_to_zero is enabled'
  }
);

export const ContainerConfigSchema = z.object({
  name: z.string().min(1),
  health_url: z.string().url().optional(),
  start_timeout_seconds: z.number().positive().default(360)
});

export const ModelConfigSchema = z.object({
  name: z.string(),
  upstream: z.string().url(),
  cost_per_1k_input: z.number().positive(),
  cost_per_1k_output: z.number().positive(),
  scale_to_zero: ScaleToZeroConfigSchema.optional(),
  container: ContainerConfigSchema.optional()
});

export const AliasConfigSchema = z.object({
  name: z.string().min(1),
  target: z.string().min(1)
});

export const RateLimitSchema = z.object({
  requests_per_minute: z.number().positive().optional(),
  tokens_per_minute: z.number().positive().optional()
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
  port: z.number().min(0).default(4000), // 0 means random port
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
  aliases: z.array(AliasConfigSchema).optional().default([]),
  rate_limits: z.object({
    default: RateLimitSchema
  }).optional()
}).superRefine((cfg, ctx) => {
  const modelNames = new Set(cfg.models.map((m) => m.name));
  for (const [i, alias] of cfg.aliases.entries()) {
    if (!modelNames.has(alias.target)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aliases', i, 'target'],
        message: `alias "${alias.name}" targets unknown model "${alias.target}"`
      });
    }
    if (modelNames.has(alias.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aliases', i, 'name'],
        message: `alias name "${alias.name}" collides with a configured model`
      });
    }
  }
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ContainerConfig = z.infer<typeof ContainerConfigSchema>;
export type AliasConfig = z.infer<typeof AliasConfigSchema>;
export type RateLimit = z.infer<typeof RateLimitSchema>;
