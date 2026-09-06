# 2026-09-07 Whole-directory bind-mount PoC for per-user IDE (uid 14410)

English | [中文](2026-09-07-ide-whole-dir-mount-poc.zh.md)

> Ops session log. No passwords, tokens, or key values live here; the model key was copied container-to-file on the host and never printed.

## What was tested

The current per-user IDE mounts two named volumes plus one bind file (`provision.sh` create branch): `ide-<uid>-workspace` → `/workspaces/system-admin`, `ide-<uid>-dshome` → `/root/.dsh`, and `/opt/ide-provision/iam-trust.json` → `/etc/ide-portal/iam-trust.json:ro`. The requester wants to evaluate a whole-directory layout under `/data`:

| Host path | Container mount | Mode |
|---|---|---|
| `/data/ide/14410/workspace` | `/workspaces/system-admin` | rw |
| `/data/ide/14410/root` | `/root` (whole directory, replaces the dshome volume) | rw |
| `/data/ide/14410/ide-provision` | `/etc/ide-portal` (whole directory, replaces the single-file mount) | ro |

This is a proof of concept only: `provision.sh`, `docs/containerization/0008`, and the Dockerfiles are unchanged, and the `ide-provision` Jenkins job still provisions the old layout. A requirements decision follows the requester's review of this PoC.

## Host facts gathered first

- `/data` is a 600G LVM volume (`datavg-datalv01`), 365G free — the 2026-09-06 disk pressure does not apply here.
- No SELinux (`getenforce` absent), so bind mounts need no `:z` relabel.
- `model-key.env/` on the host is empty (the create-stage cleans up after itself); the live model key was taken from the running `ide-14409` container's `Config.Env` instead.

## Recipe that worked (exact steps, in order)

1. `mkdir -p /data/ide/14410/{workspace,root,ide-provision}` and `chmod 700 /data/ide/14410`. Bind mounts do not auto-create host directories, and a docker-created root-owned directory would silently mask the intended source.
2. Seed `/root` from the image: `docker create` a throwaway container from `harbor.jereh.cn/base/dsh-aio:dev-amd64`, `docker cp <c>:/root/. /data/ide/14410/root/`, remove it. This step is mandatory: a bind mount shadows image content, and the image bakes `/root/.dsh/jwt-gate.cordis.patch.yml` + `iam-gate.cordis.patch.yml`; without seeding, the IAM gate never composes and the container answers 502.
3. `cp /opt/ide-provision/iam-trust.json /data/ide/14410/ide-provision/` — the mounted directory must contain only the trust file; see the security note below.
4. `docker inspect ide-14409` → extract `NR_API_KEY=…` into `/data/ide/14410/ide.env` with `umask 077`, never echoing the value.
5. `docker run` with the bind mounts above plus the standard env (`FRONT_PORT=8080`, `TRUSTED_HOSTS`/`VIRTUAL_HOST=ide-14410.jereh-pe.cn`, `VIRTUAL_PORT=8080`, `HTTPS_METHOD=noredirect`, `DSH_IAM_GATE=1`, `--shm-size 1g`, `--network dc_default`, `--restart unless-stopped`, label `com.jereh.uid`), `--entrypoint bash … -c 'sleep 60000'` as PID1.
6. Two-step boot: `docker exec -d ide-14410 /usr/local/bin/entrypoint.sh` (the mandatory C2 workaround).
7. Probe container IP `:8080` until 200/302/401, then the front proxy with `-H "Host: ide-14410.jereh-pe.cn"`.

## Results

- Internal probe: HTTP 401 on try 6 (~55 s after hook) — gate live and protecting.
- Proxy probe through jr-nginx-proxy: HTTP 401 — vhost installed correctly.
- Persistence: markers written inside the container (`/workspaces/system-admin/.poc-14410-marker`, `/root/.poc-14410-marker`) appeared at the host paths immediately; still present after `docker restart` + re-hook, and the container returned to HTTP 401 on both probes.
- `docker inspect .Mounts` shows the three bind mounts exactly as designed; container `/etc/ide-portal` lists only `iam-trust.json`.
- Host-side `/data/ide/14410/root/.dsh` shows the runtime population (`profiles`, `settings.yaml`, `storages`, both gate patches) — the whole-`/root` volume is genuinely in use, not a stale copy.

## Constraints and risks to weigh in the requirements decision

1. **Image-upgrade freeze over `/root`.** Everything under `/data/ide/<uid>/root` shadows the image from first create onward. A later image that fixes `jwt-gate.cordis.patch.yml` or ships a new `settings.yaml` default will not reach existing users; only brand-new users get it. The old layout had the same property for `/root/.dsh` only; the whole-directory layout widens the frozen surface to all of `/root` (dotfiles, `.npm`, caches). A re-seed procedure (stop → `docker cp` fresh `/root` minus user data → start) does not exist yet and must merge, not overwrite, if users accumulate real state there.
2. **`/etc/ide-portal` directory mount is safe only because the source dir holds one file.** `/opt/ide-provision/` also contains `ide-portal.env` (the Jenkins token) and portal config; the PoC therefore copies the trust file into a dedicated per-uid directory instead of mounting `/opt/ide-provision` itself. Any future tooling that writes into `/data/ide/<uid>/ide-provision/` exposes that content to the user container.
3. **The model key now sits in `/data/ide/14410/ide.env` (0600, root/admin-readable) rather than being piped per-create.** The `ide-provision` SR5 rule (key only via stdin, never on disk) does not hold for this PoC path; a production design needs a decision here.
4. Named-volume benefits given up: atomic rename on delete (`docker volume rm`), and Docker's copy-on-first-use population of image content (replaced here by the manual seed step).

## Reproduction scripts

Executed via the `dsh-aio-remote-exec` Jenkins job (`TARGET_HOST=10.1.17.58`, `SCRIPT_B64`, form-encoded `buildWithParameters`): probe script gathered host facts; run script performed steps 1–7 plus evidence capture; restart script verified stop/start self-healing. The scripts are session-local (`/tmp/poc*.sh` in the operator container); the recipe above is the durable form.

## Current state

`ide-14410` is running on the whole-directory layout, healthy (401 = gate protecting), data at `/data/ide/14410/`. `ide-14409` and the production portal are untouched. Awaiting the requester's requirements decision before touching `provision.sh`, `docs/containerization/0008`, or the portal.
