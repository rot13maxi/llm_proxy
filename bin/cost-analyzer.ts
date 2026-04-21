#!/usr/bin/env node
/**
 * Cost Analyzer CLI
 * 
 * Analyze actual electricity costs vs OpenRouter pricing
 * 
 * Usage:
 *   tsx bin/cost-analyzer.ts --since 30d
 *   tsx bin/cost-analyzer.ts --model gpt-4o-mini
 *   tsx bin/cost-analyzer.ts --api-key 1
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseService } from '../src/db/index.js';
import { UsageLogQueries } from '../src/db/queries.js';
import { loadConfig } from '../src/config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse command line arguments
function parseArgs(args: string[]): {
  since?: string;
  model?: string;
  apiKey?: string;
  days: number;
} {
  const result: { since?: string; model?: string; apiKey?: string; days: number } = { days: 30 };
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--since':
      case '-s':
        result.since = args[++i];
        parseSince(result.since!);
        break;
      case '--model':
      case '-m':
        result.model = args[++i];
        break;
      case '--api-key':
      case '-k':
        result.apiKey = args[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }
  
  return result;
  
  function parseSince(since: string): void {
    const match = since.match(/^(\d+)(d|w|m)$/);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2];
      
      switch (unit) {
        case 'd':
          result.days = value;
          break;
        case 'w':
          result.days = value * 7;
          break;
        case 'm':
          result.days = value * 30;
          break;
      }
    }
  }
}

function printHelp(): void {
  console.log(`
Cost Analyzer - Compare actual electricity costs vs OpenRouter pricing

Usage:
  tsx bin/cost-analyzer.ts [options]

Options:
  --since, -s <duration>  Time range (e.g., 30d, 4w, 3m) [default: 30d]
  --model, -m <name>      Filter by model name
  --api-key, -k <id>      Filter by API key ID
  --help, -h              Show this help message

Examples:
  tsx bin/cost-analyzer.ts --since 30d
  tsx bin/cost-analyzer.ts --model gpt-4o-mini
  tsx bin/cost-analyzer.ts --api-key 1
  tsx bin/cost-analyzer.ts -s 7d -m gpt-4o-mini
`);
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatNumber(value: number): string {
  if (value >= 1000000) {
    return `(value / 1000000).toFixed(1)}M`;
  } else if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return value.toString();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  
  // Load config
  let config;
  try {
    config = loadConfig();
  } catch {
    // Use default config if file not found
    config = {
      server: { port: 4000, host: '0.0.0.0' },
      database: { path: './data/llm_proxy.db', retention_days: 90 },
      admin: { username: 'admin', password: 'admin' },
      models: [],
      power_monitoring: {
        enabled: false,
        cost_per_kwh: 0.161,
        idle_baseline_watts: 100,
        power_logs_path: '~/power-logs'
      }
    };
  }
  
  // Initialize database
  const db = new DatabaseService(config as any);
  const queries = new UsageLogQueries(db.db);
  
  try {
    // Get cost attribution stats
    const stats = queries.getCostAttributionStats(args.days, args.model, args.apiKey ? Number(args.apiKey) : undefined);
    
    console.log('\n📊 Cost Attribution Analysis');
    console.log('=' .repeat(60));
    console.log(`  Time range: Last ${args.days} days`);
    if (args.model) console.log(`  Model: ${args.model}`);
    if (args.apiKey) console.log(`  API Key: ${args.apiKey}`);
    console.log('='.repeat(60));
    
    // Summary
    console.log('\n💰 Summary');
    console.log('  '.padEnd(4) + 'Total Requests:'.padEnd(20) + formatNumber(stats.totalRequests));
    console.log('  '.padEnd(4) + 'Attributed Requests:'.padEnd(20) + formatNumber(stats.attributedRequests));
    console.log('  '.padEnd(4) + 'OpenRouter Cost:'.padEnd(20) + formatCurrency(stats.totalOpenRouterCost));
    console.log('  '.padEnd(4) + 'Actual Cost:'.padEnd(20) + formatCurrency(stats.totalActualCost));
    console.log('  '.padEnd(4) + 'Savings:'.padEnd(20) + formatCurrency(stats.savings));
    console.log('  '.padEnd(4) + 'Savings %:'.padEnd(20) + stats.savingsPercentage.toFixed(1) + '%');
    
    // Get recent requests
    const recentRequests = queries.getRecentRequestsWithCost(10, args.model, args.apiKey ? Number(args.apiKey) : undefined);
    
    if (recentRequests.length > 0) {
      console.log('\n📋 Recent Requests');
      console.log('-'.repeat(60));
      
      // Table header
      console.log(
        '  '.padEnd(4) +
        'Model'.padEnd(25) +
        'OpenRouter'.padEnd(15) +
        'Actual'.padEnd(15) +
        'Savings'
      );
      console.log('-'.repeat(60));
      
      // Table rows
      for (const req of recentRequests) {
        const model = req.model.slice(0, 24).padEnd(24);
        const openRouter = formatCurrency(req.openRouterCost).padEnd(14);
        const actual = req.actualCost 
          ? formatCurrency(req.actualCost).padEnd(14)
          : 'pending'.padEnd(14);
        const savings = req.savings 
          ? formatCurrency(req.savings)
          : '-';
        
        console.log(
          '  '.padEnd(4) +
          model +
          openRouter +
          actual +
          savings
        );
      }
      
      console.log('-'.repeat(60));
    }
    
    // Burn rate
    if (stats.attributedRequests > 0) {
      const burnRate = stats.totalActualCost / args.days;
      console.log('\n📈 Burn Rate');
      console.log('  '.padEnd(4) + 'Daily:'.padEnd(20) + formatCurrency(burnRate));
      console.log('  '.padEnd(4) + 'Monthly:'.padEnd(20) + formatCurrency(burnRate * 30));
    }
    
    console.log('\n');
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
