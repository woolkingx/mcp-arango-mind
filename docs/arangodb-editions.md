# ArangoDB Community vs Enterprise Edition — REST API Differences

## TL;DR

**ArangoDB 3.12.5+ has full feature parity between Community and Enterprise editions.**

All 253 operations in `arango-openapi.json` (v3.12.8) are available in Community Edition.
The only runtime difference is a 100 GiB dataset size limit enforced by the license server.

---

## History: What Was Enterprise-Only (before v3.12.5)

These features required an Enterprise license in earlier versions.
Listed here for reference when targeting older ArangoDB deployments.

### Hot Backups (`Hot Backups` tag — 6 ops)

Near-instantaneous consistent snapshots while the server is running.

| operationId | Method | Path |
|-------------|--------|------|
| `createBackup` | POST | `/_admin/backup/create` |
| `listBackups` | GET | `/_admin/backup/list` |
| `restoreBackup` | POST | `/_admin/backup/restore` |
| `deleteBackup` | DELETE | `/_admin/backup/delete` |
| `uploadBackup` | POST | `/_admin/backup/upload` |
| `downloadBackup` | POST | `/_admin/backup/download` |

### Encryption at Rest (`Security` tag — 1 op)

Key rotation for AES-256 encryption at rest.

| operationId | Method | Path |
|-------------|--------|------|
| `rotateEncryptionAtRestKey` | POST | `/_admin/server/encryption` |

### JWT Secret Management (`Authentication` tag — 6 ops)

Hot-reload of JWT secrets and access token management.

| operationId | Method | Path |
|-------------|--------|------|
| `reloadServerJwtSecrets` | POST | `/_admin/server/jwt` |
| `listAccessTokens` | GET | `/_admin/server/jwt/tokens` |
| `createAccessToken` | POST | `/_admin/server/jwt/tokens` |
| `deleteAccessToken` | DELETE | `/_admin/server/jwt/tokens/{id}` |
| `getServerJwtSecrets` | GET | `/_admin/server/jwt/secrets` |
| `createSessionToken` | POST | `/_admin/server/jwt/session` |

### AQL / Cluster Features (no dedicated REST endpoints)

These were enterprise-only at the AQL or startup-option level, not separate REST endpoints:

- SmartGraphs, EnterpriseGraphs, SatelliteGraphs, SatelliteCollections
- SmartJoins, OneShard databases
- Advanced Analyzers: `minhash`, `geo_s2`, `classification`, `nearest_neighbors`
- ArangoSearch WAND optimization, search highlighting, nested search

---

## Generating a Legacy Community Spec

If targeting ArangoDB < 3.12.5, use `scripts/gen-community-spec.mjs` to strip
formerly-enterprise operations from `arango-openapi.json`:

```bash
node scripts/gen-community-spec.mjs
# Output: config/arango-openapi-community.json
```

The script removes operations by tag (`Hot Backups`) and by operationId
(`rotateEncryptionAtRestKey`), then writes the filtered spec.

---

## Reference

- [ArangoDB Enterprise Edition features](https://docs.arangodb.com/stable/about-arangodb/features/enterprise-edition/)
- [Feature parity announcement (v3.12.5)](https://docs.arangodb.com/stable/release-notes/)
- Spec version in use: `config/arango-openapi.json` → `info.version: 3.12.8`
