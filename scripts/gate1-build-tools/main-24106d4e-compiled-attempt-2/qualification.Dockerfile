# No RUN instructions: assembly uses only the previously verified offline archives.
FROM --platform=linux/amd64 docker.io/library/amazonlinux@sha256:500790b3c980438d9d6cde6c149e59dda1992660941a814198b95ed56574fb96
ADD --chown=1000:1000 node-v22.23.3-linux-x64.tar.gz /opt/
ADD --chown=1000:1000 source.tar /opt/source/
ADD --chown=1000:1000 npm-cache.tar /opt/npm-cache/
COPY qualify-build.cjs inspect-compiled.cjs contract.json /opt/qualification/
ENV PATH=/opt/node-v22.23.3-linux-x64/bin:/usr/bin:/bin NODE_DISABLE_COMPILE_CACHE=1
USER 1000:1000
WORKDIR /state
ENTRYPOINT ["/usr/bin/timeout", "--signal=KILL", "1800s", "/opt/node-v22.23.3-linux-x64/bin/node", "/opt/qualification/qualify-build.cjs", "--inside"]
