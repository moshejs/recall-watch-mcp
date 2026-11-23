# Recall Watch MCP server (stdio) for Glama's build-and-inspect check, or for anyone who prefers a container.
# Build from the root of the public repository (github.com/moshejs/recall-watch-mcp):
#   docker build -t recall-watch-mcp .
#   docker run -i --rm -e OPENFDA_API_KEY recall-watch-mcp
# The image holds exactly the files of the npm package (package.json, README.md, LICENSE, mcp/server.js and the
# lib/ files it requires): no tests, no .env, no dependencies to install. It talks MCP over stdin/stdout, so run
# it with -i. (In the private source repository the same file builds from the staged package:
# npm --prefix mcp run stage && docker build -f mcp/Dockerfile mcp/dist)
FROM node:22-alpine
WORKDIR /app
COPY package.json README.md LICENSE ./
COPY lib/ ./lib/
COPY mcp/ ./mcp/
USER node
ENTRYPOINT ["node", "/app/mcp/server.js"]
