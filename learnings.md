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
