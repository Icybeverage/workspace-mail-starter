# Neo4j

SQLite stores application state. Neo4j holds a tenant-scoped projection used for dependency queries and relationship views.

There are two main graphs:

- **Setup:** domains, DNS records, checks, and affected mailboxes.
- **Workspace:** emails, suggested tasks, meetings, and files.

The operations agent reads the setup graph to explain problems. The workspace view uses the second graph to surface context around a message. Suggested links retain their confidence and source information.

## Connect a database

Choose a local database or Aura. Both connect through the same three application settings.

### Local database

1. Install Docker and Compose from [Software and services](REQUIREMENTS.md).
2. From the repository root, prepare the secret file:

```sh
mkdir -p secrets
touch secrets/neo4j_auth.txt
chmod 600 secrets/neo4j_auth.txt
```

3. Open that file in your editor and enter `neo4j/` followed by a strong password on one line. Keep the password for the application configuration.
4. Start the database:

```sh
docker compose up -d neo4j
docker compose ps neo4j
```

5. Add the connection settings to the application’s `.env`, filling in the same password:

```dotenv
NEO4J_URI=neo4j://127.0.0.1:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=
```

The Compose file starts Neo4j only, binds its ports to loopback, and persists data in a Docker volume. These settings assume the Node app runs on that same host. See the [Neo4j Compose guide](https://neo4j.com/docs/operations-manual/current/docker/docker-compose-standalone/) for administration details.

### Aura

Create an Aura instance using the link in [Software and services](REQUIREMENTS.md). Copy its `neo4j+s://` URI, username, and password into `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD` in `.env`. You do not need local Docker for Aura.

### Verify the connection

Restart the application after saving `.env`. Open Workspace and sync resources from a test mailbox to populate email, calendar, and file context. If the graph remains unavailable, check the database status and connection settings. The fixture demo deliberately leaves Neo4j unconfigured; use the normal app for this check.

## Extend the graph

Projection and query code lives in [`server/services/graph.js`](../server/services/graph.js). Workspace ingestion is in [`workspace-knowledge.js`](../server/services/workspace-knowledge.js); operational traversal is in [`investigation.js`](../server/services/investigation.js).

Preserve tenant filters when adding a query, and cover cross-tenant access and database outages in tests. Database credentials stay on the server.
