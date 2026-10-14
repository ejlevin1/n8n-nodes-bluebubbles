# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-14

### Added

- BlueBubbles API credential (server URL + password) with a connection test via `GET /api/v1/ping`.
- BlueBubbles Trigger node that automatically registers a BlueBubbles webhook when the workflow is activated and removes it when the workflow is deactivated.
- Event multi-select on the trigger to choose which BlueBubbles events are delivered.
- Raw `{ type, data }` payload passthrough from BlueBubbles to the workflow.

[0.1.0]: https://github.com/ejlevin1/n8n-nodes-bluebubbles/releases/tag/v0.1.0
