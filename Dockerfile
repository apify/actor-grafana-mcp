FROM grafana/mcp-grafana:2.1.1 AS mcp

FROM apify/actor-node:22

# Statically linked Go binary (CGO_ENABLED=0), runs fine on the Alpine-based Apify image.
COPY --from=mcp /app/mcp-grafana /usr/local/bin/mcp-grafana

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && rm -rf ~/.npm

COPY --chown=myuser:myuser . ./

CMD ["npm", "start", "--silent"]
