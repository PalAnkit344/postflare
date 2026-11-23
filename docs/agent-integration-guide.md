# External Video Agent Architectural Integration Guide

This guide details how external AI video generation agents, autonomous media pipelines, and programmatic content engines integrate with Postflare to publish videos to Buffer social channels (Instagram Reels, TikTok, YouTube Shorts, Facebook, X, etc.).

---

## 1. Architectural Overview

```
┌─────────────────────────────────┐
│   External AI Video Agent       │
│  (Runway / Sora / Pika / Custom)│
└────────────────┬────────────────┘
                 │ 1. POST /api/v1/agent/posts
                 │    Authorization: Bearer pf_...
                 │    videoUrl: Google Drive or direct MP4 link
                 ▼
┌─────────────────────────────────┐
│   Postflare Ingestion Gateway   │
│  (Cloudflare Workers on Edge)   │
└────────────────┬────────────────┘
                 │ 2. Authenticate & validate Bearer token
                 │ 3. Resolve direct download stream (&confirm=t)
                 │ 4. Stream bytes directly to R2 bucket
                 ▼
┌─────────────────────────────────┐
│     Cloudflare R2 Bucket        │ ◄─── Zero RAM buffer (streams up to 5GB)
│       (Media Storage)           │ ───► Signed public URL generated
└────────────────┬────────────────┘
                 │ 5. Insert posts into D1 database
                 │ 6. Dispatch Cloudflare Workflow (PublishWorkflow)
                 ▼
┌─────────────────────────────────┐
│  Buffer Multi-Account Publisher │
│ (GraphQL + Core REST Fallback)  │
└────────────────┬────────────────┘
                 │ 7. Buffer ingests video from Postflare R2 URL
                 │ 8. Publishes to designated social channels
                 ▼
┌─────────────────────────────────┐
│     Target Social Networks      │
│  Instagram, TikTok, YouTube...  │
└─────────────────────────────────┘
```

### Key Architectural Characteristics
- **Zero-Memory Streaming**: External videos (50MB to 5GB) stream directly into Cloudflare R2 (`c.env.MEDIA.put(key, res.body)`). Worker RAM (128MB ceiling) is never overwhelmed.
- **Automated Google Drive Resolution**: Public Google Drive sharing links (`/view?usp=sharing`, `/open?id=...`, `/uc?id=...`) are parsed and resolved to direct byte streams with virus scan bypass (`&confirm=t`).
- **Buffer Multi-Account Routing**: Up to 50 distinct Buffer accounts can be connected to a Postflare workspace. Posts can target all accounts, specific accounts by `accountTag` (e.g. `client-alpha`), specific channel IDs by `accountId`, or specific social networks by `channelServices` (e.g. `["instagram", "tiktok"]`).
- **Asynchronous Status Polling**: Every submitted post receives a persistent `postId` and Cloudflare Workflow instance. Agents poll `GET /api/v1/agent/posts/:id` to inspect publication status, social platform URLs, and execution logs.

---

## 2. Authentication

External agents authenticate using Postflare Workspace Bearer API keys.

### 2.1 Generating an API Key
1. Sign in to your Postflare dashboard.
2. Navigate to **Settings → API Keys**.
3. Click **Create API Key**, specify a descriptive label (e.g., `ai-video-pipeline`), and copy the generated token.
4. Tokens are formatted with the `pf_` prefix:
   ```
   pf_a1b2c3d4e5f67890abcdef1234567890abcdef12
   ```

### 2.2 Transmitting the API Key
Send the token in the standard HTTP `Authorization` header:
```http
Authorization: Bearer pf_YOUR_API_KEY
```

Requests with missing or invalid tokens receive `401 Unauthorized`:
```json
{
  "error": "Unauthorized"
}
```

---

## 3. Endpoint Reference

### 3.1 Post Submission (`POST /api/v1/agent/posts`)

Creates and schedules a video post across the resolved Buffer social channels.

- **Method**: `POST`
- **Path**: `/api/v1/agent/posts` (alias `/api/incoming/posts`)
- **Headers**:
  ```http
  Authorization: Bearer pf_...
  Content-Type: application/json
  ```

#### Request Schema (JSON)

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | `string` | **Yes** | Post caption text / copy. Supports emojis and hashtags. (Alias: `text`) |
| `videoUrl` | `string` | **Yes** | Direct video URL (MP4/MOV) or public Google Drive file link. (Alias: `video_url`) |
| `accountTag` | `string` | No | Buffer account tag (e.g. `"client-alpha"` or `"#client-alpha"`). Targets all channels under that Buffer account. (Alias: `account_tag`) |
| `accountTags` | `string[]` | No | Array of Buffer account tags to target multiple accounts. (Alias: `account_tags`) |
| `accountId` | `string` | No | Specific Postflare account/channel ID (`"acc_..."`). (Alias: `account_id`) |
| `accountIds` | `string[]` | No | Array of specific account/channel IDs. (Alias: `account_ids`) |
| `channelServices` | `string[]` | No | Filter to specific social platforms, e.g. `["instagram", "tiktok", "youtube"]`. |
| `scheduledAt` | `string\|number` | No | `"now"` (default) for immediate publication, or an ISO-8601 string (e.g. `"2026-11-25T15:30:00Z"`), or epoch milliseconds. |
| `title` | `string` | No | Video title for platforms that support it (YouTube, Facebook). |
| `filename` | `string` | No | Custom filename for storage in R2 (defaults to Google Drive file ID or URL filename). |
| `mediaAlt` | `string` | No | Accessibility alt text for the video asset. |

#### Example Request Body
```json
{
  "content": "Check out this AI-generated architectural flythrough! 🏛️✨ #GenerativeAI #Architecture",
  "videoUrl": "https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J1K2L3M/view?usp=sharing",
  "accountTag": "client-alpha",
  "channelServices": ["instagram", "tiktok"],
  "scheduledAt": "now",
  "title": "Architectural Flythrough Preview",
  "filename": "building_render_v1.mp4"
}
```

#### Response (HTTP 201 Created)
```json
{
  "success": true,
  "postId": "pst_9876543210abcdef",
  "groupId": "grp_1234567890abcdef",
  "status": "scheduled",
  "scheduledAt": 1764084600000,
  "scheduledAtIso": "2026-11-25T15:30:00.000Z",
  "mediaId": "med_a1b2c3d4e5f6",
  "media": {
    "id": "med_a1b2c3d4e5f6",
    "filename": "building_render_v1.mp4",
    "mime": "video/mp4",
    "size": 42189312,
    "url": "https://postflare.example.com/m/med_a1b2c3d4e5f6/sig_abc123/building_render_v1.mp4"
  },
  "accounts": [
    {
      "id": "acc_001",
      "name": "client-alpha (@arch_studio)",
      "provider": "buffer",
      "username": "client-alpha"
    },
    {
      "id": "acc_002",
      "name": "client-alpha (@arch_tok)",
      "provider": "buffer",
      "username": "client-alpha"
    }
  ],
  "posts": [
    {
      "id": "pst_9876543210abcdef",
      "accountId": "acc_001",
      "accountName": "client-alpha (@arch_studio)",
      "provider": "buffer",
      "channelService": "instagram",
      "status": "scheduled",
      "workflowId": "pst_9876543210abcdef-0"
    },
    {
      "id": "pst_abcdef1234567890",
      "accountId": "acc_002",
      "accountName": "client-alpha (@arch_tok)",
      "provider": "buffer",
      "channelService": "tiktok",
      "status": "scheduled",
      "workflowId": "pst_abcdef1234567890-0"
    }
  ]
}
```

---

### 3.2 Status Inspection (`GET /api/v1/agent/posts/:id`)

Polls post execution status, publication confirmation, destination social URLs, and execution logs.

- **Method**: `GET`
- **Path**: `/api/v1/agent/posts/:id`
- **Headers**:
  ```http
  Authorization: Bearer pf_...
  ```

#### Response (HTTP 200 OK)
```json
{
  "id": "pst_9876543210abcdef",
  "status": "published",
  "scheduledAt": 1764084600000,
  "publishedAt": 1764084615000,
  "externalId": "514853c9e6f2132304000099",
  "externalUrl": "https://publish.buffer.com/profile/514853c9e6f2132304000010/tab/sent",
  "error": null,
  "logs": [
    {
      "level": "info",
      "message": "Queued for immediate publishing via External Agent Ingestion API",
      "createdAt": 1764084600000
    },
    {
      "level": "info",
      "message": "Buffer post created: 514853c9e6f2132304000099",
      "createdAt": 1764084610000
    },
    {
      "level": "info",
      "message": "Published successfully",
      "createdAt": 1764084615000
    }
  ]
}
```

#### Post Lifecycle Statuses
- `scheduled`: Queued for publication at `scheduledAt` or executing publication workflow.
- `publishing`: Currently communicating with Buffer and uploading media.
- `published`: Successfully published to the destination social channel. `externalUrl` contains the link.
- `failed`: Publication encountered an error. Check `error` and `logs` for diagnostic details.

---

## 4. Google Drive Integration

Postflare features automated Google Drive resolution designed specifically for automated media generation pipelines.

### 4.1 Required Sharing Permission
The file in Google Drive **must** be set to:
> **General access: Anyone with the link can view**

If the file is restricted to specific users or your organization, Google returns an HTML sign-in page. Postflare detects this and rejects the request with HTTP 400:
```json
{
  "error": "Google Drive file is not publicly accessible. Ensure sharing is set to 'Anyone with the link can view'."
}
```

### 4.2 Supported URL Patterns
Any of the following URL structures are parsed automatically:
- `https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J1K2L3M/view?usp=sharing`
- `https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J1K2L3M/preview`
- `https://drive.google.com/open?id=1A2B3C4D5E6F7G8H9I0J1K2L3M`
- `https://drive.google.com/uc?id=1A2B3C4D5E6F7G8H9I0J1K2L3M&export=download`
- `https://drive.usercontent.google.com/download?id=1A2B3C4D5E6F7G8H9I0J1K2L3M`

*Note*: Google Drive folder links (`/drive/folders/...`) are not valid media files and will be rejected with:
```json
{
  "error": "URL points to a Google Drive folder, but a direct video file link is required"
}
```

### 4.3 Large File Handling (>100MB Virus Interstitial Bypass)
When Google Drive files exceed 100MB, Google displays a warning page: *"Google Drive cannot scan this file for viruses"*. Naive download scripts store the HTML warning page instead of video bytes.

Postflare's resolver appends `&confirm=t` to the download request stream (`https://drive.usercontent.google.com/download?id=...&export=download&confirm=t`), safely bypassing the interstitial and receiving the raw binary stream directly into R2.

---

## 5. Buffer Multi-Account Routing

Postflare connects up to 50 distinct Buffer accounts in a single workspace. Each Buffer account represents an independent brand or client containing multiple social channels (e.g. Instagram, TikTok, YouTube).

### Routing Strategies

1. **Tag-based Routing (Recommended)**:
   Specify `"accountTag": "client-alpha"`. Postflare routes the post to all active channels connected under that Buffer account tag.
2. **Platform Filtering**:
   Combine `"accountTag": "client-alpha"` with `"channelServices": ["instagram", "tiktok"]` to target only specific platforms under that account (skipping Facebook or X).
3. **Explicit Account Selection**:
   Specify `"accountId": "acc_..."` or `"accountIds": ["acc_001", "acc_002"]` to target exact channel accounts.
4. **Broadcast Routing**:
   Omit account selectors to publish across all active Buffer accounts connected to the workspace.

---

## 6. End-to-End Python Example

Here is a production-ready Python script using `requests` that submits an AI-generated video and polls until publication completes:

```python
#!/usr/bin/env python3
import time
import requests

POSTFLARE_BASE = "https://postflare.example.com"
API_KEY = "pf_YOUR_POSTFLARE_API_KEY"

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

payload = {
    "content": "Autonomous drone inspection preview 🚁⚡ #Robotics #DroneTech",
    "videoUrl": "https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J1K2L3M/view?usp=sharing",
    "accountTag": "robotics-brand",
    "channelServices": ["instagram", "tiktok"],
    "scheduledAt": "now",
    "title": "Drone Inspection Demo",
    "filename": "drone_inspection_01.mp4"
}

print("1. Submitting post to Postflare...")
response = requests.post(f"{POSTFLARE_BASE}/api/v1/agent/posts", json=payload, headers=headers)

if response.status_code != 201:
    print(f"❌ Error ({response.status_code}):", response.text)
    exit(1)

result = response.json()
print(f"✅ Ingestion successful! Group ID: {result['groupId']}")
print(f"📁 Stored R2 Media: {result['media']['filename']} ({result['media']['size']} bytes)")

# Monitor each channel post
for post in result["posts"]:
    post_id = post["id"]
    channel = post["channelService"]
    print(f"\nMonitoring {channel} post ({post_id})...")
    
    max_checks = 30
    for attempt in range(max_checks):
        status_res = requests.get(f"{POSTFLARE_BASE}/api/v1/agent/posts/{post_id}", headers=headers)
        if status_res.status_code != 200:
            print("Failed to fetch status:", status_res.text)
            break
            
        data = status_res.json()
        current_status = data["status"]
        print(f"  [{attempt + 1}/{max_checks}] Status: {current_status}")
        
        if current_status == "published":
            print(f"  🎉 Published to {channel}!")
            print(f"  🔗 URL: {data.get('externalUrl')}")
            break
        elif current_status == "failed":
            print(f"  ❌ Publish failed: {data.get('error')}")
            break
            
        time.sleep(10)
```

---

## 7. End-to-End cURL Example

### 7.1 Submit Video Post
```bash
curl -X POST "https://postflare.example.com/api/v1/agent/posts" \
  -H "Authorization: Bearer pf_YOUR_POSTFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Next-gen generative video showcase! 🎬 #AIArt #VFX",
    "videoUrl": "https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J1K2L3M/view?usp=sharing",
    "accountTag": "creative-studio",
    "channelServices": ["instagram", "tiktok"],
    "scheduledAt": "now",
    "filename": "showcase_final.mp4"
  }'
```

### 7.2 Inspect Status & Logs
```bash
curl -X GET "https://postflare.example.com/api/v1/agent/posts/pst_9876543210abcdef" \
  -H "Authorization: Bearer pf_YOUR_POSTFLARE_API_KEY"
```

---

## 8. Common HTTP Error Codes

| Status | Code | Cause & Resolution |
|---|---|---|
| `400` | Bad Request | Missing `content`, missing or invalid `videoUrl`, unknown `accountTag`/`accountId`, or file points to a Google Drive folder. |
| `400` | Google Drive Private | Google Drive file is not set to "Anyone with the link can view". |
| `401` | Unauthorized | Missing or invalid `Authorization: Bearer pf_...` token. Verify key in Settings → API Keys. |
| `403` | Forbidden | API key's user lacks `posts.write` or `posts.read` permission. |
| `404` | Not Found | Requested `postId` does not exist or belongs to another workspace. |
| `413` | Payload Too Large | Remote server sent no `Content-Length` and stream exceeded memory limit. |
