import { test, expect } from '@playwright/test';

const AUTH = {
  username: 'admin',
  password: 'change_me_to_secure_password'
};

test.describe('Dashboard - Desktop', () => {
  test.use({
    viewport: { width: 1280, height: 800 }
  });

  test('should load the dashboard on desktop', async ({ page }) => {
    await page.goto('http://localhost:4000/admin', {
      username: AUTH.username,
      password: AUTH.password
    });
    
    // Check page title
    await expect(page).toHaveTitle('LLM Proxy Dashboard');
    
    // Check navigation
    await expect(page.locator('.nav-link')).toHaveCount(3);
    await expect(page.locator('.nav-link').nth(0)).toHaveText('API Keys');
    await expect(page.locator('.nav-link').nth(1)).toHaveText('Live Logs');
    await expect(page.locator('.nav-link').nth(2)).toHaveText('Metrics');
    
    // Check API Keys page is active
    await expect(page.locator('#page-keys')).toHaveClass(/active/);
    await expect(page.locator('.page-title')).toHaveText('API Keys');
  });

  test('should navigate to Live Logs page', async ({ page }) => {
    await page.goto('http://localhost:4000/admin', {
      username: AUTH.username,
      password: AUTH.password
    });
    
    // Click on Live Logs
    await page.click('.nav-link[data-page="logs"]');
    
    // Verify page changed
    await expect(page.locator('#page-logs')).toHaveClass(/active/);
    await expect(page.locator('.page-title')).toHaveText('Live Logs');
    
    // Check filters exist
    await expect(page.locator('#logs-key-filter')).toBeVisible();
    await expect(page.locator('#logs-model-filter')).toBeVisible();
  });

  test('should navigate to Metrics page', async ({ page }) => {
    await page.goto('http://localhost:4000/admin', {
      username: AUTH.username,
      password: AUTH.password
    });
    
    // Click on Metrics
    await page.click('.nav-link[data-page="metrics"]');
    
    // Verify page changed
    await expect(page.locator('#page-metrics')).toHaveClass(/active/);
    await expect(page.locator('.page-title')).toHaveText('Metrics');
    
    // Check time range buttons
    await expect(page.locator('.time-range-btn')).toHaveCount(4);
    
    // Check charts exist
    await expect(page.locator('#requests-chart')).toBeVisible();
    await expect(page.locator('#tokens-chart')).toBeVisible();
    await expect(page.locator('#cost-chart')).toBeVisible();
    await expect(page.locator('#model-chart')).toBeVisible();
  });

  test('should create an API key', async ({ page }) => {
    await page.goto('http://localhost:4000/admin', {
      username: AUTH.username,
      password: AUTH.password
    });
    
    // Click create button
    await page.click('button:has-text("Create Key")');
    
    // Fill form
    await page.fill('#key-name', 'Test Key E2E');
    await page.fill('#key-rpm', '100');
    await page.fill('#key-tpm', '200000');
    
    // Submit
    await page.click('button[type="submit"]');
    
    // Check that key was shown
    await expect(page.locator('#show-key-modal')).toHaveClass(/active/);
    
    // Close modal
    await page.click('#show-key-modal .btn-primary');
    
    // Key should appear in list
    await expect(page.locator('.key-name')).toContainText('Test Key E2E');
  });

  test('should show connection status indicator', async ({ page }) => {
    await page.goto('http://localhost:4000/admin', {
      username: AUTH.username,
      password: AUTH.password
    });
    
    // Check connection status element exists
    await expect(page.locator('#connection-status')).toBeVisible();
  });
});

test.describe('Dashboard - Mobile', () => {
  test.use({
    viewport: { width: 375, height: 667 }
  });

  test('should load the dashboard on mobile', async ({ page }) => {
    await page.goto('http://localhost:4000/admin', {
      username: AUTH.username,
      password: AUTH.password
    });
    
    // Check page title
    await expect(page).toHaveTitle('LLM Proxy Dashboard');
    
    // Check navigation is responsive
    await expect(page.locator('.nav-brand')).toBeVisible();
    await expect(page.locator('.nav-links')).toBeVisible();
    
    // Check API Keys page
    await expect(page.locator('#page-keys')).toHaveClass(/active/);
  });

  test('should navigate to Live Logs page on mobile', async ({ page }) => {
    await page.goto('http://localhost:4000/admin', {
      username: AUTH.username,
      password: AUTH.password
    });
    
    // Click on Live Logs
    await page.click('.nav-link[data-page="logs"]');
    
    // Verify page changed
    await expect(page.locator('#page-logs')).toHaveClass(/active/);
    await expect(page.locator('.page-title')).toHaveText('Live Logs');
    
    // Check filters are visible on mobile
    await expect(page.locator('#logs-key-filter')).toBeVisible();
    await expect(page.locator('#logs-model-filter')).toBeVisible();
  });

  test('should navigate to Metrics page on mobile', async ({ page }) => {
    await page.goto('http://localhost:4000/admin', {
      username: AUTH.username,
      password: AUTH.password
    });
    
    // Click on Metrics
    await page.click('.nav-link[data-page="metrics"]');
    
    // Verify page changed
    await expect(page.locator('#page-metrics')).toHaveClass(/active/);
    await expect(page.locator('.page-title')).toHaveText('Metrics');
    
    // Check time range buttons are visible
    await expect(page.locator('.time-range-btn')).toHaveCount(4);
    
    // Check charts exist (they should be responsive)
    await expect(page.locator('#requests-chart')).toBeVisible();
    await expect(page.locator('#tokens-chart')).toBeVisible();
  });

  test('should create an API key on mobile', async ({ page }) => {
    await page.goto('http://localhost:4000/admin', {
      username: AUTH.username,
      password: AUTH.password
    });
    
    // Click create button (may be full width on mobile)
    const createBtn = page.locator('button').filter({ hasText: 'Create Key' }).first();
    await createBtn.click();
    
    // Fill form
    await page.fill('#key-name', 'Mobile Test Key');
    await page.fill('#key-rpm', '50');
    
    // Submit
    await page.click('button[type="submit"]');
    
    // Check that key was shown
    await expect(page.locator('#show-key-modal')).toHaveClass(/active/);
    
    // Close modal
    await page.click('#show-key-modal .btn-primary');
    
    // Key should appear in list
    await expect(page.locator('.key-name')).toContainText('Mobile Test Key');
  });

  test('should show responsive tables on mobile', async ({ page }) => {
    await page.goto('http://localhost:4000/admin', {
      username: AUTH.username,
      password: AUTH.password
    });
    
    // Navigate to Live Logs
    await page.click('.nav-link[data-page="logs"]');
    
    // Check table container exists
    await expect(page.locator('.table-container')).toBeVisible();
    
    // Check table has correct headers
    const headers = page.locator('th');
    await expect(headers.nth(0)).toContainText('Timestamp');
    await expect(headers.nth(1)).toContainText('API Key');
    await expect(headers.nth(2)).toContainText('Model');
  });

  test('should show stats cards on mobile', async ({ page }) => {
    await page.goto('http://localhost:4000/admin', {
      username: AUTH.username,
      password: AUTH.password
    });
    
    // Navigate to Metrics
    await page.click('.nav-link[data-page="metrics"]');
    
    // Wait for stats to load
    await page.waitForSelector('#metrics-stats', { timeout: 5000 });
    
    // Check stats grid exists
    await expect(page.locator('#metrics-stats')).toBeVisible();
  });
});

test.describe('Dashboard - API Tests', () => {
  test('should get API keys list', async ({ request }) => {
    const response = await request.get('http://localhost:4000/admin/keys', {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${AUTH.username}:${AUTH.password}`).toString('base64')
      }
    });
    
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.keys).toBeDefined();
    expect(Array.isArray(data.keys)).toBeTruthy();
  });

  test('should create API key via API', async ({ request }) => {
    const response = await request.post('http://localhost:4000/admin/keys', {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${AUTH.username}:${AUTH.password}`).toString('base64'),
        'Content-Type': 'application/json'
      },
      data: {
        name: 'API Test Key',
        rateLimitRpm: 60,
        rateLimitTpm: 100000
      }
    });
    
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.key).toBeDefined();
    expect(data.name).toBe('API Test Key');
  });

  test('should get metrics data', async ({ request }) => {
    const response = await request.get('http://localhost:4000/admin/metrics?days=7', {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${AUTH.username}:${AUTH.password}`).toString('base64')
      }
    });
    
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.summary).toBeDefined();
    expect(data.summary.totalRequests).toBeDefined();
    expect(data.byModel).toBeDefined();
    expect(data.dailyStats).toBeDefined();
  });

  test('should get filters data', async ({ request }) => {
    const [keysResponse, modelsResponse] = await Promise.all([
      request.get('http://localhost:4000/admin/filters/api-keys', {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${AUTH.username}:${AUTH.password}`).toString('base64')
        }
      }),
      request.get('http://localhost:4000/admin/filters/models', {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${AUTH.username}:${AUTH.password}`).toString('base64')
        }
      })
    ]);
    
    expect(keysResponse.ok()).toBeTruthy();
    expect(modelsResponse.ok()).toBeTruthy();
    
    const keysData = await keysResponse.json();
    const modelsData = await modelsResponse.json();
    
    expect(keysData.keys).toBeDefined();
    expect(modelsData.models).toBeDefined();
  });
});
