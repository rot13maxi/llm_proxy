# Learnings

A running log of what we tried, what broke, and how we fixed it. This document captures the journey of building and improving the LLM Proxy gateway.

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
