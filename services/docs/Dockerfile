FROM nginx:alpine

# Docs are pre-built locally (run `npm run build --workspace=@butterbase/docs`
# from the repo root). Building inside Docker via `npm install` pulls floating
# transitive deps (Astro/Starlight/zod) and fails on incompatible zod releases;
# building from the workspace lockfile inside Docker requires every workspace's
# package.json. Avoid both by shipping the prebuilt static output.
COPY services/docs/dist /usr/share/nginx/html
COPY services/docs/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
