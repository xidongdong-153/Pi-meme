FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash bubblewrap ca-certificates git openssl \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o ubuntu -g ubuntu /home/ubuntu/.pi-meme /run/pi-meme/tls \
    && install -d -o ubuntu -g ubuntu /workspace

ARG VERSION
ARG REVISION
ARG HOST_ARCH
ARG TARGETARCH
ADD --chown=0:0 pi-meme-host-${VERSION}-linux-${HOST_ARCH}.tar.gz /opt/
RUN /opt/pi-meme-host/runtime/bin/node -e '\
    const assert = require("node:assert/strict"); \
    const release = require("/opt/pi-meme-host/release.json"); \
    assert.equal(release.arch, process.arch); \
    assert.equal(release.arch, { amd64: "x64", arm64: "arm64" }[process.env.TARGETARCH]); \
    assert.equal(release.version, process.env.VERSION); \
    assert.equal(release.commit, process.env.REVISION)'
LABEL org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV HOME=/home/ubuntu \
    PI_MEME_HOST=0.0.0.0 \
    PI_MEME_AUTH_MODE=token-required \
    PI_MEME_TLS_CERT=/run/pi-meme/tls/host.crt \
    PI_MEME_TLS_KEY=/run/pi-meme/tls/host.key

USER ubuntu
WORKDIR /workspace
EXPOSE 3185
ENTRYPOINT ["/opt/pi-meme-host/bin/pi-meme-host"]
