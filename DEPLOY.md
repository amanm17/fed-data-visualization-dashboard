# Deploying the Backend

Two ways to get the Node/Express/DuckDB backend live. Either way, your
existing website doesn't change beyond updating the embed snippet /
iframe `src` to point at wherever this ends up — the app is designed to
be embedded cross-origin from anywhere (see `public/demo.html`).

- **Option A — Render, free tier.** $0/month. One-click `render.yaml`
  blueprint, no server administration. The tradeoff: free web services
  spin down after 15 min of no traffic, so the next visitor after a quiet
  period waits roughly 1–3 minutes while it wakes up and re-downloads the
  566MB ASI/PLFS dataset (there's no persistent disk on this tier, so
  nothing survives a spin-down) — the Trade Explorer's shared Comtrade
  cache resets along with it for the same reason. Good default if traffic
  is occasional rather than constant.
- **Option B — Oracle Cloud "Always Free."** Also $0/month, but a real,
  permanently-on VM — no spin-down, no repeated re-downloads. The
  tradeoff: it's a raw VM, so you're doing the Node/process-manager/HTTPS
  setup yourself instead of a platform doing it for you.

(There's also a paid step up from Option A — Render's Starter plan
($7/month) plus a $0.25/month persistent disk removes the spin-down and
re-download entirely, with the exact same one-click deploy. See the note
at the end of Option A if that trade becomes worth it later.)

Both free options need the same 566MB ASI/PLFS data (gitignored, never
reaches either host via git) to end up on the server somehow — the
mechanism differs between them below.

## Option A: Render (free tier)

The ASI CSVs + `CPERV1.txt` are gitignored (566MB, too large and not
appropriate to commit) and never reach Render via git. On the free tier
there's no persistent disk, so a `prestart` hook
(`scripts/ensure-data.js`) downloads and unpacks them fresh every time the
service starts up from cold — including every time it wakes from a
15-minute idle spin-down. That download is the entire reason the first
request after a quiet period is slow; every request after that is normal
speed until it goes idle again.

### 1. Package your data as one zip

```
cd data
zip -r ../asi-plfs-data.zip CPERV1.txt block_a.csv block_b.csv block_c.csv \
  block_d.csv block_e.csv block_f.csv block_g.csv block_h.csv block_i.csv block_j.csv
```

Zip from *inside* `data/` (not `zip -r asi-plfs-data.zip data/`) — the
files must sit at the top level of the archive, not inside a `data/`
subfolder, or `ensure-data.js` won't find them after extracting. Don't
include `PLFS_Layout.csv` — it's only used offline to generate
`server/modules/data/plfs_person_layout.js`, which is already committed;
the server never reads the raw layout file at runtime.

### 2. Upload the zip to OneDrive and get a direct-download link

Upload `asi-plfs-data.zip`, then get a shareable link ("Anyone with the
link can view"). OneDrive's default share link opens a preview page, not a
raw download — you need to convert it to a direct-download link:

- If the link looks like `https://onedrive.live.com/redir?resid=...`,
  change `redir?` to `download?`.
- If it's a short `https://1drv.ms/...` link, open it once in a browser
  first to get the full `onedrive.live.com` URL it redirects to, then
  apply the same change.

**Test the converted link before relying on it** — run
`curl -L --fail -o test.zip "<your link>"` and confirm `test.zip` is
actually a valid zip (`unzip -l test.zip`), not an HTML page. OneDrive's
link format has changed over the years and isn't built for repeated
automated/server-side fetches the way S3/R2 presigned URLs are — this is
exactly why the persistent-disk approach only needs this link to work
*once*, at first boot, rather than on every restart.

### 3. Deploy to Render

**Blueprint (recommended):** push this repo (it now includes `render.yaml`,
already set to `plan: free`) to GitHub, then in the Render dashboard:
**New > Blueprint**, connect the repo. Render reads `render.yaml` and
provisions the free web service automatically. You'll be prompted for the
one `sync: false` env var:

- `DATA_ARCHIVE_URL` — the direct-download link from step 2.

**Manual alternative:** New > Web Service, connect the repo, and set:
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Plan: Free
- Environment variable: `DATA_ARCHIVE_URL=<link>`
- Health check path: `/api/metadata`

### 4. Verify the first deploy

Watch the deploy logs — you should see:
```
[ensure-data] 11 file(s) missing (...) — downloading archive...
[ensure-data] all required data files present.
ASI dashboard server listening on http://localhost:10000
```
(Render assigns its own `PORT`; the app already respects `process.env.PORT`.)

Then hit `https://<your-service>.onrender.com/api/metadata` — you should
get the same JSON as `localhost:4000/api/metadata` did locally, listing
all 10 ASI blocks, `unit_summary`, and `plfs_person`.

**Every subsequent request** (until the service goes idle again) sees the
data already there and skips the download — you'll only see the
`[ensure-data] ... downloading archive` log line again after a spin-down.
This is expected on the free tier, not a bug.

**If the wake-up delay becomes annoying later:** upgrade the same service
to the Starter plan ($7/month) in Render's dashboard and add a 1GB
persistent disk mounted at `/data` (with `ASI_DATA_DIR=/data` added as an
env var) — this removes both the spin-down and the repeated re-download
entirely, with no code changes and no redeploy-from-scratch needed.

### 5. Point your existing website at it

Update the embed snippet on your actual site (the pattern in
`public/demo.html`):

```html
<div data-asi-dashboard data-api-base="https://<your-service>.onrender.com"></div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<script src="https://<your-service>.onrender.com/asi-dashboard.js"></script>
```

The Financial Analyzer doesn't need any of this — it's entirely
client-side and can just be embedded/linked as static files from
wherever `public/financial-analyzer.html` is served (Render will serve it
too, at `/financial-analyzer.html`, if that's convenient).

## Option B: Oracle Cloud "Always Free"

This runs the same app as a plain Node process on a real, permanently-free
VM (Oracle's Ampere A1 tier — up to 4 OCPUs / 24GB RAM and 200GB of block
storage, at no cost, indefinitely — not a time-limited trial). There's no
platform automating the Node setup, process supervision, or HTTPS the way
Render does, so those are done by hand below, once.

Steps that only you can do (account creation, console clicks, DNS) are
called out as such — everything else is a command to run.

### 1. Create the Oracle Cloud account and a compute instance

**You do this yourself** at [cloud.oracle.com](https://cloud.oracle.com) —
sign-up requires a credit card for identity verification, but Always Free
resources are never billed against it.

Once in the console: **Compute → Instances → Create Instance**.
- **Image:** Canonical Ubuntu (22.04 or newer).
- **Shape:** click "Change shape" → Ampere → `VM.Standard.A1.Flex` → set
  2 OCPUs / 12GB memory (well inside the 4 OCPU/24GB Always Free
  allowance — plenty for this app, and leaves room to spin up something
  else later).
- **Networking:** keep the default VCN, make sure "Assign a public IPv4
  address" is checked.
- **SSH keys:** upload your own public key (`~/.ssh/id_ed25519.pub`, or
  generate one first with `ssh-keygen -t ed25519`) — you'll need the
  matching private key to log in.
- Create the instance and note its public IP.

### 2. Reserve that public IP (so it survives reboots)

**In the console:** Networking → IP Management → Reserved Public IPs →
Create, then attach it to the instance's VNIC (replacing the ephemeral
one it started with). Skipping this means the IP can change on a reboot,
which would silently break your DNS record in step 6.

### 3. Open the ports — two separate firewalls, both need it

**In the console:** the VCN's Security List needs ingress rules for TCP
`80` and `443` from `0.0.0.0/0` (Networking → Virtual Cloud Networks →
your VCN → Security Lists → Default Security List → Add Ingress Rules).

**On the VM itself**, Oracle's Ubuntu images also ship with `iptables`
rules that block everything except SSH by default — this trips up almost
everyone on OCI, since the Security List alone looks sufficient but isn't.
SSH in (`ssh -i <private-key> ubuntu@<public-ip>`) and run:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### 4. Install Node and get the app onto the VM

Still on the VM, over SSH:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git unzip

git clone https://github.com/FrankenArnav/fed-data-visualization-dashboard.git app
cd app
npm install
```

### 5. Get the ASI/PLFS data onto the VM

Unlike Render, this VM's disk is permanent — nothing resets between
restarts — so the simplest path is just copying the files directly rather
than going through `ensure-data.js`'s OneDrive-download mechanism. From
**your own machine**, not the VM:

```bash
scp -i <private-key> data/CPERV1.txt data/block_*.csv ubuntu@<public-ip>:~/app/data/
```

(`ensure-data.js`'s `DATA_ARCHIVE_URL` mechanism from Option A still works
here too, if you'd rather reuse that path — it's just unnecessary when you
can `scp` directly to a disk that won't disappear.)

### 6. Point a domain at it and get HTTPS, via Caddy

Caddy is a reverse proxy that issues and renews HTTPS certificates
automatically — no separate certbot step needed. On the VM:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Then, **you** point a DNS A record for your chosen subdomain (e.g.
`tools.fedev.org`) at the reserved public IP from step 2 — this has to be
done wherever `fedev.org`'s DNS is managed, outside Oracle entirely.

Once that DNS record is live, edit `/etc/caddy/Caddyfile` on the VM
(`sudo nano /etc/caddy/Caddyfile`), replacing its contents with:

```
tools.fedev.org {
  reverse_proxy localhost:4000
}
```

```bash
sudo systemctl reload caddy
```

Caddy will automatically request and renew a Let's Encrypt certificate for
that domain the moment it can reach it over port 80/443 — no manual
certificate handling required.

### 7. Run the app permanently with pm2

```bash
sudo npm install -g pm2
cd ~/app
pm2 start server/index.js --name fed-dashboard
pm2 startup   # run the sudo command it prints out
pm2 save
```

`pm2 startup` + `pm2 save` is what makes the app come back up
automatically if the VM ever reboots — without it, a reboot would leave
the process dead until someone manually restarts it.

### 8. Verify

`https://tools.fedev.org/api/metadata` should return the same JSON your
local server does. From there, `https://tools.fedev.org/demo.html`,
`/trade-explorer.html`, and `/financial-analyzer.html` are exactly what
goes into the WordPress `<iframe src="...">` tags.

**Ongoing maintenance this option takes on that Render would otherwise
handle:** OS security updates (`sudo apt update && sudo apt upgrade`),
Node version upgrades, and restarting the app after code changes
(`git pull && npm install && pm2 restart fed-dashboard`) are all manual
from here — there's no auto-deploy-on-push the way Render's Blueprint
provides.
