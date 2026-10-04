# Security policy

Mandate is an authorization control. A defect that lets an agent act outside its
mandate is the most serious kind of bug this project can have, and it is treated
differently from an ordinary issue.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository: **Security → Report a vulnerability**. That channel is private
to the maintainers.

Please include the mandate (redacted if it names private repositories), the
ceiling, the call or input that got through, and what you expected to be denied.

We aim to acknowledge within 3 working days and to ship a fix or a documented
mitigation for a confirmed ceiling bypass within 14 days.

## What counts as a vulnerability

These are in scope, in rough order of severity:

1. **Ceiling bypass** — a mandate validates while granting authority outside the
   org ceiling or outside the requesting user's permissions.
2. **Enforcement bypass** — a tool call the mandate denies reaches GitHub anyway
   through the MCP proxy.
3. **Unsound containment** — a case where the containment check reports
   `contained` for a pattern pair that is not actually contained. A reproducing
   pattern pair is enough; no exploit chain is needed.
4. **Privilege escalation through the writer** — input (issue text, a tool
   description, an agent plan) that causes a wider mandate to be *validated*.
   Note that input causing the writer to merely *propose* something wider is
   working as designed, because the validator is what decides.
5. **Credential exposure** — a minted token, an App private key, or repository
   contents written to a log, a trace, or an error message.

## What does not count

These are documented properties, not defects. Please read
[docs/enforced-where.md](docs/enforced-where.md) first.

- An agent escaping the MCP proxy using a credential Mandate did not mint. The
  sandbox is the control for that, and it is documented as such.
- Branch or path limits not being enforced by the GitHub token itself. GitHub
  App tokens cannot express branch or path scope; those limits are enforced at
  the proxy, and the enforcement report says so for every grant.
- Prompt injection that is not blocked. Mandate does not detect injection; it
  bounds what an injected agent can do. An injection that stays inside the
  mandate is out of scope.
- Data sent to a destination the mandate explicitly allows.

## Safe harbour

We will not pursue or support legal action against anyone who reports in good
faith through the channel above, stays within their own accounts and
repositories, and gives us reasonable time to respond before disclosing.
