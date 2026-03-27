# Integration Tests

This directory contains integration tests for the LLM Proxy gateway. These tests provide a self-correcting feedback loop for validating fixes and new features.

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Mock Upstream  │◀───│  LLM Proxy      │◀───│  Test Client    │
│  Server         │    │  (Real Server)  │    │  (supertest)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
       ▲                      │                      │
       │                      ▼                      │
       │              ┌─────────────────┐           │
       └──────────────│  SQLite DB      │───────────┘
                      │  (in-memory)    │
                      └─────────────────┘
```

## Test Files

| File | Purpose |
|------|---------|
| `proxy.test.ts` | Core proxy functionality (routing, forwarding, usage logging) |
| `auth.test.ts` | API key authentication |
| `fixtures/mock-upstream.ts` | Mock upstream server for testing |
| `fixtures/proxy-fixture.ts` | Test fixture for setup/teardown |

## Running Tests

```bash
# Run all integration tests
npm run test:integration

# Run specific test file
npm run test:integration -- proxy.test.ts

# Run specific test
npm run test:integration -- -t "should proxy request"

# Watch mode for development
npm run test:integration:watch
```

## Agent Workflow

When implementing a fix or feature:

1. **Make your changes** to the source code
2. **Run the relevant tests**:
   ```bash
   npm run test:integration -- proxy.test.ts
   ```
3. **Check the output**:
   - ✅ All tests pass → Fix is complete
   - ❌ Tests fail → Read the failure message and fix the issue
4. **Iterate** until all tests pass

## Example Test Output

### Success
```
✓ tests/integration/proxy.test.ts (8 tests) 807ms
  ✓ should proxy request to upstream and return response
  ✓ should forward request to correct upstream URL
  ✓ should log usage to database after request
  ...

Test Files  2 passed (2)
Tests  14 passed (14)
```

### Failure
```
✗ tests/integration/proxy.test.ts > should enforce rate limit
  Expected: 429, Got: 200
  at proxy.test.ts:45
```

## Adding New Tests

1. Create a new test file in `tests/integration/`
2. Import the fixture:
   ```typescript
   import { ProxyTestFixture } from './fixtures/proxy-fixture.js';
   ```
3. Use the fixture in your tests:
   ```typescript
   describe('My Feature', () => {
     let fixture: ProxyTestFixture;
     
     beforeEach(async () => {
       fixture = new ProxyTestFixture();
       await fixture.setup();
     });
     
     afterEach(async () => {
       await fixture.teardown();
     });
     
     it('should do something', async () => {
       // Configure mock upstream
       fixture.getMockServer().setResponse({
         status: 200,
         body: { choices: [...], usage: {...} }
       });
       
       // Make request through proxy
       const response = await request(fixture.getProxyUrl())
         .post('/v1/chat/completions')
         .set('Authorization', `Bearer ${fixture.getApiKey()}`)
         .send({ model: 'test-model', messages: [...] });
       
       // Validate response
       expect(response.status).toBe(200);
       
       // Validate mock received request
       expect(fixture.getMockServer().getRequests()).toHaveLength(1);
     });
   });
   ```

## Fixture API

| Method | Description |
|--------|-------------|
| `setup()` | Start mock server, proxy server, create API key |
| `teardown()` | Stop servers, clean up |
| `getProxyUrl()` | Get proxy server URL |
| `getApiKey()` | Get test API key |
| `getMockServer()` | Get mock upstream server |
| `getDbPath()` | Get SQLite database path |
| `getMetricsUrl()` | Get metrics endpoint URL |

## Mock Server API

| Method | Description |
|--------|-------------|
| `setResponse(config)` | Set response for all requests |
| `setStreamingResponse(chunks)` | Set streaming response |
| `getRequests()` | Get all received requests |
| `clearRequests()` | Clear request history |
| `getPort()` | Get mock server port |
