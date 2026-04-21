# E2E Testing with Playwright

End-to-end (E2E) tests verify the application works correctly in a real browser environment.

## Overview

We use **Playwright** for E2E testing:
- Tests run against the production build
- Covers mobile and desktop viewports
- Validates authentication, UI rendering, and interactive elements
- Captures screenshots on failure for debugging

## Running Tests

```bash
# Run all E2E tests
npm run test:e2e

# Run in headed mode (see browser)
npm run test:e2e:headed

# Run with UI inspector
npm run test:e2e:ui
```

## Test Structure

```
tests/e2e/
└── ui-regression.test.ts    # Admin UI regression tests
```

### Test Coverage

**Mobile Viewport (375x667 - iPhone SE):**
- Page title and headers
- Create Key button
- Keys list section
- Mobile-responsive buttons (full width)
- Create Key modal
- Screenshots

**Desktop Viewport (1280x800):**
- Page title and headers
- Create Key button
- Keys list section
- Desktop layout (buttons not full width)
- Action buttons (Show Key, Delete)
- Screenshots

**Authentication:**
- Rejects unauthorized requests (401)
- Accepts valid basic auth

**Interactive Elements:**
- Correct number of buttons
- Modal form elements
- Responsive CSS media queries

## Test Fixtures

Tests use Playwright fixtures for server lifecycle management:

```typescript
const test = base.extend<{ server: any }>({
  server: [
    async ({}, use) => {
      // Start server before tests
      const server = spawn('npm', ['start'], ...);
      
      // Wait for server ready
      await waitForServer();
      
      // Use the server
      await use(server);
      
      // Cleanup: stop server after tests
      server.kill();
    },
    { auto: true }
  ]
});
```

## Playwright Patterns

### Basic Auth

Use context-level headers (not page-level):

```typescript
await context.setExtraHTTPHeaders({
  'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
  'Accept': 'text/html'
});
```

### Stable Selectors

Prefer role-based selectors over text matchers:

```typescript
// ❌ Avoid (can match multiple elements)
page.locator('button:has-text("Create Key")')

// ✅ Use (stable, accessible)
page.getByRole('button', { name: '➕ Create Key' })
```

### Server Communication

Check response status from `goto()`:

```typescript
// ❌ Wrong (page.status() doesn't exist)
const status = await page.status();

// ✅ Correct
const response = await page.goto(url);
expect(response?.status()).toBe(401);
```

## Configuration

### playwright.config.ts

```typescript
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,  // Sequential to avoid port conflicts
  workers: 1,             // Single worker
  use: {
    baseURL: 'http://localhost:4000',
    screenshot: 'only-on-failure'
  }
});
```

### ES Modules

Project uses ES modules throughout:

```json
{
  "type": "module"
}
```

```typescript
{
  "compilerOptions": {
    "module": "ES2022",
    "moduleResolution": "bundler"
  }
}
```

## Troubleshooting

### "exports is not defined"

**Symptom:** Build output uses CommonJS but package.json says ES module

**Fix:** Update tsconfig to output ES modules:
```json
{
  "module": "ES2022",
  "moduleResolution": "bundler"
}
```

### "strict mode violation"

**Symptom:** Locator matches multiple elements

**Fix:** Use more specific selectors:
```typescript
// Instead of:
page.locator('button:has-text("Create Key")')

// Use:
page.getByRole('button', { name: '➕ Create Key' })
```

### "element(s) not found"

**Symptom:** Selector doesn't match HTML

**Fix:** Check actual HTML structure:
```bash
curl http://localhost:4000/admin | grep -A5 "input"
```

## Screenshots

Test failures automatically capture screenshots:
- Location: `test-results/`
- Format: PNG
- Full page capture

Manual screenshots:
```typescript
await page.screenshot({ 
  path: 'test-results/screenshot.png',
  fullPage: true 
});
```

## CI/CD Integration

Add to your CI pipeline:

```yaml
- name: Install dependencies
  run: npm ci

- name: Build
  run: npm run build

- name: Install Playwright browsers
  run: npx playwright install chromium

- name: Run E2E tests
  run: npm run test:e2e
```

## Related

- [UI Documentation](../ui/api-keys.md)
- [Integration Testing](../../tests/integration/README.md)
- [Learning Feedback Loop](../../../.agents/skills/learning-feedback-loop/SKILL.md)
