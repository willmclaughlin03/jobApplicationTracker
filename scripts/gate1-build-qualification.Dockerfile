# Offline assembly only. The launcher supplies a minimal, hash-checked tar context;
# never use the working directory as a Docker build context. No RUN/download step.
ARG QUALIFICATION_BASE=docker.io/library/amazonlinux@sha256:500790b3c980438d9d6cde6c149e59dda1992660941a814198b95ed56574fb96
FROM --platform=linux/amd64 ${QUALIFICATION_BASE}
ADD node-v22.23.3-linux-x64.tar.gz /opt/
ADD source.tar /opt/source/
ADD npm-cache.tar /opt/npm-cache/
COPY toolchain-package.json /opt/toolchain/package.json
COPY toolchain-lock.json /opt/toolchain/package-lock.json
COPY execution/ /opt/gate1/scripts/
COPY package-lock.json /opt/gate1/package-lock.json
COPY review.json /opt/gate1/review.json
ENV PATH=/opt/node-v22.23.3-linux-x64/bin:/usr/bin:/bin \
    HOME=/tmp/home CI=1 NEXT_TELEMETRY_DISABLED=1 VERCEL_TELEMETRY_DISABLED=1 \
    npm_config_offline=true npm_config_audit=false npm_config_fund=false \
    npm_config_update_notifier=false
WORKDIR /opt/gate1
ENTRYPOINT ["/opt/node-v22.23.3-linux-x64/bin/node", "/opt/gate1/scripts/gate1-build-qualification.js"]
