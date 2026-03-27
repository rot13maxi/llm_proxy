# Development Guide

## Setup

```bash
# Clone repository
git clone https://github.com/rot13maxi/llm_proxy.git
cd llm_proxy

# Install dependencies
npm install

# Copy config
cp config.example.yaml config.yaml

# Edit config.yaml (change admin password!)
```

## Development Workflow

### Run in Development Mode

```bash
# Hot reload enabled
npm run dev
```

### Build for Production

```bash
# Compile TypeScript
npm run build

# Run production build
npm start
```

### Run Tests

```bash
# All tests
npm test

# Integration tests only
npm run test:integration

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage
```

### Linting

```bash
npm run lint
```

## Project Structure

```
llm_proxy/
├── src/
│   ├── config/          # Configuration loading and validation
│   ├── db/              # Database layer (SQLite)
│   ├── middleware/      # Express middleware (auth, rate limit, logging)
│   ├── routes/          # Route handlers (openai, anthropic, admin)
│   ├── services/        # Business logic (proxy, metering, metrics)
│   └── server.ts        # Application entry point
├── tests/
│   ├── integration/     # End-to-end tests
│   │   ├── fixtures/    # Test fixtures and mocks
│   │   └── *.test.ts    # Integration test files
│   └── unit/            # Unit tests
├── docs/                # Documentation
├── docker/              # Docker configuration
├── config.example.yaml  # Example configuration
└── package.json
```

## Adding a New Feature

1. **Write tests first** (if possible)
   - Add integration tests in `tests/integration/`
   - Use existing fixtures (`ProxyTestFixture`, `MockUpstreamServer`)

2. **Implement the feature**
   - Follow existing patterns
   - Add TypeScript types
   - Handle errors gracefully

3. **Update documentation**
   - Add to `docs/` if it's a significant feature
   - Update `learnings.md` with any lessons learned

4. **Run all tests**
   ```bash
   npm run test:integration
   ```

5. **Commit with clear message**
   ```bash
   git add -A
   git commit -m "feat: add new feature
   
   - What was added
   - Why it was needed
   - How it works"
   ```

## Debugging

### Debug Mode

```bash
# Run with debug logging
DEBUG=* npm run dev
```

### Database Inspection

```bash
# Install SQLite CLI
brew install sqlite3  # macOS
# or
sudo apt install sqlite3  # Ubuntu

# Inspect database
sqlite3 data/llm_proxy.db

# Useful queries
SELECT * FROM api_keys;
SELECT * FROM usage_logs ORDER BY id DESC LIMIT 10;
SELECT * FROM model_config;
```

### API Testing

```bash
# Create API key
curl -X POST http://localhost:4000/admin/keys \
  -u admin:password \
  -H "Content-Type: application/json" \
  -d '{"name": "test"}'

# Test OpenAI endpoint
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "test-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Test Anthropic endpoint
curl -X POST http://localhost:4000/v1/messages \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "test-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Common Issues

### TypeScript Errors

```bash
# Check for type errors
npm run build
```

### Port Already in Use

Change port in `config.yaml`:
```yaml
server:
  port: 4001  # Different port
```

### Database Migration Issues

```bash
# Re-run migrations
npm run db:migrate

# Or manually reset
rm data/llm_proxy.db
npm run dev  # Will recreate
```

## Integration Testing Best Practices

1. **Use fixtures**: Don't duplicate setup code
2. **Random ports**: Use port 0 to avoid conflicts
3. **Clean teardown**: Always stop servers in `afterEach`
4. **Clear assertions**: Be specific about expected values
5. **Test real flows**: End-to-end, not just unit tests

Example test structure:
```typescript
describe('Feature', () => {
  let fixture: ProxyTestFixture;
  
  beforeEach(async () => {
    fixture = new ProxyTestFixture();
    await fixture.setup();
  });
  
  afterEach(async () => {
    await fixture.teardown();
  });
  
  it('should do something', async () => {
    // Configure mock
    fixture.getMockServer().setResponse({...});
    
    // Make request
    const response = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fixture.getApiKey()}`)
      .send({...});
    
    // Assert
    expect(response.status).toBe(200);
    expect(fixture.getMockServer().getRequests()).toHaveLength(1);
  });
});
```

## Code Style

- TypeScript strict mode
- ESLint configured
- 2-space indentation
- Single quotes for strings
- Async/await over promises
- Early returns over nesting

## Documentation

Keep docs updated:
- `docs/architecture/` - System design
- `docs/api/` - API reference
- `docs/deployment/` - Deployment guides
- `learnings.md` - Lessons learned

When adding features:
1. Update relevant docs
2. Add to learnings.md if there were mistakes/lessons
3. Keep docs in sync with code
