# AIM research adapter

Utopia calls this private MCP server for approved web acquisition. The adapter
starts Hermes with web/browser tools, keeps its job queue in SQLite, and returns
candidate sources and claims. Utopia independently fetches and checks quoted
pages before any excerpt enters the knowledge base.

On the DGX host, install `bridge.py` at
`~/.local/share/aim-research/bridge.py`, install
`aim-hermes-research.service` in `~/.config/systemd/user/`, and create a
mode-0600 `~/.config/aim-research/bridge.env` from `bridge.env.example`.
Set `AIM_RESEARCH_BIND` to a private address reachable from the Utopia
container and generate a random `AIM_RESEARCH_TOKEN` of at least 32 characters.
Then run `systemctl --user daemon-reload` and
`systemctl --user enable --now aim-hermes-research.service`.

Configure Utopia with `UTOPIA_HERMES_MCP_URL` (the private `/mcp` endpoint),
`UTOPIA_HERMES_MCP_TOKEN` (the same token), and
`UTOPIA_RESEARCH_TRUSTED_DOMAINS`. The last variable is a comma-separated
allowlist such as `antaranews.com:2,idx.co.id:1`; a hostname outside the list
cannot be promoted into KB evidence. Government `go.id` and `gov.id` domains
are tier 1 by default. Keep the adapter off public ingress.

Useful checks:

```sh
curl http://PRIVATE_BIND:8796/healthz
python3 -m unittest discover -s services/hermes-research -p test_bridge.py
```

Before replacing the production app, preserve a PostgreSQL dump, the app data
directory (especially `secret.key`), the current Compose file and the current
image tag. A safe application rollback restores the previous image tag with
the same Compose project; migration 0058 only adds research tables and does
not change existing tables. Restore the database dump only if the database
itself must be reverted, since a full restore discards writes made after the
dump. The adapter's SQLite queue survives service restarts; interrupted
SEARCHING jobs become FAILED so the UI can request a fresh retry.
