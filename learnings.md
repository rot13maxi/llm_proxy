# Learnings

A running log of what we tried, what broke, and how we fixed it. This document captures the journey of building and improving the LLM Proxy gateway.

## 🔄 Learning Feedback Loop Skill

This project uses a **Learning Feedback Loop** workflow codified in a skill:
- **Skill Location**: `/Users/alex/.agents/skills/learning-feedback-loop/SKILL.md`
- **Purpose**: Repeatable workflow for implementing, testing, learning, and improving
- **Process**: Implement → Test → Fail → Learn → Fix → Verify → Commit → Document

**How to Use:**
1. Before starting work, read this file for relevant patterns
2. When tests fail, document the mistake here before fixing
3. When complete, update docs/ and commit
4. Periodically, extract patterns to update the skill

---

## How to Use This File

- **For Developers**: Read before starting similar work to avoid past mistakes
- **For Agents**: Review related sections before implementing features
- **For Review**: Periodically extract patterns to update agent configs and skills

## Format

```
## [Date] - [Feature/Fix Name]

**Goal**: What we were trying to achieve

**What We Tried**: Initial approach

**What Went Wrong**: Specific failures and symptoms

**Diagnosis**: Root cause analysis

**Solution**: How we fixed it

**Key Takeaways**: Lessons for future work
```

---

## Entries

---

## 2026-03-23 - Per-Key Rate Limiting

**Goal**: Ensure rate limiting works correctly per API key, not globally

**What We Tried**: Initially thought the rate limiter implementation was broken because tests were failing - requests weren't being rate limited after hitting the limit.

**What Went Wrong**: The rate limiter code was actually correct. The problem was in the test fixture - when creating test API keys, we weren't setting `rate_limit_rpm` and `rate_limit_tpm` in the database. Keys were created with NULL values, which fell back to defaults (60 RPM), but our tests expected 5 RPM.

**Diagnosis**: 
- Test fixture's `createTestApiKey()` method only inserted `key_prefix`, `key_hash`, `name`, and `is_active`
- Rate limit columns were NULL
- Rate limiter fell back to default limits (60 RPM) instead of test-configured limits (5 RPM)
- Tests sent 5 requests expecting the 6th to fail, but all passed because limit was actually 60

**Solution**: 
1. Added `keyRateLimitRpm` and `keyRateLimitTpm` fields to `ProxyTestFixture`
2. Updated `createTestApiKey()` to insert these values into the database
3. Added 4 comprehensive rate limiting integration tests

**Key Takeaways**:
- Always verify test fixtures are setting up data correctly, not just the code under test
- Rate limiter implementation was fine - the bug was in test data setup
- Integration tests catch real-world issues that unit tests might miss
- When tests fail, check the full data flow: config → DB → code → response

---

## 2026-03-23 - Admin UI for API Key Management

**Goal**: Build a mobile-responsive web UI for managing API keys (list, create, delete)

**What We Tried**:
1. Created a single HTML file with embedded CSS/JS
2. Served it from the admin route
3. Used existing admin API endpoints

**What Went Wrong**:
1. **Build Issues**: TypeScript compilation failed because:
   - `import.meta.url` not allowed in CommonJS output
   - Tests were included in tsconfig but rootDir was set to ./src
2. **Server Stability**: Development server kept stopping during testing
3. **Path Resolution**: UI file path needed to be resolved correctly for production builds

**Diagnosis**:
- Used `import.meta.url` which doesn't work with CommonJS
- Need to use `resolve(process.cwd(), 'src/ui/index.html')` instead
- Had to exclude tests from tsconfig to avoid rootDir conflicts
- Development server (`tsx watch`) was unstable; needed to use built version

**Solution**:
1. Changed path resolution to use `process.cwd()` and `path.resolve()`
2. Excluded tests from tsconfig (vitest handles TypeScript compilation)
3. Cleaned up compiled .js files from tests directory
4. Built and ran production server for testing

**Key Takeaways**:
- For serving static files in Express, use `path.resolve()` with `process.cwd()`
- Keep tsconfig focused on src/; let test framework handle test files
- Always test the built production code, not just dev mode
- Single-file HTML with embedded CSS/JS works well for simple admin UIs
- Mobile responsiveness requires: viewport meta tag + media queries + flexbox
- **Browser testing matters**: Don't assume the UI works just because the HTML is valid
  - Used Playwright to actually render the UI in a browser
  - Tested both mobile (375x667) and desktop (1280x800) viewports
  - Verified all interactive elements are present and accessible
- **Playwright patterns**:
  - Basic auth requires context-level headers, not page-level
  - Use `getByRole()` for stable selectors instead of text matchers
  - Server fixtures need proper lifecycle management
  - ES module config (`"type": "module"`) required for modern tooling

---

## 2026-03-23 - Playwright E2E Regression Tests

**Goal**: Add automated browser regression tests for the admin UI using Playwright

**What We Tried:**
1. Created 20 e2e tests covering mobile, desktop, auth, and interactive elements
2. Used Playwright fixtures for server lifecycle management
3. Configured ES modules throughout the project

**What Went Wrong:**
1. **Module conflicts**: Adding `"type": "module"` broke CommonJS build output
   - Fix: Updated tsconfig to output ES modules (`"module": "ES2022"`)
2. **Playwright lifecycle hooks**: `afterAll`/`beforeAll` don't exist in Playwright
   - Fix: Used `test.extend` with fixtures for server management
3. **Strict mode violations**: Multiple elements matched text selectors
   - Fix: Used `getByRole('button', { name: '...' })` for unique selectors
4. **Wrong element selectors**: Inputs use IDs, not names
   - Fix: Updated selectors to use `#key-name` instead of `input[name="name"]`
5. **Wrong Playwright API**: `page.status()` doesn't exist
   - Fix: Used `response?.status()` from `page.goto()`

**Diagnosis:**
- Read Playwright docs for proper fixture pattern
- Checked HTML structure to find correct selectors
- Used error messages to identify API mismatches

**Solution:**
1. Updated tsconfig for ES modules
2. Used test fixtures for server lifecycle
3. Used role-based selectors for stability
4. Fixed all selector mismatches

**Key Takeaways:**
- Playwright uses fixtures, not jest-style lifecycle hooks
- Role-based selectors (`getByRole`) are more stable than text matchers
- ES modules require consistent config across tsconfig and package.json
- Always verify selectors match actual HTML structure
- E2E tests catch real browser issues that API tests miss
