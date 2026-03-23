# Current Best Practices

*Last updated: 2026-03-23 (batch review)*
*Next review: 2026-03-30 or after 5 new learnings*

This document captures the current best practices for the LLM Proxy project, distilled from learnings.md through batch review.

---

## Testing

### Integration Tests
- ✅ **Always set fixture data completely** - Don't forget rate_limit_rpm/tpm when creating API keys
- ✅ **Use random ports** - Avoid conflicts between parallel tests
- ✅ **Use in-memory SQLite** - Fast, isolated, no cleanup needed
- ✅ **Tests must fail loudly** - Clear assertions, not silent passes
- ✅ **Tests must be deterministic** - No random data, predictable outcomes

### E2E/Browser Tests
- ✅ **Use context-level headers for auth** - Not page-level (Playwright pattern)
- ✅ **Use getByRole() for selectors** - More stable than text matchers
- ✅ **Test actual browser rendering** - Don't assume HTML validity = working UI
- ✅ **Test both mobile and desktop** - 375x667 (iPhone SE) and 1280x800
- ✅ **Capture screenshots on failure** - Debugging aid

### Test Order
1. Run `npm run build` first (catch build issues)
2. Run `npm run test:integration` (API tests)
3. Run `npm run test:e2e` (browser tests, if UI changed)

---

## Build & Configuration

### TypeScript
- ✅ **Use ES2022 modules consistently** - Set `"module": "ES2022"` in tsconfig
- ✅ **Exclude tests from tsconfig** - Let vitest/playwright handle them
- ✅ **rootDir should be ./src** - Don't include tests in rootDir
- ✅ **Avoid import.meta.url in CommonJS** - Use `path.resolve(process.cwd(), ...)` instead

### Package.json
- ✅ **Set `"type": "module"`** - For ES module support
- ✅ **Keep devDependencies organized** - Group testing tools together

### Path Resolution
- ✅ **Use `path.resolve(process.cwd(), ...)`** - For production builds
- ✅ **Don't use `__dirname`** - Not available in ES modules
- ✅ **Test production build** - `npm run build` then `npm start`

---

## UI Development

### Responsive Design
- ✅ **Include viewport meta tag** - `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
- ✅ **Use CSS media queries** - `@media (max-width: 640px)` for mobile
- ✅ **Test in actual browser** - Not just HTML validation
- ✅ **Mobile-first buttons** - Full width on small screens

### File Serving
- ✅ **Serve HTML based on Accept header** - JSON for API clients, HTML for browsers
- ✅ **Use single HTML file** - Embedded CSS/JS for simple admin UIs
- ✅ **Test with curl** - `curl -u admin:pass http://localhost:4000/admin`

---

## Authentication

### Basic Auth
- ✅ **Context-level in Playwright** - `context.setExtraHTTPHeaders({ Authorization: ... })`
- ✅ **Always test unauthorized** - Verify 401 responses
- ✅ **Document credentials** - In docs, not code

### Admin Routes
- ✅ **Protect with middleware** - `adminAuthMiddleware` for /admin/*
- ✅ **Keep API endpoints functional** - Don't break existing APIs when adding UI

---

## Debugging Patterns

### When Tests Fail
1. Check test fixture data setup first
2. Verify full data flow: config → DB → code → response
3. Add debug logging to see actual values
4. Check build output, not just source

### When Build Fails
1. Check module consistency (ES vs CommonJS)
2. Verify tsconfig rootDir and include patterns
3. Look for import.meta usage in CommonJS context
4. Clean dist/ and rebuild

### When Browser Shows 401
1. Check Accept header (text/html vs application/json)
2. Verify basic auth encoding (Buffer.from(...).toString('base64'))
3. Use context-level, not page-level headers
4. Check credentials match config.yaml

---

## Documentation

### Keep Current
- ✅ **Update docs/ with each feature** - Don't let docs drift
- ✅ **Add to learnings.md before fixing** - Document mistakes first
- ✅ **Update best-practices.md in batches** - Weekly or every 5 learnings

### Structure
- `docs/architecture/` - System design and components
- `docs/api/` - API reference and endpoints
- `docs/deployment/` - Docker, production setup
- `docs/development/` - Testing, contributing, tools
- `docs/ui/` - UI documentation and guides

---

## Learning Feedback Loop

### Priority Triage
- **#critical**: >15 min pain, blocker, >2 reworks, or agent/human disagreement
  - Action: Complete COE post-mortem with 5 Whys
  - Update skills/configs immediately
  
- **#normal**: Moderate issues (5-15 min)
  - Action: Add to batch queue
  - Process in next review
  
- **#minor**: Quick fixes (<5 min)
  - Action: Just document
  - Review in batch if patterns emerge

### Batch Processing
- **Trigger**: 5 learnings OR 7 days since last review
- **Action**: Find patterns, update skills, update best-practices.md
- **Document**: Add batch summary to learnings.md

---

## Common Pitfalls

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| Tests fail, code looks correct | Test fixture data incomplete | Check fixture setup, not code |
| Build errors after adding "type": "module" | tsconfig still outputs CommonJS | Set `"module": "ES2022"` |
| Playwright auth fails | Using page-level headers | Use `context.setExtraHTTPHeaders()` |
| File not found in production | Using `__dirname` | Use `path.resolve(process.cwd(), ...)` |
| Multiple elements match selector | Using text matchers | Use `getByRole()` |
| Browser 401, API works | Wrong Accept header | Set `Accept: text/html` |

---

## Tools & Commands

```bash
# Test suite
npm run test:integration    # Integration tests
npm run test:e2e           # E2E browser tests
npm run test               # All tests

# Build & run
npm run build              # TypeScript compile
npm start                  # Production server
npm run dev                # Development with hot reload

# Debugging
grep "#keyword" learnings.md   # Search learnings
cat docs/best-practices.md     # Current best practices
```

---

## Related Documentation

- [Learning Feedback Loop Skill](../../../.agents/skills/learning-feedback-loop/SKILL.md)
- [Learnings Log](../learnings.md)
- [E2E Testing Guide](development/e2e-testing.md)
- [UI Documentation](ui/api-keys.md)

---

*This document is updated through batch processing of learnings.md. See "Learning Feedback Loop" section for process details.*
