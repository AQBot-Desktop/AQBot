# AQBot Storage Policy

## Dual-Root Directory Model

AQBot uses two directory roots with distinct responsibilities:

| Root | Platform path | Purpose |
|------|---------------|---------|
| **Config home** | macOS/Linux: `~/.aqbot/`<br>Windows: `%USERPROFILE%\.aqbot\` | Application state, database, encryption keys, SSL, vector DB |
| **Documents root** | macOS/Linux: `~/Documents/aqbot/`<br>Windows: `%USERPROFILE%\Documents\aqbot\` | User-visible files: images, documents, backups |

Both directories are created automatically on first launch.

## Directory Layout

### Config home (`~/.aqbot/`)

```
~/.aqbot/
├── aqbot.db          # SQLite database (all app state, settings, keys, …)
├── master.key        # 32-byte AES-256 master encryption key (mode 0600 on Unix)
├── vector_db/        # LanceDB vector store for knowledge-base embeddings
└── ssl/              # Self-signed TLS certificate and private key for the gateway
    ├── cert.pem
    └── key.pem       # mode 0600 on Unix
```

### Documents root (`~/Documents/aqbot/`)

```
~/Documents/aqbot/
├── images/           # Image attachments (chat uploads, avatars, AI-generated)
├── files/            # Non-image file attachments (documents, code, archives)
└── backups/          # Default location for auto- and manual backups
```

All paths stored in the database (e.g. `messages.attachments`, `stored_files.storage_path`)
use **relative paths** under the documents root (e.g. `images/abc123_photo.jpg`).

## Design Decisions

### Dual-Root vs. Single Home

User-created files (images, documents, backups) belong in a user-visible
location under `~/Documents/` so users can browse, back up, and share them
with standard OS tools.  Application internals (database, encryption keys,
vector indices) stay hidden in `~/.aqbot/` to avoid clutter and accidental
modification.

### Single Home vs. Tauri `app_data_dir`

Tauri's `app_data_dir()` resolves to platform-specific, version-locked paths
(e.g. `~/Library/Application Support/top.aqbot.app/` on macOS).  Using a
user-visible `~/.aqbot/` makes backups, debugging, and cross-version upgrades
predictable and independent of the Tauri bundle identifier.

### `aqbot.db` + `master.key` — Atomic Migration

The database and its master encryption key are always migrated as a matched
pair.  During the one-time migration from the legacy `app_data_dir`:

1. Both files are copied to `~/.aqbot/*.migrating` staging names.
2. Both staging files are renamed to their final names in a single pass.
3. If either step fails the staging files are cleaned up and the old location
   is left intact — no data is ever left in a half-migrated state.

### Other Subdirectories

`vector_db/` and `ssl/` are migrated best-effort (rename, falling back to
copy+delete for cross-device moves).  A failure to migrate a subdirectory is
logged as a warning; the application continues normally and the new
subdirectory will be created empty on next use.

### Backup Defaults

`resolve_backup_dir(None)` returns `~/Documents/aqbot/backups/`.
Users may override this via Settings → Backup → Backup Directory; an absolute
path stored there takes precedence.

### SSL Certificate Storage

`generate_self_signed_cert` writes `cert.pem` and `key.pem` to
`~/.aqbot/ssl/`.  The private key is written atomically (temp-file + rename)
with mode `0600` on Unix.

## Agent / Automation Guidance

- Application state (database, keys, vector DB): read/write under `~/.aqbot/`
- User files (images, documents, backups): read/write under `~/Documents/aqbot/`
- Database paths for files must be **relative** to the documents root
- Do **not** hard-code paths derived from `app_data_dir`, bundle identifier,
  or application version strings
- All directory names are **lowercase** with no spaces

## UI Conventions

### Image Preview & Modal Rules

All antd `<Image>` components **must** use blur-mask preview:

```tsx
<Image preview={{ mask: { blur: true }, scaleStep: 0.5 }} />
```

- `mask: { blur: true }` — hover shows a blurred overlay (never `mask: false` or plain text mask)
- `scaleStep: 0.5` — consistent zoom step across the app
- These settings apply to **all** image previews: chat attachments, file list thumbnails, avatar previews, etc.
