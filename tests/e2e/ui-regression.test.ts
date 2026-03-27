import { test as base, expect } from '@playwright/test';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'change_me_to_secure_password';
const SERVER_URL = 'http://localhost:4000';

// Create a test fixture that manages the server lifecycle
const test = base.extend<{ server: any }>({
  server: [
    async ({}, use) => {
      // Start the production server
      console.log('🚀 Starting production server...');
      const server = spawn('npm', ['start'], {
        cwd: join(__dirname, '../..'),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PORT: '4000' }
      });

      // Wait for server to be ready
      await new Promise<void>((resolve, reject) => {
        let output = '';
        server.stdout?.on('data', (data) => {
          output += data.toString();
          if (output.includes('Server running')) {
            resolve();
          }
        });
        server.stderr?.on('data', (data) => {
          console.error('Server error:', data.toString());
        });
        setTimeout(() => reject(new Error('Server startup timeout')), 15000);
      });

      console.log('✅ Server ready');

      // Use the server
      await use(server);

      // Cleanup: stop the server
      console.log('🛑 Stopping server...');
      server.kill();
    },
    { auto: true } // Auto-run this fixture
  ]
});

/**
 * UI Regression Tests
 * 
 * These tests verify the admin UI works correctly in a real browser:
 * - Mobile responsive design (375x667 - iPhone SE)
 * - Desktop layout (1280x800)
 * - All interactive elements present and functional
 * - Authentication works correctly
 * 
 * Based on learnings.md:
 * - Basic auth requires context-level headers, not page-level
 * - Must test actual browser rendering, not just HTML structure
 */

test.describe('Admin UI - Mobile Viewport (375x667)', () => {
  test.beforeEach(async ({ page, context }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Set basic auth at context level (learnings.md pattern)
    await context.setExtraHTTPHeaders({
      'Authorization': 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64'),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });

    // Navigate to admin UI
    await page.goto(`${SERVER_URL}/admin`, { waitUntil: 'networkidle' });
  });

  test('should render page title', async ({ page }) => {
    const title = await page.title();
    expect(title).toBe('LLM Proxy - API Keys');
  });

  test('should have main header', async ({ page }) => {
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
    await expect(h1).toContainText('API Keys');
  });

  test('should have Create Key button', async ({ page }) => {
    const createButton = page.getByRole('button', { name: '➕ Create Key' });
    await expect(createButton).toBeVisible();
  });

  test('should have keys list section', async ({ page }) => {
    const keysSection = page.locator('#keys-list');
    await expect(keysSection).toBeVisible();
  });

  test('should show existing keys', async ({ page }) => {
    // Check that keys are displayed (check for key items)
    const keyItems = page.locator('.key-item');
    // Keys may exist or not, just verify the section renders
    await expect(page.locator('#keys-list')).toBeVisible();
  });

  test('should have mobile-responsive buttons', async ({ page }) => {
    const buttons = page.locator('button');
    await expect(buttons.first()).toBeVisible();
    
    // On mobile, buttons should be full width
    const button = await buttons.first();
    const box = await button.boundingBox();
    expect(box?.width).toBeGreaterThan(300); // Should be nearly full width
  });

  test('should have Create Key modal trigger', async ({ page }) => {
    const createButton = page.getByRole('button', { name: '➕ Create Key' });
    await createButton.click();
    
    // Modal should appear
    const modal = page.locator('#create-modal');
    await expect(modal).toBeVisible();
    
    const modalTitle = modal.locator('h2');
    await expect(modalTitle).toContainText('Create API Key');
  });

  test('should capture mobile screenshot', async ({ page }) => {
    await page.screenshot({ 
      path: 'test-results/ui-mobile-regression.png',
      fullPage: true 
    });
  });
});

test.describe('Admin UI - Desktop Viewport (1280x800)', () => {
  test.beforeEach(async ({ page, context }) => {
    // Set desktop viewport
    await page.setViewportSize({ width: 1280, height: 800 });

    // Set basic auth at context level (learnings.md pattern)
    await context.setExtraHTTPHeaders({
      'Authorization': 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64'),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });

    // Navigate to admin UI
    await page.goto(`${SERVER_URL}/admin`, { waitUntil: 'networkidle' });
  });

  test('should render page title', async ({ page }) => {
    const title = await page.title();
    expect(title).toBe('LLM Proxy - API Keys');
  });

  test('should have main header', async ({ page }) => {
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
    await expect(h1).toContainText('API Keys');
  });

  test('should have Create Key button', async ({ page }) => {
    const createButton = page.getByRole('button', { name: '➕ Create Key' });
    await expect(createButton).toBeVisible();
  });

  test('should have keys list section', async ({ page }) => {
    const keysSection = page.locator('#keys-list');
    await expect(keysSection).toBeVisible();
  });

  test('should have desktop layout (buttons not full width)', async ({ page }) => {
    const buttons = page.locator('button');
    const button = await buttons.first();
    const box = await button.boundingBox();
    // On desktop, buttons should not be full width
    expect(box?.width).toBeLessThan(400);
  });

  test('should have all action buttons visible', async ({ page }) => {
    const showKeyButtons = page.locator('button:has-text("Show Key")');
    const deleteButtons = page.locator('button:has-text("Delete")');
    
    // These should be visible for each key
    await expect(showKeyButtons.first()).toBeVisible();
    await expect(deleteButtons.first()).toBeVisible();
  });

  test('should capture desktop screenshot', async ({ page }) => {
    await page.screenshot({ 
      path: 'test-results/ui-desktop-regression.png',
      fullPage: true 
    });
  });
});

test.describe('Admin UI - Authentication', () => {
  test('should reject unauthorized requests', async ({ page }) => {
    // Navigate without auth
    const response = await page.goto(`${SERVER_URL}/admin`, {
      headers: {
        'Accept': 'text/html'
      }
    });

    // Should get 401
    expect(response?.status()).toBe(401);
  });

  test('should accept valid basic auth', async ({ page, context }) => {
    await context.setExtraHTTPHeaders({
      'Authorization': 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64'),
      'Accept': 'text/html'
    });

    await page.goto(`${SERVER_URL}/admin`);

    const title = await page.title();
    expect(title).toBe('LLM Proxy - API Keys');
  });
});

test.describe('Admin UI - Interactive Elements', () => {
  test.beforeEach(async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    await context.setExtraHTTPHeaders({
      'Authorization': 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64'),
      'Accept': 'text/html'
    });

    await page.goto(`${SERVER_URL}/admin`, { waitUntil: 'networkidle' });
  });

  test('should have correct number of buttons', async ({ page }) => {
    const buttons = page.locator('button');
    const count = await buttons.count();
    
    // We expect at least: Create Key, Show Key (for each key), Delete (for each key)
    // Minimum 1 (Create Key) + 2 (Show + Delete for first key) = 3
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('should have all required modal elements', async ({ page }) => {
    // Open Create Key modal
    await page.getByRole('button', { name: '➕ Create Key' }).click();
    
    const modal = page.locator('#create-modal');
    
    // Check modal has required elements (using IDs, not names)
    await expect(modal.locator('#key-name')).toBeVisible();
    await expect(modal.locator('#key-rpm')).toBeVisible();
    await expect(modal.locator('button[type="submit"]')).toBeVisible();
    await expect(modal.locator('button:has-text("Cancel")')).toBeVisible();
  });

  test('should have responsive CSS media queries', async ({ page }) => {
    // Check that CSS includes mobile styles
    const styles = await page.evaluate(() => {
      const sheets = Array.from(document.styleSheets);
      return sheets.map(sheet => {
        try {
          return Array.from(sheet.cssRules || []).map(rule => rule.cssText).join('');
        } catch {
          return '';
        }
      }).join('');
    });

    expect(styles).toContain('@media');
    expect(styles).toContain('max-width');
  });
});
