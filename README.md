# n8n-nodes-bluebubbles

n8n community nodes for [BlueBubbles](https://bluebubbles.app/), the self-hosted server that exposes macOS iMessage over HTTP. Use it to start n8n workflows from incoming iMessages and other BlueBubbles server events.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

- [Included nodes](#included-nodes)
- [Credential setup](#credential-setup)
- [BlueBubbles Trigger](#bluebubbles-trigger)
- [Networking](#networking)
- [Installing in self-hosted n8n (Docker)](#installing-in-self-hosted-n8n-docker)
- [Development](#development)
- [Contributing](#contributing)
- [Compatibility](#compatibility)
- [License](#license)

## Included nodes

| Name | Type | Purpose |
| --- | --- | --- |
| BlueBubbles API | Credential | Server URL and password for a BlueBubbles server |
| BlueBubbles Trigger | Trigger node | Starts a workflow when BlueBubbles sends a webhook event |

## Credential setup

Create a **BlueBubbles API** credential with:

| Field | Description |
| --- | --- |
| Server URL | Full base URL of your BlueBubbles server, including `https://` and any path prefix, **without** `/api/v1`. Example: `https://bluebubbles.example.com` or `http://192.168.1.50:1234`. |
| Password | The BlueBubbles server password (as set in the BlueBubbles server app). |

The credential test calls `GET /api/v1/ping`.

## BlueBubbles Trigger

### Webhook lifecycle

The trigger manages its BlueBubbles webhook for you; there is nothing to configure on the BlueBubbles side.

On workflow activation:

1. Lists existing webhooks with `GET /api/v1/webhook?url=<n8n webhook URL>`.
2. If a webhook with the identical URL and events exists, it is reused.
3. If a webhook with the same URL but different events exists, it is replaced.
4. Otherwise, a new webhook is created with `POST /api/v1/webhook` and body `{ "url": "...", "events": [...] }`.
5. The webhook ID is stored in the workflow static data.

On workflow deactivation, the webhook is removed with `DELETE /api/v1/webhook/:id`.

"Listen for test event" in the editor temporarily registers the `/webhook-test/` URL and removes it when listening stops.

### Events

Select one or more events (`*` subscribes to all):

`*`, `new-message`, `updated-message`, `message-send-error`, `group-name-change`, `group-icon-changed`, `group-icon-removed`, `participant-added`, `participant-removed`, `participant-left`, `chat-read-status-changed`, `typing-indicator`, `scheduled-message-error`, `server-update`, `new-server`, `new-findmy-location`, `incoming-facetime`, `ft-call-status-changed`, `imessage-alias-removed`, `hello-world`

### Output

Each item is the raw BlueBubbles payload:

```json
{ "type": "new-message", "data": { "...": "..." } }
```

To branch on event type, add an IF or Switch node on `{{ $json.type }}`.

### Notes

- BlueBubbles webhooks are not signed and are not retried. If n8n is unreachable when an event fires, that event is lost.
- BlueBubbles sends a `hello-world` event when a webhook is created. Filter it out downstream if you subscribed to `*`.

## Networking

BlueBubbles (on the Mac) calls n8n directly, so the webhook URL n8n generates must be reachable from that Mac. Set n8n's `WEBHOOK_URL` environment variable to an address the Mac can reach, such as a LAN IP, a Tailscale hostname, or a reverse-proxy URL. `localhost` will not work unless n8n runs on the same Mac.

Example Docker environment:

```yaml
services:
  n8n:
    image: n8nio/n8n
    environment:
      - WEBHOOK_URL=http://192.168.1.20:5678/
      # or: WEBHOOK_URL=https://n8n.your-tailnet.ts.net/
    ports:
      - "5678:5678"
    volumes:
      - n8n_data:/home/node/.n8n
volumes:
  n8n_data:
```

## Installing in self-hosted n8n (Docker)

Install the release tarball straight from GitHub. Every [release](https://github.com/ejlevin1/n8n-nodes-bluebubbles/releases) attaches `n8n-nodes-bluebubbles-<version>.tgz` at:

```text
https://github.com/ejlevin1/n8n-nodes-bluebubbles/releases/download/v<version>/n8n-nodes-bluebubbles-<version>.tgz
```

`VERSION` below is kept at the latest release automatically:

```sh
VERSION=0.1.0 # x-release-please-version
docker exec -it n8n sh -c "mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes && npm i --omit=peer https://github.com/ejlevin1/n8n-nodes-bluebubbles/releases/download/v${VERSION}/n8n-nodes-bluebubbles-${VERSION}.tgz"
docker restart n8n
```

Then search for "BlueBubbles" in the node picker.

Notes:

- `--omit=peer` is required. Without it npm installs the `n8n-workflow` peer dependency (hundreds of MB, plus a native `isolated-vm` build that fails in the official image). n8n provides `n8n-workflow` at runtime.
- `~/.n8n` (`/home/node/.n8n`) must be on a persistent volume, or the install is lost when the container is recreated.
- Do not use `npm i github:ejlevin1/n8n-nodes-bluebubbles`: a git install has to build from source, which pulls all dev dependencies and fails inside the official n8n image.
- docker compose users: replace `docker exec -it n8n` with `docker compose exec n8n`.

### Local tarball (testing local changes or offline install)

```sh
npm run build && npm pack      # on your machine, produces n8n-nodes-bluebubbles-<version>.tgz
docker cp n8n-nodes-bluebubbles-<version>.tgz n8n:/tmp/
docker exec -it n8n sh -c 'mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes && npm i --omit=peer /tmp/n8n-nodes-bluebubbles-<version>.tgz'
docker restart n8n
```

### Updating

Re-run the install command with the new `VERSION` (or new tarball), then restart the container.

## Development

Requires Node 24 (see `.nvmrc`).

```sh
npm install           # also points git at the repo's hooks (see below)
npm run dev           # starts n8n with hot reload of this node at http://localhost:5678
npm run lint
npm run build
```

## Contributing

### One-time setup after cloning

```sh
nvm use               # Node 24 from .nvmrc
npm install
npm run hooks:install # git config core.hooksPath .githooks
```

`npm install` already runs `hooks:install` through npm's `dependencies` lifecycle script, which only runs in this repository, never when n8n installs the release tarball. Run `npm run hooks:install` yourself if you installed with `--ignore-scripts` or the hooks are not firing (check with `git config core.hooksPath`, which should print `.githooks`).

The hooks in [`.githooks/`](.githooks) are plain shell scripts with no extra dependencies:

| Hook | Runs | Purpose |
| --- | --- | --- |
| `commit-msg` | `npx --no -- commitlint --edit` | Rejects messages that are not Conventional Commits |
| `pre-commit` | `npm run lint` | Same lint CI runs |
| `pre-push` | `npm run build` | Same build CI runs |

They use `node`/`npm` from your `PATH`. If a GUI git client does not inherit your shell `PATH`, the hooks try to load nvm (`$NVM_DIR`, then `~/.nvm`), and exit with a clear error if Node still cannot be found. `git commit --no-verify` skips them; CI checks the same rules anyway.

### Commit conventions

Commit messages, and PR titles for squash merges, must follow [Conventional Commits](https://www.conventionalcommits.org/), using the rules in [`commitlint.config.mjs`](commitlint.config.mjs) (`@commitlint/config-conventional`):

```text
<type>(<optional scope>): <lower-case summary>

<optional body>

<optional footers, e.g. BREAKING CHANGE: ..., Refs: #12>
```

| Type | Release effect (while < 1.0.0) | Changelog section |
| --- | --- | --- |
| `feat` | minor (0.1.0 -> 0.2.0) | Features |
| `fix`, `perf` | patch (0.1.0 -> 0.1.1) | Bug Fixes, Performance Improvements |
| `refactor`, `docs`, `revert` | patch | Code Refactoring, Documentation, Reverts |
| `chore`, `ci`, `test`, `build`, `style` | none on their own | hidden |
| `feat!:` / `BREAKING CHANGE:` footer | minor before 1.0.0, major after | Breaking changes |

Examples: `feat(trigger): add chat filter option`, `fix: handle empty webhook list`, `docs: clarify WEBHOOK_URL`.

CI enforces this: the **PR Title** workflow lints the PR title, and the `commitlint` job in **CI** lints every commit in the PR.

### Releases

Releases are fully automated by [release-please](https://github.com/googleapis/release-please) ([`.github/workflows/release-please.yml`](.github/workflows/release-please.yml)). Nothing is published to npm.

1. Merge conventional commits into `main`.
2. release-please opens or updates a release PR titled `chore(main): release X.Y.Z`. It bumps `package.json`, `.release-please-manifest.json`, `CHANGELOG.md` and the `VERSION` in this README.
3. Merge the release PR when you want to ship. The same workflow then creates the `vX.Y.Z` tag and GitHub Release, builds the package, and uploads `n8n-nodes-bluebubbles-X.Y.Z.tgz` to that release.

Do not bump versions, edit `CHANGELOG.md` release entries, or push `v*` tags by hand. To force a specific version, add a `Release-As: X.Y.Z` footer to a commit on `main`.

## Compatibility

Built with `@n8n/node-cli` 0.52.3. Tested against n8n 2.x.

## License

[MIT](LICENSE)
