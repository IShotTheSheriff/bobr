# Self-hosted Bazel cache

Bóbr uses `bazel-remote` behind Caddy. Caddy provides HTTPS and enforces separate
reader and writer credentials. The backend has no published port. Only trusted
CI pushes get the writer credential. Developers and PR builds use readers.
Bazel computes action keys; developers do not maintain hashes or affected-app lists.

The default cache holds up to 50 GiB. Docker volumes persist across restarts.
Images are pinned by digest. This is a single server, so outages interrupt remote
cache access. Bazel can rebuild evicted entries; a server outage can still fail a
CI job. Clear `BAZEL_REMOTE_CACHE` in GitHub variables to temporarily use the CI
disk cache alone.

## AWS VM

`aws.yml` creates a dedicated public subnet, a `t3.medium` EC2 instance, an Elastic
IP and a separate encrypted 100 GiB gp3 EBS volume. Only ports 80 and 443 accept
inbound traffic. Administration uses AWS Systems Manager Session Manager.
The instance role has the AWS SSM managed-instance policy and no cache credentials.

Use an authenticated AWS CLI session in the intended account. Set the region
explicitly. The example uses Frankfurt. These commands create billable resources.

```sh
aws sts get-caller-identity
aws cloudformation deploy \
  --region eu-central-1 \
  --stack-name bobr-cache \
  --template-file infra/bazel-cache/aws.yml \
  --capabilities CAPABILITY_IAM
aws cloudformation describe-stacks \
  --region eu-central-1 --stack-name bobr-cache \
  --query 'Stacks[0].Outputs'
```

Point the cache domain's DNS A record to the `PublicIp` output. Do not add an AAAA
record unless IPv6 routing is also configured. Use the `SessionCommand` output to
connect, then run `sudo -i`. Wait for `cloud-init status --wait` and check that
`/srv/bobr-cache/bootstrap-complete` exists before continuing. Stack completion
alone does not prove that the bootstrap script succeeded. Its log is
`/var/log/cloud-init-output.log` and contains no generated cache credentials.

Bootstrap installs Docker and Compose. Docker stores all volumes on the data EBS
volume at `/srv/bobr-cache/docker`. The mount is required before Docker starts.
Keep the checkout and credentials on that same volume. Clone the repository into
`/srv/bobr-cache/bobr` and check out the reviewed commit containing these files.
For a private repository, transfer a reviewed archive using your existing secure
access method. Do not give the VM a developer's GitHub credentials.

An EC2 status-check alarm is included. Configure its SNS notification action in
your AWS account. Also monitor disk space and authenticated HTTPS availability;
EC2 status checks do not detect a failed cache container or expired certificate.

The data volume has CloudFormation `Retain` policies. Stack deletion leaves it
behind and it continues to incur storage charges. Instance replacement is a
maintenance operation: stop writes, snapshot the data volume, and verify the
reattachment and mount before restarting the cache. This template does not provide
automatic failover or a zero-downtime upgrade.

## Start the cache

From the server checkout, as its owner:

```sh
cd infra/bazel-cache
python3 configure.py cache.example.com
docker compose up -d
docker compose ps
```

Replace `cache.example.com` with the actual domain. Caddy obtains and renews its
certificate after DNS resolves and ports 80 and 443 are reachable. Do not place a
proxy that rewrites cache paths or response bytes in front of it.

`configure.py` generates random reader and writer passwords, hashes them with
bcrypt for Caddy, and writes these private files without printing credentials:

- `.env` contains the domain and cache size.
- `.secrets/cache-users` contains Caddy's password hashes.
- `.secrets/reader.header` and `.secrets/writer.header` contain complete Bazel headers.

The secrets directory has mode 0700 and files have mode 0600. Git ignores them.
The script refuses to overwrite existing configuration. Use `--size-gib` to change
the initial capacity. Keep disk capacity above the cache limit for uploads,
metadata, container images and certificate storage.

## Connect CI and developers

On a trusted machine with GitHub CLI access to the CI repository, set these values.
If credentials were generated on the VM, transfer the header files privately first.
Do not paste their contents into terminal commands, logs or chat.

```sh
gh variable set BAZEL_REMOTE_CACHE --repo ernest-oneteam/bobr \
  --body 'https://cache.example.com'
gh secret set BAZEL_REMOTE_READ_HEADER --repo ernest-oneteam/bobr \
  < .secrets/reader.header
gh secret set BAZEL_REMOTE_WRITE_HEADER --repo ernest-oneteam/bobr \
  < .secrets/writer.header
```

Leave `BAZEL_REMOTE_PUBLIC_READ` unset. The server requires authentication.
Same-repository PRs can read but cannot write, even if their code bypasses the
Bazel wrapper. Fork PRs receive no credentials. Readers can download cached build
outputs, so distribute their credential only to people allowed to see those outputs.
Keep runtime secrets out of build artifacts.

Developers set `BAZEL_REMOTE_CACHE` and load `BAZEL_REMOTE_HEADER` from their secret
manager once. Normal `pnpm build` and `pnpm test` commands use the wrapper. No
developer needs writer access. macOS and Linux use different action keys for
platform-dependent builds; sharing a cache does not make those outputs portable.

## Verify it

Run the `Shared cache acceptance` GitHub workflow after adding the endpoint and
secrets. It verifies the permissions, builds with a trusted writer, restores from
a fresh reader, then edits an unused barrel export and builds from another fresh
reader. It requires remote hits for both actual Next builds and both browser test
actions, and checks that restored deployment archives match byte for byte. The
clients have separate Bazel output directories and disable the local disk cache.

The `Self-hosted cache acceptance` workflow runs the same proof against disposable
instances of these exact containers, without AWS or repository secrets. Locally:

```sh
python3 scripts/verify-self-hosted-cache.py
python3 scripts/verify-self-hosted-cache.py --bazel
```

The first command tests authentication and the HTTP cache protocol. The second
also builds the apps and runs the browser tests, so it needs Bazel and browser
system libraries. Both remove only their own temporary containers and volumes.

The AWS bootstrap and public DNS/TLS path need validation on the real VM before
this deployment can be called operational. Local container tests do not cover them.

## Maintenance

Check `docker compose ps`, disk usage and `docker compose logs --tail=100` when
investigating failures. Access logging is disabled to avoid logging authorization
headers; Caddy strips authorization before forwarding requests to the backend.
Do not enable verbose request logging with live credentials.

To upgrade, change the image version and digest in `compose.yml`, run the
acceptance workflow, then run `docker compose pull && docker compose up -d` on the
VM. Apply OS security updates and schedule reboots. Do not use `down --volumes`
on the deployed stack. The cache can be recreated, but that command also deletes
Caddy's certificate state.

To rotate credentials, copy `compose.yml`, `Caddyfile` and `configure.py` to a new
private directory and run the configuration script there. Replace the deployed
`.secrets/cache-users`, then run `docker compose up -d --force-recreate caddy` so
the secret bind mount reads the new file. Replace the two GitHub secrets and any
developer reader credentials, run shared-cache acceptance, and remove the old
header files. This simple procedure has an authentication interruption; schedule
it between CI runs. Protect backups of the credential files and Caddy state.

References: [bazel-remote](https://github.com/buchgr/bazel-remote),
[Caddy authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth),
[Bazel remote caching](https://bazel.build/remote/caching),
[AWS retained volumes](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ec2-volume.html).
