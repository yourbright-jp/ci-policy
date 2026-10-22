FROM gcr.io/cloud-builders/docker AS docker-cli
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598
COPY --from=docker-cli /usr/bin/docker /usr/bin/docker
# Test supervisor only. The checker container never receives this socket or CLI.
ENTRYPOINT ["/usr/local/bin/bun"]
