# Neo4j

SQLite stores application state. Neo4j holds a tenant-scoped projection used for dependency queries and relationship views.

There are two main graphs:

- **Setup:** domains, DNS records, checks, and affected mailboxes.
- **Workspace:** emails, suggested tasks, meetings, and files.

The operations agent reads the setup graph to explain problems. The workspace view uses the second graph to surface context around a message. Suggested links retain their confidence and source information.

## Connect a database

Set these values in the application’s `.env`:

```dotenv
NEO4J_URI=neo4j://127.0.0.1:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=
```

Fill in the password locally. For Aura, use the instance’s `neo4j+s://` URI and credentials.

To run the included local database configuration, create `secrets/neo4j_auth.txt` containing `neo4j/` followed by your password, restrict the file to your user, and start it:

```sh
docker compose up -d neo4j
```

The Compose file starts Neo4j only, binds its ports to loopback, and persists data in a Docker volume. It reads the password through a mounted secret. See the [Neo4j Compose guide](https://neo4j.com/docs/operations-manual/current/docker/docker-compose-standalone/) for administration details.

Restart the application after changing its connection settings. Sync workspace resources from the UI to populate email, calendar, and file context. Without a configured database, the app reports the graph as unavailable; the local fixture demo uses this mode.

## Extend the graph

Projection and query code lives in [`server/services/graph.js`](../server/services/graph.js). Workspace ingestion is in [`workspace-knowledge.js`](../server/services/workspace-knowledge.js); operational traversal is in [`investigation.js`](../server/services/investigation.js).

Preserve tenant filters when adding a query, and cover cross-tenant access and database outages in tests. Database credentials stay on the server.
