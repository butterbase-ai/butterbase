FROM node:22-alpine

WORKDIR /app

RUN npm install -g @butterbase/mcp@1.1.0 pg@^8.20.0

ENV BUTTERBASE_REGION=us-east-1 \
    BUTTERBASE_REGIONS=us-east-1

ENTRYPOINT ["butterbase-mcp"]
