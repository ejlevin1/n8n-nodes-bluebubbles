# n8n-nodes-bluebubbles

n8n community nodes for [BlueBubbles](https://bluebubbles.app/), the self-hosted server that exposes macOS iMessage over HTTP. Use it to send and manage iMessages (messages, chats, attachments, contacts, scheduled messages) from n8n workflows, and to start workflows from incoming iMessages and other BlueBubbles server events.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

- [Included nodes](#included-nodes)
- [Credential setup](#credential-setup)
- [BlueBubbles node](#bluebubbles-node)
- [BlueBubbles Trigger](#bluebubbles-trigger)
- [Networking](#networking)
- [Install from npm (recommended once published)](#install-from-npm-recommended-once-published)
- [Installing in self-hosted n8n (Docker)](#installing-in-self-hosted-n8n-docker)
- [Development](#development)
- [Contributing](#contributing)
- [Compatibility](#compatibility)
- [License](#license)

## Included nodes

| Name | Type | Purpose |
| --- | --- | --- |
| BlueBubbles API | Credential | Server URL and password for a BlueBubbles server |
| BlueBubbles | Action node | Sends messages and manages chats, attachments, contacts, handles, scheduled messages and the server |
| BlueBubbles Trigger | Trigger node | Starts a workflow when BlueBubbles sends a webhook event |

## Credential setup

Create a **BlueBubbles API** credential with:

| Field | Description |
| --- | --- |
| Server URL | Full base URL of your BlueBubbles server, including `https://` and any path prefix, **without** `/api/v1`. Example: `https://bluebubbles.example.com` or `http://192.168.1.50:1234`. |
| Password | The BlueBubbles server password (as set in the BlueBubbles server app). |

The credential test calls `GET /api/v1/ping`.

## BlueBubbles node

The **BlueBubbles** action node calls the BlueBubbles REST API (`/api/v1`) with the **BlueBubbles API** credential. It can be used as an AI agent tool.

### Resources and operations

Operations marked **PA** need the [Private API](#private-api).

| Resource | Operation | API call | Notes |
| --- | --- | --- | --- |
| Message | Send | `POST /message/text` | Send text to an existing chat. Options: Send Method, Subject (PA), Effect ID (PA), Reply to Message GUID (PA). |
| Message | Send to Address | `POST /message/text`, or `POST /chat/new` for SMS | Send to a phone number or email. Service: iMessage or SMS (SMS needs PA). |
| Message | Get | `GET /message/:guid` | Includes chats and attachments. |
| Message | Get Many | `GET /chat/:guid/message` | Messages in one chat. Filters: Created After/Before, From Address, Sort. |
| Message | Search | `POST /message/query` | Case-insensitive text search, optionally in one chat. Filters: Created After/Before, From Address. |
| Message | React (PA) | `POST /message/react` | Add or remove a tapback (love, like, dislike, laugh, emphasize, question). |
| Message | Edit (PA) | `POST /message/:guid/edit` | Edit a message you sent. |
| Message | Unsend (PA) | `POST /message/:guid/unsend` | Retract a message you sent. |
| Chat | Get | `GET /chat/:guid` | With participants and last message. |
| Chat | Get Many | `POST /chat/query` | Most recent first. Options: Unread Only, Include Recent Messages. |
| Chat | Create (PA) | `POST /chat/new` | Start a chat with one or more addresses and a first message. |
| Chat | Mark as Read / Mark as Unread (PA) | `POST /chat/:guid/read`, `/unread` | Mark as Unread needs macOS 13+. |
| Chat | Start Typing / Stop Typing (PA) | `POST` / `DELETE /chat/:guid/typing` | |
| Chat | Rename Group (PA) | `PUT /chat/:guid` | |
| Chat | Add Participant / Remove Participant (PA) | `POST /chat/:guid/participant/add`, `/remove` | |
| Chat | Leave (PA) | `POST /chat/:guid/leave` | |
| Chat | Delete (PA) | `DELETE /chat/:guid` | |
| Attachment | Get | `GET /attachment/:guid` | Metadata only. |
| Attachment | Download | `GET /attachment/:guid/download?original=true` | Writes the file to a binary field (default `data`). |
| Attachment | Send | `POST /message/attachment` (multipart) | Sends a file from a binary field. |
| Contact | Get Many | `GET /contact` | Optional case-insensitive search on name, phone numbers and emails. |
| Contact | Lookup by Address | `POST /contact/query` | Addresses without a matching contact are left out. |
| Handle | Check iMessage Availability (PA) | `GET /handle/availability/imessage` | Returns `{ available }`. |
| Handle | Check FaceTime Availability (PA) | `GET /handle/availability/facetime` | Returns `{ available }`. |
| Scheduled Message | Create | `POST /message/schedule` | Sends once at the given time. |
| Scheduled Message | Get Many | `GET /message/schedule` | Each record has a `status`: `pending`, `in-progress`, `complete` or `error` (reason in `error`). |
| Scheduled Message | Delete | `DELETE /message/schedule/:id` | |
| Server | Ping | `GET /ping` | |
| Server | Get Info | `GET /server/info` | Server and macOS versions, Private API status. |
| Server | Get My Addresses | `GET /server/info`, then `GET /icloud/account` | Phone numbers and emails of the signed-in Apple account, primary first. The iCloud lookup is only tried with the Private API, and is best-effort. |

### Choosing a chat

Operations that target a chat use a **Chat** picker with three modes:

- **From List:** searchable list of recent chats, shown by display name or participants.
- **By GUID:** a chat GUID such as `iMessage;+;chat123456`. A leading `iMessage;-;` is rewritten to `any;-;` so the server picks the service.
- **By Address:** a phone number or email; targets the one-to-one chat `any;-;<address>`.

### Private API

Operations marked **PA** (and the Subject, Effect ID and Reply options) use the BlueBubbles Private API. It requires:

- Private API enabled in BlueBubbles Server.
- System Integrity Protection (SIP) disabled on the Mac.
- The BlueBubbles Private API helper connected (check with **Server > Get Info**: `private_api` and `helper_connected`).

The node does not hide these operations when the Private API is off. The server rejects the request, and the error hint says to enable the Private API (SIP off, helper connected).

### Send method

Text, attachment, chat-create and scheduled sends have a **Send Method** option: **Auto** (default), **Private API** or **AppleScript**.

- **Auto** calls `GET /server/info` once per execution (cached for all items in that run) and uses the Private API only when `private_api` is on **and** the helper is connected; otherwise AppleScript.
- **Reply to Message GUID** needs the Private API; the item fails if the method resolves to AppleScript.
- **Send to Address** with **Service: SMS** always needs the Private API and fails otherwise. It creates the chat with `POST /chat/new`, so its output is a **chat** object (chat `guid`), not a message: there is no message GUID and `text` is `null`.
- **Send to Address** with **Service: iMessage** sends to the chat `any;-;<address>` and lets the server choose the service.

### Scheduled messages

The send method of a scheduled message is resolved and **frozen when it is scheduled**. A message scheduled with the Private API fails when it fires if the helper is disconnected at that time, with no fallback to AppleScript and no retry. Scheduling is not delivery: check **Scheduled Message > Get Many** for records with status `error` afterwards.

### Simplify

**Message > Get / Get Many / Search** and **Chat > Get Many** (for Include Recent Messages) have a **Simplify** toggle, on by default. Simplified messages keep only:

`guid`, `text`, `handle` (`address`, `service`), `isFromMe`, `dateCreated`, `attachments`, `replyToGuid`, `associatedMessageGuid`, `associatedMessageType`, `dateEdited`, `dateRetracted`, `isAudioMessage`, `error`, `chats` (`guid`, `displayName`, `isArchived`).

Turn it off to get the raw BlueBubbles objects.

### Lists and pagination

Get Many and Search operations have **Return All** and **Limit** (default 50). Message Get Many, Message Search and Chat Get Many page through results with `limit`/`offset`, at most 1,000 rows per request (the server rejects larger pages). Contact Get Many and Scheduled Message Get Many fetch the full list in one request and apply the limit in n8n.

- **Message > Get Many**, **From Address** filter: applied after each page is fetched, so fewer results than the limit may come back. Use `me` for messages you sent.
- **Message > Search**, **From Address**: matches the *other* party of the conversation; use `me` for your own messages. Searching a chat that does not exist returns no results rather than an error. Messages whose text is stored only in rich-text form may not be found.
- **Chat > Get Many**, **Unread Only**: the limit applies after filtering, and "unread" is the read state of the Mac's user.

### Visible and destructive actions

These change what other people see. Use them deliberately, especially from an AI agent:

- **Visible to others:** Message React, Edit and Unsend; Chat Mark as Read (read receipt), Start/Stop Typing, Rename Group, Add/Remove Participant.
- **Destructive, cannot be undone:** Chat Delete (removes the chat and all its messages from the Mac), Chat Leave (another member has to add you back), Chat Remove Participant, Message Unsend, Scheduled Message Delete.

### Unverified

These are implemented from the BlueBubbles API reference but not yet confirmed against a live server. Test them before relying on them:

- The **Subject** and **Effect ID** send options.
- The request shape of **Chat > Create** (`POST /chat/new` with `addresses`, `message`, `method`, `service`, `tempGuid`).

### Errors

Errors name the request, HTTP status and BlueBubbles error message with a hint (for example "Chat does not exist; check the chat GUID" on a 404). The password is never included. With **On Error > Continue**, a failing item becomes `{ "error": "<message>" }`, paired with its input item, and the rest of the items still run.

## BlueBubbles Trigger

### Webhook lifecycle

The trigger manages its BlueBubbles webhook for you; there is nothing to configure on the BlueBubbles side.

On workflow activation:

1. Lists all webhooks with `GET /api/v1/webhook` and matches the n8n webhook URL exactly. (The server's `?url=` filter is not used: on BlueBubbles Server 1.9.9 it returns HTTP 500 when no webhook has that URL.) If listing fails, activation continues and step 4 reports any problem.
2. If a webhook with the identical URL and events exists, it is reused.
3. If a webhook with the same URL but different events exists, it is replaced. BlueBubbles keeps one webhook per URL and returns the existing one unchanged on `POST`, so the trigger also checks the events the server returns and replaces the webhook if they differ.
4. Otherwise, a new webhook is created with `POST /api/v1/webhook` and body `{ "url": "...", "events": [...] }`.
5. The webhook ID is stored in the workflow static data.

On workflow deactivation, the webhook is removed with `DELETE /api/v1/webhook/:id`.

"Listen for test event" in the editor temporarily registers the `/webhook-test/` URL and removes it when listening stops.

### Events

Select one or more events (`*` subscribes to all):

`*`, `new-message`, `updated-message`, `message-send-error`, `group-name-change`, `group-icon-changed`, `group-icon-removed`, `participant-added`, `participant-removed`, `participant-left`, `chat-read-status-changed`, `typing-indicator`, `scheduled-message-error`, `server-update`, `new-server`, `new-findmy-location`, `incoming-facetime`, `ft-call-status-changed`, `imessage-alias-removed`, `hello-world`, `settings-backup-created`, `settings-backup-updated`, `settings-backup-deleted`, `theme-backup-created`, `theme-backup-updated`, `theme-backup-deleted`

This is the server's own whitelist (`webhookEventOptions` in BlueBubbles Server); any other value is rejected with HTTP 400.

### Output

Each item is the raw BlueBubbles payload:

```json
{ "type": "new-message", "data": { "...": "..." } }
```

To branch on event type, add an IF or Switch node on `{{ $json.type }}`.

### Notes

- BlueBubbles webhooks are not signed and are not retried. If n8n is unreachable when an event fires, that event is lost.
- BlueBubbles does not send a test event when a webhook is created. `hello-world` is only emitted when the BlueBubbles HTTP server starts; filter it out downstream if you subscribed to `*`.
- The webhook API (`/api/v1/webhook`) requires BlueBubbles Server 1.9.9 or newer.
- `imessage-alias-removed` is the name the server accepts for subscriptions, but BlueBubbles Server (1.9.9 / master) emits that event as `imessage-aliases-removed`, so only a `*` subscription receives it.
- If activation fails ("Failed triggers"), open the trigger node: the error names the request, the server URL, the HTTP status or network error, the BlueBubbles error message and a hint. The password is never included.

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

## Install from npm (recommended once published)

The package is published to npm as [`n8n-nodes-bluebubbles`](https://www.npmjs.com/package/n8n-nodes-bluebubbles), with npm provenance linking each version to the GitHub Actions run that built it.

**n8n UI:** go to **Settings > Community Nodes > Install**, enter `n8n-nodes-bluebubbles`, accept the risk prompt, and install.

**Manual (e.g. Docker, or when the UI install is disabled):**

```sh
docker exec -it n8n sh -c "mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes && npm i --omit=peer n8n-nodes-bluebubbles"
docker restart n8n
```

The `--omit=peer` and persistent-volume notes in the next section apply here too. To update, use **Update** in the Community Nodes settings, or re-run the command with `n8n-nodes-bluebubbles@latest` and restart.

## Installing in self-hosted n8n (Docker)

Install the release tarball straight from GitHub. This works without npm, and every GitHub Release tarball is byte-identical to the npm package of the same version. Every [release](https://github.com/ejlevin1/n8n-nodes-bluebubbles/releases) attaches `n8n-nodes-bluebubbles-<version>.tgz` at:

```text
https://github.com/ejlevin1/n8n-nodes-bluebubbles/releases/download/v<version>/n8n-nodes-bluebubbles-<version>.tgz
```

`VERSION` below is kept at the latest release automatically:

```sh
VERSION=0.1.2 # x-release-please-version
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
npm test              # builds, then runs test/*.test.cjs against a mock BlueBubbles server
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

Releases are fully automated by [release-please](https://github.com/googleapis/release-please) ([`.github/workflows/release-please.yml`](.github/workflows/release-please.yml)).

1. Merge conventional commits into `main`.
2. release-please opens or updates a release PR titled `chore(main): release X.Y.Z`. It bumps `package.json`, `.release-please-manifest.json`, `CHANGELOG.md` and the `VERSION` in this README.
3. Merge the release PR when you want to ship. The same workflow then creates the `vX.Y.Z` tag and GitHub Release, builds the package, uploads `n8n-nodes-bluebubbles-X.Y.Z.tgz` to that release, and (when the `NPM_PUBLISH` repository variable is `true`) publishes that same tarball to npm.

Do not bump versions, edit `CHANGELOG.md` release entries, or push `v*` tags by hand. To force a specific version, add a `Release-As: X.Y.Z` footer to a commit on `main`.

Do not run `npm publish` from the working tree: the `prepublishOnly` script refuses it. Publishing a tarball (`npm publish ./<file>.tgz`) skips lifecycle scripts, which is how both CI and the one-time manual publish below work.

### npm publishing (maintainers)

CI publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (GitHub Actions OIDC), so there is no `NPM_TOKEN` secret. Provenance is generated automatically because the repository and package are public. The publish step is skipped unless the repository variable `NPM_PUBLISH` is `true`.

One-time setup, in order:

1. **First publish by hand.** The package must exist on npm before a trusted publisher can be attached. Publish the tarball from the first GitHub Release:

   ```sh
   gh release download v0.1.0 --repo ejlevin1/n8n-nodes-bluebubbles --pattern '*.tgz'
   npm login
   npm publish ./n8n-nodes-bluebubbles-0.1.0.tgz --access public
   ```

2. **Add the trusted publisher.** On npmjs.com, open the package's **Settings > Trusted publishing**, choose **GitHub Actions**, and enter:
   - Organization or user: `ejlevin1`
   - Repository: `n8n-nodes-bluebubbles`
   - Workflow filename: `release-please.yml` (filename only; the publish must run in this file, not in a reusable workflow it calls)
   - Environment: leave empty
   - Allow `npm publish`.
3. **Turn on CI publishing.** In GitHub, **Settings > Secrets and variables > Actions > Variables**, add the repository variable `NPM_PUBLISH` with value `true`.
4. **Lock down tokens.** After the first CI publish succeeds, set the package's **Settings > Publishing access** to **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working; classic and granular tokens can no longer publish.

The trusted publisher configuration must complete a publish within 2 days of being created, so do step 2 shortly before the next release PR is merged (or re-create it if that window passes). `package.json` `repository.url` must stay `git+https://github.com/ejlevin1/n8n-nodes-bluebubbles.git`, or npm rejects the provenance/OIDC publish.

## Compatibility

Built with `@n8n/node-cli` 0.52.3. Tested against n8n 2.x.

## License

[MIT](LICENSE)
