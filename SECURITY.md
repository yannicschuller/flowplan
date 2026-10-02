# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them privately via [GitHub's private vulnerability reporting](https://github.com/yannicschuller/flowplan/security/advisories/new).

Include what is affected, how to reproduce it and the impact you see. You will get an answer within a few days; fixes are released as soon as possible and credited if you wish.

## Supported versions

Security fixes go into the latest release and the `latest` image. Please keep your instance up to date (`docker compose pull && docker compose up -d`).

## Scope

In scope: the Flowplan application and its Docker image. Out of scope: your reverse proxy, OIDC provider, S3 storage and other infrastructure around Flowplan – but tell us if Flowplan's documentation leads to an insecure setup.
