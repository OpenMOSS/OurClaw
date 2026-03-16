cd ./openclaw

pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
pnpm openclaw onboard --install-daemon