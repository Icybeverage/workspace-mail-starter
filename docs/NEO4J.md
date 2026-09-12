# Neo4j relationship layer

SQLite is the application's source of truth. Neo4j projects tenant-scoped domain/DNS/mailbox relationships and email/calendar/file context for queries and visual exploration. It never hosts SMTP or stores the mailbox as a mail server.

## Local Neo4j or Aura

For a local instance, install Docker, create `secrets/neo4j_auth.txt` containing `neo4j/` followed by a strong unique password, and restrict it to your user. That directory is ignored by Git. Then run:

```sh
docker compose up -d neo4j
```

Set `NEO4J_URI=neo4j://127.0.0.1:7687`, `NEO4J_USERNAME=neo4j`, and your password in the ignored application `.env`. For Aura, use the instance's `neo4j+s://` URI and credentials instead. Do not put them in frontend variables.

The application initializes the graph service at startup. After connecting real resources, use the workspace sync action to project metadata. The fixture demo deliberately leaves Neo4j unavailable; it cannot demonstrate a real connection.

## Understand the graph

Domain, DNS record, mailbox and verification nodes support dependency investigation. Email, suggested task, event and file nodes connect workspace context. The consumer view uses Email / Suggested task / Meeting / File cards. Match confidence remains in the data; a suggested connection is not proof that a meeting or file was explicitly linked by its author.

All application queries must retain tenant filtering. Do not expose the Neo4j database directly to the browser. The operations agent reads dependencies and explains findings; it does not edit infrastructure.

Review `server/services/graph.js`, `server/services/workspace-knowledge.js`, and `server/services/investigation.js` when extending the graph. Add regressions for another tenant's records and for disconnected Neo4j before shipping a new query.

Official setup reference: [Neo4j Compose with secrets](https://neo4j.com/docs/operations-manual/current/docker/docker-compose-standalone/).
