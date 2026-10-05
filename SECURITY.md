# Security Policy

Flow handles real household financial data — bank-sync credentials, account
balances, transaction history — so security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private reporting instead:
the **Security** tab of this repository → **Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you expect. You
should get an acknowledgement within a week.

## Scope

Flow is self-hosted software; each deployment is run by its own operator.
In scope: the application code in this repository (authentication, session
handling, authorization between household members, server actions/API
routes, stored-secret encryption, SSRF protections on outbound fetches).
Out of scope: a specific operator's infrastructure, reverse proxy, or
configuration choices.

## Supported versions

Only the latest `main` (and the `ghcr.io/jbuxxy/flow:latest` image built from
it) receives fixes.
