# n8n-nodes-bluebubbles

n8n community nodes for [BlueBubbles](https://bluebubbles.app/), the self-hosted server that exposes macOS iMessage over HTTP. Use it to start n8n workflows from incoming iMessages and other BlueBubbles server events.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

- [Included nodes](#included-nodes)
- [Credential setup](#credential-setup)
- [BlueBubbles Trigger](#bluebubbles-trigger)
- [Networking](#networking)
- [Publishing to GitHub](#publishing-to-github)
- [Installing in self-hosted n8n (Docker)](#installing-in-self-hosted-n8n-docker)
- [Development](#development)
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

## Publishing to GitHub

```sh
git add -A && git commit -m "feat: initial BlueBubbles credential and trigger"
gh repo create ejlevin1/n8n-nodes-bluebubbles --public --source . --push
git tag v0.1.0 && git push origin v0.1.0
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which lints, builds, runs `npm pack`, and attaches `n8n-nodes-bluebubbles-<version>.tgz` to a GitHub Release. The tag must match `version` in `package.json`. `dist/` is never committed.

To release a new version: bump `version` in `package.json` (and `CHANGELOG.md`), commit, then tag and push `v<version>`.

## Installing in self-hosted n8n (Docker)

Install the release tarball straight from GitHub:

```sh
docker exec -it n8n sh -c 'mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes && npm i --omit=peer https://github.com/ejlevin1/n8n-nodes-bluebubbles/releases/download/v0.1.0/n8n-nodes-bluebubbles-0.1.0.tgz'
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
npm pack                       # on your machine, produces n8n-nodes-bluebubbles-0.1.0.tgz
docker cp n8n-nodes-bluebubbles-0.1.0.tgz n8n:/tmp/
docker exec -it n8n sh -c 'mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes && npm i --omit=peer /tmp/n8n-nodes-bluebubbles-0.1.0.tgz'
docker restart n8n
```

### Updating

Re-run the install command with the new release URL (or new tarball), then restart the container.

## Development

Requires Node 24 (see `.nvmrc`).

```sh
npm install
npm run dev     # starts n8n with hot reload of this node at http://localhost:5678
npm run lint
npm run build
```

## Compatibility

Built with `@n8n/node-cli` 0.52.3. Tested against n8n 2.x.

## License

[MIT](LICENSE)
