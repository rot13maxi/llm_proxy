# API Keys UI

The LLM Proxy includes a mobile-responsive web UI for managing API keys.

## Access

Navigate to: `http://localhost:4000/admin`

**Authentication Required**: Basic Auth or Admin API Key (configured in `config.yaml`)

```bash
# Example
curl -u admin:password http://localhost:4000/admin
```

## Features

### View API Keys

See all your API keys with:
- Name and status (active/inactive)
- Creation date and expiration
- Usage statistics (last 7 days)
  - Request count
  - Token count
  - Cost

### Create API Key

Click "Create Key" to generate a new API key:
- **Name**: Required, descriptive label (e.g., "Production App")
- **Expiration**: Optional, auto-revocation date
- **Rate Limit (RPM)**: Requests per minute (default: 60)
- **Token Limit (TPM)**: Tokens per minute (default: 100,000)

⚠️ **Important**: The full API key is only shown once during creation. Save it securely!

### Show API Key

Click "👁️ Show Key" to view an existing key's value.

### Delete API Key

Click "🗑️ Delete" to permanently revoke an API key.

## Mobile Responsive

The UI is fully responsive and works on:
- Desktop browsers
- Tablets
- Mobile phones

### Mobile Features

- Full-width buttons for easy tapping
- Stacked layout on small screens
- Touch-friendly modals
- Readable text sizes

## API Endpoints

The UI uses these REST endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/keys` | List all keys with usage |
| POST | `/admin/keys` | Create new key |
| DELETE | `/admin/keys/:id` | Delete key |

### Example: Create Key via API

```bash
curl -X POST http://localhost:4000/admin/keys \
  -u admin:password \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My App",
    "rateLimitRpm": 100,
    "rateLimitTpm": 200000
  }'
```

Response:
```json
{
  "id": 1,
  "key": "sk-96acfe3e-5890-4f9b-8ae2-06ecc6fefd6b",
  "name": "My App",
  "created_at": "2026-03-23T..."
}
```

## Screenshots

### Desktop View

```
┌─────────────────────────────────────────────────────┐
│ 🔑 API Keys                                        │
├─────────────────────────────────────────────────────┤
│ Your API Keys                          [+ Create]  │
├─────────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────────┐  │
│ │ My App                    [✓ Active]          │  │
│ │ Created: 2026-03-23                          │  │
│ │ Expires: Never                                │  │
│ │ Requests (7d): 150    Cost (7d): $0.125      │  │
│ │ [👁️ Show Key] [🗑️ Delete]                    │  │
│ └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Mobile View

```
┌───────────────────────┐
│ 🔑 API Keys           │
├───────────────────────┤
│ Your API Keys         │
│ [+ Create Key]        │
├───────────────────────┤
│ My App                │
│ [✓ Active]            │
│ Created: 2026-03-23   │
│ Expires: Never        │
│ Requests: 150         │
│ Cost: $0.125          │
│ [👁️ Show Key]         │
│ [🗑️ Delete]           │
└───────────────────────┘
```

## Customization

The UI is a single HTML file with embedded CSS/JS:
- `src/ui/index.html`

To customize:
1. Edit the HTML file
2. Update styles in the `<style>` block
3. Modify JavaScript in the `<script>` block
4. Restart the server

## Security

- Requires admin authentication
- API keys are never stored in plain text
- Full key only shown during creation
- HTTPS recommended for production
